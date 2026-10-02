import { MSE } from 'xgplayer-streaming-shared'
import { FMP4Remuxer, VideoTrack } from 'xgplayer-transmuxer'
import {
  createSilentAudioTrack,
  DEFAULT_AUDIO_CHANNEL_COUNT,
  DEFAULT_AUDIO_SAMPLE_RATE,
  fillSilentAudio,
  secondsToTicks
} from './silent-track'

/** Seconds of silent clock kept past the newest picture being decoded. */
const DEFAULT_SILENT_FILL_AHEAD = 0.2

/**
 * Most silence synthesised by one append. A seek, or a stream with a hole in
 * it, must not make the clock chase hours of container time in a single go.
 */
const MAX_SILENT_FILL_SECONDS = 10

/**
 * Audio-only MSE output.
 *
 * The first version of soft decoding keeps AAC on the platform decoder: the
 * demuxed audio track is remuxed to fMP4 and pushed into an audio-only
 * `MediaSource` attached to the same `<video>` element the hard path would use.
 * That buys three things for free that a hand-rolled WebAudio clock does not:
 * `currentTime`, `buffered`, `duration`, seek and `playbackRate`.
 *
 * When the stream carries no audio at all a silent AAC track is synthesised so
 * the element still has a clock to advance.
 */
export class AudioOutput {
  /**
   * @param {HTMLMediaElement} media
   * @param {object} [options] soft decode options
   * @param {{MSE?: any}} [deps] injection seam for tests
   */
  constructor(media, options = {}, deps = {}) {
    this._media = media
    this._options = options
    this._deps = deps
    this._mse = null
    this._remuxer = null
    this._emptyVideoTrack = new VideoTrack()
    this._sourceCreated = false
    this._bound = false
    this._bindPromise = null
    this._pendingDuration = null
    this._duration = 0
    this._track = null
    this._trackCodec = ''
    this._silentTrack = null
    this._silentPts = 0
    /** Whether the silent clock has been anchored to the first video span. */
    this._silentSeeded = false
    /** `MediaSource.timestampOffset` for the audio track, in seconds. */
    this._timeOffset = 0
  }

  get blobUrl() {
    return this._mse?.url || null
  }

  get isOpened() {
    return !!this._mse?.isOpened
  }

  /** Whether the audio-only MediaSource is attached to the media element. */
  get isBound() {
    return this._bound
  }

  get mse() {
    return this._mse
  }

  get media() {
    return this._media
  }

  /**
   * Relocate the audio timeline so that container time `origin` plays at
   * `start`.
   *
   * The demuxer tracks for HLS keep the absolute `tfdt` stamps of the source
   * fragments, and the hardware path handles that with `setTimeoffset()` on the
   * video and audio SourceBuffers. The soft path remuxes an audio-only MSE from
   * the same tracks, so it needs the same shift or `currentTime` (0 based) can
   * never catch up with the buffered range.
   *
   * @param {number} offset seconds added to every decoded audio timestamp
   */
  setTimeline(offset) {
    const value = Math.abs(offset || 0) < 0.001 ? 0 : offset
    if (value === this._timeOffset) return
    this._timeOffset = value
    if (this._mse && this._sourceCreated) {
      this._mse.setTimeoffset(MSE.AUDIO, value, { source: 'soft-audio' })
    }
  }

  _createMse() {
    if (this._mse) return this._mse
    const MSEImpl = this._deps.MSE || MSE
    this._mse = new MSEImpl(null, {
      preferMMS: !!this._options.preferMMS,
      attachMode: this._options.attachMode
    })
    return this._mse
  }

  /**
   * Attach the audio-only MediaSource to the `<video>` element.
   *
   * `MSE.open()` only settles once `bindMedia()` has pointed the element at the
   * MediaSource object URL, so every append has to bind first. The promise is
   * cached because binding is a one-time operation per MediaSource.
   * @param {HTMLMediaElement} [media]
   */
  bindMedia(media) {
    if (this._bound) return Promise.resolve(this._mse)
    if (this._bindPromise) return this._bindPromise
    const mse = this._createMse()
    this._bindPromise = (async () => {
      await mse.bindMedia(media || this._media)
      this._bound = true
      if (this._pendingDuration !== null) {
        const duration = this._pendingDuration
        this._pendingDuration = null
        await mse.updateDuration(duration)
      }
      return mse
    })()
    return this._bindPromise
  }

  /** Bind on demand; returns the MSE instance ready for `createSource`. */
  async _ensureBound() {
    if (this._bound) return this._mse
    return this.bindMedia(this._media)
  }

  /**
   * Feed one demuxed batch.
   * @param {import('xgplayer-transmuxer').AudioTrack | null} audioTrack
   * @param {{from: number, to: number}} [videoSpan] seconds the matching video covers
   * @returns {Promise<boolean>} true when a new SourceBuffer was created
   */
  async append(audioTrack, videoSpan) {
    const useTrack = this._selectTrack(audioTrack, videoSpan)
    if (!useTrack) return false

    let created = false
    if (!this._remuxer || this._trackCodec !== useTrack.codec) {
      this._remuxer = new FMP4Remuxer(
        this._emptyVideoTrack,
        useTrack,
        this._options.openLog ? {} : undefined
      )
      this._trackCodec = useTrack.codec
      this._track = useTrack
      this._sourceCreated = false
    }

    if (!useTrack.samples.length) return false

    const mse = await this._ensureBound()
    if (!this._sourceCreated) {
      mse.createSource(MSE.AUDIO, `audio/mp4;codecs=${useTrack.codec}`)
      // The op queue is FIFO per type, so this lands before the init segment.
      if (this._timeOffset) {
        mse.setTimeoffset(MSE.AUDIO, this._timeOffset, { source: 'soft-audio' })
      }
      const init = this._remuxer.remux(true)
      this._sourceCreated = true
      created = true
      if (init.audioInitSegment) await mse.append(MSE.AUDIO, init.audioInitSegment)
      if (init.audioSegment) await mse.append(MSE.AUDIO, init.audioSegment)
      return created
    }

    const result = this._remuxer.remux(false)
    if (result.audioSegment) await mse.append(MSE.AUDIO, result.audioSegment)
    return created
  }

