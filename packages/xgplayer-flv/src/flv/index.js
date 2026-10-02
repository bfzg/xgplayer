import EventEmitter from 'eventemitter3'
import {
  BandwidthService,
  Buffer,
  EVENT,
  GapService,
  getVideoPlaybackQuality,
  isMediaPlaying,
  Logger,
  MediaStatsService,
  MSE,
  NetLoader,
  SeiService,
  StreamingError
} from 'xgplayer-streaming-shared'
import { Logger as TransmuxerLogger } from 'xgplayer-transmuxer'
import { getOption } from './options'
import { BufferService } from './services'
import { TRANSFER_EVENT, TransferCost } from './services/transfer-cost'
import { searchKeyframeIndex } from './utils'

export const logger = new Logger('flv')

const noop = () => {}

const MAX_HOLE = 0.1
const MAX_START_GAP = 0.3

/** Rate changes below this are ignored, keeps the catch-up controller quiet */
const RATE_EPS = 1e-4

/**
 * @typedef {import("../../../xgplayer-streaming-shared/es/services/stats").StatsInfo} Stats
 */
export class Flv extends EventEmitter {
  /** @type {HTMLMediaElement | null} */
  media = null

  _loading = false

  /** @type {import('./options').FlvOption} */
  _opts = null

  /** @type {BufferService} */
  _bufferService = null

  /** @type {GapService} */
  _gapService = null

  /** @type {MediaStatsService} */
  _stats = null

  /** @type {NetLoader} */
  _mediaLoader = null

  _maxChunkWaitTimer = null

  _tickTimer = null
  _tickInterval = 500

  _urlSwitching = false
  _seamlessSwitching = false
  _disconnectRetryCount = 0
  _preLoadEndPoint = 0

  /** Rate the app asked for, kept apart from the live catch-up multiplier */
  _userPlaybackRate = 1

  /** Last rate written by this class; lets us tell our own writes from the app's */
  _appliedCatchUpRate = null

  _keyframes = null
  _acceptRanges = true

  /**
   * Serializes `_onProgress` handling. The streaming loader invokes the
   * callback without awaiting it, so two in-flight chunks would otherwise
   * demux into the same (reused) track objects concurrently and lose data.
   */
  _progressChain = Promise.resolve()
  _progressToken = 0

  /**
   * @param {import('./options').FlvOption} opts
   */
  constructor(opts) {
    super()
    this._opts = getOption(opts)
    this.media = this._opts.media || document.createElement('video')
    this._opts.media = null
    this._userPlaybackRate = this.media.playbackRate || 1
    this._firstProgressEmit = false
    this._mediaLoader = new NetLoader({
      ...this._opts.fetchOptions,
      retry: this._opts.retryCount,
      retryDelay: this._opts.retryDelay,
      timeout: this._opts.loadTimeout,
      onRetryError: this._onRetryError,
      onProgress: this._onProgress,
      responseType: 'arraybuffer'
    })

    this._disconnectRetryCount = this._opts.disconnectRetryCount
    this._transferCost = new TransferCost()

    // `softDecode` keeps its legacy meaning: an external soft-decoding media
    // element (`MVideo`) receives the demuxed tracks directly. The built-in
    // wasm soft sink is driven by `softDecodeMode` instead, so both can coexist.
    const softVideo = this._opts.softDecode ? this.media : undefined
    this._bufferService = new BufferService(this, softVideo, {
      ...this._opts,
      softDecode: this._opts.softDecodeMode || false
    })
    this._seiService = new SeiService(this)
    this._bandwidthService = new BandwidthService({
      chunkCountForSpeed: this._opts.chunkCountForSpeed,
      skipChunkSize: this._opts.skipChunkSize,
      longtimeNoReceived: this._opts.longtimeNoReceived
    })
    this._stats = new MediaStatsService(this)

    if (!this._opts.softDecode) {
      this._gapService = new GapService()
    }

    this.media.addEventListener('play', this._onPlay)
    this.media.addEventListener('loadeddata', this._onLoadeddata)
    this.media.addEventListener('seeking', this._onSeeking)
    this.media.addEventListener('timeupdate', this._onTimeupdate)
    this.media.addEventListener('progress', this._onBufferUpdate)
    this.media.addEventListener('waiting', this._onWaiting)
    this.media.addEventListener('ratechange', this._onRatechange)

    this.on(EVENT.FLV_SCRIPT_DATA, this._onFlvScriptData)
  }

  get version() {
    return __VERSION__
  }

  get isLive() {
    return this._opts.isLive
  }

