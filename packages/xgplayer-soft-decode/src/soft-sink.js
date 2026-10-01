import { MediaSink, SinkKind } from 'xgplayer-streaming-shared'
import { AudioOutput } from './audio/audio-output'
import { getSoftDecodeOptions } from './config'
import { createFramePacer } from './decoder/av-sync'
import { buildHevcPackets } from './decoder/nalu'
import { createDecoder } from './decoder/session'
import { createCanvasRenderer } from './render/canvas-renderer'
import { detachOverlayCanvas, ensureOverlayCanvas, syncMediaSize } from './render/overlay'

/** Frames thrown away by one resync before the gate gives up and paints. */
const MAX_RESYNC_FRAMES = 120

/**
 * Snapshot the demuxed video track into plain data before any async work.
 *
 * The demuxer reuses one track object per stream and appends to `samples`, so
 * the packets must be copied out (and the array drained) synchronously, exactly
 * like `FMP4Remuxer.remux()` does on the hard path.
 */
/**
 * @param {import('xgplayer-transmuxer').VideoTrack} track
 * @param {number} [lastFrameTicks] duration, in ticks, of the last frame gap
 *   seen on this stream; used when this batch is too small to measure one
 * @returns {object|null} the packets plus their position on the media timeline
 */
export function snapshotVideo(track, lastFrameTicks = 0) {
  if (!track || typeof track.exist !== 'function' || !track.exist()) {
    if (track) track.samples = []
    return null
  }
  const packets = buildHevcPackets(track)
  const timescale = track.timescale || 90000
  const frameTicks = frameTicksOf(packets, lastFrameTicks)
  const span = spanOf(packets, timescale, frameTicks)
  const snapshot = {
    codec: track.codec,
    width: track.width,
    height: track.height,
    timescale,
    vps: (track.vps || []).slice(),
    sps: (track.sps || []).slice(),
    pps: (track.pps || []).slice(),
    packets,
    span,
    frameTicks
  }
  track.samples = []
  return snapshot
}

/**
 * How much media time a batch of pictures occupies, in container seconds.
 *
 * `pts` marks the *start* of a picture, so a span built from the first and last
 * stamp of a single-packet batch comes out empty. That is not a corner case: a
 * live FLV reader hands over one or two pictures at a time, an empty span made
 * the synthesised audio clock advance by nothing, and every append left a hole
 * in the SourceBuffer. The element reads its clock from that buffer, so it
 * stalled, `readyState` sat at `HAVE_METADATA`, and the spinner never cleared.
 * Adding one frame duration makes the span honest.
 *
 * @param {{pts: number}[]} packets
 * @param {number} timescale
 * @param {number} frameTicks nominal duration of one picture, in ticks
 * @returns {{from: number, to: number}|null}
 */
function spanOf(packets, timescale, frameTicks) {
  if (!packets.length) return null
  let first = Infinity
  let last = -Infinity
  for (const packet of packets) {
    if (packet.pts < first) first = packet.pts
    if (packet.pts > last) last = packet.pts
  }
  return { from: first / timescale, to: (last + frameTicks) / timescale }
}

/**
 * Nominal duration of one picture, in timescale ticks.
 *
 * Consecutive `dts` deltas are the reliable measurement, because decode order
 * is monotonic even when presentation order is not. A single-picture batch has
 * nothing to measure, so the sample's own duration is used, and failing that
 * the value carried over from the previous batch.
 *
 * @param {{dts: number, duration: number}[]} packets
 * @param {number} lastFrameTicks
 * @returns {number}
 */
function frameTicksOf(packets, lastFrameTicks) {
  let observed = 0
  for (let i = 1; i < packets.length; i += 1) {
    const delta = packets[i].dts - packets[i - 1].dts
    if (delta > 0) observed = delta
  }
  if (!observed) observed = packets[packets.length - 1]?.duration || 0
  return observed > 0 ? observed : lastFrameTicks
}

