import { BasePlugin, Errors, Events } from 'xgplayer'
import { EVENT } from 'xgplayer-streaming-shared'
import { Flv, logger } from './flv'
import PluginExtension from './plugin-extension'

/**
 * Locate a soft-decode sink factory without adding a hard dependency on the
 * wasm package: it can be injected through `softDecodeOptions.createSoftSink`
 * or registered globally (UMD build or `registerSoftDecode()`).
 * @param {object} [options]
 * @returns {((context: object) => any) | null}
 */
function resolveSoftSinkFactory(options = {}) {
  if (typeof options.createSoftSink === 'function') return options.createSoftSink
  const registered =
    (typeof globalThis !== 'undefined' &&
      (globalThis.XGPlayerSoftDecode || globalThis.SoftDecode)) ||
    null
  if (registered && typeof registered.createSoftSinkFactory === 'function') {
    const base = { ...options }
    delete base.createSoftSink
    return registered.createSoftSinkFactory(base)
  }
  return null
}

export class FlvPlugin extends BasePlugin {
  static Flv = Flv

  static isStreamingPlugin = true

  static get pluginName() {
    return 'flv'
  }

  logger = logger

  /** @type {Flv} */
  flv = null

  /** @type {PluginExtension} */
  pluginExtension = null

  /** @type {Flv} */
  get core() {
    return this.flv
  }

  /** @type {string} */
  get version() {
    return this.flv?.version
  }

  /** @type {boolean} */
  get softDecode() {
    const mediaType = this.player?.config?.mediaType
    return (
      !!mediaType &&
      mediaType !== 'video' &&
      mediaType !== 'audio' &&
      mediaType !== 'offscreen-video'
    )
  }

  /**
   * Built-in wasm soft-decode request (`softDecode: 'auto' | true`). Distinct
   * from {@link FlvPlugin#softDecode}, which detects an external soft media element.
   * Returns `null` when the user left it unset, so the caller can default to
   * `'auto'` once a soft sink factory is available.
   * @returns {boolean | 'auto' | null}
   */
  get softDecodeMode() {
    const config = this.player?.config || {}
    const mode = config.softDecode ?? config.flv?.softDecodeMode
    if (mode === true || mode === 'auto') return mode
    if (mode === false) return false
    return null
  }

  get loader() {
    return this.flv?.loader
  }

  /** Live latency in seconds, 0 while not live or nothing is buffered yet. */
  get latency() {
    return this.flv?.latency ?? 0
  }

  /** Playback rate asked for by the app, without the catch-up multiplier. */
  get userPlaybackRate() {
    return this.flv?.userPlaybackRate ?? this.player?.playbackRate ?? 1
  }

  get transferCost() {
    return this.flv._transferCost.transferCost
  }

