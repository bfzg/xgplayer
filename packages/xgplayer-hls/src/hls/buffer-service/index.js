import {
  Buffer,
  ERR,
  EVENT,
  isHevcTrack,
  Logger,
  MSE,
  MseSink,
  SinkManager,
  SinkSwitchReason,
  StreamingError,
  supportsHevcMse
} from 'xgplayer-streaming-shared'
import { MP4Parser, TsDemuxer } from 'xgplayer-transmuxer'
import { Event } from '../constants'
import { Decryptor } from './decrypt'
import { Transmuxer } from './transmuxer'

const logger = new Logger('BufferService')

// Parsing every moof of a long fragment to find the timeline start is wasted
// work; the leading fragments always declare all tracks.
const FMP4_MOOF_SCAN_LIMIT = 8

/**
 * Bind the per-player soft decode options to a sink factory without losing the
 * factory's own capabilities.
 *
 * `SinkManager` asks `canDecode` *before* it retires the MSE sink, and the
 * wrapping arrow used to drop that property, which quietly turned every codec
 * into a supported one.
 *
 * @param {(context: object) => any} factory
 * @param {object} [options] `softDecodeOptions`
 * @returns {(context: object) => any}
 */
function wrapSoftSinkFactory(factory, options) {
  const wrapper = (context) => factory({ ...context, options: options || {} })
  if (typeof factory.canDecode === 'function') {
    wrapper.canDecode = (info) => factory.canDecode(info)
  }
  return wrapper
}

export class BufferService {
  _decryptor = new Decryptor()
  /** @type {Transmuxer} */
  _transmuxer = null
  _rawMse = null
  _sinkManager = null
  _softVideo = null
  _sourceCreated = false
  _needInitSegment = true
  _directAppend = false
  /**
   * Codec the current stream carries, kept so the runtime soft-decode entry
   * points can be answered without a track in hand.
   * @type {{codec?: string, width?: number, height?: number}|null}
   */
  _softCodecHint = null
  /** Codec a forced soft switch was already declined for, to log it once. */
  _softDeclineCodec = ''
  /**
   * trackId to timescale, learned from the fMP4 init segment. Media fragments
   * carry no moov, so without this the base decode time cannot be turned into
   * seconds for the fragments after the first.
   * @type {Record<string|number, number>}
   */
  _fmp4TrackTimescale = {}

  constructor(hls) {
    this.hls = hls
    const cfg = hls.config
    const createSoftSink =
      typeof cfg.createSoftSink === 'function' ? cfg.createSoftSink : null

    if (cfg.softDecode) {
      // legacy external soft media element (`MVideo`) receives raw tracks
      this._softVideo = hls.media
    } else if (createSoftSink) {
      this._sinkManager = new SinkManager({
        media: hls.media,
        createMseSink: () => new MseSink(null, cfg),
        createSoftSink: wrapSoftSinkFactory(createSoftSink, cfg.softDecodeOptions),
        onFallback: (info) => this._onFallback(info)
      })
      // Built (and attached) up front even when software decoding is forced:
      // the switch can be declined for a codec without a software decoder, and
      // the MSE sink has to exist and be open by the time the first segment is
      // appended. `auto` already worked this way.
      const mse = this._sinkManager.ensureMse()
      if (cfg.url) {
        mse.bindMedia(hls.media).then((e) => this.hls.emit(EVENT.MEDIASOURCE_OPENED, e))
      }
    } else {
      this._rawMse = new MSE(null, {
        preferMMS: cfg.preferMMS,
        attachMode: cfg.mseAttachMode
      })

      if (cfg.url) {
        this._rawMse.bindMedia(hls.media).then((e) => {
          this.hls.emit(EVENT.MEDIASOURCE_OPENED, e)
        })
      }
    }

    // If a third-party decryption module is configured, use it
    if (cfg.decryptor) {
      this._decryptor.externalDecryptor = cfg.decryptor
    }
  }

  get baseDts() {
    return this._transmuxer?._demuxer?._fixer?._baseDts
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
    return !!this._softVideo || !!this._sinkManager?.isSoft
  }

  /**
   * Whether the transmuxer should hand back raw tracks (soft-capable) instead
   * of fMP4 chunks. The hard path remuxes those tracks lazily via
   * {@link Transmuxer#remux}, so soft and hard decoding can share one demuxer.
   */
  get _transmuxRaw() {
    return !!(this._softVideo || this._sinkManager)
  }

  get nbSb() {
    if (!this._mse?._sourceBuffer) return 0

    return Object.keys(this._mse._sourceBuffer).length
  }

