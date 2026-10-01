/**
 * Where the decoder lives.
 *
 * Three placements, in order of preference, all behind one async interface so
 * `SoftSink` never has to care:
 *
 *   1. `createDecoderSession` from options or deps, a caller supplied decoder.
 *   2. a worker, only when one can actually be created, because decoding wasm
 *      on the main thread is what makes a low end device stutter.
 *   3. the libmedia wasm session on the main thread.
 *
 * A worker that fails to boot is not fatal. `worker-src` CSP rules and `blob:`
 * restrictions are common on embedded pages, and the same wasm runs on the main
 * thread, so the fallback keeps the stream playable.
 */
import { createHevcDecoderSession } from './hevc-decoder'
import { createWorkerControl } from './worker-factory'

/**
 * @param {boolean|'auto'} [worker]
 * @param {object} [deps]
 * @returns {boolean}
 */
export function shouldUseWorker(worker, deps = {}) {
  const mode = worker === undefined || worker === null ? 'auto' : worker
  if (mode === false || mode === 'none' || mode === 'off' || mode === 0) return false
  if (typeof deps?.createWorkerControl === 'function') return true
  if (mode === true || mode === 'auto') return typeof globalThis.Worker !== 'undefined'
  return true
}

/**
 * The plain track description handed to a session or a worker. It is built from
 * the snapshot taken on the main thread, so nothing here is a live track object.
 * @param {{timescale?: number, width?: number, height?: number, codec?: string}} video
 * @returns {object}
 */
export function descriptorOf(video) {
  return {
    timescale: video?.timescale || 90000,
    width: video?.width || 0,
    height: video?.height || 0,
    codec: video?.codec || '',
    vps: video?.vps || [],
    sps: video?.sps || [],
    pps: video?.pps || []
  }
}

const list = (value) => (Array.isArray(value) ? value : [])

function wrapSession(session, kind) {
  return {
    kind,
    get variant() {
      return session.variant
    },
    get wasmSource() {
      return session.wasmSource
    },
    async decode(packets) {
      return list(await session.decode(packets))
    },
    async flush() {
      return list(await session.flush())
    },
    async destroy() {
      if (typeof session.destroy === 'function') await session.destroy()
    }
  }
}

function wrapControl(control, info) {
  return {
    kind: 'worker',
    get variant() {
      return info.variant
    },
    get wasmSource() {
      return info.wasmSource
    },
    async decode(packets) {
      return list(await control.decode(packets))
    },
    async flush() {
      return list(await control.flush())
    },
    async destroy() {
      control.destroy()
    }
  }
}

/**
 * @param {object} args
 * @param {any} args.video snapshot produced by `snapshotVideo`
 * @param {import('../config').SoftDecodeOption} [args.options]
 * @param {object} [args.deps] injection seams: `createDecoderSession`,
 *   `createWorkerControl`, `resource`
 * @returns {Promise<any>} a wrapped decoder, always async
 */
export async function createDecoder({ video, options = {}, deps = {} } = {}) {
  const descriptor = descriptorOf(video)

  const custom = deps.createDecoderSession || options.createDecoderSession
  if (typeof custom === 'function') {
    const session = await custom({ track: descriptor, options })
    return wrapSession(session, 'main')
  }

  if (shouldUseWorker(options.worker, deps)) {
    const injected = typeof deps.createWorkerControl === 'function'
    const control = injected
      ? await deps.createWorkerControl()
      : createWorkerControl(options)
    if (control) {
      const info = {}
      try {
        Object.assign(info, (await control.init(descriptor, options)) || {})
        return wrapControl(control, info)
      } catch (error) {
        // An injected control belongs to the caller, so its failures belong to
        // the caller too. Something we spawned is ours to recover from.
        if (injected) throw error
        try {
          control.destroy()
        } catch (_error) {
          // ignore
        }
        if (options.openLog) {
          console.warn('[xgplayer-soft-decode] decode worker unavailable', error)
        }
      }
    }
  }

  const session = await createHevcDecoderSession({
    track: descriptor,
    options,
    resource: deps.resource || null
  })
  return wrapSession(session, 'main')
}