  beforePlayerInit() {
    const config = this.player.config
    const mediaElem = this.player.media || this.player.video

    if (!config.url) return

    if (this.flv) this.flv.destroy()

    this.player.switchURL = this._onSwitchURL

    const flvOpts = config.flv || {}
    if (flvOpts.disconnectTime === null || flvOpts.disconnectTime === undefined) {
      flvOpts.disconnectTime = 0
    }

    const legacySoftVideo =
      flvOpts.softDecode === undefined ? this.softDecode : !!flvOpts.softDecode
    const requestedMode = legacySoftVideo ? false : this.softDecodeMode
    const softDecodeOptions = config.softDecodeOptions || flvOpts.softDecodeOptions || {}
    const resolvedFactory = legacySoftVideo
      ? null
      : resolveSoftSinkFactory(softDecodeOptions)
    // Registering the soft-decode package arms the automatic HEVC fallback even
    // when the caller never mentioned `softDecode`. Explicit `false` still wins.
    const effectiveMode = legacySoftVideo
      ? false
      : requestedMode === null
        ? resolvedFactory
          ? 'auto'
          : false
        : requestedMode
    // An explicit `false` means "never software decode": leave the sink
    // unwired so not even a runtime/error fallback can select it.
    const createSoftSink = effectiveMode === false ? null : resolvedFactory
    if ((requestedMode === true || requestedMode === 'auto') && !resolvedFactory) {
      logger.warn(
        'softDecode is enabled but no soft sink factory is available, keeping native decode'
      )
    }

    this.flv = new Flv({
      isLive: config.isLive,
      media: mediaElem,
      preProcessUrl: (url, ext) => this.player?.preProcessUrl?.(url, ext) || { url, ext },
      ...flvOpts,
      softDecode: legacySoftVideo,
      softDecodeMode: createSoftSink ? effectiveMode : false,
      softDecodeOptions,
      createSoftSink
    })

    // 直播延迟与用户倍速，供宿主页面读取（追帧会临时改写 media.playbackRate）
    this.player.getLiveLatency = () => this.latency
    this.player.getUserPlaybackRate = () => this.userPlaybackRate

    if (createSoftSink) {
      this.player.forceSoftDecode = (reason) => this.flv?.fallbackToSoft(reason)
      if (typeof config.onSoftDecodeFallback === 'function') {
        this.flv.on(EVENT.SOFT_DECODE_FALLBACK, (info) => {
          try {
            config.onSoftDecodeFallback(info)
          } catch (error) {
            logger.warn('onSoftDecodeFallback failed', error)
          }
        })
      }
    }

    if (!this.softDecode) {
      BasePlugin.defineGetterOrSetter(this.player, {
        url: {
          get: () => {
            return this.flv?.blobUrl
          },
          configurable: true
        }
      })
    }

    if (this.softDecode) {
      this.pluginExtension = new PluginExtension(
        {
          media: this.player.video,
          isLive: config.isLive,
          ...config.flv
        },
        this
      )
      this.player.forceDegradeToVideo = (...args) =>
        this.pluginExtension?.forceDegradeToVideo(...args)
    }

    if (config.isLive) {
      this.player?.useHooks('replay', () => this.flv?.replay())
    }

    this.on(Events.URL_CHANGE, this._onSwitchURL)
    this.on(Events.DESTROY, this.destroy)

    this._transError()
    this._transCoreEvent(EVENT.TTFB)
    this._transCoreEvent(EVENT.LOAD_START)
    this._transCoreEvent(EVENT.LOAD_RESPONSE_HEADERS)
    this._transCoreEvent(EVENT.LOAD_COMPLETE)
    this._transCoreEvent(EVENT.LOAD_RETRY)
    this._transCoreEvent(EVENT.SOURCEBUFFER_CREATED)
    this._transCoreEvent(EVENT.ANALYZE_DURATION_EXCEEDED)
    this._transCoreEvent(EVENT.APPEND_BUFFER)
    this._transCoreEvent(EVENT.REMOVE_BUFFER)
    this._transCoreEvent(EVENT.BUFFEREOS)
    this._transCoreEvent(EVENT.KEYFRAME)
    this._transCoreEvent(EVENT.CHASEFRAME)
    this._transCoreEvent(EVENT.LIVE_CATCH_UP)
    this._transCoreEvent(EVENT.METADATA_PARSED)
    this._transCoreEvent(EVENT.SEI)
    this._transCoreEvent(EVENT.SEI_IN_TIME)
    this._transCoreEvent(EVENT.FLV_SCRIPT_DATA)
    this._transCoreEvent(EVENT.STREAM_EXCEPTION)
    this._transCoreEvent(EVENT.SWITCH_URL_SUCCESS)
    this._transCoreEvent(EVENT.SWITCH_URL_FAILED)
    this._transCoreEvent(EVENT.SOFT_DECODE_FALLBACK)

    if (!flvOpts.manualLoad) {
      this.loadSource(config.url, flvOpts.streamRes)
    }
  }

  /**
   * @return {import('./flv').Stats | undefined}
   */
  getStats = () => {
    return this.flv?.getStats()
  }

  loadSource = (url = this.player.config.url, streamRes) => {
    this.flv?.load(this.player.config.url, true, streamRes)
  }

  destroy = () => {
    if (this.flv) {
      this.flv.destroy()
      this.flv = null
    }
    this.pluginExtension?.destroy()
    this.pluginExtension = null
  }

  /**
   * @param {string | boolean} [mediaType]
   * @param {string} [codec]
   * @returns {boolean}
   * - mediaType: 默认检测 MSE 对 H264 codec是否支持，传入 true 或者配置参数的mediaType的取值检测 WebAssembly是否支持
   * - codec: 暂无使用
   */
  static isSupported(mediaType, codec) {
    return Flv.isSupported(mediaType, codec)
  }

  static isSupportedMMS() {
    return typeof ManagedMediaSource !== 'undefined'
  }

  /**
   *
   * @param {string} url
   * @param {boolean | {seamless: boolean}} seamless
   */
  _onSwitchURL = (url, seamless) => {
    if (this.flv) {
      this.player.config.url = url

      if (typeof seamless === 'object') {
        seamless = seamless.seamless
      }

      this.flv.switchURL(url, seamless)

      if (!seamless && this.player.config?.flv?.keepStatusAfterSwitch) {
        this._keepPauseStatus()
      }
    }
  }

  _keepPauseStatus = () => {
    const paused = this.player.paused
    if (!paused) return
    this.player.once('canplay', () => {
      this.player.pause()
    })
  }

  _onDefinitionChange = ({ to }) => {
    if (this.flv) this.flv.switchURL(to)
  }

  _transError() {
    this.flv.on(EVENT.ERROR, (err) => {
      if (this.player) {
        this.player.emit(Events.ERROR, new Errors(this.player, err))
      }
    })
  }

  _transCoreEvent(eventName) {
    this.flv.on(eventName, (e) => {
      if (this.player) {
        this.player.emit('core_event', {
          ...e,
          eventName
        })
      }
    })
  }
}
