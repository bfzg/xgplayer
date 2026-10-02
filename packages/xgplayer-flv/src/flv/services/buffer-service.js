import {
  Buffer,
  concatUint8Array,
  ERR,
  EVENT,
  isHevcTrack,
  Logger,
  MSE,
  MseSink,
  SinkKind,
  SinkManager,
  SinkSwitchReason,
  StreamingError,
  supportsHevcMse
} from 'xgplayer-streaming-shared'
import { FlvDemuxer, FMP4Remuxer, WarningType } from 'xgplayer-transmuxer'
import { TRANSFER_EVENT } from './transfer-cost'

const logger = new Logger('BufferService')

export class BufferService {
  /** @type {import('../index').Flv | null} */
  flv = null

  _demuxer = new FlvDemuxer()
  _remuxer = null
  _rawMse = null
  _sinkManager = null
  _softVideo = null

  _sourceCreated = false

  _needInitSegment = true
  _discontinuity = true
  _contiguous = false

  _initSegmentId = ''

  _cachedBuffer = null

  _demuxStartTime = 0

  _opts = null

  get baseDts() {
    return this._demuxer?._fixer?._baseDts
  }

  get blobUrl() {
    if (this._sinkManager) return this._sinkManager.sink?.blobUrl
    return this._mse?.url
  }

  /** Active MSE instance, whether it is owned directly or by a sink. */
  get _mse() {
    return this._sinkManager ? this._sinkManager.mse : this._rawMse
  }

  /** Currently installed sink, only present when a soft sink factory was injected. */
  get sink() {
    return this._sinkManager?.sink || null
  }

  /** Whether pictures are produced by software decoding. */
  get isSoftDecoding() {
    return !!this._softVideo || (!!this._sinkManager && this._sinkManager.isSoft)
  }

  /**
   * @param {import('../index').Flv} flv
   * @param {Object} [softVideo]
   */
  constructor(flv, softVideo, opts = {}) {
    this.flv = flv
    this._opts = opts
    const createSoftSink =
      typeof opts.createSoftSink === 'function' ? opts.createSoftSink : null

    if (softVideo) {
      // soft decode
      this._softVideo = softVideo
    } else {
      this._remuxer = new FMP4Remuxer(this._demuxer.videoTrack, this._demuxer.audioTrack)
      if (createSoftSink) {
        this._sinkManager = new SinkManager({
          media: flv.media,
          createMseSink: () => new MseSink(flv.media, opts),
          createSoftSink: (context) =>
            createSoftSink({ ...context, options: opts.softDecodeOptions || {} }),
          onFallback: (info) => this._onFallback(info)
        })
        if (opts.softDecode !== true) this._sinkManager.ensureMse()
      } else {
        this._rawMse = new MSE(null, {
          preferMMS:
            typeof opts.preferMMS === 'boolean'
              ? opts.preferMMS
              : !!opts.perferMMS /* perferMMS is typo, deprecated */
        })
        this._rawMse.bindMedia(flv.media)
      }
    }
  }

  isFull(mediaType = MSE.VIDEO) {
    if (this._sinkManager) return !!this._sinkManager.sink?.isFull(mediaType)
    return this._mse.isFull(mediaType)
  }

  seamlessSwitch() {
    this._needInitSegment = true
    this._discontinuity = true
    this._contiguous = true
    this._initSegmentId = ''
  }

  unContiguous(startTime) {
    this._contiguous = false
    this._demuxStartTime = startTime
  }

  async reset(reuseMse = false) {
    if (this._sinkManager) {
      await this._sinkManager.sink?.reset(reuseMse)
    } else if (this._rawMse && !reuseMse) {
      await this._rawMse.unbindMedia()
      await this._rawMse.bindMedia(this.flv.media)
    }
    this._needInitSegment = true
    this._discontinuity = true
    this._contiguous = false
    this._sourceCreated = false
    this._initSegmentId = ''
    this.resetSeamlessSwitchStats()
  }

  resetSeamlessSwitchStats() {
    this.seamlessLoadingSwitch = null
    this.seamlessLoadingSwitching = false
    if (this._demuxer) {
      this._demuxer.seamlessLoadingSwitching = false
    }
  }

  async endOfStream() {
    if (this._softVideo) {
      await this._softVideo.endOfStream()
    } else if (this._sinkManager && this._sinkManager.isSoft) {
      await this._sinkManager.soft.endOfStream()
    } else if (this._mse) {
      if (this._sourceCreated) {
        await this._mse.endOfStream()
        this.flv.emit(EVENT.BUFFEREOS)
      }
    }
  }