  /**
   * Playback rate requested by the app, without the live catch-up multiplier.
   * @returns {number}
   */
  get userPlaybackRate() {
    return this._userPlaybackRate
  }

  /**
   * Live latency in seconds, end of the buffered range minus the playhead.
   * @returns {number}
   */
  get latency() {
    if (!this.media || !this.isLive) return 0
    return Math.max(0, Buffer.end(Buffer.get(this.media)) - this.media.currentTime)
  }

  get baseDts() {
    return this._bufferService?.baseDts
  }

  get seekable() {
    return !!this._keyframes && this._acceptRanges
  }

  get loader() {
    return this._mediaLoader
  }

  get blobUrl() {
    return this._bufferService?.blobUrl
  }

  /** Whether pictures are currently produced by software decoding. */
  get isSoftDecoding() {
    return !!this._bufferService?.isSoftDecoding
  }

  /**
   * Live software-decode counters, or null while the MSE sink is active.
   * @returns {{decoded: number, rendered: number, dropped: number, queue: number, variant?: string}|null}
   */
  get softDecodeStats() {
    if (!this._bufferService?.isSoftDecoding) return null
    return this._bufferService?.sink?.stats || null
  }

  /**
   * Switch to software decoding at runtime (`lowdecode`, manual degradation).
   * No-op when no soft sink factory was configured.
   * @param {string} [reason]
   * @param {object} [info]
   * @returns {Promise<any>}
   */
  fallbackToSoft(reason, info) {
    return this._bufferService?.fallbackToSoft(reason, info)
  }

  speedInfo() {
    return {
      speed: this._bandwidthService.getLatestSpeed(),
      avgSpeed: this._bandwidthService.getAvgSpeed(),
      totalSize: this._bandwidthService.getTotalSize(),
      totalCost: this._bandwidthService.getTotalCost()
    }
  }

  /**
   * @returns {Stats}
   */
  getStats() {
    return this._stats.getStats()
  }

  bufferInfo(maxHole = MAX_HOLE) {
    return Buffer.info(Buffer.get(this.media), this.media?.currentTime, maxHole)
  }

  playbackQuality() {
    return getVideoPlaybackQuality(this.media)
  }

  /**
   * load or reload source
   * @param {string} [url]
   * @return {Promise}
   */
  async load(url, reuseMse = false, streamRes) {
    if (!this._bufferService) return
    await this._reset(reuseMse)

    this._loadData(
      url,
      this._opts.isLive ? [] : [0, this._opts.defaultVodLoadSize],
      streamRes
    )

    clearTimeout(this._tickTimer)
    this._tickTimer = setTimeout(this._tick, this._tickInterval)
  }

  /** @return {Promise} */
  async replay(seamlesslyReload = this._opts.seamlesslyReload, isPlayEmit) {
    if (!this.media) return

    this._resetDisconnectCount()

    if (seamlesslyReload) {
      await this._clear()

      setTimeout(() => {
        this._seamlessSwitching = true
        this._loadData(this._opts.url)
        this._bufferService.seamlessSwitch()
      })
    } else {
      await this.load()
    }
    return this.media.play(!isPlayEmit).catch(() => {})
  }

  disconnect() {
    logger.debug('disconnect!')
    this._bufferService?.resetSeamlessSwitchStats()
    return this._clear()
  }

  /**
   * @param {string} url
   * @param {boolean} [seamless=false]
   */
  async switchURL(url, seamless) {
    if (!this._bufferService) return

    this._resetDisconnectCount()

    if (this._loading && seamless) {
      this._bufferService.seamlessLoadingSwitch = async (pts) => {
        await this._clear()
        this._bufferService.seamlessLoadingSwitching = true
        this._urlSwitching = true
        this._seamlessSwitching = true
        this._bufferService.seamlessSwitch()
        this._loadData(url)
      }
      return
    }

    if (!seamless || !this._opts.isLive) {
      await this.load(url)
      this._urlSwitching = true
      return this.media.play(true).catch(() => {})
    }

    await this._clear()

    setTimeout(() => {
      this._urlSwitching = true
      this._seamlessSwitching = true
      this._loadData(url)
      this._bufferService.seamlessSwitch()
    })
  }