  get msIsOpened() {
    return this._mse?.isOpened
  }

  get msHasOpTasks() {
    return this._mse?.hasOpTasks
  }

  get msStreaming() {
    return this._mse?.streaming
  }

  async updateDuration(duration) {
    logger.debug('update duration', duration)
    if (this._sinkManager) {
      // Always go through the manager, whichever sink is live. It publishes on
      // the active sink and remembers the number, so a switch that happens
      // later still gets it. Reaching for `MSE` here instead worked for forced
      // soft decoding and quietly lost the duration for `auto`: the player
      // starts on MSE, the playlist hands the real duration over while MSE is
      // still active, and the soft sink installed by the first HEVC append had
      // nothing to replay, leaving `duration` at `Infinity` and the progress bar
      // reading `00:00`.
      await this._sinkManager.updateDuration(duration)
      return
    }
    if (this._softVideo) {
      this._softVideo.duration = duration
      return
    }
    const mse = this._mse
    if (!mse) return
    await mse.updateDuration(duration)
  }

  createSource(videoChunk, audioChunk, videoCodec, audioCodec) {
    if (this._sourceCreated) return
    const chunk = videoChunk || audioChunk
    if (!chunk) return
    if (TsDemuxer.probe(chunk)) {
      if (!this._transmuxer)
        this._transmuxer = new Transmuxer(
          this.hls,
          false,
          !this._transmuxRaw,
          this.hls.config.fixerConfig,
          this._transmuxRaw
        )
    } else if (MP4Parser.probe(chunk)) {
      if (this._transmuxRaw) {
        if (!this._transmuxer)
          this._transmuxer = new Transmuxer(
            this.hls,
            true,
            false,
            this.hls.config.fixerConfig,
            true
          )
      } else {
        this._directAppend = true
        let mix = false
        if (videoChunk && !videoCodec) {
          MP4Parser.findBox(videoChunk, ['moov', 'trak']).forEach((t) => {
            const box = MP4Parser.findBox(t.data, [
              'trak',
              'mdia',
              'minf',
              'stbl',
              'stsd'
            ])[0]
            if (box) {
              const e = MP4Parser.stsd(box).entries[0]
              if (e) {
                if (e.hvcC) {
                  videoCodec = e.hvcC.codec
                } else if (e.avcC) {
                  videoCodec = e.avcC.codec
                } else if (e.type === 'hvc1' || e.type === 'hev1') {
                  // HEVC sample entry without a packed hvcC, the parameter sets
                  // live in the elementary stream. Keep the container honest
                  // instead of falling through to the H.264 default below.
                  videoCodec = `${e.type}.1.6.L93.B0`
                } else if (e.sampleRate || e.esds) {
                  audioCodec = e.esds?.codec || 'mp4a.40.2'
                  mix = true
                }
              }
            }
          })
        }
        if (audioChunk && !audioCodec) {
          MP4Parser.findBox(audioChunk, [
            'moov',
            'trak',
            'mdia',
            'minf',
            'stbl',
            'stsd'
          ]).forEach((stsd) => {
            const e = MP4Parser.stsd(stsd).entries[0]
            if (e && e.esds) audioCodec = e.esds.codec
          })
        }
        if (videoChunk && !videoCodec) videoCodec = 'avc1.42e01e'
        if (audioChunk && !audioCodec) audioCodec = 'mp4a.40.2'
        if (mix) {
          videoCodec += `, ${audioCodec}`
          audioCodec = ''
        }
        this._createMseSource(videoCodec, audioCodec)
      }
    } else {
      throw new StreamingError(ERR.OTHER, null, null, null, 'unsupported stream')
    }
    if (this._softVideo) this._sourceCreated = true
  }