  async updateDuration(duration) {
    if (this._sinkManager) {
      // Always go through the manager, whichever sink is live. It publishes on
      // the active sink and remembers the number, so a switch that happens
      // later still gets it. Reaching for `MSE` here instead worked for forced
      // soft decoding and quietly lost the duration for `auto`: the player
      // starts on MSE, the script tag carrying the duration is parsed while MSE
      // is still active, and the soft sink installed by the first HEVC append
      // had nothing to replay.
      await this._sinkManager.updateDuration(duration)
      return
    }
    const mse = this._mse
    if (!mse) return
    logger.debug('update duration', duration)
    await mse.updateDuration(duration)
  }

  async destroy() {
    if (this._sinkManager) {
      await this._sinkManager.destroy()
      this._sinkManager = null
    }
    if (this._rawMse) {
      await this._rawMse.unbindMedia()
      this._rawMse = null
    }

    this._softVideo = null
    this._demuxer = null
    this._remuxer = null
  }

  async appendBuffer(chunk) {
    let switchingNoReset = false
    if (this._cachedBuffer) {
      chunk = concatUint8Array(this._cachedBuffer, chunk)
      this._cachedBuffer = null
    }

    const demuxer = this._demuxer
    if (!chunk || !chunk.length || !demuxer) return

    try {
      this.flv._transferCost.start(TRANSFER_EVENT.DEMUX)
      demuxer.demuxAndFix(
        chunk,
        this.seamlessLoadingSwitching || this._discontinuity,
        this._contiguous,
        this._demuxStartTime,
        this.seamlessLoadingSwitching
      )
      this.seamlessLoadingSwitching = false
      this.flv._transferCost.end(TRANSFER_EVENT.DEMUX)
    } catch (error) {
      throw new StreamingError(ERR.DEMUX, ERR.SUB_TYPES.FLV, error)
    }
    const { videoTrack, audioTrack, metadataTrack } = demuxer

    if (this.seamlessLoadingSwitch) {
      const idx = videoTrack.samples.findIndex(
        (sample) => sample.originDts === videoTrack.lastKeyFrameDts
      )
      if (idx >= 0) {
        videoTrack.samples.splice(idx)
        await this.seamlessLoadingSwitch()
        // 切换清晰度后，删除原清晰度数据
        this.seamlessLoadingSwitch = null
        chunk = null
        switchingNoReset = true
      }
    }
    // else if (this._opts.onlyLastGop && !this._initSegmentId) {
    //   // 首次添加数据，只保留最后一个gop数据
    //   const idx = videoTrack.samples.findIndex(sample => (sample.originDts === videoTrack.lastKeyFrameDts))
    //   if (idx >= 0) {
    //     videoTrack.samples.splice(idx)
    //   }
    //   audioTrack.samples = audioTrack.samples.filter(sample => (sample.originPts >= videoTrack.lastKeyFrameDts))
    // }

    let videoExist = videoTrack.exist()
    let audioExist = audioTrack.exist()

    if (this._opts.onlyAudio) {
      videoExist = false
      videoTrack.present = false
    }

    if (this._opts.onlyVideo) {
      audioExist = false
      audioTrack.present = false
    }

    if ((!videoExist && videoTrack.present) || (!audioExist && audioTrack.present)) {
      let duration = 0
      const track = videoExist ? videoTrack : audioExist ? audioTrack : undefined
      if (track && track.samples.length) {
        duration =
          ((track.samples[track.samples.length - 1].originPts -
            track.samples[0].originPts) /
            track.timescale) *
          1000
      }
      if (duration > this._opts.analyzeDuration) {
        logger.warn(`analyze duration exceeded, ${duration}ms`, track)
        videoTrack.present = videoExist
        audioTrack.present = audioExist
        this.flv.emit(EVENT.ANALYZE_DURATION_EXCEEDED, { duration })
      } else {
        this._cachedBuffer = chunk
        return
      }
    }

    const videoType = videoTrack.type
    const audioType = audioTrack.type
    this._fireEvents(videoTrack, audioTrack, metadataTrack)
    if (!switchingNoReset) {
      this._discontinuity = false
      this._contiguous = true
      this._demuxStartTime = 0
    }

    const mse = this._mse
    const afterAppend = () => {
      if (this.flv?.emit) {
        this.flv?.emit(EVENT.APPEND_BUFFER, {})
      }
    }

    // emit demuxed track
    this.flv.emit(EVENT.DEMUXED_TRACK, { videoTrack })

    const newId = `${videoTrack.codec}/${videoTrack.width}/${videoTrack.height}/${audioTrack.codec}/${audioTrack.config}`
    if (newId !== this._initSegmentId) {
      this._needInitSegment = true
      this._initSegmentId = newId
      this._emitMetaParsedEvent(videoTrack, audioTrack)
    }

    // A soft sink may be requested up-front (`softDecode: true`) or selected
    // because the platform cannot decode this stream (`softDecode: 'auto'`).
    const softSink = await this._selectSoftSink(videoTrack, videoExist)
    if (softSink) {
      await softSink.append(videoTrack, audioTrack)
      afterAppend()
      return
    }

    if (this._softVideo) {
      this._softVideo.appendBuffer(videoTrack, audioTrack)
      afterAppend()
      return
    }

    if (mse) {
      if (!this._sourceCreated) {
        try {
          await mse.open()
          if (videoExist) {
            logger.log(`codec: video/mp4;codecs=${videoTrack.codec}`)
            mse.createSource(videoType, `video/mp4;codecs=${videoTrack.codec}`)
          }
          if (audioExist) {
            logger.log(`codec: audio/mp4;codecs=${audioTrack.codec}`)
            mse.createSource(audioType, `audio/mp4;codecs=${audioTrack.codec}`)
          }
          this._sourceCreated = true
          this.flv.emit(EVENT.SOURCEBUFFER_CREATED)
        } catch (error) {
          // The codec was rejected while creating the SourceBuffer. The tracks
          // have not been drained yet, so the same chunk can go straight to the
          // soft sink without dropping data.
          const fallback = await this._fallbackFromError(error, videoTrack)
          if (fallback) {
            await fallback.append(videoTrack, audioTrack)
            afterAppend()
            return
          }
          throw error
        }
      }

      let remuxResult
      try {
        // LG webos5.4系统上发现, 直播流开启low latency mode渲染的话，出首帧后需要等一段时间才触发loadeddata、canplay事件,影响首帧统计
        // low latency mode通过解析封装的fmp4中对媒体播放时长的描述判断 https://issues.chromium.org/issues/41161663
        if (this._needInitSegment && !this._opts.mseLowLatency) {
          videoTrack.duration =
            this._opts.durationForMSELowLatencyOff * videoTrack.timescale
          audioTrack.duration =
            this._opts.durationForMSELowLatencyOff * audioTrack.timescale
        }
        this.flv._transferCost.start(TRANSFER_EVENT.REMUX)
        remuxResult = this._remuxer.remux(this._needInitSegment)
        this.flv._transferCost.end(TRANSFER_EVENT.REMUX)
      } catch (error) {
        throw new StreamingError(ERR.REMUX, ERR.SUB_TYPES.FMP4, error)
      }

      if (
        this._needInitSegment &&
        !remuxResult.videoInitSegment &&
        !remuxResult.audioInitSegment
      ) {
        return
      }

      this._needInitSegment = false

      const p = []
      if (remuxResult.videoInitSegment)
        p.push(mse.append(videoType, remuxResult.videoInitSegment))
      if (remuxResult.audioInitSegment)
        p.push(mse.append(audioType, remuxResult.audioInitSegment))
      if (remuxResult.videoSegment)
        p.push(mse.append(videoType, remuxResult.videoSegment))
      if (remuxResult.audioSegment)
        p.push(mse.append(audioType, remuxResult.audioSegment))

      this.flv._transferCost.start(TRANSFER_EVENT.APPEND)

      const ret = Promise.all(p)
      ret.then(afterAppend).then(() => {
        this.flv._transferCost.end(TRANSFER_EVENT.APPEND)
        afterAppend()
      })
      ret.catch((error) => {
        // Segments were already drained, so only the following chunks can be
        // rescued; still record the failure so the switch happens once.
        this._fallbackFromError(error, videoTrack).catch(() => {})
      })
      return ret
    }
  }

