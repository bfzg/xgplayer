import { WasmVideoDecoder } from '@libmedia/avcodec'
import {
  destroyAVPacket,
  freeCodecParameters,
  unserializeAVCodecParameters,
  unserializeAVPacket
} from '@libmedia/avutil'
import { packFrame } from './frame'
import { resolveWasmResource } from './libmedia'
import { buildHevcExtradata, buildHevcPackets, timeBaseOf } from './nalu'

/**
 * `AVMEDIA_TYPE_VIDEO` from libavutil.
 *
 * The enum starts at `AVMEDIA_TYPE_UNKNOWN = -1`, so video is `0` and audio is
 * `1`. libmedia copies this straight into `AVCodecParameters.codec_type`, and
 * the wasm `decoder_open` rejects a parameter block whose type does not match
 * the decoder, so it has to be the real value.
 */
export const AVMEDIA_TYPE_VIDEO = 0

/**
 * `AV_CODEC_ID_HEVC` is positional in libavcodec, so its number does move
 * between FFmpeg major versions. libmedia pins its wasm build to one FFmpeg
 * revision, which makes the value stable for this package. The upstream enum is
 * a TypeScript `const enum` and therefore vanishes from a JavaScript bundle, so
 * the numbers used here are spelled out instead of imported.
 */
export const AV_CODEC_ID_HEVC = 173

/** `AVCodecParameterFlags.AV_CODECPAR_FLAG_H26X_ANNEXB`. */
export const AV_CODECPAR_FLAG_H26X_ANNEXB = 1

/** `AV_PKT_FLAG_KEY`. */
export const AV_PKT_FLAG_KEY = 1

/**
 * `AVCodecParameters` for one HEVC track, in the plain shape that
 * `unserializeAVCodecParameters` writes into wasm memory. Every field is present
 * because the serializer assigns them one by one with no defaults, and the
 * 64 bit members have to be `bigint`.
 *
 * Extradata is Annex B VPS/SPS/PPS, exactly what the demuxer keeps, and the
 * `H26X_ANNEXB` flag tells the decoder not to expect AVCC length prefixes.
 *
 * @param {import('xgplayer-transmuxer').VideoTrack} track
 */
export function buildHevcCodecParSerialize(track) {
  const size = (value) => (Number.isFinite(value) && value > 0 ? Math.floor(value) : 0)
  return {
    codecType: AVMEDIA_TYPE_VIDEO,
    codecId: AV_CODEC_ID_HEVC,
    codecTag: 0,
    extradata: buildHevcExtradata(track),
    codedSideData: [],
    format: 0,
    bitrate: 0n,
    bitsPerCodedSample: 0,
    bitsPerRawSample: 8,
    profile: 0,
    level: 0,
    width: size(track?.width),
    height: size(track?.height),
    sampleAspectRatio: { num: 0, den: 1 },
    framerate: { num: 0, den: 1 },
    fieldOrder: 0,
    colorRange: 0,
    colorPrimaries: 0,
    colorTrc: 0,
    colorSpace: 0,
    chromaLocation: 0,
    videoDelay: 0,
    chLayout: { order: 0, nbChannels: 0, u: 0n },
    sampleRate: 0,
    blockAlign: 0,
    frameSize: 0,
    initialPadding: 0,
    trailingPadding: 0,
    seekPreroll: 0,
    flags: AV_CODECPAR_FLAG_H26X_ANNEXB
  }
}

/**
 * Create a decoder session for one HEVC track.
 *
 * The session is a thin, stateful wrapper over `WasmVideoDecoder`. It is
 * created lazily on the first video append so a channel that never falls back
 * never pays for wasm at all.
 *
 * Two libmedia behaviours shape the wrapper:
 *  - `decode()` is synchronous and pushes finished frames straight into
 *    `onReceiveAVFrame`, so frames are collected during the call rather than
 *    returned by it.
 *  - frames leave the decoder in **decode** order, not presentation order. The
 *    pacer owns the reordering; the session only reports what came out.
 *
 * @param {object} args
 * @param {import('xgplayer-transmuxer').VideoTrack} args.track
 * @param {import('../config').SoftDecodeOption} [args.options]
 * @param {any} [args.resource] an already compiled `WebAssemblyResource`
 * @param {(decoder: any, parametersPtr: number) => Promise<number>} [args.initDecoder] override for tests
 * @returns {Promise<any>}
 */
