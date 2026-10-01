import { BasePlugin, Errors, Events } from 'xgplayer'
import { EVENT, MSE } from 'xgplayer-streaming-shared'
import { Hls, logger } from './hls'
import { Event } from './hls/constants'
import PluginExtension from './plugin-extension'

/**
 * @param { import('xgplayer').SwitchUrlOptions } args
 * @param { HlsPlugin } plugin
 * @returns
 */
export function parseSwitchUrlArgs(args, plugin) {
  const { player } = plugin
  const curTime = player.currentTime

  /**
   * @type {{
   *  startTime: number
   *  seamless?: boolean
   * }}
   */
  const options = {
    startTime: curTime
  }

  switch (typeof args) {
    case 'boolean':
      options.seamless = args
      break
    case 'object': {
      const { currentTime, ...rest } = args
      Object.assign(options, rest)
      if (typeof currentTime === 'number') {
        options.startTime = currentTime
      }
      break
    }
    default:
      break
  }
  return options
}

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

export class HlsPlugin extends BasePlugin {
  static Hls = Hls

  static EVENT = Event

  static isStreamingPlugin = true

  logger = logger

  /**
   * @type {Hls}
   */
  hls = null

  pluginExtension = null

  static get pluginName() {
    return 'hls'
  }

  get core() {
    return this.hls
  }