  async evictBuffer(bufferBehind) {
    const media = this.flv.media
    if (!this._mse || !this._demuxer || !media || !bufferBehind || bufferBehind < 0)
      return
    const currentTime = media.currentTime
    const removeEnd = currentTime - bufferBehind
    if (removeEnd <= 0) return
    const start = Buffer.start(Buffer.get(media))
    if (start + 1 >= removeEnd) return
    return this._mse
      .clearBuffer(0, removeEnd)
      .then(() => this.flv.emit(EVENT.REMOVE_BUFFER, { removeEnd }))
  }

  /**
   * Choose the soft sink for the current chunk when software decoding is either
   * requested up-front (`softDecode: true`) or required because the platform
   * cannot decode HEVC (`softDecode: 'auto'`).
   * @private
   * @returns {Promise<import('xgplayer-streaming-shared').MediaSink | null>}
   */
  async _selectSoftSink(videoTrack, videoExist) {
    if (!this._sinkManager) return null
    if (this._opts.softDecode === true) {
      await this._sinkManager.switchToSoft(SinkSwitchReason.FORCED, {
        codec: videoTrack?.codec,
        width: videoTrack?.width,
        height: videoTrack?.height
      })
    } else if (
      this._opts.softDecode === 'auto' &&
      videoExist &&
      !this._sinkManager.isSoft
    ) {
      const codec = videoTrack?.codec
      if (isHevcTrack(videoTrack) && !supportsHevcMse(codec)) {
        await this._sinkManager.switchToSoft(SinkSwitchReason.UNSUPPORTED, {
          codec,
          width: videoTrack.width,
          height: videoTrack.height
        })
      }
    }
    return this._sinkManager.soft
  }

