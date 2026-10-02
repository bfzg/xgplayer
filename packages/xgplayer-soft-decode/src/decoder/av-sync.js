/**
 * Frame pacing for software decoding.
 *
 * The clock is the audio-only MSE driven by the native `<video>` element, and
 * the renderer must show the frame whose PTS is the greatest that is still
 * `<= clock`. Frames that fall far behind are dropped so a slow decode cannot
 * build an unbounded backlog.
 *
 * Two things make the queue more than a FIFO:
 *  - libmedia hands back decoded pictures in **decode** order, not presentation
 *    order, so an inter-coded stream with B frames arrives as `10, 9, 11, ...`.
 *    Frames are therefore inserted in PTS order, not appended.
 *  - the clock does not advance while a clip decodes ahead of playback: a
 *    software decoder routinely finishes a whole segment long before the first
 *    frame is due. So the queue has to preserve frames that are still in the
 *    future and only discard frames the clock has already passed.
 */

const EPSILON = 1e-4

/**
 * Presentation time in seconds.
 *
 * `packFrame` already resolves `pts * time_base`, so `timestamp` wins when it is
 * there. The remaining shapes are for hand-built frames and for the
 * `[num, den]` spelling that older callers use.
 *
 * @param {any} frame
 * @returns {number} seconds, or `NaN` when the frame carries no usable timestamp
 */
export function presentationTime(frame) {
  if (!frame) return NaN
  if (Number.isFinite(frame.timestamp)) return frame.timestamp
  const num = frame.timeBase?.num ?? frame.time_base_num
  const den = frame.timeBase?.den ?? frame.time_base_den
  // A negative PTS is FFmpeg's marker for 'no timestamp' (NOPTS is -1), and a
  // frame like that has to be painted immediately rather than paced.
  if (!Number.isFinite(frame.pts) || frame.pts < 0) return NaN
  if (num && den) return (frame.pts * num) / den
  return frame.pts
}

/**
 * @param {object} [options]
 * @param {() => number} [options.getClock] defaults to reading `now` from take()
 * @param {boolean} [options.dropLateFrames=true]
 * @param {number} [options.lateFrameThreshold=0.12] seconds a frame may trail the clock
 * @param {number} [options.maxFrameQueue=24] hard cap on buffered frames
 * @param {number} [options.maxQueuedBytes=0] byte cap on the queue, `0` disables it
 */
export function createFramePacer(options = {}) {
  const {
    getClock,
    dropLateFrames = true,
    lateFrameThreshold = 0.12,
    maxFrameQueue = 24,
    maxQueuedBytes = 0
  } = options

  /** @type {{pts:number, frame:any}[]} kept sorted by `pts` */
  let queue = []
  /** Frames discarded by `push` since the last `consumeDropped()`. */
  let dropped = 0

  const clockNow = (fallback) => {
    const value = typeof getClock === 'function' ? getClock() : fallback
    return Number.isFinite(value) ? value : 0
  }

  /**
   * Insert one entry in PTS order.
   *
   * Decode order means the batch is *nearly* sorted, so scanning backwards from
   * the tail costs a couple of comparisons per frame. An entry with no usable
   * PTS cannot be compared at all; it goes in front of the timed frames so the
   * renderer paints it now instead of parking it behind a gap it will never
   * close.
   */
  /** Index where the timed entries start, after any untimed head. */
  const head = () => {
    let at = 0
    while (at < queue.length && !Number.isFinite(queue[at].pts)) at += 1
    return at
  }

  const insert = (entry) => {
    const from = head()
    if (!Number.isFinite(entry.pts)) {
      queue.splice(from, 0, entry)
      return
    }
    // Comparing against an untimed entry is always false, which would sort a
    // real frame in front of it, so the scan stops at the head.
    let at = queue.length
    while (at > from && !(queue[at - 1].pts <= entry.pts)) at -= 1
    queue.splice(at, 0, entry)
  }

  const trim = () => {
    if (maxFrameQueue > 0 && queue.length > maxFrameQueue) {
      const excess = queue.length - maxFrameQueue
      queue.splice(0, excess)
      dropped += excess
    }
    if (maxQueuedBytes > 0) {
      while (queue.length > 1 && bytesOf() > maxQueuedBytes) {
        queue.shift()
        dropped += 1
      }
    }
  }

  const bytesOf = () => {
    let total = 0
    for (const entry of queue) total += entry.frame?.bytes || 0
    return total
  }

  return {
    get size() {
      return queue.length
    },

    /** Decoded bytes held in the queue, used to pace the decode batches. */
    get bytes() {
      return bytesOf()
    },

    /**
     * PTS of the newest picture in the queue, used to keep the decoder from
     * running too far ahead of the clock. `NaN` when the queue is empty or
     * holds nothing with a usable timestamp.
     */
    get lastPts() {
      return queue.length ? queue[queue.length - 1].pts : NaN
    },

    /** Number of frames the pacer discarded since the previous call. */
    consumeDropped() {
      const value = dropped
      dropped = 0
      return value
    },

    /**
     * Add decoded frames. They arrive in decode order and are re-sorted here.
     *
     * Only frames the clock has already passed are discarded. A decoded frame
     * that is still in the future has to survive: a fast decoder runs ahead of
     * playback by design, so trimming the tail of the batch would throw the
     * whole video away. `maxFrameQueue` and `maxQueuedBytes` stay as memory
     * safety valves, and the sink paces decoding so they are rarely reached.
     */
    push(frames) {
      for (const frame of frames || []) {
        if (!frame) continue
        insert({ pts: presentationTime(frame), frame })
      }
      const clock = clockNow()
      if (dropLateFrames) {
        while (
          queue.length &&
          Number.isFinite(queue[0].pts) &&
          queue[0].pts < clock - lateFrameThreshold
        ) {
          queue.shift()
          dropped += 1
        }
      }
      trim()
      return queue.length
    },

    /**
     * Choose the frame to display for `now`.
     * @param {number} [now]
     * @returns {{frame:any, pts:number, dropped:number, wait:boolean, next:number}}
     */
    take(now) {
      const next = queue.length ? queue[0].pts : NaN
      if (!queue.length) return { frame: null, pts: NaN, dropped: 0, wait: true, next }
      // A frame without a usable PTS cannot be paced; render it immediately and
      // never let a bad timestamp stall the queue behind it.
      if (!Number.isFinite(queue[0].pts)) {
        const invalid = queue.shift()
        return { frame: invalid.frame, pts: NaN, dropped: 0, wait: false, next: NaN }
      }

      const clock = clockNow(now)

      const due = []
      while (queue.length && queue[0].pts <= clock + EPSILON) {
        due.push(queue.shift())
      }
      if (!due.length) {
        return { frame: null, pts: NaN, dropped: 0, wait: true, next: queue[0].pts }
      }

      const chosen = due[due.length - 1]
      let droppedCount = due.length - 1
      // Only the newest due frame is kept; older ones are dropped when we are
      // allowed to, otherwise they are simply superseded by the newest frame.
      if (dropLateFrames && clock - chosen.pts > lateFrameThreshold * 4) {
        droppedCount += 1
      }
      return {
        frame: chosen.frame,
        pts: chosen.pts,
        dropped: droppedCount,
        wait: false,
        next: queue.length ? queue[0].pts : NaN
      }
    },

    /** Force the next pending frame out, used on EOS/seek so nothing is stuck. */
    flush() {
      const next = queue.shift()
      return next ? { frame: next.frame, pts: next.pts, dropped: 0 } : null
    },

    clear() {
      queue = []
    }
  }
}