  async appendBuffer(
    segment,
    audioSegment,
    videoChunk,
    audioChunk,
    discontinuity,
    contiguous,
    startTime
  ) {
    if (!videoChunk?.length && !audioChunk?.length) return

    const afterAppend = () => {
      if (this.hls?.emit) {
        this.hls?.emit(EVENT.APPEND_BUFFER, {
          start: segment.start,
          end: segment.end
        })
      }
    }

    if (this._directAppend) {
      const needInit = this._needInitSegment || discontinuity
      const p = []
      if (needInit) {
        const videoOffset = this._getFmp4TimeOffset(videoChunk, segment?.start)
        const audioOffset = this._getFmp4TimeOffset(
          audioChunk,
          audioSegment?.start ?? segment?.start
        )

        if (videoChunk && Number.isFinite(videoOffset)) {
          p.push(
            this._mse.setTimeoffset(MSE.VIDEO, videoOffset, {
              start: segment?.start,
              offset: videoOffset
            })
          )
        }
        if (audioChunk && Number.isFinite(audioOffset)) {
          p.push(
            this._mse.setTimeoffset(MSE.AUDIO, audioOffset, {
              start: audioSegment?.start ?? segment?.start,
              offset: audioOffset
            })
          )
        }
      }
      if (videoChunk) p.push(this._mse.append(MSE.VIDEO, videoChunk))
      if (audioChunk) p.push(this._mse.append(MSE.AUDIO, audioChunk))
      this._needInitSegment = false
      return Promise.all(p).then(afterAppend)
    }
    const needInit = this._needInitSegment || discontinuity
    const [first, second] = this._transmuxer.transmux(
      videoChunk,
      audioChunk,
      needInit,
      contiguous,
      startTime,
      this._needInitSegment || discontinuity
    )

    let video = first
    let audio = second
    let softSink = null
    const isRawTrack = (track) => track && typeof track.exist === 'function'
    const rawVideoTrack = isRawTrack(first) ? first : null

    if (this._transmuxRaw) {
      // Soft-capable: the transmuxer returned raw tracks, so choose the decoder
      // before the samples are consumed by a remux.
      softSink = await this._selectSoftSink(first)
      if (!softSink && !this._softVideo) {
        // The transmuxer keeps its own `needInit`, which also covers a codec
        // change detected while demuxing this segment.
        const remuxed = this._transmuxer.remux()
        video = remuxed[0]
        audio = remuxed[1]
      }
    }

    if (audioChunk && audioSegment) {
      audioSegment?.setTrackExist(false, true)
    }

    if (audioChunk && segment) {
      segment?.setTrackExist(true, false)
    }

    const videoExist = isRawTrack(video) ? video.exist() : !!video
    const audioExist = isRawTrack(audio) ? audio.exist() : !!audio

    if (!audioSegment) {
      segment?.setTrackExist(videoExist, audioExist)
    }

    if (videoExist && !audioExist) {
      this.hls.emit(Event.NO_AUDIO_TRACK)
    }

    if (softSink) {
      // The soft sink owns an audio-only MSE, so it needs the same rebasing
      // that `_directAppend` does with `setTimeoffset()` above.
      await softSink.append(video, audio, {
        start: audioSegment?.start ?? segment?.start
      })
      this._needInitSegment = false
      afterAppend()
      return
    }

    if (this._softVideo) {
      this._softVideo.appendBuffer(video, audio)
      this._needInitSegment = false

      afterAppend()
    } else if (this._mse) {
      const isFirstAppend = !this._sourceCreated
      if (isFirstAppend) {
        try {
          this._createMseSource(video?.codec, audio?.codec, audio?.container)
        } catch (error) {
          const fallback = await this._fallbackFromError(error, rawVideoTrack)
          if (fallback) {
            // The current chunk was already drained; resume on the next one.
            this._needInitSegment = false
            return
          }
          throw error
        }
      }
      this._needInitSegment = false
      const mse = this._mse
      const p = []

      if (needInit && !isFirstAppend) {
        // handle codec change during midstream
        this._handleCodecChange(video, audio).forEach((task) => p.push(task))
      }

      // The demuxer kept the source's absolute base decode time, so shift the
      // source buffers onto the playlist timeline before feeding them.
      if (needInit) {
        this._rebaseMseTimeline(mse, videoChunk, audioChunk, startTime).forEach(
          (task) => p.push(task)
        )
      }

      if (video) {
        const { data: videoData, ...videoRest } = video
        p.push(mse.append(MSE.VIDEO, videoData, videoRest))
      }
      if (audio) {
        const { data: audioData, ...audioRest } = audio
        p.push(mse.append(MSE.AUDIO, audioData, audioRest))
      }

      const ret = Promise.all(p)
      ret.then(afterAppend)
      ret.catch((error) => {
        this._fallbackFromError(error, rawVideoTrack).catch(() => {})
      })
      return ret
    }
  }

