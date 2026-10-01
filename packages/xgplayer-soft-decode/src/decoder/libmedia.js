/**
 * libmedia wasm resource loading for the HEVC software decoder.
 *
 * `@libmedia/avcodec` ships the JS glue on npm but the FFmpeg wasm binaries are
 * only published in the libmedia release tree, so the default here is a pinned
 * jsDelivr mirror of `dist/decode/hevc*.wasm`. Nothing is fetched at import
 * time: `resolveWasmResource` runs on the first real fallback, and every part of
 * the lookup is overridable (`wasmBaseUrl`, `decoderWasmUrl`, `wasmBytes`,
 * `wasmModule`, `loadWasm`, `fetchImpl`), so an integrator can serve the
 * binaries from their own origin without touching the defaults.
 *
 * Licensing note: libmedia is LGPL-3.0-or-later and the wasm binaries are not
 * committed to this repository; they are either mirrored from the upstream
 * release or self-hosted by the integrator.
 */
import { compileResource } from '@libmedia/cheap'

export const LIBMEDIA_WASM_VERSION = '1.3.1'

export const DEFAULT_WASM_BASE_URL = `https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@${LIBMEDIA_WASM_VERSION}/dist`

/**
 * Ordered capability ladder. `simd` is the fastest build; a binary whose
 * features the engine cannot parse is rejected by `WebAssembly.validate`, so the
 * ladder selects itself without any browser sniffing.
 */
export const WASM_VARIANTS = [
  { name: 'simd', suffix: '-simd' },
  { name: 'atomic', suffix: '-atomic' },
  { name: 'baseline', suffix: '' }
]

/** `baseUrl` -> resolved resource, so a retry or a second player reuses one compile. */
const cache = new Map()

/** Forget every cached resource. Used by tests and by `reset()`. */
export function clearWasmResourceCache() {
  cache.clear()
}

export function wasmUrlFor(baseUrl, suffix = '', codec = 'hevc') {
  const base = String(baseUrl || DEFAULT_WASM_BASE_URL).replace(/\/+$/, '')
  return `${base}/decode/${codec}${suffix || ''}.wasm`
}

/**
 * The variants worth trying, most capable first.
 * @param {string} [wasmVariant] `'auto' | 'simd' | 'atomic' | 'baseline' | '64'`
 */
export function variantLadder(wasmVariant) {
  const wanted = String(wasmVariant || 'auto').toLowerCase()
  if (wanted === '64' || wanted === '-64') {
    return [{ name: '64', suffix: '-64' }, ...WASM_VARIANTS]
  }
  const hit = WASM_VARIANTS.find((variant) => variant.name === wanted)
  if (!hit) return WASM_VARIANTS.slice()
  return [hit, ...WASM_VARIANTS.filter((variant) => variant !== hit)]
}

/** `WebAssembly.validate` is unavailable in a few sandboxes; then assume ok. */
export function validateBytes(bytes) {
  try {
    if (
      typeof WebAssembly === 'undefined' ||
      typeof WebAssembly.validate !== 'function'
    ) {
      return true
    }
    return WebAssembly.validate(toArrayBuffer(bytes))
  } catch (_error) {
    return false
  }
}

export function toArrayBuffer(value) {
  if (!value) return null
  if (value instanceof ArrayBuffer) return value
  if (ArrayBuffer.isView(value)) {
    return value.slice().buffer
  }
  return null
}

/**
 * @param {string} url
 * @param {typeof fetch} [fetchImpl]
 * @returns {Promise<ArrayBuffer>}
 */
export async function fetchBytes(url, fetchImpl) {
  const load = typeof fetchImpl === 'function' ? fetchImpl : globalThis.fetch
  if (typeof load !== 'function') {
    throw new Error(
      '[xgplayer-soft-decode] fetch is unavailable, cannot load the wasm decoder'
    )
  }
  const response = await load(url, {
    method: 'GET',
    mode: 'cors',
    credentials: 'omit',
    cache: 'default',
    referrerPolicy: 'no-referrer-when-downgrade'
  })
  if (!response || response.ok === false) {
    const status = response
      ? `${response.status} ${response.statusText || ''}`.trim()
      : 'no response'
    throw new Error(`[xgplayer-soft-decode] failed to load ${url} (${status})`)
  }
  return await response.arrayBuffer()
}