  /** @return {Promise} */
  async destroy() {
    if (!this.media) return
    this.removeAllListeners()
    this._seiService.reset()
    this.media.removeEventListener('play', this._onPlay)
    this.media.removeEventListener('loadeddata', this._onLoadeddata)
    this.media.removeEventListener('seeking', this._onSeeking)
    this.media.removeEventListener('timeupdate', this._onTimeupdate)
    this.media.removeEventListener('waiting', this._onWaiting)
    this.media.removeEventListener('progress', this._onBufferUpdate)
    this.media.removeEventListener('ratechange', this._onRatechange)
    await Promise.all([this._clear(), this._bufferService.destroy()])
    this.media = null
    this._bufferService = null
  }

  /**
   * @param {('video'|'audio')?} mediaType
   * @returns {Boolean}
   */
  static isSupported(mediaType) {
    if (!mediaType || mediaType === 'video' || mediaType === 'audio') {
      return MSE.isSupported()
    }

    return typeof WebAssembly !== 'undefined'
  }

  static enableLogger() {
    Logger.enable()
    TransmuxerLogger.enable()
  }

  static disableLogger() {
    Logger.disable()
    TransmuxerLogger.disable()
  }

  _emitError(error, endOfStream = true) {
    logger.table(error)
    logger.error(error)
    logger.error(this.media?.error)
    if (this._urlSwitching) {
      this._urlSwitching = false
      this._seamlessSwitching = false
      this.emit(EVENT.SWITCH_URL_FAILED, error)
    }
    this.emit(EVENT.ERROR, error)
    if (endOfStream) {
      this._seiService.reset()
      this._end()
    }
  }

  async _reset(reuseMse = false) {
    this._seiService.reset()
    this._bandwidthService.reset()
    this._stats.reset()
    await this._clear()
    await this._bufferService.reset(reuseMse)
  }

  async _loadData(url, range, streamRes) {
    if (url) this._opts.url = url
    let finnalUrl = (url = this._opts.url)
    if (!url) throw new Error('Source url is missing')

    if (this._opts.preProcessUrl) {
      finnalUrl = this._opts.preProcessUrl(url).url
    }

    this._mediaLoader.finnalUrl = finnalUrl

    this.emit(EVENT.LOAD_START, {
      url: finnalUrl,
      seamlessSwitching: this._seamlessSwitching
    })

    logger.debug('load data, loading:', this._loading, finnalUrl)

    if (this._loading) {
      await this._mediaLoader.cancel()
    }

    this._loading = true
    try {
      await this._mediaLoader.load({
        url: finnalUrl,
        range,
        streamRes,
        firstMaxChunkSize: this._opts.firstMaxChunkSize
      })
    } catch (error) {
      this._loading = false
      return this._emitError(StreamingError.network(error), false)
    }
  }

  /**
   *
   * @param {ArrayBuffer} chunk
   * @param {boolean} done
   * @param { {startTime: number, endTime: number, st: number, firstByteTime: number}}
   * startTime: 当前流式分段开始read时间
   * endTime: 当前流式分段结束read时间
   * st: 拉流开始时间
   * firstByteTime: 首字节响应时间
   * @param {Response} response
   */
  _onProgress = (chunk, done, info, response) => {
    // The loader fires progress callbacks without awaiting them, so enqueue
    // the real handler to guarantee chunks are demuxed/appended in order.
    const token = this._progressToken
    const run = () => {
      if (token !== this._progressToken) return undefined
      return this._handleProgress(chunk, done, info, response)
    }
    const next = this._progressChain.then(run, run)
    this._progressChain = next.then(noop, noop)
    return next
  }

