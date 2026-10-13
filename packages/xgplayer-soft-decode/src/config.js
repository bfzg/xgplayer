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
 * @property {number} [timelineJumpThreshold] seconds the source's own stamps
 *   may disagree with the locked container/media mapping before the mapping is
 *   re-anchored. Recording back-ends that restart every fragment file at zero
 *   (HLS discontinuities) need this to keep seeking and playing across files
 * @property {string[]} [softDecodeCodecs] codec families this build has a
 *   software decoder for. Only what is listed here may be force-switched away
 *   from the platform decoder; anything else stays on MSE
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

/**
 * How far the source's own stamps may sit from the mapping the sink locked in
 * before that mapping is rebuilt.
 *
 * A second is far beyond the inter-segment jitter of a normal stream, and far
 * below the jump of a source that restarted its clock.
 */
export const DEFAULT_TIMELINE_JUMP_THRESHOLD = 1

/**
 * Codec families this build can actually decode.
 *
 * The wasm ladder in `decoder/libmedia.js` only fetches `hevc*.wasm`, and the
 * session only knows `AV_CODEC_ID_HEVC`, so this is the list the HLS/FLV layer
 * consults before it hands a stream over. `softDecode: true` therefore means
 * "force software decoding where a software decoder exists"; an H.264 stream
 * keeps the platform decoder instead of landing on a canvas nobody can paint.
 * Adding an AVC/AV1 wasm decoder later is a matter of appending its family here
 * and extending the decoder table.
 */
export const DEFAULT_SOFT_DECODE_CODECS = ['hevc']

/**
 * Codec families understood by {@link codecFamilyOf}, in match order.
 *
 * The sample-entry prefixes are matched after a separator (mime type, comma or
 * whitespace) so `video/mp4;codecs="hev1.1.6.L120.90"` resolves as well as a
 * bare `hev1.…` string, without `mp4a` matching the AVC branch.
 */
const CODEC_FAMILIES = [
  {
    family: 'hevc',
    test: (codec) =>
      /(?:^|[;:="'\s])(hvc1|hev1|hvc2|hev2)\b/i.test(codec) || /hevc|h\.?265/i.test(codec)
  },
  {
    family: 'avc',
    test: (codec) =>
      /(?:^|[;:="'\s])(avc1|avc3|avc4)\b/i.test(codec) || /h\.?264/i.test(codec)
  },
  { family: 'av1', test: (codec) => /(?:^|[;:="'\s])av01\b/i.test(codec) },
  {
    family: 'vvc',
    test: (codec) =>
      /(?:^|[;:="'\s])(vvc1|vvi1)\b/i.test(codec) || /h\.?266|vvc/i.test(codec)
  }
]

/**
 * Normalise a codec string, a full mime type, or a track to a family name.
 *
 * Accepts `hvc1.1.6.L93.B0`, `video/mp4;codecs="hev1.1.6.L120.90"`, or a
 * demuxer track (`{codec, codecType}`), because the callers on the streaming
 * side have different shapes at hand.
 *
 * @param {string|{codec?: string, codecType?: string}|null} [value]
 * @returns {''|'hevc'|'avc'|'av1'|'vvc'}
 */
export function codecFamilyOf(value) {
  const codec =
    typeof value === 'string' ? value : `${value?.codec || ''} ${value?.codecType || ''}`
  if (!codec.trim()) return ''
  const hit = CODEC_FAMILIES.find((item) => item.test(codec))
  return hit ? hit.family : ''
}

/**
 * Whether this build has a software decoder for the given codec.
 *
 * @param {string|{codec?: string, codecType?: string}|null} [value]
 * @param {string[]} [codecs] defaults to `softDecodeCodecs`
 * @returns {boolean}
 */
export function isSoftDecodableCodec(value, codecs = DEFAULT_SOFT_DECODE_CODECS) {
  const family = codecFamilyOf(value)
  if (!family) return false
  const list = Array.isArray(codecs) ? codecs : DEFAULT_SOFT_DECODE_CODECS
  return list.includes(family)
}

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
  timelineJumpThreshold: DEFAULT_TIMELINE_JUMP_THRESHOLD,
  softDecodeCodecs: DEFAULT_SOFT_DECODE_CODECS,
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
 * Merge caller options over the defaults.
 *
 * The shallow spread is enough for the scalars; `softDecodeCodecs` is the one
 * array default, and it is copied so a caller that appends a family to its own
 * options cannot edit the shared default.
 * @param {Partial<SoftDecodeOption>} [options]
 * @returns {SoftDecodeOption}
 */
export function getSoftDecodeOptions(options) {
  const merged = { ...DEFAULT_SOFT_DECODE_OPTIONS, ...(options || {}) }
  if (Array.isArray(merged.softDecodeCodecs)) {
    merged.softDecodeCodecs = merged.softDecodeCodecs.slice()
  }
  return merged
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
