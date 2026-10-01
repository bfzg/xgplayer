/**
 * Soft decode options.
 *
 * Everything here is optional. The defaults describe a conservative setup:
 * wasm decoding only happens as a fallback, on one thread, on the main thread
 * unless a worker is wired up, and the queue is bounded so a slow device sheds
 * frames instead of memory.
 *
 * @typedef {object} SoftDecodeOption
 * @property {boolean} [enabled] master switch for the sink
 * @property {boolean|'auto'} [worker] `'auto'` uses a worker when one can be
 *   created; `false` keeps decoding on the main thread
 * @property {'canvas'} [renderer] painter to use
 * @property {number} [maxSoftResolution] height above which software decoding
 *   can be declined. `0`, the default, means no limit: a browser without HEVC
 *   MSE has no better option at 1440p, and refusing would black the screen.
 * @property {boolean} [dropLateFrames] shed frames that fall behind the clock
 * @property {number} [lateFrameThreshold] seconds a frame may trail the clock
 * @property {number} [maxFrameQueue] decoded frames held in memory
 * @property {number} [maxQueuedBytes] decoded bytes held in memory, `0` disables
 * @property {number} [maxDecodeLead] seconds of video the decoder may run ahead
 *   of the audio clock before the pump waits; `0` removes the limit
 * @property {number} [maxDecodeBatch] packets handed to the decoder per pump
 * @property {number} [maxDecodeSliceMs] milliseconds of synchronous decoding
 *   allowed per pump turn before the event loop is handed back
 * @property {number} [maxPendingPackets] compressed packets held behind the
 *   clock; beyond it the late part of the backlog is cut back to a keyframe.
 *   Packets ahead of the clock, the prebuffer, are never shed. `0` disables it
 * @property {number} [maxFrameBytes] largest single packed frame accepted
 * @property {'mse-native'} [audioThrough] how audio is decoded
 * @property {number} [audioSampleRate] sample rate of the synthesised silent
 *   track that clocks the element when the stream carries no audio
 * @property {number} [audioChannelCount] channels of that silent track
 * @property {number} [silentFillAhead] seconds of silent clock kept ahead of
 *   the newest appended picture, so the element never reads past its buffer
 * @property {HTMLCanvasElement|null} [canvas] caller supplied paint target
 * @property {string} [wasmBaseUrl] origin of `decode/hevc*.wasm`
 * @property {string} [decoderWasmUrl] one explicit binary, skips the ladder
 * @property {Uint8Array|ArrayBuffer|null} [wasmBytes] binary without any network
 * @property {any} [wasmModule] an already compiled `WebAssemblyResource`
 * @property {'auto'|'simd'|'atomic'|'baseline'|'64'} [wasmVariant] ladder head
 * @property {(options: SoftDecodeOption) => any} [loadWasm] custom loader
 * @property {typeof fetch} [fetchImpl] custom fetch, used for CSP/`file:` hosts
 * @property {object|null} [wasmDecoderOptions] passed to `WasmVideoDecoder.open`
 * @property {Function|null} [createDecoderSession] full decoder replacement
 * @property {(() => Worker)|null} [decoderWorkerFactory] custom worker
 * @property {string} [decoderWorkerUrl] url of the bundled `decoder.worker.js`
 * @property {boolean} [openLog] warn on recoverable decode problems
 */
import { DEFAULT_WASM_BASE_URL } from './decoder/libmedia'

/** 32 MiB per plane set; a 4K yuv420p frame is ~12 MiB. */
const DEFAULT_MAX_FRAME_BYTES = 32 * 1024 * 1024

/**
 * 160 MiB of decoded frames.
 *
 * Sized so the frame count stays the binding valve at every resolution worth
 * decoding in software: a 2560x1440 yuv420p picture is 5.5 MB, so 24 of them
 * need 133 MB. At the previous 96 MiB the byte cap bound first at 1440p, the
 * pacer evicted its own newest pictures, and the decode budget fell back to 0
 * on the very next turn, which starved the canvas.
 */
const DEFAULT_MAX_QUEUED_BYTES = 160 * 1024 * 1024

/** About 24 seconds of pictures at 25 fps. */
const DEFAULT_MAX_PENDING_PACKETS = 600

/** A third of one 60 Hz frame; long enough to amortise a wasm call. */
const DEFAULT_MAX_DECODE_SLICE_MS = 12

/** Half a frame at 20 fps, plus slack for the append granularity. */
const DEFAULT_SILENT_FILL_AHEAD = 0.2

export const DEFAULT_SOFT_DECODE_OPTIONS = {
  enabled: true,
  worker: 'auto',
  renderer: 'canvas',
  maxSoftResolution: 0,
  dropLateFrames: true,
  lateFrameThreshold: 0.12,
  maxFrameQueue: 24,
  maxQueuedBytes: DEFAULT_MAX_QUEUED_BYTES,
  maxDecodeLead: 1,
  maxDecodeBatch: 8,
  maxDecodeSliceMs: DEFAULT_MAX_DECODE_SLICE_MS,
  maxPendingPackets: DEFAULT_MAX_PENDING_PACKETS,
  maxFrameBytes: DEFAULT_MAX_FRAME_BYTES,
  audioThrough: 'mse-native',
  audioSampleRate: 48000,
  audioChannelCount: 2,
  silentFillAhead: DEFAULT_SILENT_FILL_AHEAD,
  canvas: null,
  wasmBaseUrl: DEFAULT_WASM_BASE_URL,
  decoderWasmUrl: '',
  wasmBytes: null,
  wasmModule: null,
  wasmVariant: 'auto',
  loadWasm: null,
  fetchImpl: null,
  wasmDecoderOptions: null,
  createDecoderSession: null,
  decoderWorkerFactory: null,
  decoderWorkerUrl: '',
  openLog: false
}

/**
 * Merge caller options over the defaults. A shallow spread is enough because no
 * default value is a mutable object that a caller is expected to extend.
 * @param {Partial<SoftDecodeOption>} [options]
 * @returns {SoftDecodeOption}
 */
export function getSoftDecodeOptions(options) {
  return { ...DEFAULT_SOFT_DECODE_OPTIONS, ...(options || {}) }
}

/**
 * Whether a stream is too big to be worth decoding in software.
 *
 * Vertical size is the useful measure for landscape video, and the two get
 * swapped for portrait captures, where `height` is the long edge.
 * @param {number} width
 * @param {number} height
 * @param {number} maxSoftResolution
 * @returns {boolean}
 */
export function exceedsSoftResolution(width, height, maxSoftResolution) {
  if (!maxSoftResolution || maxSoftResolution <= 0) return false
  const h = height || 0
  if (h > maxSoftResolution) return true
  if (h > 0) return false
  return Math.max(width || 0, h) > maxSoftResolution
}
