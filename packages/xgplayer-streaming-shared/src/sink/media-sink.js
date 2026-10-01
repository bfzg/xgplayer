/**
 * Runtime media output abstraction.
 *
 * Both FLV and HLS demux a stream into `videoTrack` / `audioTrack` and then
 * hand the result to a sink. Historically the sink was always MSE + native
 * `<video>`. Soft decoding inserts a second implementation that renders HEVC on
 * a canvas and only routes audio through MSE, so the buffer services need a
 * seam they can switch at runtime.
 */

/** @enum {string} */
export const SinkKind = {
  MSE: 'mse',
  SOFT: 'soft'
}

/**
 * Why the active sink was replaced. Reused verbatim by the fallback event so
 * business code can tell an up-front capability miss from a runtime error.
 * @enum {string}
 */
export const SinkSwitchReason = {
  /** The browser cannot hardware decode this codec at all. */
  UNSUPPORTED: 'unsupported',
  /** MSE refused the init/segment during appendBuffer. */
  APPEND_ERROR: 'append-error',
  /** The media element raised a decode/format error. */
  MEDIA_ERROR: 'media-error',
  /** The legacy `lowdecode` degradation signal fired. */
  LOWDECODE: 'lowdecode',
  /** Soft decoding was requested explicitly through config. */
  FORCED: 'forced'
}

/**
 * Best-effort classification of a runtime failure into the reason we hand to
 * the fallback event. Codec/mime problems surface as `NotSupportedError`, MSE
 * append failures as `MSEError` (`type: 'updateError'`), media element problems
 * as `<video>` error events.
 * @param {any} error
 * @returns {SinkSwitchReason}
 */
export function reasonFromError(error) {
  const name = error?.name || error?.constructor?.name || ''
  const message = error?.message || (error && String(error)) || ''
  const text = `${name} ${message}`
  if (/NotSupportedError|not supported|unsupported codec/i.test(text)) {
    return SinkSwitchReason.UNSUPPORTED
  }
  if (error?.type === 'mediaError' || /MEDIA_ELEMENT_ERROR|MEDIA_ERR_/i.test(text)) {
    return SinkSwitchReason.MEDIA_ERROR
  }
  if (error?.type === 'lowdecode') {
    return SinkSwitchReason.LOWDECODE
  }
  if (error?.type === 'updateError' || /append(buffer)?/i.test(text)) {
    return SinkSwitchReason.APPEND_ERROR
  }
  return SinkSwitchReason.APPEND_ERROR
}

/**
 * Minimal contract every sink honours. Subclasses override what they need.
 * Methods resolve to promises so callers do not care whether the backing
 * implementation is synchronous (MSE SourceBuffer) or asynchronous (wasm).
 */
export class MediaSink {
  /** @returns {SinkKind} */
  get kind() {
    return 'unknown'
  }

  /** Object URL of the attached MediaSource, when the sink owns one. */
  get blobUrl() {
    return null
  }

  /** @returns {HTMLMediaElement | null} */
  get media() {
    return null
  }

  /** True once the sink has produced something playable. */
  get isOpened() {
    return false
  }

  /** @param {number} duration seconds */
  updateDuration(duration) {
    // eslint-disable-line no-unused-vars
    return Promise.resolve()
  }

  /**
   * Publish the window a live stream can be seeked within.
   * @param {number} start seconds
   * @param {number} end seconds
   */
  setLiveSeekableRange(start, end) {
    // eslint-disable-line no-unused-vars
  }

  /** @returns {Promise<void>} */
  endOfStream() {
    return Promise.resolve()
  }

  /**
   * @param {boolean} [reuse] keep the underlying media attachment when possible
   * @returns {Promise<void>}
   */
  reset(reuse) {
    // eslint-disable-line no-unused-vars
    return Promise.resolve()
  }

  /**
   * @param {'video' | 'audio'} type
   * @returns {boolean}
   */
  isFull(type) {
    // eslint-disable-line no-unused-vars
    return false
  }

  /**
   * @param {number} start seconds
   * @param {number} end seconds
   * @returns {Promise<void>}
   */
  evict(start, end) {
    // eslint-disable-line no-unused-vars
    return Promise.resolve()
  }

  /** @returns {Promise<void>} */
  destroy() {
    return Promise.resolve()
  }
}
