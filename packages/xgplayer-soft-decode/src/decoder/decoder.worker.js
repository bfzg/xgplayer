/**
 * Worker entry point. Kept build-tool agnostic: it only relies on the standard
 * `self`/`postMessage` worker API, so it can be wired with Vite's
 * `new Worker(new URL('./decoder.worker.js', import.meta.url), { type: 'module' })`,
 * webpack's `worker-loader`, or `rollup-plugin-web-worker-loader`.
 */
import { createHevcDecoderSession, packetsOf } from './hevc-decoder'
import { frameTransferables } from './worker-control'

let session = null

async function init(track, options) {
  await destroy()
  session = await createHevcDecoderSession({
    track: {
      timescale: track.timescale,
      width: track.width,
      height: track.height,
      vps: track.vps || [],
      sps: track.sps || [],
      pps: track.pps || []
    },
    options
  })
  return {
    width: track.width,
    height: track.height,
    variant: session.variant,
    wasmSource: session.wasmSource
  }
}

async function destroy() {
  if (session) {
    await session.destroy()
    session = null
  }
}

async function handle(method, payload) {
  switch (method) {
    case 'init':
      return init(payload.track, payload.options || {})
    case 'decode':
      if (!session) throw new Error('[xgplayer-soft-decode] decoder is not initialised')
      return session.decode(payload.packets)
    case 'flush':
      if (!session) return []
      return session.flush()
    case 'packets':
      return packetsOf(payload.track)
    case 'destroy':
      await destroy()
      return true
    default:
      throw new Error(`[xgplayer-soft-decode] unknown method ${method}`)
  }
}

// Only wire the message loop when actually running inside a worker. The module
// is also imported for side effects so bundlers emit it next to the main entry;
// on the main thread this guard keeps it inert.
const isWorkerScope =
  typeof WorkerGlobalScope !== 'undefined' &&
  typeof self !== 'undefined' &&
  self instanceof WorkerGlobalScope

if (isWorkerScope && typeof self.postMessage === 'function') {
  self.addEventListener('message', (event) => {
    const { id, method, payload } = event.data || {}
    Promise.resolve()
      .then(() => handle(method, payload))
      .then((result) => {
        const transfer =
          method === 'decode' || method === 'flush' ? frameTransferables(result) : []
        self.postMessage({ id, result }, transfer)
      })
      .catch((error) => {
        self.postMessage({ id, error: error?.message || String(error) })
      })
  })
}

export { handle }