function decoderKeyOf(video) {
  const sizes = (list) => (list || []).map((n) => n.byteLength).join('.')
  return [
    video.codec,
    `${video.width}x${video.height}`,
    sizes(video.vps),
    sizes(video.sps),
    sizes(video.pps)
  ].join('/')
}

/**
 * Read the audio timeline anchor synchronously.
 *
 * Every demuxer keeps `track.baseMediaDecodeTime` in the *track* timescale and
 * points it at the first sample of the batch: `FlvFixer`/`TsFixer` write
 * `samples[0].pts * timescale / 1000` (there the stamps are in milliseconds
 * while `audioTrack.timescale` is the sample rate), and `FMP4Demuxer` relabels
 * the batch after its per-moof walk. So this field, not `samples[0].pts`, is the
 * one that converts cleanly to container seconds; comparing the two, as an
 * earlier revision did, picked the millisecond number whenever the sample rate
 * was above 1000 and moved the audio clock by orders of magnitude.
 *
 * The anchor matters twice: it locks the timeline below, and `MP4.traf` writes
 * the same field as the `tfdt` of the remuxed audio. When it was left at the
 * `tfdt` of the last moof of a segment, several hundred moofs past the samples
 * it described, the sound landed ~10s late relative to its pictures and every
 * segment boundary gained a hole. Those holes split `media.buffered`, which is
 * what both the element's clock and the HLS loader's preload window read.
 *
 * It is read here rather than in `_append` because the demuxer keeps running
 * while an append is queued.
 *
 * @param {import('xgplayer-transmuxer').AudioTrack} track
 * @returns {{from: number}|null} container seconds where this batch starts
 */
function audioAnchor(track) {
  if (
    !track ||
    typeof track.exist !== 'function' ||
    !track.exist() ||
    !track.samples?.length
  ) {
    return null
  }
  const timescale = track.timescale
  const base = track.baseMediaDecodeTime
  if (!Number.isFinite(base) || !(timescale > 0)) return null
  return { from: base / timescale }
}

const nowMs = () =>
  typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now()

