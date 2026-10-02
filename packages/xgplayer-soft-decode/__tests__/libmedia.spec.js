/**
 * @jest-environment node
 *
 * The loader itself is environment agnostic, but `compileResource` builds a
 * `Response` internally, and jest-environment-jsdom ships no fetch globals, so
 * this suite runs on node where the real WebAssembly and fetch APIs exist.
 */
import {
  DEFAULT_WASM_BASE_URL,
  LIBMEDIA_WASM_VERSION,
  WASM_VARIANTS,
  clearWasmResourceCache,
  compileWasmBytes,
  fetchBytes,
  resolveWasmResource,
  toArrayBuffer,
  validateBytes,
  variantLadder,
  wasmUrlFor
} from '../src/decoder/libmedia'

// A real (if empty) wasm module: magic number plus version 1.
const WASM_BYTES = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0])
const OTHER_BYTES = new Uint8Array([0x6a, 0x61, 0x6e, 0x67, 0x61, 0x00, 0x01])

function fetchReturning (map) {
  const urls = []
  const impl = async (url) => {
    urls.push(url)
    const hit = map[url]
    if (!hit) {
      return { ok: false, status: 404, statusText: 'Not Found' }
    }
    if (hit instanceof Error) throw hit
    return { ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(hit) }
  }
  return { impl, urls }
}

beforeEach(() => {
  clearWasmResourceCache()
})

describe('wasm url layout', () => {
  test('mirrors the upstream release tree', () => {
    expect(LIBMEDIA_WASM_VERSION).toBe('1.3.1')
    expect(DEFAULT_WASM_BASE_URL).toContain(LIBMEDIA_WASM_VERSION)
    expect(wasmUrlFor(DEFAULT_WASM_BASE_URL)).toBe(
      `${DEFAULT_WASM_BASE_URL}/decode/hevc.wasm`
    )
    expect(wasmUrlFor('https://example.com/a/', '-simd')).toBe(
      'https://example.com/a/decode/hevc-simd.wasm'
    )
    // An empty base falls back to the pinned CDN rather than a relative url.
    expect(wasmUrlFor('', '', 'h264')).toBe(`${DEFAULT_WASM_BASE_URL}/decode/h264.wasm`)
  })

  test('the ladder goes fastest first and keeps 64 bit as an opt-in', () => {
    expect(variantLadder().map((entry) => entry.name)).toEqual([
      'simd',
      'atomic',
      'baseline'
    ])
    expect(variantLadder('auto')).toEqual(WASM_VARIANTS)
    expect(variantLadder('baseline').map((entry) => entry.name)).toEqual([
      'baseline',
      'simd',
      'atomic'
    ])
    expect(variantLadder('64').map((entry) => entry.suffix)).toEqual([
      '-64',
      '-simd',
      '-atomic',
      ''
    ])
    expect(variantLadder('nonsense').map((entry) => entry.name)).toEqual([
      'simd',
      'atomic',
      'baseline'
    ])
  })
})

describe('byte helpers', () => {
  test('toArrayBuffer normalises views and rejects junk', () => {
    expect(toArrayBuffer(null)).toBe(null)
    expect(toArrayBuffer('nope')).toBe(null)
    expect(toArrayBuffer(WASM_BYTES)).toBeInstanceOf(ArrayBuffer)
    const view = new Uint8Array(WASM_BYTES).subarray(4)
    expect(new Uint8Array(toArrayBuffer(view))).toEqual(WASM_BYTES.subarray(4))
  })

  test('validateBytes defers to the engine', () => {
    expect(validateBytes(WASM_BYTES)).toBe(true)
    expect(validateBytes(OTHER_BYTES)).toBe(false)
    expect(validateBytes(null)).toBe(false)
  })
})

describe('fetchBytes', () => {
  test('passes the cors options the CDN needs', async () => {
    let seen
    const impl = async (url, init) => {
      seen = { url, init }
      return { ok: true, status: 200, arrayBuffer: async () => toArrayBuffer(WASM_BYTES) }
    }
    const buffer = await fetchBytes('https://example.com/hevc.wasm', impl)
    expect(buffer).toBeInstanceOf(ArrayBuffer)
    expect(seen.init.mode).toBe('cors')
    expect(seen.init.credentials).toBe('omit')
  })

  test('a non ok response is an error, not a silent empty buffer', async () => {
    await expect(
      fetchBytes('https://example.com/x.wasm', async () => ({
        ok: false,
        status: 503,
        statusText: 'Service Unavailable'
      }))
    ).rejects.toThrow(/503 Service Unavailable/)

    await expect(fetchBytes('https://example.com/x.wasm', async () => null)).rejects.toThrow(
      /no response/
    )
  })

  test('complains when the environment has no fetch at all', async () => {
    const saved = globalThis.fetch
    delete globalThis.fetch
    await expect(fetchBytes('https://example.com/x.wasm')).rejects.toThrow(/fetch is unavailable/)
    globalThis.fetch = saved
  })
})