export async function createHevcDecoderSession({
  track,
  options = {},
  resource,
  initDecoder
} = {}) {
  const resolved = resource
    ? { resource, variant: 'custom', source: 'resource' }
    : await resolveWasmResource({ ...options, codec: 'hevc' })

  const timeBase = timeBaseOf(track.timescale)
  const limits = { maxFrameBytes: options.maxFrameBytes }

  /** @type {object[]} */
  let collected = []
  let unusable = 0

  const decoder = new WasmVideoDecoder({
    resource: resolved.resource,
    onReceiveAVFrame(ptr) {
      const frame = packFrame(ptr, limits)
      if (frame) {
        collected.push(frame)
        return
      }
      // `packFrame` always releases the AVFrame, so a format the renderer
      // cannot paint is counted here rather than crashing the session.
      unusable += 1
      if (options.openLog && unusable === 1) {
        console.warn('[xgplayer-soft-decode] decoded frame is not paintable, skipped')
      }
    }
  })

  const parametersPtr = unserializeAVCodecParameters(buildHevcCodecParSerialize(track))

  const open =
    initDecoder || ((dec, ptr) => dec.open(ptr, 1, options.wasmDecoderOptions || {}))
  // libmedia compiles its decoder without `threadModule`, so a threadCount
  // above 1 would reach `wasm_pthread_create` with nothing to spawn. One thread
  // is the only supported setting, and it is also what keeps the decoder usable
  // on a plain page without `SharedArrayBuffer`.
  const ret = await open(decoder, parametersPtr)
  if (ret) {
    try {
      freeCodecParameters(parametersPtr)
    } catch (_error) {
      // ignore
    }
    throw new Error(`[xgplayer-soft-decode] HEVC decoder failed to open (code ${ret})`)
  }

  let packetPtr = 0
  let destroyed = false

  const takeCollected = () => {
    const frames = collected
    collected = []
    return frames
  }

  return {
    variant: resolved.variant,
    wasmSource: resolved.source,
    resource: resolved.resource,
    timeBase,
    /** @returns {boolean} */
    get destroyed() {
      return destroyed
    },
    /**
     * @param {{data: Uint8Array, pts: number, dts: number, keyframe?: boolean}[]} packets
     * @returns {object[]} packed frames, still in decode order
     */
    decode(packets) {
      if (destroyed || !packets || !packets.length) return []
      for (const packet of packets) {
        if (!packet?.data?.byteLength) continue
        // Reusing one `AVPacket` is safe: the serializer unrefs the previous
        // payload before copying the new one in.
        packetPtr = unserializeAVPacket(
          {
            pts: BigInt(Math.round(packet.pts)),
            dts: BigInt(Math.round(packet.dts ?? packet.pts)),
            data: packet.data,
            streamIndex: 0,
            flags: packet.keyframe ? AV_PKT_FLAG_KEY : 0,
            sideData: [],
            duration: 0n,
            pos: -1n,
            timeBase
          },
          packetPtr
        )
        decoder.decode(packetPtr)
      }
      return takeCollected()
    },
    /** Drain the decoder and return the frames the clock never reached. */
    flush() {
      if (destroyed) return []
      try {
        decoder.flush()
      } catch (_error) {
        // A flaky drain must not block the audio end of stream.
      }
      return takeCollected()
    },
    async destroy() {
      if (destroyed) return
      destroyed = true
      try {
        decoder.close()
      } catch (_error) {
        // Teardown must never throw into the append chain.
      }
      try {
        freeCodecParameters(parametersPtr)
      } catch (_error) {
        // ignore
      }
      if (packetPtr) {
        try {
          destroyAVPacket(packetPtr)
        } catch (_error) {
          // ignore
        }
        packetPtr = 0
      }
      collected = []
    }
  }
}

/** Convenience for callers that only want the packets of a track. */
export function packetsOf(track) {
  return buildHevcPackets(track)
}