/** Hand the event loop one turn so rAF, MSE callbacks and input are not starved. */
function yieldToLoop() {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** 720p, the resolution `maxDecodeBatch` is calibrated against. */
const MAIN_THREAD_BASE_PIXELS = 1280 * 720

/**
 * Software decoding sink.
 *
 * HEVC is decoded with a libmedia wasm build (worker or main thread) and painted
 * to a canvas layered over the `<video>` element, while AAC keeps using the
 * platform decoder through an audio-only MediaSource. That leaves `player.media`
 * as the real `<video>` element, so the rest of xgplayer sees a normal player.
 *
 * Decoding is paced by the audio clock: the compressed packets are queued and
 * only decoded when playback comes within `maxFrameQueue` frames of them. A
 * software decoder is far faster than realtime, so decoding whole segments up
 * front would either exhaust memory or force the pacer to throw most frames
 * away before they were ever due.
 *
 * The audio half is appended *before* any video work, and the decode pump is
 * never awaited by an append. The element's clock is the audio-only MediaSource,
 * so a slow wasm decode sitting in front of an audio append starves the very
 * thing the video is paced by: the element raises `waiting`, xgplayer paints its
 * loading spinner, and the live edge keeps running away.
 */
export class SoftSink extends MediaSink {
  /**
   * @param {HTMLMediaElement} media
   * @param {import('./config').SoftDecodeOption} [options]
   * @param {object} [deps] injection seams used by tests/integrators
   */
  constructor(media, options = {}, deps = {}) {
    super()
    this._media = media || null
    this._options = getSoftDecodeOptions(options)
    this._deps = deps
    this._clockFn =
      typeof deps.getClock === 'function'
        ? deps.getClock
        : () => {
            const element = this._media
            return element && Number.isFinite(element.currentTime)
              ? element.currentTime
              : 0
          }
    this._pacer = createFramePacer({
      getClock: () => this._clock(),
      dropLateFrames: this._options.dropLateFrames,
      lateFrameThreshold: this._options.lateFrameThreshold,
      maxFrameQueue: this._options.maxFrameQueue,
      maxQueuedBytes: this._options.maxQueuedBytes
    })
    this._audio = new AudioOutput(this._media, this._options, deps)
    /** Container time, in seconds, that the media timeline starts at; `null` until locked. */
    this._origin = null
    /** `currentTime` the first appended batch is meant to play at. */
    this._start = 0
    this._canvas = null
    this._renderer = null
    this._decoder = null
    this._decoderKey = ''
    /** Compressed packets waiting for their turn in front of the clock. */
    this._pending = []
    /** Container timescale of the packets in `_pending`. */
    this._timescale = 1
    /**
     * Duration of one picture in `timescale` ticks, measured from the stream.
     * Carried between appends because a live reader can hand over a single
     * picture at a time, and one picture cannot measure itself.
     */
    this._frameTicks = 0
    /**
     * Set when the packet backlog was cut mid-GOP: HEVC inter prediction needs
     * an IRAP before the decoder output is meaningful again.
     */
    this._resyncing = false
    /** Frames discarded since `_resyncing` was set; bounds the suppression. */
    this._resyncFrames = 0
    /** Bumped by `reset()`/`destroy()` so in-flight work can discard results. */
    this._generation = 0
    this._pumping = false
    this._pumpPromise = null
    this._pumpRequested = false
    this._videoStarted = false
    this._size = { width: 0, height: 0 }
    this._duration = -1
    this._ticking = false
    this._rafId = null
    this._timerId = null
    this._task = Promise.resolve()
    this._endQueued = false
    this._eos = false
    this._flushed = false
    this._finalizing = false
    this._destroyed = false
    this._destroyedPromise = null
    this._lastError = null
    this._stats = {
      decoded: 0,
      rendered: 0,
      dropped: 0,
      /** Packets shed by the live-edge catch-up before they were ever decoded. */
      caughtUp: 0,
      /** Frames thrown away while waiting for a keyframe after a mid-GOP cut. */
      suppressed: 0,
      /** Resyncs that ran out of patience and painted without a keyframe. */
      resyncAbandoned: 0,
      queue: 0,
      decoder: null,
      variant: null
    }
  }

  get kind() {
    return SinkKind.SOFT
  }

  get media() {
    return this._media
  }

  get canvas() {
    return this._canvas
  }

  get renderer() {
    return this._renderer
  }

  get blobUrl() {
    return this._audio.blobUrl
  }

  get audioOutput() {
    return this._audio
  }

  get isOpened() {
    return !!this._media
  }

  get videoWidth() {
    return this._size.width
  }

  get videoHeight() {
    return this._size.height
  }

  get duration() {
    return this._duration
  }

  set duration(value) {
    this.updateDuration(value)
  }

  get stats() {
    return {
      ...this._stats,
      queue: this._pacer.size,
      pending: this._pending.length,
      resyncing: this._resyncing
    }
  }

  get lastError() {
    return this._lastError
  }

  /**
   * Drop-in entry point for the legacy `_softVideo.appendBuffer(video, audio)`
   * call sites. Work is serialised so batches decode in arrival order.
   * @param {import('xgplayer-transmuxer').VideoTrack} [videoTrack]
   * @param {import('xgplayer-transmuxer').AudioTrack} [audioTrack]
   * @param {{start?: number}} [info] where this batch belongs on the timeline
   * @returns {Promise<void>}
   */
  appendBuffer(videoTrack, audioTrack, info) {
    const video = snapshotVideo(videoTrack, this._frameTicks)
    const anchor = audioAnchor(audioTrack)
    const start = info?.start
    const generation = this._generation
    this._task = this._task
      .then(() => this._append(video, audioTrack, anchor, start, generation))
      .catch((error) => this._onError(error))
    return this._task
  }

  /** Unified `MediaSink.append` alias used by `SinkManager` consumers. */
  append(videoTrack, audioTrack, info) {
    return this.appendBuffer(videoTrack, audioTrack, info)
  }

  /** @returns {boolean} true when a reset or destroy happened while awaiting. */
  _stale(generation) {
    return this._destroyed || generation !== this._generation
  }

  async _append(video, audioTrack, anchor, start, generation) {
    if (this._stale(generation)) return
    this._establishTimeline(video, anchor, start)
    // First the clock, then the pictures. Everything after this point may take
    // as long as it likes without putting the element out of data.
    await this._audio.append(audioTrack, video?.span)
    if (this._stale(generation) || !video) return
    await this._ensureRenderer()
    this._syncSize(video)
    this._timescale = video.timescale
    if (video.frameTicks) this._frameTicks = video.frameTicks
    // The decoder is settled before the head filter runs, because retiring one
    // and building a replacement is what clears the "first keyframe seen" state.
    await this._ensureDecoder(video)
    if (this._stale(generation)) return
    const packets = this._filterStart(video.packets)
    if (packets.length) this._pending.push(...packets)
    this._trimPending()
    // Deliberately not awaited: the pump is paced by `_tick`, so the caller can
    // feed the next batch while this one is still being decoded.
    this._pump()
  }

  /**
   * Lock the demuxer timeline to the media timeline, once.
   *
   * HLS fragments carry the absolute `tfdt` of the source mp4 (hours into a
   * recording), while the element plays from `segment.start`. The hardware path
   * shifts both SourceBuffers with `setTimeoffset()`; here the video half is
   * decoded in the demuxer timeline, so one number does the same job: `_origin`
   * is added to `currentTime` by `_clock()`, and its negative is handed to the
   * audio MSE as a `timestampOffset`.
   *
   * The audio track is the anchor rather than `min(video, audio)`, because the
   * MSE the element reads is audio-only. A hole at the head of that MSE stalls
   * playback outright, while video pictures that precede the first audio sample
   * are a fraction of a frame and are shed by the late-frame rule, so the A/V
   * relationship is preserved and the element never waits for data it lacks.
   *
   * @param {{span: {from: number, to: number}}|null} video
   * @param {{from: number}|null} anchor audio start of this batch, in container
   *   seconds, read before the demuxer could move it
   * @param {number} [start]
   */
  _establishTimeline(video, anchor, start) {
    if (this._origin !== null) return
    let origin = null
    if (anchor && Number.isFinite(anchor.from)) {
      origin = anchor.from
    }
    if (origin === null) {
      // Video only: the silent track is synthesised across the video span, so
      // the span start is the same number.
      if (!video?.span || !Number.isFinite(video.span.from)) return
      origin = video.span.from
    }
    this._start = Number.isFinite(start) ? start : 0
    this._origin = origin
    this._audio.setTimeline(this._start - this._origin)
  }

  /**
   * Decode queued packets while the backlog is narrower than the memory budget.
   *
   * Three caps keep the backlog honest: `maxFrameQueue` counts pictures,
   * `maxQueuedBytes` counts the raw YUV behind them, and `maxDecodeLead` limits
   * how far past the audio clock the newest queued picture may sit.
   * `maxDecodeBatch` then bounds one turn of the loop, so a synchronous wasm
   * decode cannot sit on the main thread long enough to be felt as a hang.
   *
   * Every cap is checked *before* a batch is handed to the decoder. Checking
   * them afterwards does not work: `push()` sheds the oldest frame when the
   * queue is over budget, which frees the very room the loop was testing, so a
   * big-resolution stream (where the byte valve bites long before the frame
   * count does) decoded straight to the end of the stream and evicted nearly
   * every picture it produced. That shows up as a black canvas with a `dropped`
   * count in the hundreds.
   *
   * The decoder is stateful, so packets stay in presentation order and may be
   * handed over in arbitrarily small batches. Re-entrant calls mark the pump so
   * packets queued while a decode is in flight are not stranded.
   */
  async _pump() {
    if (this._pumping) {
      this._pumpRequested = true
      return this._pumpPromise
    }
    const generation = this._generation
    this._pumping = true
    this._pumpPromise = (async () => {
      try {
        do {
          this._pumpRequested = false
          while (!this._stale(generation) && this._decoder && this._pending.length) {
            const budget = this._decodeBudget()
            if (!budget) break
            const batch = this._pending.splice(0, budget)
            // A mid-GOP cut is only undone by an IRAP, and the packets know about
            // it even when the decoder does not report key frames.
            const anchored = this._resyncing && batch.some((packet) => packet.keyframe)
            const startedAt = nowMs()
            const frames = await this._decoder.decode(batch)
            if (this._stale(generation)) return
            const count = frames?.length || 0
            this._stats.decoded += count
            this._stats.decoder = this._decoder.kind
            if (this._decoder.variant) this._stats.variant = this._decoder.variant
            const paintable = count ? this._filterResync(frames, anchored) : frames
            if (paintable?.length) {
              this._pacer.push(paintable)
              this._startTicking()
            }
            // A wasm decode is synchronous inside the call, so the only way to
            // keep the element, the renderer and the UI responsive is to hand
            // the event loop a turn once a batch has eaten its time slice.
            if (
              this._pending.length &&
              nowMs() - startedAt >= this._options.maxDecodeSliceMs
            ) {
              await yieldToLoop()
              if (this._stale(generation)) return
            }
          }
        } while (this._pumpRequested && !this._stale(generation))
      } catch (error) {
        this._onError(error)
      } finally {
        this._pumping = false
        this._pumpPromise = null
      }
    })()
    return this._pumpPromise
  }

  /**
   * Drop decoded pictures that cannot be trusted yet after a mid-GOP cut.
   *
   * Once the backlog was trimmed to a keyframe, whatever the decoder still holds
   * from the previous GOP is garbage, and FFmpeg says so with "Duplicate POC in a
   * sequence". Suppressing the output until the first key frame comes back keeps
   * those artefacts off the canvas.
   *
   * Two escape hatches keep that gate from turning into a permanent black screen.
   * `anchored` reports that the batch which produced these frames contained an
   * IRAP packet, which is proof from the bitstream that clean pictures follow even
   * when the decoder leaves `AVFrame.keyFrame` unset. And suppression is capped:
   * a picture with artefacts beats no picture at all.
   *
   * @param {object[]} frames in decode order
   * @param {boolean} [anchored] whether the decoded batch carried an IRAP
   * @returns {object[]|null} the frames that may be painted
   */
  _filterResync(frames, anchored) {
    if (!this._resyncing) return frames
    let at = -1
    for (let i = 0; i < frames.length; i += 1) {
      if (frames[i]?.key) {
        at = i
        break
      }
    }
    if (at < 0 && anchored) at = 0
    if (at < 0) {
      this._stats.suppressed += frames.length
      this._resyncFrames += frames.length
      if (this._resyncFrames < MAX_RESYNC_FRAMES) return null
      this._stats.resyncAbandoned += 1
      at = 0
    }
    this._resyncing = false
    this._resyncFrames = 0
    if (at) this._stats.suppressed += at
    return at ? frames.slice(at) : frames
  }

  /**
   * Shed compressed packets the clock has already passed.
   *
   * Without this the decoder works through the whole backlog, every picture it
   * produces is already late, the pacer throws all of them away, and a stream
   * that fell behind once can never catch up: the canvas freezes while the CPU
   * spins. Cutting the backlog *before* decoding is what keeps a live stream at
   * the live edge.
   *
   * The cut only ever lands on a keyframe. HEVC P and B pictures predict from
   * references, so a run that starts mid-GOP decodes to corruption; when no
   * keyframe is in reach the backlog is left alone, because those packets are
   * still decodable and the next round will find an IRAP.
   *
   * The cut also never reaches past the clock. Pictures the player has not
   * asked for yet are not a backlog, they are the prebuffer of a stream being
   * read ahead of playback, and a volume of them is normal: a video on demand
   * load fetches every segment in a fraction of a second while the decoder is
   * paced in real time. Shedding them, which an earlier revision of this
   * function did by hunting backwards for the newest keyframe, left the canvas
   * holding one picture from the end of the file, 30 seconds past the playhead,
   * frozen there for the rest of the programme.
   */
  _trimPending() {
    const { lateFrameThreshold, maxPendingPackets } = this._options
    const pending = this._pending
    const timescale = this._timescale > 0 ? this._timescale : 1
    if (!pending.length) return

    let late = 0
    if (lateFrameThreshold > 0) {
      const limit = this._clock() - lateFrameThreshold
      while (late < pending.length && pending[late].pts / timescale < limit) late += 1
    }

    let cut = 0
    if (late > 0) {
      // Move forwards to the first packet that may legally start a decode run.
      let at = late
      while (at < pending.length && !pending[at].keyframe) at += 1
      if (at < pending.length) {
        cut = at
      } else if (maxPendingPackets > 0 && pending.length > maxPendingPackets) {
        // No IRAP in reach, but the compressed queue is over budget anyway, so
        // cut at the clock and let the resync gate cover the mid-GOP head.
        cut = late
      }
    }

    if (cut <= 0) return
    if (!pending[cut]?.keyframe) this._resyncing = true
    this._pending = pending.splice(cut)
    this._stats.caughtUp += cut
    if (this._options.openLog) {
      console.warn('[xgplayer-soft-decode] catch-up, shed', cut, 'packets')
    }
  }

  /**
   * How many packets may be decoded right now. `0` means the backlog is full and
   * the pump has to wait for the clock to eat a few frames.
   * @returns {number}
   */
  _decodeBudget() {
    const { maxFrameQueue, maxQueuedBytes, maxDecodeBatch, maxDecodeLead } = this._options
    const pacer = this._pacer
    if (maxDecodeLead > 0) {
      const last = pacer.lastPts
      if (Number.isFinite(last) && last - this._clock() > maxDecodeLead) return 0
    }
    let room = this._decodeBatchSize(maxDecodeBatch)
    if (maxFrameQueue > 0) room = Math.min(room, maxFrameQueue - pacer.size)
    const frameBytes = this._frameBytes()
    if (maxQueuedBytes > 0 && frameBytes > 0) {
      room = Math.min(room, Math.floor((maxQueuedBytes - pacer.bytes) / frameBytes))
    }
    return room >= 1 ? Math.floor(room) : 0
  }

  /**
   * Packets per batch, scaled so one batch costs about the same wall time
   * whatever the resolution.
   *
   * Only matters on the main thread: `maxDecodeBatch` is tuned for 720p and the
   * same count at 1440p is four times the synchronous wasm work, which lands as
   * stutter in the element and the controls. A worker absorbs the bigger batch
   * and amortises the round trip better, so it keeps the configured size.
   *
   * @param {number} maxDecodeBatch
   * @returns {number}
   */
  _decodeBatchSize(maxDecodeBatch) {
    if (!this._decoder || this._decoder.kind !== 'main') return maxDecodeBatch
    const pixels = this._size.width * this._size.height
    if (!pixels || pixels <= MAIN_THREAD_BASE_PIXELS) return maxDecodeBatch
    return Math.max(1, Math.round((maxDecodeBatch * MAIN_THREAD_BASE_PIXELS) / pixels))
  }

  /**
   * Packed size of one decoded picture, estimated from the coded frame size.
   * @returns {number} bytes, `0` while the stream description is unknown
   */
  _frameBytes() {
    const { width, height } = this._size
    if (!width || !height) return 0
    // yuv420p; every planar layout the renderer accepts stays under 2 bytes/px.
    return Math.ceil(width * height * 1.5)
  }

  /**
   * HEVC pictures before the first IRAP reference frames we never received,
   * so a stream that starts mid-GOP must drop them instead of asking the
   * decoder to reconstruct references it never received.
   * @param {{keyframe?: boolean}[]} packets
   * @returns {{keyframe?: boolean}[]}
   */
  _filterStart(packets) {
    if (this._videoStarted) return packets
    const first = packets.findIndex((packet) => packet.keyframe)
    // No keyframe flag at all means the producer does not report them;
    // trimming there would silently discard the whole stream.
    if (first < 0) return packets
    this._videoStarted = true
    return first === 0 ? packets : packets.slice(first)
  }

  async _ensureRenderer() {
    if (this._renderer || this._destroyed) return
    this._canvas = ensureOverlayCanvas(this._media, this._options, this._deps)
    if (!this._canvas) return
    const factory = this._deps.createRenderer || createCanvasRenderer
    this._renderer = factory(this._canvas, {})
  }

  _syncSize(video) {
    if (!video.width || !video.height) return
    this._size = { width: video.width, height: video.height }
    syncMediaSize(this._media, this._size)
  }

  async _ensureDecoder(video) {
    const key = decoderKeyOf(video)
    if (this._decoder && this._decoderKey === key) return
    // Only a real replacement invalidates the keyframe state. Retiring `null`
    // on the first creation cleared `_videoStarted` right after `_filterStart`
    // had set it, so every stream re-trimmed its own head on the second batch.
    if (this._decoder) await this._teardownDecoder()
    this._decoder = await createDecoder({
      video,
      options: this._options,
      deps: this._deps
    })
    this._decoderKey = key
  }

  async _teardownDecoder() {
    const decoder = this._decoder
    this._decoder = null
    this._decoderKey = ''
    this._videoStarted = false
    if (decoder) {
      try {
        await decoder.destroy()
      } catch (_error) {
        // Teardown must never throw into the append chain.
      }
    }
  }

  _clock() {
    const value = this._clockFn()
    if (!Number.isFinite(value)) return 0
    return this._origin === null ? value : value + (this._origin - this._start)
  }

  _startTicking() {
    if (this._ticking || this._destroyed) return
    this._ticking = true
    this._scheduleTick()
  }

  _scheduleTick() {
    const raf = this._deps.requestAnimationFrame || globalThis.requestAnimationFrame
    if (typeof raf === 'function') {
      this._rafId = raf(() => this._tick())
    } else {
      this._timerId = setTimeout(() => this._tick(), 16)
    }
  }

  _cancelTick() {
    const cancel = this._deps.cancelAnimationFrame || globalThis.cancelAnimationFrame
    if (this._rafId !== null && typeof cancel === 'function') cancel(this._rafId)
    if (
      this._rafId !== null &&
      typeof this._rafId === 'number' &&
      typeof clearTimeout === 'function'
    ) {
      clearTimeout(this._rafId)
    }
    if (this._timerId !== null) clearTimeout(this._timerId)
    this._rafId = null
    this._timerId = null
    this._ticking = false
  }

  _tick() {
    this._rafId = null
    this._timerId = null
    if (this._destroyed) {
      this._ticking = false
      return
    }
    const result = this._pacer.take(this._clock())
    if (result.frame && this._renderer) {
      if (this._renderer.render(result.frame)) this._stats.rendered += 1
    }
    this._stats.dropped += result.dropped + this._pacer.consumeDropped()
    this._stats.queue = this._pacer.size

    if (this._pending.length) this._pump()

    // At end of stream the clock can stop a hair short of the last frame; do
    // not spin on a frame the media will never reach.
    const stalledAtEos = this._eos && this._pacer.size > 0 && this._mediaEnded()
    if (this._pending.length || (this._pacer.size && !stalledAtEos)) {
      this._scheduleTick()
    } else {
      this._ticking = false
      if (this._eos) this._finalizeEos()
    }
  }

  _mediaEnded() {
    const media = this._media
    if (!media) return false
    if (media.ended) return true
    const duration = media.duration
    return (
      Number.isFinite(duration) && duration > 0 && media.currentTime >= duration - 1e-3
    )
  }

  async updateDuration(duration) {
    this._duration = duration
    await this._audio.updateDuration(duration)
  }

  /**
   * The only MediaSource here is the audio-only one, so it is what has to carry
   * the live window that `media.seekable` reports.
   * @param {number} start
   * @param {number} end
   */
  setLiveSeekableRange(start, end) {
    this._audio.setLiveSeekableRange(start, end)
  }

  /**
   * The audio MediaSource ends as soon as its segments are appended, but the
   * video half keeps draining from the packet queue until the clock walks past
   * the last frame. `_tick` drives that and calls `_finalizeEos` when the queue
   * empties.
   */
  async endOfStream() {
    if (this._endQueued) return
    this._endQueued = true
    this._eos = true
    await this._task.catch(() => {})
    await this._audio.endOfStream()
    if (!this._destroyed) this._startTicking()
  }

  /** Drain the decoder once, then paint whatever the clock never reached. */
  async _finalizeEos() {
    if (this._destroyed || this._finalizing) return
    this._finalizing = true
    try {
      // Packets can still be in front of the decoder when the audio says it is
      // done; draining underneath a running pump would lose the last pictures.
      if (this._pumpPromise) await this._pumpPromise
    } catch (_error) {
      // The pump reports its own failures.
    }
    if (!this._flushed) {
      this._flushed = true
      if (this._decoder) {
        try {
          const frames = await this._decoder.flush()
          if (this._destroyed) return
          const paintable = frames?.length ? this._filterResync(frames) : frames
          if (paintable?.length) {
            this._pacer.push(paintable)
            this._startTicking()
            return
          }
        } catch (_error) {
          // A flaky drain must not block the audio EOS.
        }
      }
    }
    let last = null
    let next
    while ((next = this._pacer.flush())) last = next.frame
    if (last && this._renderer) {
      if (this._renderer.render(last)) this._stats.rendered += 1
    }
    this._stats.queue = this._pacer.size
  }

  isFull() {
    return false
  }

  async evict(start, end) {
    await this._audio.evict(start, end)
  }

  async reset(reuse = false) {
    // Anything still in flight belongs to the timeline being left behind.
    this._generation += 1
    this._pacer.clear()
    this._pacer.consumeDropped()
    this._pending = []
    this._resyncing = false
    this._resyncFrames = 0
    this._timescale = 1
    this._frameTicks = 0
    this._stats.queue = 0
    this._endQueued = false
    this._eos = false
    this._flushed = false
    this._finalizing = false
    // Re-locked from the next batch's `start`, which is how a seek is honoured.
    this._origin = null
    this._start = 0
    await this._teardownDecoder()
    await this._audio.reset(reuse)
  }

  destroy() {
    if (!this._destroyedPromise) {
      this._destroyedPromise = this._destroy()
    }
    return this._destroyedPromise
  }

  async _destroy() {
    if (this._destroyed) return
    this._destroyed = true
    this._generation += 1
    this._cancelTick()
    this._pacer.clear()
    this._pending = []
    await this._teardownDecoder()
    try {
      await this._audio.destroy()
    } catch (_error) {
      // ignore
    }
    try {
      this._renderer?.destroy()
    } catch (_error) {
      // ignore
    }
    detachOverlayCanvas(this._canvas)
    this._canvas = null
    this._renderer = null
  }

  _onError(error) {
    this._lastError = error
    if (this._options.openLog) {
      console.warn('[xgplayer-soft-decode] append failed', error)
    }
  }
}

/**
 * Build a `SinkManager.createSoftSink` compatible factory.
 * @param {object} [baseOptions]
 * @returns {(context: object) => SoftSink}
 */
export function createSoftSinkFactory(baseOptions = {}) {
  return (context = {}) => {
    const { media, info = {}, options } = context
    const merged = { ...baseOptions, ...(options || {}) }
    const sink = new SoftSink(media, merged, merged.deps || {})
    if (info.codec) sink.codec = info.codec
    return sink
  }
}
