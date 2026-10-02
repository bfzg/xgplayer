import { isBrowser } from './env'
import { Logger } from './logger'

const logger = new Logger('MediaCapability')

// A spread of HEVC profiles (Main / Main10) used when no real codec string is
// available yet, so `supportsHevcMse()` can still answer before the first track.
const DEFAULT_HEVC_CODECS = [
  'hvc1.1.6.L120.90',
  'hev1.1.6.L120.90',
  'hvc1.2.4.L120.90',
  'hev1.2.4.L120.90',
  'hvc1.1.6.L93.B0',
  'hev1.1.6.L93.B0'
]

/**
 * Flip the sample-entry prefix of an HEVC codec string. `hvc1` and `hev1`
 * describe the same bitstream, so a supporting browser may accept only one of
 * them depending on how the segments are muxed.
 * @param {string} codec
 * @returns {string}
 */
export function swapHevcPrefix(codec) {
  if (typeof codec !== 'string') return ''
  if (codec.startsWith('hvc1.')) return `hev1.${codec.slice(5)}`
  if (codec.startsWith('hev1.')) return `hvc1.${codec.slice(5)}`
  return ''
}

/**
 * Whether a codec string / mime type describes HEVC (H.265).
 * Accepts both sample-entry prefixes (`hvc1` for mp4, `hev1` for annex-b) and
 * a leading `video/` mime prefix.
 * @param {string} codec
 * @returns {boolean}
 */
export function isHevcCodec(codec) {
  if (typeof codec !== 'string') return false
  return /(^|[/;"' ])(hvc1|hev1)(\.|\b)/i.test(codec)
}

/**
 * Whether a demuxed video track carries HEVC (H.265).
 *
 * The codec string is the primary signal, but a track can know its codec type
 * before (or without) a well-formed RFC 6381 string. `auto` mode must not treat
 * such a stream as something the platform can decode.
 * @param {{codec?: string, codecType?: string}} [track]
 * @returns {boolean}
 */
export function isHevcTrack(track) {
  if (!track) return false
  if (isHevcCodec(track.codec)) return true
  return `${track.codecType || ''}`.toLowerCase() === 'hevc'
}

function toMimeType(codec) {
  if (!codec) return ''
  return /^(video|audio)\//i.test(codec) ? codec : `video/mp4; codecs="${codec}"`
}

function hevcCandidates(codecString) {
  if (!codecString) return DEFAULT_HEVC_CODECS.slice()
  return [codecString, swapHevcPrefix(codecString)].filter(Boolean)
}

/**
 * Whether the current browser can hardware-decode HEVC through MSE.
 * @param {string} [codecString] e.g. `hev1.1.6.L93.B0` or a full mime type
 * @returns {boolean}
 */
export function supportsHevcMse(codecString) {
  if (!isBrowser) return false
  const MediaSource = globalThis.MediaSource
  if (!MediaSource || typeof MediaSource.isTypeSupported !== 'function') {
    return false
  }
  return hevcCandidates(codecString).some((codec) => {
    try {
      return MediaSource.isTypeSupported(toMimeType(codec))
    } catch (e) {
      logger.debug('isTypeSupported failed', codec, e)
      return false
    }
  })
}

/**
 * Whether WebCodecs can decode HEVC, preferring a hardware-accelerated decoder.
 * Always resolves, never rejects.
 * @param {string} [codecString]
 * @param {object} [options]
 * @param {number} [options.codedWidth]
 * @param {number} [options.codedHeight]
 * @param {string} [options.hardwareAcceleration] default `prefer-hardware`
 * @returns {Promise<boolean>}
 */
export async function supportsHevcWebCodecs(codecString, options = {}) {
  if (!isBrowser) return false
  const VideoDecoder = globalThis.VideoDecoder
  if (!VideoDecoder || typeof VideoDecoder.isConfigSupported !== 'function') {
    return false
  }
  const { codedWidth, codedHeight, hardwareAcceleration = 'prefer-hardware' } = options
  const candidates = hevcCandidates(codecString)
  for (const codec of candidates) {
    const config = { codec, hardwareAcceleration }
    if (codedWidth) config.codedWidth = codedWidth
    if (codedHeight) config.codedHeight = codedHeight
    try {
      const result = await VideoDecoder.isConfigSupported(config)
      if (result && result.supported) return true
    } catch (e) {
      logger.debug('isConfigSupported failed', codec, e)
    }
  }
  return false
}

/**
 * Whether multi-threaded wasm decoders are usable. Needs `SharedArrayBuffer`,
 * which browsers only expose in a cross-origin isolated (secure) context.
 * @returns {boolean}
 */
export function canUseThreads() {
  if (!isBrowser) return false
  return (
    typeof SharedArrayBuffer !== 'undefined' && globalThis.crossOriginIsolated === true
  )
}
