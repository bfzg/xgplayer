/**
 * Request/response bridge around the decoding worker.
 *
 * The worker is deliberately optional: when no worker is configured the
 * SoftSink decodes on the main thread. When one is, only encoded packets and
 * decoded frame buffers cross the boundary, and buffers are transferred rather
 * than copied.
 */

/**
 * The option keys a worker can make sense of.
 *
 * `postMessage` structured-clones, and the soft decode option bag is full of
 * things that cannot survive that: `loadWasm`, `fetchImpl` and
 * `createDecoderSession` are functions, `canvas` is a DOM node, `wasmModule` is
 * a compiled instance owned by the main thread's realm, and the pacing knobs
 * only mean anything to the sink. Sending the whole bag was a guaranteed
 * `DataCloneError`, which the session ladder then quietly swallowed, so
 * `worker: true` always ended up decoding on the main thread anyway.
 */
const WORKER_OPTION_KEYS = [
  'wasmBaseUrl',
  'decoderWasmUrl',
  'wasmBytes',
  'wasmVariant',
  'maxFrameBytes',
  'wasmDecoderOptions',
  'audioSampleRate',
  'audioChannelCount',
  'openLog'
]

/**
 * @param {object} [options] the full soft decode option bag
 * @returns {object} a copy holding only the keys the worker understands
 */
export function cloneableSoftDecodeOptions(options = {}) {
  const picked = {}
  for (const key of WORKER_OPTION_KEYS) {
    if (options[key] !== undefined) picked[key] = options[key]
  }
  return picked
}

let seq = 0

export class DecoderWorkerControl {
  /**
   * @param {Worker} worker
   */
  constructor(worker) {
    this._worker = worker
    this._pending = new Map()
    this._listener = (event) => this._handleMessage(event.data)
    if (typeof worker.addEventListener === 'function') {
      worker.addEventListener('message', this._listener)
    } else {
      worker.onmessage = this._listener
    }
  }

  get worker() {
    return this._worker
  }

  _handleMessage(data) {
    if (!data || data.id === undefined) return
    const entry = this._pending.get(data.id)
    if (!entry) return
    this._pending.delete(data.id)
    if (data.error) {
      entry.reject(new Error(data.error))
    } else {
      entry.resolve(data.result)
    }
  }

  _request(method, payload, transfer) {
    const id = ++seq
    const worker = this._worker
    if (!worker) return Promise.reject(new Error('[xgplayer-soft-decode] worker is gone'))
    return new Promise((resolve, reject) => {
      this._pending.set(id, { resolve, reject })
      worker.postMessage({ id, method, payload }, transfer || [])
    })
  }

  /**
   * Only the wasm-location knobs go over: the worker is the side that has to
   * find and compile the binary, and everything else in the bag is either a
   * closure or a main-thread object.
   *
   * @param {{timescale:number,width:number,height:number,vps:any[],sps:any[],pps:any[]}} descriptor
   * @param {object} [options]
   * @returns {Promise<{width:number,height:number,variant?:string,wasmSource?:string}>}
   */
  init(descriptor, options) {
    return this._request('init', {
      track: descriptor,
      options: cloneableSoftDecodeOptions(options)
    })
  }

  /**
   * @param {{data: Uint8Array, pts: number, dts: number}[]} packets
   * @returns {Promise<any[]>}
   */
  decode(packets) {
    const transfer = []
    for (const packet of packets) {
      if (packet?.data?.buffer) transfer.push(packet.data.buffer)
    }
    return this._request('decode', { packets }, transfer)
  }

  flush() {
    return this._request('flush', {})
  }

  destroy() {
    try {
      this._worker?.removeEventListener?.('message', this._listener)
    } catch (_error) {
      // ignore
    }
    try {
      this._worker?.terminate?.()
    } catch (_error) {
      // ignore
    }
    this._pending.forEach((entry) =>
      entry.reject(new Error('[xgplayer-soft-decode] worker destroyed'))
    )
    this._pending.clear()
    this._worker = null
  }
}

/**
 * Collect the transferable buffers of the decoded frames.
 *
 * `packFrame` gives every frame a `Uint8Array` of its own, so transferring the
 * backing buffer moves the pixels instead of copying them, and the decoder in
 * the worker can immediately reuse the heap it copied from.
 */
export function frameTransferables(frames) {
  const transfer = []
  for (const frame of frames || []) {
    const buffer = frame?.data?.buffer
    if (buffer && typeof buffer === 'object' && !transfer.includes(buffer)) {
      transfer.push(buffer)
    }
  }
  return transfer
}
