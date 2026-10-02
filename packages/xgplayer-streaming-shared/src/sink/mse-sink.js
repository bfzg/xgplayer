import { MSE } from '../mse'
import { MediaSink, SinkKind } from './media-sink'

/**
 * Hard-decode sink: a wafer-thin owner of a {@link MSE} instance.
 *
 * The buffer services still drive remuxing and segment layout themselves, so
 * this sink deliberately exposes the MSE primitives (`createSource`, `append`,
 * `setTimeoffset`, ...) instead of inventing a second segment pipeline. What it
 * buys is a single, swappable object: `SinkManager` can retire it and install a
 * `SoftSink` without the buffer services reaching for `MSE` directly.
 */
export class MseSink extends MediaSink {
  /** @type {MSE | null} */
  _mse = null

  /**
   * @param {HTMLMediaElement} [media]
   * @param {import('../mse').MSEConfig} [config]
   */
  constructor(media, config) {
    super()
    this._mse = new MSE(null, {
      preferMMS:
        typeof config?.preferMMS === 'boolean' ? config.preferMMS : !!config?.perferMMS,
      attachMode: config?.attachMode
    })
    if (media) {
      this._mse.bindMedia(media)
    }
  }

  get kind() {
    return SinkKind.MSE
  }

  /** Underlying MSE instance, or null once destroyed. */
  get mse() {
    return this._mse
  }

  get blobUrl() {
    return this._mse?.url || null
  }

  get media() {
    return this._mse?.media || null
  }

  get mediaSource() {
    return this._mse?.mediaSource || null
  }

  get isOpened() {
    return !!this._mse?.isOpened
  }

  get duration() {
    return this._mse?.duration ?? -1
  }

  get streaming() {
    return this._mse?.streaming
  }

  get hasOpTasks() {
    return !!this._mse?.hasOpTasks
  }

  open() {
    return this._mse?.open() || Promise.resolve()
  }

  bindMedia(media) {
    return this._mse?.bindMedia(media) || Promise.resolve()
  }

  unbindMedia() {
    return this._mse?.unbindMedia() || Promise.resolve()
  }

  createSource(type, mimeType) {
    this._mse?.createSource(type, mimeType)
  }

  changeType(type, mimeType) {
    return this._mse?.changeType(type, mimeType) || Promise.resolve()
  }

  createOrChangeSource(type, mimeType) {
    return this._mse?.createOrChangeSource(type, mimeType) || Promise.resolve()
  }

  append(type, buffer, context) {
    return this._mse?.append(type, buffer, context) || Promise.resolve()
  }

  remove(type, startTime, endTime, context) {
    return this._mse?.remove(type, startTime, endTime, context) || Promise.resolve()
  }

  clearBuffer(startTime, endTime) {
    return this._mse?.clearBuffer(startTime, endTime) || Promise.resolve()
  }

  clearAllBuffer() {
    return this._mse?.clearAllBuffer() || Promise.resolve()
  }

  getSourceBuffer(type) {
    return this._mse?.getSourceBuffer(type)
  }

  bufferEnd(type) {
    return this._mse?.bufferEnd(type) ?? 0
  }

  setLiveSeekableRange(start, end) {
    this._mse?.setLiveSeekableRange(start, end)
  }

  /**
   * Publish `duration`, opening the MediaSource first when needed.
   *
   * The buffer services used to run the open guard themselves, which meant a
   * caller going through `SinkManager` could set a duration on a closed
   * MediaSource. Keeping the guard here makes the sink a safe single funnel.
   * @param {number} duration
   * @returns {Promise<void>}
   */
  async updateDuration(duration) {
    // Hold the instance for the whole operation: a soft switch can retire it
    // while `open()` is pending.
    const mse = this._mse
    if (!mse) return
    if (!mse.isOpened) {
      await mse.open()
    }
    await mse.updateDuration(duration)
  }

  endOfStream(reason) {
    return this._mse?.endOfStream(reason) || Promise.resolve()
  }

  isFull(type) {
    return !!this._mse?.isFull(type)
  }

  setTimeoffset(type, timestampOffset, context) {
    return this._mse?.setTimeoffset(type, timestampOffset, context) || Promise.resolve()
  }

  abort(type, context) {
    return this._mse?.abort(type, context) || Promise.resolve()
  }

  clearOpQueues(type, allClear) {
    this._mse?.clearOpQueues(type, allClear)
  }

  async evict(start, end) {
    await this.clearBuffer(start, end)
  }

  async reset(reuse = false) {
    if (this._mse && !reuse) {
      const media = this._mse.media
      await this._mse.unbindMedia()
      if (media) await this._mse.bindMedia(media)
    }
  }

  async destroy() {
    if (this._mse) {
      await this._mse.unbindMedia()
      this._mse = null
    }
  }
}
