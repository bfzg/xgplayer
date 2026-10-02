import { concatUint8Array, ERR, Logger, StreamingError } from 'xgplayer-streaming-shared'
import {
  FMP4Demuxer,
  FMP4Remuxer,
  TrackType,
  TsDemuxer,
  WarningType
} from 'xgplayer-transmuxer'
import { Event } from '../../constants'

const logger = new Logger('Transmuxer')

export class Transmuxer {
  _initSegmentId = ''

  /**
   * @param {import('../index').default} hls
   * @param {boolean} isMP4 fmp4 source instead of mpeg-ts
   * @param {boolean} needRemux remux eagerly inside {@link Transmuxer#transmux}
   * @param {object} [fixerConfig]
   * @param {boolean} [lazyRemux] keep the remuxer but only run it on demand, so
   *   `transmux()` hands back raw tracks and the caller can still pick software
   *   decoding after the demuxer has run.
   */
  constructor(hls, isMP4, needRemux, fixerConfig, lazyRemux = false) {
    this.hls = hls
    this._demuxer = isMP4
      ? new FMP4Demuxer()
      : new TsDemuxer(null, null, null, fixerConfig)
    this._isMP4 = isMP4
    this._lazyRemux = !needRemux && !!lazyRemux
    if (needRemux || this._lazyRemux)
      this._remuxer = new FMP4Remuxer(this._demuxer.videoTrack, this._demuxer.audioTrack)
  }

  transmux(videoChunk, audioChunk, discontinuity, contiguous, startTime, needInit) {
    const demuxer = this._demuxer
    try {
      if (this._isMP4) {
        demuxer.demux(videoChunk, audioChunk)
      } else {
        demuxer.demuxAndFix(
          concatUint8Array(videoChunk, audioChunk),
          discontinuity,
          contiguous,
          startTime
        )
      }
    } catch (error) {
      throw new StreamingError(ERR.DEMUX, ERR.SUB_TYPES.HLS, error)
    }

    const { videoTrack, audioTrack, metadataTrack } = demuxer
    const newId = `${videoTrack.codec}/${videoTrack.width}/${videoTrack.height}/${audioTrack.codec}/${audioTrack.config}`
    if (newId !== this._initSegmentId) {
      this._initSegmentId = newId
      needInit = true
    }

    this._fireEvents(videoTrack, audioTrack, metadataTrack, discontinuity || needInit)

    this.hls.emit(Event.DEMUXED_TRACK, { videoTrack, audioTrack })

    // Remember the codec-change aware `needInit` so a lazy remux (see below)
    // can reuse it without re-deriving the init-segment boundary.
    this._needInit = needInit

    if (this._remuxer && !this._lazyRemux) return this.remux(needInit)

    // Raw mode: hand back the demuxer tracks untouched so the caller can pick
    // software decoding, or remux on demand for the hard path.
    return [videoTrack, audioTrack]
  }

  /**
   * Remux the current demuxer tracks into fMP4 elementary chunks.
   *
   * Only used by soft-capable buffer services that demux first and decide per
   * append whether the picture is decoded by MSE or by the wasm sink. The
   * hard path calls this lazily so raw-mode transmuxers can still feed MSE.
   * @param {boolean} [needInit]
   * @returns {[object|undefined, object|undefined]}
   */
  remux(needInit = this._needInit) {
    const remuxer = this._remuxer
    if (!remuxer) return [undefined, undefined]
    const { videoTrack, audioTrack } = this._demuxer
    const vParsed = {
      codec: videoTrack.codec,
      timescale: videoTrack.timescale,
      firstDts: videoTrack.firstDts / videoTrack.timescale,
      firstPts: videoTrack.firstPts / videoTrack.timescale,
      duration: videoTrack.samplesDuration / videoTrack.timescale
    }
    const aParsed = {
      codec: audioTrack.codec,
      timescale: audioTrack.timescale,
      firstDts: audioTrack.firstDts / videoTrack.timescale,
      firstPts: audioTrack.firstPts / videoTrack.timescale,
      duration: audioTrack.samplesDuration / videoTrack.timescale,
      container: audioTrack.container
    }

    // LG webos5.4系统上发现, 直播流开启low latency mode渲染的话，出首帧后需要等一段时间才触发loadeddata、canplay事件,影响首帧统计
    // low latency mode通过解析封装的fmp4中对媒体播放时长的描述判断 https://issues.chromium.org/issues/41161663
    if (needInit && this.hls.isLive && !this.hls.config.mseLowLatency) {
      videoTrack.duration = this.hls.totalDuration * videoTrack.timescale
      audioTrack.duration = this.hls.totalDuration * audioTrack.timescale
    }

    try {
      const { videoInitSegment, videoSegment, audioInitSegment, audioSegment } =
        remuxer.remux(needInit)
      const v = concatUint8Array(videoInitSegment, videoSegment)
      const a = concatUint8Array(audioInitSegment, audioSegment)
      return [
        v ? { ...vParsed, data: v } : undefined,
        a ? { ...aParsed, data: a } : undefined
      ]
    } catch (error) {
      throw new StreamingError(ERR.REMUX, ERR.SUB_TYPES.FMP4, error)
    }
  }