  get version() {
    return this.hls?.version
  }

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
   * from {@link HlsPlugin#softDecode}, which detects an external soft media element.
   * Returns `null` when the user left it unset, so the caller can default to
   * `'auto'` once a soft sink factory is available.
   * @returns {boolean | 'auto' | null}
   */
  get softDecodeMode() {
    const config = this.player?.config || {}
    const mode = config.softDecode ?? config.hls?.softDecodeMode
    if (mode === true || mode === 'auto') return mode
    if (mode === false) return false
    return null
  }

  beforePlayerInit() {
    const config = this.player.config
    const mediaElem = this.player.media || this.player.video
    const hlsOpts = config.hls || {}

    if (
      (!config.url &&
        // private config key
        !config.__allowHlsEmptyUrl__) ||
      (!this.softDecode && !this.softDecodeMode && !hlsOpts.preferMMS && MSE.isMMSOnly())
    ) {
      return
    }

    if (this.hls) this.hls.destroy()

    /**
     * 支持被继承时，指定不可写的属性。用来实现外部 switchURL 逻辑
     */
    const descriptor = Object.getOwnPropertyDescriptor(this.player, 'switchURL')
    if (!descriptor || descriptor.writable) {
      this.player.switchURL = (url, args) => {
        return new Promise((resolve, reject) => {
          const { player, hls } = this
          if (hls) {
            const options = parseSwitchUrlArgs(args, this)
            player.config.url = url
            hls
              .switchURL(url, options)
              .then(() => resolve(true))
              .catch(reject)

            if (!options.seamless && this.player.config?.hls?.keepStatusAfterSwitch) {
              this._keepPauseStatus()
            }
          } else {
            reject()
          }
        })
      }
    }
    const onSwitchUrl = this.player.switchURL
    this.player.handleSource = false // disable player source handle

    hlsOpts.innerDegrade = hlsOpts.innerDegrade || config.innerDegrade
    if (hlsOpts.disconnectTime === null || hlsOpts.disconnectTime === undefined)
      hlsOpts.disconnectTime = 0

    const hlsCfg = {
      softDecode: this.softDecode,
      isLive: config.isLive,
      media: mediaElem,
      startTime: config.startTime,
      url: config.url,
      ...hlsOpts
    }
    const legacySoftVideo =
      hlsOpts.softDecode === undefined ? this.softDecode : !!hlsOpts.softDecode
    const requestedMode = legacySoftVideo ? false : this.softDecodeMode
    const softDecodeOptions = config.softDecodeOptions || hlsCfg.softDecodeOptions || {}
    const resolvedFactory = legacySoftVideo
      ? null
      : resolveSoftSinkFactory(softDecodeOptions)
    // Registering the soft-decode package arms the automatic HEVC fallback even
    // when the caller never mentioned `softDecode`. Explicit `false` still wins.
    const softDecodeMode = legacySoftVideo
      ? false
      : requestedMode === null
        ? resolvedFactory
          ? 'auto'
          : false
        : requestedMode
    // An explicit `false` means "never software decode": leave the sink
    // unwired so not even a runtime/error fallback can select it.
    const createSoftSink = softDecodeMode === false ? null : resolvedFactory
    if ((requestedMode === true || requestedMode === 'auto') && !resolvedFactory) {
      logger.warn(
        'softDecode is enabled but no soft sink factory is available, keeping native decode'
      )
    }
    hlsCfg.softDecode = legacySoftVideo
    hlsCfg.softDecodeMode = createSoftSink ? softDecodeMode : false
    hlsCfg.softDecodeOptions = softDecodeOptions
    hlsCfg.createSoftSink = createSoftSink

    this.hls = new Hls(hlsCfg)

    if (createSoftSink) {
      this.player.forceSoftDecode = (reason) => this.hls?.fallbackToSoft(reason)
      if (typeof config.onSoftDecodeFallback === 'function') {
        this.hls.on(EVENT.SOFT_DECODE_FALLBACK, (info) => {
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
          get: () => this.hls?.media?.src,
          configurable: true
        }
      })
    }

    if (this.softDecode) {
      this.pluginExtension = new PluginExtension(
        {
          isLive: config.isLive,
          media: mediaElem,
          ...hlsOpts
        },
        this
      )
      this.player.forceDegradeToVideo = (...args) =>
        this.pluginExtension?.forceDegradeToVideo(...args)
    }

    if (config.isLive) {
      // This is a heavy operation for the vod flow, which may cause seeked event never emit
      this.player?.useHooks('replay', () => this.hls?.replay())
    }

    this.on(Events.URL_CHANGE, onSwitchUrl)
    this.on(Events.SWITCH_SUBTITLE || 'switch_subtitle', this._onSwitchSubtitle)
    this.on(Events.DESTROY, this.destroy.bind(this))

    this._transError()
    this._transCoreEvent(EVENT.TTFB)
    this._transCoreEvent(EVENT.LOAD_START)
    this._transCoreEvent(EVENT.LOAD_RESPONSE_HEADERS)
    this._transCoreEvent(EVENT.LOAD_COMPLETE)
    this._transCoreEvent(EVENT.LOAD_RETRY)
    this._transCoreEvent(EVENT.SOURCEBUFFER_CREATED)
    this._transCoreEvent(EVENT.MEDIASOURCE_OPENED)
    this._transCoreEvent(EVENT.APPEND_BUFFER)
    this._transCoreEvent(EVENT.REMOVE_BUFFER)
    this._transCoreEvent(EVENT.BUFFEREOS)
    this._transCoreEvent(EVENT.KEYFRAME)
    this._transCoreEvent(EVENT.METADATA_PARSED)
    this._transCoreEvent(EVENT.DEMUXED_TRACK)
    this._transCoreEvent(EVENT.SEI)
    this._transCoreEvent(EVENT.SEI_IN_TIME)
    this._transCoreEvent(EVENT.SPEED)
    this._transCoreEvent(EVENT.HLS_MANIFEST_LOADED)
    this._transCoreEvent(EVENT.HLS_LEVEL_LOADED)
    this._transCoreEvent(EVENT.STREAM_EXCEPTION)
    this._transCoreEvent(EVENT.SWITCH_URL_SUCCESS)
    this._transCoreEvent(EVENT.SWITCH_URL_FAILED)
    this._transCoreEvent(EVENT.SOFT_DECODE_FALLBACK)
    this._transCoreEvent(Event.NO_AUDIO_TRACK)
    this._transCoreEvent(Event.STREAM_PARSED)
    this._transCoreEvent(Event.SUBTITLE_SEGMENTS)
    this._transCoreEvent(Event.SUBTITLE_PLAYLIST)
    this._transCoreEvent(Event.APPEND_COST)

    if (config.url) {
      this.hls
        .load(config.url, {
          reuseMse: true
        })
        .catch((e) => {})
    }
  }

  /**
   * It needs to be supported as a subclass to be inherited externally, so don't write it as an attribute here
   */
  destroy() {
    if (this.hls) {
      this.hls.destroy()
      this.hls = null
    }

    this.pluginExtension?.destroy()
    this.pluginExtension = null
  }

  /**
   * @returns {import('./hls').Stats |  undefined}
   */
  getStats = () => {
    return this.hls?.getStats()
  }

  /**
   * @param {string | boolean} [mediaType]
   * @param {string} [codec]
   * @returns {boolean}
   * - mediaType: 默认检测 MSE 对 H264 codec是否支持，传入 true 或者配置参数的mediaType的取值检测 WebAssembly是否支持
   * - codec: 暂无使用
   */
  static isSupported(mediaType, codec) {
    return Hls.isSupported(mediaType, codec)
  }

  _onSwitchSubtitle = ({ lang }) => {
    this.hls?.switchSubtitleStream(lang)
  }

  _keepPauseStatus = () => {
    const paused = this.player.paused
    if (!paused) return
    this.player.once('canplay', () => {
      this.player.pause()
    })
  }

  _transError() {
    this.hls.on(Event.ERROR, (err) => {
      if (this.player) {
        this.player.emit(Events.ERROR, new Errors(this.player, err))
      }
    })
  }

  _transCoreEvent(eventName) {
    this.hls.on(eventName, (e) => {
      if (this.player) {
        this.player.emit('core_event', {
          ...e,
          eventName
        })

        if (eventName === EVENT.SEI_IN_TIME && this.hls.hasSubtitle) {
          this._emitSeiPaylodTime(e)
        }
      }
    })
  }

  _emitSeiPaylodTime(e) {
    try {
      const seiJson = JSON.parse(
        Array.from(e.data.payload)
          .map((x) => String.fromCharCode(x))
          .join('')
          .slice(0, -1)
      )
      if (!seiJson['rtmp_dts']) return
      this.player.emit('core_event', {
        eventName: Event.SEI_PAYLOAD_TIME,
        time: seiJson['rtmp_dts']
      })
    } catch (e) {}
  }
}