  /**
   * @param {*} chunk
   * @param {number} start
   * @private
   */
  _getFmp4TimeOffset(chunk, start = 0) {
    if (!chunk?.length) return null

    try {
      const moofBoxes = MP4Parser.findBox(chunk, ['moof'])
      if (!moofBoxes.length) return null

      const trackTimescale = { ...this._fmp4TrackTimescale }
      const moovBox = MP4Parser.findBox(chunk, ['moov'])[0]
      if (moovBox) {
        const moov = MP4Parser.moov(moovBox)
        moov?.trak?.forEach((trak) => {
          const trackId = trak?.tkhd?.trackId
          const timescale = trak?.mdia?.mdhd?.timescale
          if (trackId !== undefined && Number.isFinite(timescale) && timescale > 0) {
            trackTimescale[trackId] = timescale
          }
        })
        this._fmp4TrackTimescale = { ...trackTimescale }
      }

      // One fragment only carries the tracks that have samples in it, and a
      // GB28181 style recorder interleaves audio and video fragments, so the
      // first moof alone can sit after the real start of the timeline. Walk
      // the leading fragments until every declared track reported a base time.
      const wanted = Object.keys(trackTimescale)
      const seen = []
      const decodeTimes = []
      const scanLimit = Math.min(moofBoxes.length, FMP4_MOOF_SCAN_LIMIT)
      for (let i = 0; i < scanLimit; i++) {
        const moof = MP4Parser.moof(moofBoxes[i])
        if (!moof?.traf?.length) continue
        moof.traf.forEach((traf) => {
          const trackId = traf?.tfhd?.trackId
          const baseMediaDecodeTime = traf?.tfdt?.baseMediaDecodeTime
          const timescale = trackTimescale[trackId]
          if (
            Number.isFinite(baseMediaDecodeTime) &&
            Number.isFinite(timescale) &&
            timescale > 0
          ) {
            decodeTimes.push(baseMediaDecodeTime / timescale)
            if (!seen.includes(`${trackId}`)) seen.push(`${trackId}`)
          }
        })
        if (wanted.length && wanted.every((id) => seen.includes(id))) break
      }

      if (!decodeTimes.length) return null
      const firstDecodeTime = Math.min(...decodeTimes)
      const targetStart = Number.isFinite(start) ? start : 0
      const offset = targetStart - firstDecodeTime

      return Math.abs(offset) < 0.001 ? 0 : offset
    } catch (error) {
      logger.warn('calc fmp4 timestamp offset failed', error)
      return null
    }
  }

  /**
   * Rebasing helper for the demux/remux path.
   *
   * `FMP4Demuxer` keeps the encoder's absolute `baseMediaDecodeTime`, so a
   * recording whose timestamps start thousands of seconds in would fill the
   * source buffers there instead of at the playlist position. `_directAppend`
   * already shifts with `setTimeoffset()`; a soft-capable player does not use
   * direct append, so the same shift has to be applied here, from the raw
   * chunk before the demuxer consumed it.
   * @param {MSE} mse
   * @param {Uint8Array} videoChunk
   * @param {Uint8Array} audioChunk
   * @param {number} startTime
   * @returns {Promise[]}
   * @private
   */
  _rebaseMseTimeline(mse, videoChunk, audioChunk, startTime) {
    if (!mse) return []
    const offset =
      this._getFmp4TimeOffset(videoChunk, startTime) ??
      this._getFmp4TimeOffset(audioChunk, startTime)
    if (offset === null || offset === undefined) return []

    const tasks = []
    const types = [MSE.VIDEO, MSE.AUDIO]
    types.forEach((type) => {
      if (!mse.getSourceBuffer(type)) return
      tasks.push(mse.setTimeoffset(type, offset, { start: startTime, offset }))
    })
    if (tasks.length) logger.debug('rebase source buffer timeline', offset)
    return tasks
  }

  /**
   * Choose the soft sink for the current chunk when software decoding is
   * either requested up-front (`softDecodeMode: true`) or required because the
   * platform cannot decode HEVC (`softDecodeMode: 'auto'`).
   *
   * A forced switch still has to be one the sink can honour: `switchToSoft`
   * asks the factory what it can decode and declines (leaving the MSE sink
   * alone) when the answer is no. That is what keeps `softDecode: true` on an
   * H.264 stream on the platform decoder instead of an audio-only element with
   * an unpaintable canvas.
   *
   * @private
   * @returns {Promise<import('xgplayer-streaming-shared').MediaSink | null>}
   */
  async _selectSoftSink(videoTrack) {
    if (!this._sinkManager) return null
    const mode = this.hls?.config?.softDecodeMode
    const info = {
      codec: videoTrack?.codec,
      width: videoTrack?.width,
      height: videoTrack?.height
    }
    // Remembered so the runtime entry points (`player.forceSoftDecode()`) can be
    // answered without a track in hand.
    if (info.codec) this._softCodecHint = info
    if (mode === true) {
      if (this._sinkManager.canSoftDecodeTrack(info)) {
        await this._sinkManager.switchToSoft(SinkSwitchReason.FORCED, info)
      } else {
        this._warnSoftDecodeUnavailable(info)
      }
    } else if (mode === 'auto' && !this._sinkManager.isSoft) {
      if (isHevcTrack(videoTrack) && !supportsHevcMse(videoTrack?.codec)) {
        await this._sinkManager.switchToSoft(SinkSwitchReason.UNSUPPORTED, info)
      }
    }
    return this._sinkManager.soft
  }