/**
 * Parse + validate + compile one binary, memoised by name.
 *
 * `compileResource` reads the `dylink.0` and import sections so the wasm static
 * data and function table can be allocated in the shared heap before the module
 * is instantiated. Handing it bytes (never a URL) keeps the download under our
 * own control and lets a failed variant be dropped cheaply.
 */
export async function compileWasmBytes(bytes, name = 'custom') {
  const key = `bytes:${name}`
  const cached = cache.get(key)
  if (cached) return cached
  if (!validateBytes(bytes)) {
    throw new Error(
      `[xgplayer-soft-decode] ${name} wasm binary is not usable in this engine`
    )
  }
  const buffer = toArrayBuffer(bytes)
  const promise = compileResource({ source: buffer })
  cache.set(key, promise)
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key)
  })
  return promise
}

async function compileWasmUrl(url, fetchImpl) {
  const key = `url:${url}`
  const cached = cache.get(key)
  if (cached) return cached
  const promise = (async () => {
    const bytes = await fetchBytes(url, fetchImpl)
    if (!validateBytes(bytes)) {
      throw new Error(
        `[xgplayer-soft-decode] ${url} is not a valid wasm module for this engine`
      )
    }
    return await compileResource({ source: bytes })
  })()
  cache.set(key, promise)
  promise.catch(() => {
    if (cache.get(key) === promise) cache.delete(key)
  })
  return promise
}

/**
 * Resolve the `{ resource, variant, source }` triple that `WasmVideoDecoder` needs.
 *
 * Resolution order, first match wins:
 *   1. `wasmModule` (an already compiled resource)
 *   2. `loadWasm(options)` (integrator supplied loader)
 *   3. `wasmBytes` (raw binary, no network)
 *   4. `decoderWasmUrl` (one explicit url)
 *   5. the variant ladder under `wasmBaseUrl`
 *
 * @param {import('../config').SoftDecodeOption & {codec?: string}} [options]
 * @returns {Promise<{resource: any, variant: string, source: string}>}
 */
export async function resolveWasmResource(options = {}) {
  const codec = options.codec || 'hevc'
  const log = options.openLog

  if (options.wasmModule) {
    return { resource: options.wasmModule, variant: 'custom', source: 'wasmModule' }
  }

  if (typeof options.loadWasm === 'function') {
    const loaded = await options.loadWasm(options)
    if (!loaded) {
      throw new Error('[xgplayer-soft-decode] loadWasm resolved to nothing')
    }
    if (loaded.resource) {
      return {
        resource: loaded.resource,
        variant: loaded.variant || 'custom',
        source: loaded.source || 'loadWasm'
      }
    }
    const bytes = toArrayBuffer(loaded)
    if (bytes) {
      return {
        resource: await compileWasmBytes(bytes, 'loadWasm'),
        variant: 'custom',
        source: 'loadWasm'
      }
    }
    return { resource: loaded, variant: 'custom', source: 'loadWasm' }
  }

  const bytes = toArrayBuffer(options.wasmBytes)
  if (bytes) {
    return {
      resource: await compileWasmBytes(bytes, 'wasmBytes'),
      variant: 'custom',
      source: 'wasmBytes'
    }
  }

  if (options.decoderWasmUrl) {
    return {
      resource: await compileWasmUrl(options.decoderWasmUrl, options.fetchImpl),
      variant: 'url',
      source: options.decoderWasmUrl
    }
  }

  const baseUrl = options.wasmBaseUrl || DEFAULT_WASM_BASE_URL
  const ladder = variantLadder(options.wasmVariant)
  let lastError = null
  for (const variant of ladder) {
    const url = wasmUrlFor(baseUrl, variant.suffix, codec)
    try {
      const resource = await compileWasmUrl(url, options.fetchImpl)
      return { resource, variant: variant.name, source: url }
    } catch (error) {
      lastError = error
      if (log) {
        console.warn(
          `[xgplayer-soft-decode] wasm variant "${variant.name}" unavailable`,
          error
        )
      }
    }
  }
  const message = `[xgplayer-soft-decode] no usable ${codec.toUpperCase()} wasm below ${baseUrl}`
  const wrapped = new Error(message)
  wrapped.cause = lastError
  throw wrapped
}
