import { DecoderWorkerControl } from './worker-control'
// Side-effect import: keeps `decoder.worker.js` in the ES module graph so the
// build emits it next to the entry, which is what `decoderWorkerUrl` points at.
// Inside the worker the module wires its message loop; on the main thread it is
// inert (see the `WorkerGlobalScope` guard in decoder.worker.js).
import './decoder.worker.js'

/**
 * Instantiate the decoding worker.
 *
 * Worker output is opt-in: pass `decoderWorkerUrl` (the bundled
 * `decoder.worker.js` on your origin) or `decoderWorkerFactory`. The library
 * never resolves the URL itself, because the UMD bundle is a single file with
 * no sibling worker module, and referencing `import.meta.url` would force the
 * bundler to emit a code-split worker chunk that UMD cannot express. When
 * neither option yields a worker, decoding continues on the main thread.
 *
 * @param {{decoderWorkerUrl?: string, decoderWorkerFactory?: () => Worker}} [options]
 * @returns {Worker|null}
 */
export function createDecoderWorker(options = {}) {
  if (typeof Worker === 'undefined') return null
  try {
    if (typeof options.decoderWorkerFactory === 'function') {
      return options.decoderWorkerFactory()
    }
    const url = options.decoderWorkerUrl
    if (!url) return null
    return new Worker(url, { type: 'module' })
  } catch (_error) {
    return null
  }
}

/** @param {{decoderWorkerUrl?: string, decoderWorkerFactory?: () => Worker}} [options] */
export function createWorkerControl(options = {}) {
  const worker = createDecoderWorker(options)
  return worker ? new DecoderWorkerControl(worker) : null
}