  /**
   * Whether the configured soft sink could decode the given codec, or the codec
   * of the stream that is playing when nothing is passed.
   * @param {string|{codec?: string}|null} [value]
   * @returns {boolean}
   */
  canSoftDecode(value) {
    if (!this._sinkManager) return false
    const info =
      typeof value === 'string' ? { codec: value } : value || this._softCodecHint
    return this._sinkManager.canSoftDecodeTrack(info || {})
  }

  /**
   * Say once why a requested soft switch is not happening, instead of on every
   * appended segment.
   * @private
   */
  _warnSoftDecodeUnavailable(info) {
    const codec = info?.codec || 'unknown codec'
    if (this._softDeclineCodec === codec) return
    this._softDeclineCodec = codec
    const active = this._sinkManager?.isSoft ? 'soft' : 'mse'
    logger.warn(
      `softDecode is forced but ${codec} has no software decoder, ` +
        (active === 'soft'
          ? 'the soft sink cannot be undone without a reload'
          : 'keeping native decode')
    )
    if (typeof this.hls?.emit === 'function') {
      this.hls.emit(EVENT.SOFT_DECODE_FALLBACK, {
        reason: SinkSwitchReason.FORCED,
        from: active,
        to: active,
        declined: true,
        codec: info?.codec,
        message: `${codec} has no software decoder`
      })
    }
  }

  /**
   * Switch to software decoding after a runtime decode/append failure.
   * @private
   */
  async _fallbackFromError(error, videoChunk) {
    if (!this._sinkManager || this._sinkManager.isSoft) return null
    return this._sinkManager.handleError(error, {
      codec: videoChunk?.codec || this._softCodecHint?.codec,
      message: error?.message || error?.name || String(error || '')
    })
  }

  /**
   * Force software decoding from an external signal (`lowdecode` etc).
   *
   * Resolves to `null` when the sink has no decoder for the stream that is
   * playing, so a caller can tell a decline from a switch.
   *
   * @param {string} [reason]
   * @param {object} [info]
   * @returns {Promise<import('xgplayer-streaming-shared').MediaSink | null>}
   */
  fallbackToSoft(reason = SinkSwitchReason.LOWDECODE, info = {}) {
    if (!this._sinkManager || this._sinkManager.isSoft) {
      return Promise.resolve(null)
    }
    const withCodec = { ...(this._softCodecHint || {}), ...info }
    if (!this._sinkManager.canSoftDecodeTrack(withCodec)) {
      this._warnSoftDecodeUnavailable(withCodec)
      return Promise.resolve(null)
    }
    return this._sinkManager.switchToSoft(reason, withCodec)
  }

  _onFallback(info) {
    if (typeof this.hls?.emit === 'function') {
      this.hls.emit(EVENT.SOFT_DECODE_FALLBACK, info)
    }
  }

  /**
   * Whatever currently owns the buffered media: the installed sink, or the raw
   * MSE when no sink was injected. Eviction has to go through it, because a
   * soft sink's only MediaSource is the audio-only one it owns and
   * `_mse` is deliberately null there. Reading `_mse` directly made every
   * eviction a silent no-op while software decoding, so the audio buffer grew
   * without bound and the playlist, which reads `media.buffered` to decide
   * whether a seek target is already available, believed the whole programme
   * was buffered and skipped loading the segment being seeked to.
   */
  get _bufferOwner() {
    return this._sinkManager ? this._sinkManager.sink : this._rawMse
  }

  async removeBuffer(start = 0, end = Infinity) {
    const media = this.hls.media
    const owner = this._bufferOwner
    // `owner.duration` is `-1` while a sink has not been told the duration yet,
    // which keeps this a no-op exactly as it was before.
    if (!owner || !media || start < 0 || end < start || start >= owner.duration) return

    return this._evict(owner, start, end).then(() =>
      this.hls.emit(EVENT.REMOVE_BUFFER, { start, end, removeEnd: end })
    )
  }