  _fireEvents(videoTrack, audioTrack, metadataTrack, discontinuity) {
    const tracks = [videoTrack, audioTrack]
    let logCC = `discontinuity: ${discontinuity}`

    tracks.forEach((track) => {
      if (track.samples?.length) {
        logCC += `; ${track.samples.length} ${
          track.type === TrackType.VIDEO ? 'video' : 'audio'
        } samples, firstDts/firstPts/duration: ${(
          track.firstDts / track.timescale
        ).toFixed(3)}/${(track.firstPts / track.timescale).toFixed(3)}/${(
          track.samplesDuration / track.timescale
        ).toFixed(3)}`
      }

      if (discontinuity && track.exist()) {
        this.hls.emit(Event.METADATA_PARSED, {
          type: track.type,
          track,
          meta: {
            codec: track.codec,
            timescale: track.timescale,
            baseDts: track.baseDts,
            ...(track.type === TrackType.VIDEO
              ? { width: track.width, height: track.height, sarRatio: track.sarRatio }
              : {
                  codec: track.codec,
                  channelCount: track.channelCount,
                  sampleRate: track.sampleRate
                })
          }
        })
      }
    })
    logger.debug(logCC)

    videoTrack.warnings.forEach((warn) => {
      let type
      switch (warn.type) {
        case WarningType.LARGE_AV_SHIFT:
          type = Event.LARGE_AV_FIRST_FRAME_GAP_DETECT
          break
        case WarningType.LARGE_VIDEO_GAP:
          type = Event.LARGE_VIDEO_DTS_GAP_DETECT
          break
        case WarningType.LARGE_VIDEO_GAP_BETWEEN_CHUNK:
          type = Event.MAX_DTS_DELTA_WITH_NEXT_SEGMENT_DETECT
          break
        default:
      }

      if (type) this.hls.emit(Event.STREAM_EXCEPTION, { ...warn, type })
      logger.warn('video exception', warn)
    })

    audioTrack.warnings.forEach((warn) => {
      let type
      switch (warn.type) {
        case WarningType.LARGE_AUDIO_GAP:
          type = Event.LARGE_AUDIO_DTS_GAP_DETECT
          break
        case WarningType.AUDIO_FILLED:
          type = Event.AUDIO_GAP_DETECT
          break
        case WarningType.AUDIO_DROPPED:
          type = Event.AUDIO_OVERLAP_DETECT
          break
        default:
      }

      if (type) this.hls.emit(Event.STREAM_EXCEPTION, { ...warn, type })
      logger.warn('audio exception', warn)
    })

    videoTrack.samples.forEach((sample) => {
      if (sample.keyframe) {
        this.hls.emit(Event.KEYFRAME, { pts: sample.pts })
      }
    })

    metadataTrack.seiSamples.forEach((sei) => {
      this.hls.emit(Event.SEI, {
        ...sei,
        originPts: sei.originPts / 90, // sei 统一时间单位为毫秒
        sei: {
          code: sei.data.type,
          content: sei.data.payload,
          dts: sei.pts
        }
      })
    })
  }
}