  async _handleProgress(
    chunk,
    done,
    { startTime, endTime, st, firstByteTime },
    response
  ) {
    this._loading = !done
    if (!this._firstProgressEmit) {
      if (!this.media) {
        this._mediaLoader?.cancel()
        return
      }
      const headers = response.headers
      const elapsed = st ? firstByteTime - st : endTime - startTime
      this.emit(EVENT.TTFB, {
        url: this._opts.url,
        responseUrl: response.url,
        elapsed
      })
      this.emit(EVENT.LOAD_RESPONSE_HEADERS, { headers })
      this._transferCost.set(TRANSFER_EVENT.TTFB, elapsed)
      this._acceptRanges =
        !!headers?.get('Accept-Ranges') || !!headers?.get('Content-Range')
      this._firstProgressEmit = true
    }

    if (!this._bufferService) return
    clearTimeout(this._maxChunkWaitTimer)

    this._bandwidthService.addChunkRecord(chunk?.byteLength, endTime - startTime)

    try {
      await this._bufferService.appendBuffer(chunk)
      this._bufferService?.evictBuffer(this._opts.bufferBehind)
    } catch (error) {
      if (!this.isLive && this._bufferService.isFull()) {
        await this._mediaLoader.cancel()
        this._loading = false
        // detect the large buffer size can appended
        const remaining = this.bufferInfo().remaining
        this._opts.preloadTime = parseInt(remaining) / 2
        return
      }
      return this._emitError(StreamingError.create(error))
    }

    if (this._urlSwitching) {
      this._urlSwitching = false
      this.emit(EVENT.SWITCH_URL_SUCCESS, { url: this._opts.url })
    }

    // ！！
    if (this._seamlessSwitching) {
      this._seamlessSwitching = false
      this._tick()
    }

    if (done && !this.media.seeking) {
      this.emit(EVENT.LOAD_COMPLETE)
      logger.debug('load done')

      if (this.isLive && this._disconnectRetryCount <= 0) {
        this._end()
      }
      return
    }

    if (!this.isLive) return

    const { maxReaderInterval } = this._opts
    if (maxReaderInterval && this._firstProgressEmit) {
      clearTimeout(this._maxChunkWaitTimer)
      this._maxChunkWaitTimer = setTimeout(() => {
        if (this._disconnectRetryCount) {
          this._disconnectRetryCount--
          this.load()
          return
        }
        logger.debug('onMaxChunkWait', maxReaderInterval)
        this._end()
      }, maxReaderInterval)
    }
  }

  _onRetryError = (error, retryTime) => {
    logger.debug('load retry', error, retryTime)

    this.emit(EVENT.LOAD_RETRY, {
      error: StreamingError.network(error),
      retryTime
    })
  }

  async _clear() {
    if (this._mediaLoader) await this._mediaLoader.cancel()
    clearTimeout(this._maxChunkWaitTimer)
    clearTimeout(this._tickTimer)
    this._loading = false
    this._firstProgressEmit = false
    // Drop queued progress work from the previous load.
    this._progressToken++
  }

  _end = () => {
    this._clear()
    if (this._bufferService) {
      this._bufferService.endOfStream()
    }

    logger.debug('end stream')
  }

  _resetDisconnectCount = () => {
    this._disconnectRetryCount = this._opts.disconnectRetryCount
  }

  _tick = () => {
    clearTimeout(this._tickTimer)
    const { media } = this
    if (!media) return
    this._tickTimer = setTimeout(this._tick, this._tickInterval)

    const bufferEnd = Buffer.end(Buffer.get(media))

    if (bufferEnd < MAX_HOLE || !media.readyState) return

    const opts = this._opts
    if (isMediaPlaying(media) && media.currentTime) {
      if (this._gapService) {
        this._gapService.do(media, opts.maxJumpDistance, this.isLive, 3)
      }
    } else {
      if (!media.currentTime && this._gapService && opts.enableStartGapJump) {
        // 起播跳洞检测
        const gapJump =
          this._opts.mseLowLatency ||
          (this._opts.mseLowLatency === false && this.bufferInfo(MAX_START_GAP).nextStart)
        if (gapJump) {
          this._gapService.do(media, opts.maxJumpDistance, this.isLive, 3)
        }
        return
      }
      if (
        opts.isLive &&
        media.readyState === 4 &&
        bufferEnd - media.currentTime > opts.disconnectTime
      ) {
        this.disconnect()
      }
    }
  }

  _onPlay = () => {
    const canReplay = this._opts.softDecode || this.media?.buffered?.length
    if (this.isLive) {
      if (!this._loading && canReplay) {
        this.replay(undefined, true)
      }
      return
    }

    const info = this.bufferInfo()
    if ((info.start || info.nextStart) > MAX_HOLE) {
      this._tick()
    }
  }

  _onLoadeddata = () => {
    if (this.isLive && !this._opts.mseLowLatency) {
      // update duration to Infinity
      if (this.media.duration !== Infinity) {
        this._bufferService.updateDuration(Infinity).catch((e) => {})
      }
    }
  }

  _onSeeking = async () => {
    if (!this.isLive && this.seekable) {
      this._preLoadEndPoint = -1
      this._checkPreload()
    }
  }

  _onTimeupdate = () => {
    if (!this.media) return

    const opts = this._opts
    const currentTime = this.media.currentTime

    if (opts.isLive && opts.targetLatency) {
      const bufferEnd = Buffer.end(Buffer.get(this.media))
      const latency = bufferEnd - currentTime
      if (latency > 0) {
        if (opts.maxLatency && latency >= opts.maxLatency) {
          this.media.currentTime = bufferEnd - opts.targetLatency
          this._applyLiveCatchUp(0)
          this.emit(EVENT.CHASEFRAME, {
            currentTime: this.media.currentTime,
            latency: opts.targetLatency
          })
        } else if (opts.liveCatchUp) {
          this._applyLiveCatchUp(latency)
        }
      }
    }
    this._seiService.throw(currentTime, true)

    if (opts.isLive || !this.seekable || this._loading) return

    this._checkPreload()
  }