  /**
   * Switch to software decoding after a runtime decode/append failure.
   * @private
   */
  async _fallbackFromError(error, videoTrack) {
    if (!this._sinkManager || this._sinkManager.isSoft) return null
    return this._sinkManager.handleError(error, {
      codec: videoTrack?.codec,
      width: videoTrack?.width,
      height: videoTrack?.height
    })
  }

  /**
   * Force software decoding from an external signal (`lowdecode` etc).
   * @param {string} [reason]
   * @param {object} [info]
   * @returns {Promise<import('xgplayer-streaming-shared').MediaSink | null>}
   */
  fallbackToSoft(reason = SinkSwitchReason.LOWDECODE, info = {}) {
    if (!this._sinkManager || this._sinkManager.isSoft) return Promise.resolve(null)
    return this._sinkManager.switchToSoft(reason, info)
  }

  _onFallback(info) {
    if (typeof this.flv?.emit === 'function') {
      this.flv.emit(EVENT.SOFT_DECODE_FALLBACK, info)
    }
  }

  _emitMetaParsedEvent(videoTrack, audioTrack) {
    if (videoTrack.exist()) {
      this.flv.emit(EVENT.METADATA_PARSED, {
        type: 'video',
        track: videoTrack,
        meta: {
          codec: videoTrack.codec,
          timescale: videoTrack.timescale,
          width: videoTrack.width,
          height: videoTrack.height,
          sarRatio: videoTrack.sarRatio,
          baseDts: videoTrack.baseDts
        }
      })
    }
    if (audioTrack.exist()) {
      this.flv.emit(EVENT.METADATA_PARSED, {
        type: 'audio',
        track: audioTrack,
        meta: {
          codec: audioTrack.codec,
          channelCount: audioTrack.channelCount,
          sampleRate: audioTrack.sampleRate,
          timescale: audioTrack.timescale,
          baseDts: audioTrack.baseDts
        }
      })
    }

    logger.debug('track parsed', videoTrack, audioTrack)
  }

  _fireEvents(videoTrack, audioTrack, metadataTrack) {
    logger.debug(
      `videoTrack samples count: ${videoTrack.samples.length}, audioTrack samples count: ${audioTrack.samples.length}`
    )

    metadataTrack.flvScriptSamples.forEach((sample) => {
      this.flv.emit(EVENT.FLV_SCRIPT_DATA, sample)
      logger.debug('flvScriptData', sample)
    })

    videoTrack.samples.forEach((sample) => {
      if (sample.keyframe) {
        this.flv.emit(EVENT.KEYFRAME, { pts: sample.originPts })
      }
    })

    videoTrack.warnings.forEach((warn) => {
      let type
      switch (warn.type) {
        case WarningType.LARGE_AV_SHIFT:
          type = EVENT.LARGE_AV_FIRST_FRAME_GAP_DETECT
          break
        case WarningType.LARGE_VIDEO_GAP:
          type = EVENT.LARGE_VIDEO_DTS_GAP_DETECT
          break
        case WarningType.LARGE_VIDEO_GAP_BETWEEN_CHUNK:
          type = EVENT.MAX_DTS_DELTA_WITH_NEXT_SEGMENT_DETECT
          break
        default:
      }

      if (type) this.flv.emit(EVENT.STREAM_EXCEPTION, { ...warn, type })
      logger.warn('video exception', warn)
    })
    audioTrack.warnings.forEach((warn) => {
      let type
      switch (warn.type) {
        case WarningType.LARGE_AUDIO_GAP:
          type = EVENT.LARGE_AUDIO_DTS_GAP_DETECT
          break
        case WarningType.AUDIO_FILLED:
          type = EVENT.AUDIO_GAP_DETECT
          break
        case WarningType.AUDIO_DROPPED:
          type = EVENT.AUDIO_OVERLAP_DETECT
          break
        default:
      }

      if (type) this.flv.emit(EVENT.STREAM_EXCEPTION, { ...warn, type })
      logger.warn('audio exception', warn)
    })

    metadataTrack.seiSamples.forEach((sei) => {
      this.flv.emit(EVENT.SEI, {
        ...sei,
        sei: {
          code: sei.data.type,
          content: sei.data.payload,
          dts: sei.pts
        }
      })
    })
  }
}