  /** `MediaSink` exposes `evict`, a bare `MSE` only `clearBuffer`. */
  _evict(owner, start, end) {
    return typeof owner.evict === 'function'
      ? owner.evict(start, end)
      : owner.clearBuffer(start, end)
  }

  async evictBuffer(bufferBehind) {
    const media = this.hls.media
    if (!this._bufferOwner || !media || !bufferBehind || bufferBehind < 0) return
    const currentTime = media.currentTime
    const removeEnd = currentTime - bufferBehind
    if (removeEnd <= 0) return
    const start = Buffer.start(Buffer.get(media))
    if (start + 1 >= removeEnd) return
    return this.removeBuffer(0, removeEnd)
  }

  async clearAllBuffer() {
    if (this._mse) return this._mse.clearAllBuffer()
  }

  decryptBuffer(video, audio) {
    return this._decryptor.decrypt(video, audio)
  }

  async reset(reuseMse = false) {
    if (this._sinkManager) {
      await this._sinkManager.sink?.reset(reuseMse)
      this._transmuxer = null
      this._sourceCreated = false
    } else if (this._rawMse && !reuseMse) {
      this._transmuxer = null
      this._sourceCreated = false
      await this._rawMse.unbindMedia()
      await this._rawMse.bindMedia(this.hls.media)
    }
    this._needInitSegment = true
    this._directAppend = false
    this._fmp4TrackTimescale = {}
    this._softCodecHint = null
    this._softDeclineCodec = ''
  }

  async endOfStream() {
    if (this._sinkManager && this._sinkManager.isSoft) {
      await this._sinkManager.soft.endOfStream()
    } else if (this._softVideo) {
      this._softVideo.endOfStream()
    }
    if (this._mse) {
      if (this._sourceCreated) {
        await this._mse.endOfStream()
        this.hls.emit(EVENT.BUFFEREOS)
      }
    }
  }

  async setLiveSeekableRange(start, end) {
    // The sink owns the only MediaSource once soft decoding is active.
    if (this._sinkManager) this._sinkManager.setLiveSeekableRange(start, end)
    else if (this._mse) this._mse.setLiveSeekableRange(start, end)
  }

  async detachMedia() {
    if (this._mse) {
      await this._mse.unbindMedia()
    }
  }

  async destroy() {
    this._decryptor?.destroy()
    if (this._sinkManager) {
      await this._sinkManager.destroy()
      this._sinkManager = null
    } else {
      await this.detachMedia()
    }

    this._decryptor = null
    this._rawMse = null
    this._softVideo = null
  }

  /**
   * @private
   */
  _createMseSource(videoCodec, audioCodec, container) {
    logger.debug(`create mse source, videoCodec=${videoCodec}, audioCodec=${audioCodec}`)
    const mse = this._mse
    if (!mse) return
    if (videoCodec) {
      mse.createSource(MSE.VIDEO, `video/mp4;codecs=${videoCodec}`)
      this._sourceCreated = true
    }
    if (audioCodec) {
      mse.createSource(MSE.AUDIO, `audio/mp4;codecs=${audioCodec}`)
      this._sourceCreated = true
    } else if (container) {
      mse.createSource(MSE.AUDIO, `${container};codecs=""`)
      this._sourceCreated = true
    }
    this.hls.emit(EVENT.SOURCEBUFFER_CREATED)
  }

  /**
   * This makes it possible to change codecs or container type mid-stream.
   * @private
   */
  _handleCodecChange(video, audio) {
    const tasks = []
    const mse = this._mse
    const codecList = [
      {
        type: MSE.VIDEO,
        codecs: video?.codec
      },
      {
        type: MSE.AUDIO,
        codecs: audio?.codec
      }
    ]

    codecList
      .filter((item) => !!item.codecs)
      .forEach(({ type, codecs }) => {
        const sourceBuffer = mse.getSourceBuffer(type)
        if (sourceBuffer) {
          const codec = codecs.split(',')[0]
          if (!new RegExp(codec, 'ig').test(sourceBuffer.mimeType)) {
            tasks.push(mse.changeType(type, `${type}/mp4;codecs=${codecs}`))
          }
        }
      })
    return tasks
  }

  seamlessSwitch() {
    this._needInitSegment = true
  }

  isFull(mediaType = MSE.VIDEO) {
    if (this._sinkManager) return !!this._sinkManager.sink?.isFull(mediaType)
    return this._mse?.isFull(mediaType)
  }
}