  _selectTrack(audioTrack, videoSpan) {
    const hasAudio = !!(
      audioTrack &&
      typeof audioTrack.exist === 'function' &&
      audioTrack.exist()
    )
    if (hasAudio) return audioTrack

    if (!this._silentTrack) {
      this._silentTrack = createSilentAudioTrack({
        sampleRate: this._options.audioSampleRate || DEFAULT_AUDIO_SAMPLE_RATE,
        channelCount: this._options.audioChannelCount || DEFAULT_AUDIO_CHANNEL_COUNT
      })
      this._silentPts = 0
    }
    this._advanceSilentClock(videoSpan)
    // `MP4.traf` writes `tfdt` from this field and `trun` only carries sample
    // durations, so a track left at 0 restarts its timeline on every append and
    // the buffered range stops at the length of one batch.
    const samples = this._silentTrack.samples
    if (samples.length) {
      this._silentTrack.baseMediaDecodeTime = samples[0].pts
    }
    return this._silentTrack
  }

  /**
   * Grow the silent clock so it always covers the pictures being decoded.
   *
   * `_silentPts` marks the end of the contiguous fill and every append starts
   * there, so the audio SourceBuffer can never gain a hole. That matters more
   * than staying tight to the video: the element derives `currentTime` from
   * exactly this buffer, and a hole stops the clock dead, which in turn stops
   * the frame pump that was waiting for the clock to come near it.
   *
   * `silentFillAhead` leaves a little runway past the newest picture, so the
   * clock is never reading the last millisecond of what has arrived.
   *
   * @param {{from: number, to: number}} [videoSpan] container seconds covered
   *   by the video batch that is about to be decoded
   */
  _advanceSilentClock(videoSpan) {
    const track = this._silentTrack
    if (!track || !videoSpan || !Number.isFinite(videoSpan.to)) return

    if (!this._silentSeeded) {
      this._silentPts = Math.max(0, secondsToTicks(videoSpan.from, track.timescale))
      this._silentSeeded = true
    }

    const ahead =
      this._options.silentFillAhead === undefined
        ? DEFAULT_SILENT_FILL_AHEAD
        : this._options.silentFillAhead
    const target = secondsToTicks(videoSpan.to + ahead, track.timescale)
    const ceiling =
      this._silentPts + secondsToTicks(MAX_SILENT_FILL_SECONDS, track.timescale)
    if (target > ceiling && this._options.openLog) {
      console.warn(
        '[xgplayer-soft-decode] silent clock chasing video by',
        Math.round((target - this._silentPts) / track.timescale),
        's'
      )
    }
    const to = Math.min(target, ceiling)
    if (to <= this._silentPts) return
    this._silentPts = fillSilentAudio(track, this._silentPts, to)
  }

  async updateDuration(duration) {
    // `Infinity` is what the hardware path publishes for a live stream, and the
    // silent clock represents it just as well: the duration is unknown and the
    // buffered range decides what can play. A value that is not a number at all
    // is still dropped, because `MediaSource.duration` would take it literally.
    if (duration === undefined || duration === null || Number.isNaN(duration)) return
    this._duration = duration
    if (!this._mse || !this._bound) {
      this._pendingDuration = duration
      return
    }
    await this._mse.updateDuration(duration)
  }

  /**
   * Publish the live window, mirroring `MSE.setLiveSeekableRange`.
   *
   * Without it `media.seekable` stays empty while `duration` is `Infinity`, so
   * the progress bar has nothing to draw and a live stream looks broken even
   * while pictures are moving.
   *
   * @param {number} start
   * @param {number} end
   */
  setLiveSeekableRange(start, end) {
    if (this._mse && this._sourceCreated) this._mse.setLiveSeekableRange(start, end)
  }

  async endOfStream() {
    if (this._mse && this._sourceCreated) {
      await this._mse.endOfStream()
    }
  }

  async evict(start, end) {
    if (this._mse) await this._mse.clearBuffer(start, end)
  }

  isFull(type = MSE.AUDIO) {
    return !!this._mse?.isFull(type)
  }

  async reset(reuse = false) {
    if (this._remuxer) this._remuxer.reset()
    this._sourceCreated = false
    this._silentPts = 0
    this._silentSeeded = false
    this._timeOffset = 0
    if (this._silentTrack) this._silentTrack.samples = []
    if (this._mse && !reuse) {
      const media = this._mse.media || this._media
      await this._mse.unbindMedia()
      this._bound = false
      this._bindPromise = null
      this._sourceCreated = false
      if (this._duration > 0) {
        this._pendingDuration = this._duration
      }
      if (media) await this.bindMedia(media)
    }
  }

  async destroy() {
    this._mse?.clearAllBuffer?.()
    if (this._mse) {
      await this._mse.unbindMedia()
      this._mse = null
    }
    this._bound = false
    this._bindPromise = null
    this._pendingDuration = null
    this._remuxer = null
    this._track = null
    this._silentTrack = null
  }
}
