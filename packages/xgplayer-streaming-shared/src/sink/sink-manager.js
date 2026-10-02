import { reasonFromError, SinkKind, SinkSwitchReason } from './media-sink'

/**
 * Owns the currently active {@link MediaSink} and performs the one-way switch
 * from hardware decode (MSE) to software decode.
 *
 * The buffer services keep driving demuxing/remuxing themselves; the manager is
 * the single place that decides *where the picture and sound come out*. It is
 * deliberately dependency-free so `xgplayer-streaming-shared` never has to know
 * about the wasm package: the soft sink arrives as an injected factory.
 */
export class SinkManager {
  _sink = null
  _fallbackInfo = null
  /**
   * Last duration the player asked for. Kept here because a `durationchange`
   * can arrive before the first append, and the soft sink that has to carry it
   * does not exist yet at that point.
   * @type {number|null}
   */
  _duration = null

  /**
   * @param {object} [options]
   * @param {HTMLMediaElement} [options.media]
   * @param {() => import('./media-sink').MediaSink} [options.createMseSink]
   * @param {(context: {reason: string, info: object, media: HTMLMediaElement|null}) => import('./media-sink').MediaSink | null | Promise<import('./media-sink').MediaSink | null>} [options.createSoftSink]
   * @param {(info: object) => void} [options.onFallback]
   */
  constructor(options = {}) {
    this._options = options
    this._media = options.media || null
    this._createMseSink = options.createMseSink || null
    this._createSoftSink = options.createSoftSink || null
    this._onFallback = options.onFallback || null
  }

  /** @returns {SinkKind} */
  get kind() {
    return this._sink ? this._sink.kind : SinkKind.MSE
  }

  /** Currently installed sink, or null when nothing is installed yet. */
  get sink() {
    return this._sink
  }

  get isSoft() {
    return !!this._sink && this._sink.kind === SinkKind.SOFT
  }

  /** Underlying `MSE` instance while the MSE sink is active, else null. */
  get mse() {
    if (!this._sink || this._sink.kind !== SinkKind.MSE) return null
    return this._sink.mse || null
  }

  /** Active soft sink, or null. */
  get soft() {
    if (!this._sink || this._sink.kind !== SinkKind.SOFT) return null
    return this._sink
  }

  get canSoftDecode() {
    return typeof this._createSoftSink === 'function'
  }

  /** Last fallback descriptor, useful for stats/telemetry. */
  get fallbackInfo() {
    return this._fallbackInfo
  }

  /** Duration handed to the manager, or null when none was ever requested. */
  get duration() {
    return this._duration
  }

  /**
   * Publish a duration on whichever sink is active, remembering it so a sink
   * installed later still gets it.
   *
   * Both buffer services used to talk to the `MSE` directly, which silently
   * dropped the value in two situations: a forced soft switch happens during
   * the first append, so a VOD `durationchange` that fired while the playlist
   * was being parsed had no sink to write to at all; and once the soft sink is
   * live there is no `MSE` to update. Either way `media.duration` stayed `NaN`
   * and the progress bar read `00:00`.
   *
   * @param {number} duration
   * @returns {Promise<void>}
   */
  async updateDuration(duration) {
    this._duration = duration
    if (!this._sink) return
    await this._sink.updateDuration(duration)
  }

  /**
   * Publish the live seek window on whichever sink is active.
   *
   * The hardware path called `mse.setLiveSeekableRange` directly, which does
   * nothing once a soft sink owns the element: there is no video SourceBuffer
   * there, and `duration` is `Infinity`, so `media.seekable` would stay empty.
   *
   * @param {number} start
   * @param {number} end
   */
  setLiveSeekableRange(start, end) {
    const sink = this._sink
    if (sink && typeof sink.setLiveSeekableRange === 'function') {
      sink.setLiveSeekableRange(start, end)
    }
  }

  /** Lazily build (but do not switch to) the MSE sink. */
  ensureMse() {
    if (!this._sink) {
      if (typeof this._createMseSink !== 'function') {
        throw new Error('SinkManager: createMseSink is required')
      }
      this._sink = this._createMseSink()
      // Mirror `switchToSoft`: a duration published before any sink existed
      // has to reach the one we just installed, or the timeline starts at
      // `Infinity` and the progress bar reads `00:00`.
      if (this._duration !== null) {
        try {
          const task = this._sink.updateDuration(this._duration)
          if (task && typeof task.catch === 'function') task.catch(() => {})
        } catch (_error) {
          // A sink that cannot report a duration still plays.
        }
      }
    }
    return this._sink
  }

  /**
   * Install the soft sink and retire the previous one.
   * @param {SinkSwitchReason|string} [reason]
   * @param {object} [info]
   * @returns {Promise<import('./media-sink').MediaSink | null>}
   */
  async switchToSoft(reason = SinkSwitchReason.FORCED, info = {}) {
    if (this.isSoft) return this._sink
    if (!this.canSoftDecode) return null

    const previous = this._sink
    // The factory is allowed to be async (e.g. lazily importing the wasm
    // decoder package) so resolve it before swapping the active sink.
    const softSink = await this._createSoftSink({
      reason,
      info,
      media: this._media,
      previous
    })
    if (!softSink) return null

    this._sink = softSink
    this._fallbackInfo = {
      reason,
      from: SinkKind.MSE,
      to: SinkKind.SOFT,
      ...info
    }
    // The outgoing MSE held the duration; the new sink needs the same number or
    // the timeline collapses to `00:00` the moment decoding switches.
    if (this._duration !== null) {
      try {
        await softSink.updateDuration(this._duration)
      } catch (_error) {
        // A sink that cannot report a duration still plays; the append path is
        // what matters here.
      }
    }
    if (typeof this._onFallback === 'function') {
      try {
        this._onFallback(this._fallbackInfo)
      } catch (_error) {
        // A failing listener must not abort the switch itself.
      }
    }

    if (previous && previous !== softSink) {
      try {
        await previous.destroy()
      } catch (_error) {
        // The MSE sink is being thrown away anyway.
      }
    }
    return softSink
  }

  /** Switch to soft decoding because an append/media error was observed. */
  handleError(error, info = {}) {
    const message = error?.message || error?.name || (error && String(error)) || ''
    return this.switchToSoft(reasonFromError(error), { ...info, message })
  }

  async destroy() {
    const sink = this._sink
    this._sink = null
    if (sink) await sink.destroy()
  }
}