describe('compileWasmBytes', () => {
  test('refuses a binary the engine cannot parse', async () => {
    await expect(compileWasmBytes(OTHER_BYTES, 'simd')).rejects.toThrow(
      /simd wasm binary is not usable/
    )
  })

  test('reuses one compile per name and forgets failures', async () => {
    const first = await compileWasmBytes(WASM_BYTES, 'shared')
    expect(await compileWasmBytes(WASM_BYTES, 'shared')).toBe(first)

    const rejected = compileWasmBytes(OTHER_BYTES, 'broken')
    await expect(rejected).rejects.toThrow(/not usable/)
    // A rejected promise must not stay in the cache or the next attempt is stuck.
    await expect(compileWasmBytes(WASM_BYTES, 'broken')).resolves.toBeTruthy()
  })
})

describe('resolveWasmResource precedence', () => {
  test('wasmModule wins and costs no work', async () => {
    const fake = { module: 'already compiled' }
    await expect(
      resolveWasmResource({ wasmModule: fake, decoderWasmUrl: 'https://ignored/' })
    ).resolves.toEqual({ resource: fake, variant: 'custom', source: 'wasmModule' })
  })

  test('loadWasm may return bytes, a resource, or nothing', async () => {
    const res = await resolveWasmResource({
      loadWasm: async () => new Uint8Array(WASM_BYTES),
      wasmBaseUrl: 'https://ignored/'
    })
    expect(res.source).toBe('loadWasm')
    expect(res.variant).toBe('custom')
    expect(res.resource).toBeTruthy()

    const triple = await resolveWasmResource({
      loadWasm: async () => ({ resource: 'r', variant: 'mine', source: 'bundle' })
    })
    expect(triple).toEqual({ resource: 'r', variant: 'mine', source: 'bundle' })

    const bare = await resolveWasmResource({ loadWasm: async () => 'resource-ish' })
    expect(bare).toEqual({ resource: 'resource-ish', variant: 'custom', source: 'loadWasm' })

    await expect(resolveWasmResource({ loadWasm: async () => null })).rejects.toThrow(
      /loadWasm resolved to nothing/
    )
  })

  test('wasmBytes beats an explicit url', async () => {
    const { impl, urls } = fetchReturning({ 'https://ignored/x.wasm': WASM_BYTES })
    const res = await resolveWasmResource({
      wasmBytes: WASM_BYTES,
      decoderWasmUrl: 'https://ignored/x.wasm',
      fetchImpl: impl
    })
    expect(res.source).toBe('wasmBytes')
    expect(urls).toEqual([])
  })

  test('decoderWasmUrl is fetched once and cached by url', async () => {
    const { impl, urls } = fetchReturning({ 'https://cdn/decode/hevc.wasm': WASM_BYTES })
    const a = await resolveWasmResource({
      decoderWasmUrl: 'https://cdn/decode/hevc.wasm',
      fetchImpl: impl
    })
    const b = await resolveWasmResource({
      decoderWasmUrl: 'https://cdn/decode/hevc.wasm',
      fetchImpl: impl
    })
    expect(a.variant).toBe('url')
    expect(b.resource).toBe(a.resource)
    expect(urls).toEqual(['https://cdn/decode/hevc.wasm'])
  })

  test('the ladder walks down until a variant validates', async () => {
    const base = 'https://cdn/self'
    const { impl, urls } = fetchReturning({
      [wasmUrlFor(base, '-simd')]: OTHER_BYTES,
      [wasmUrlFor(base, '-atomic')]: OTHER_BYTES,
      [wasmUrlFor(base, '')]: WASM_BYTES
    })
    const res = await resolveWasmResource({ wasmBaseUrl: base, fetchImpl: impl })
    expect(res.variant).toBe('baseline')
    expect(res.source).toBe(wasmUrlFor(base, ''))
    expect(urls).toEqual([
      wasmUrlFor(base, '-simd'),
      wasmUrlFor(base, '-atomic'),
      wasmUrlFor(base, '')
    ])
  })

  test('a variant that never resolves is skipped, not fatal', async () => {
    const base = 'https://cdn/flaky'
    const { impl } = fetchReturning({
      [wasmUrlFor(base, '-simd')]: new Error('network down'),
      [wasmUrlFor(base, '-atomic')]: WASM_BYTES
    })
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {})
    const res = await resolveWasmResource({
      wasmBaseUrl: base,
      fetchImpl: impl,
      openLog: true
    })
    expect(res.variant).toBe('atomic')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  test('when every variant fails the error names the base and keeps the cause', async () => {
    const base = 'https://cdn/empty'
    const { impl } = fetchReturning({})
    let error = null
    try {
      await resolveWasmResource({ wasmBaseUrl: base, fetchImpl: impl })
    } catch (caught) {
      error = caught
    }
    expect(error.message).toBe(`[xgplayer-soft-decode] no usable HEVC wasm below ${base}`)
    expect(
      resolveWasmResource({ wasmBaseUrl: base, codec: 'h264', fetchImpl: impl })
    ).rejects.toThrow(/no usable H264 wasm below/)
    expect(error.cause).toBeInstanceOf(Error)
    expect(error.cause.message).toContain('404')
  })

  test('the codec option redirects the lookup', async () => {
    const base = 'https://cdn/avc'
    const { impl, urls } = fetchReturning({ [wasmUrlFor(base, '-simd', 'h264')]: WASM_BYTES })
    const res = await resolveWasmResource({ wasmBaseUrl: base, codec: 'h264', fetchImpl: impl })
    expect(res.variant).toBe('simd')
    expect(urls).toEqual([wasmUrlFor(base, '-simd', 'h264')])
  })
})