  /**
   * The app owns the playback rate; the catch-up multiplier borrows it. Anything
   * written to the element that differs from our last write is treated as the
   * rate the app asked for.
   * @returns {number}
   */
  _syncUserPlaybackRate() {
    if (!this.media) return this._userPlaybackRate
    const rate = this.media.playbackRate
    if (!rate) return this._userPlaybackRate
    if (
      this._appliedCatchUpRate !== null &&
      Math.abs(rate - this._appliedCatchUpRate) < RATE_EPS
    ) {
      return this._userPlaybackRate
    }
    if (Math.abs(rate - this._userPlaybackRate) > RATE_EPS) {
      this._userPlaybackRate = rate
      this._appliedCatchUpRate = null
    }
    return this._userPlaybackRate
  }

  _onRatechange = () => {
    this._syncUserPlaybackRate()
  }

  /**
   * Smooth live catch-up. Rather than waiting for `maxLatency` and then jumping,
   * the playhead is pulled back to `targetLatency` by playing a little faster,
   * so accumulated stall latency drains without a visible skip.
   * @param {number} latency seconds behind the end of the buffered range
   */
  _applyLiveCatchUp(latency) {
    if (!this.media || this.media.seeking) return

    const opts = this._opts
    const userRate = this._syncUserPlaybackRate()
    const excess = latency - opts.targetLatency - opts.liveCatchUpBand
    const extra =
      excess > 0
        ? Math.min(
            Math.round((excess / opts.liveCatchUpTime) * 100) / 100,
            opts.liveCatchUpRate
          )
        : 0
    const rate = userRate * (1 + extra)

    if (Math.abs(rate - this.media.playbackRate) < RATE_EPS) return

    this._appliedCatchUpRate = rate
    this.media.playbackRate = rate
    logger.debug(
      `live catch-up, latency=${latency.toFixed(2)}s, rate=${rate.toFixed(3)}x`
    )
    this.emit(EVENT.LIVE_CATCH_UP, {
      latency,
      targetLatency: opts.targetLatency,
      userRate,
      extra,
      playbackRate: rate
    })
  }

  _onWaiting = () => {
    // retry for stream disconnect
    if (this.isLive && !this._loading && this._disconnectRetryCount) {
      this._disconnectRetryCount--
      this.load()
    }
  }

  _onBufferUpdate = () => {
    if (this._opts.isLive) return
    const { end, nextEnd } = this.bufferInfo()
    if (Math.abs((end || nextEnd) - this.media.duration) < 1) {
      this._end()
      // start with gap and buffer append finished untimely
      if (this.media.readyState <= 2) {
        this._tick()
      }
    }
  }

  _checkPreload = async () => {
    const { remaining: remainingBuffer = 0 } = this.bufferInfo()
    const opts = this._opts
    const filepositions = this._keyframes.filepositions
    const times = this._keyframes.times
    const currentTime = this.media.currentTime

    if (remainingBuffer < opts.preloadTime) {
      const i = searchKeyframeIndex(
        this._keyframes.times,
        currentTime + remainingBuffer + MAX_HOLE
      )
      let end = searchKeyframeIndex(
        this._keyframes.times,
        currentTime + remainingBuffer + this._opts.preloadTime
      )
      if (end === i) {
        end = i + 1
      }

      if (this._preLoadEndPoint === end) return

      const startByte = filepositions[i]
      if (startByte === null || startByte === undefined) return
      await this._mediaLoader.cancel()
      this._loadData(null, [startByte, filepositions[end]])
      this._preLoadEndPoint = end
      this._bufferService.unContiguous(times[i])
    }
  }

  _onFlvScriptData = (sample) => {
    const keyframes = sample.data?.onMetaData?.keyframes
    const duration = sample.data?.onMetaData?.duration
    if (keyframes) {
      this._keyframes = keyframes
    }

    if (!this._opts.isLive && duration) {
      this._bufferService.updateDuration(duration)
    }
  }
}

try {
  if (localStorage.getItem('xgd')) {
    Flv.enableLogger()
  } else {
    Flv.disableLogger()
  }
} catch (error) {
  // ignore
}
