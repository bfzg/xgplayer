import { AAC, AudioSample, AudioTrack } from 'xgplayer-transmuxer'

export const DEFAULT_AUDIO_SAMPLE_RATE = 48000
export const DEFAULT_AUDIO_CHANNEL_COUNT = 2

/** AAC frames always carry 1024 samples (2048 for HE-AAC, which we do not emit). */
export const AAC_SAMPLES_PER_FRAME = 1024

/**
 * Build a minimal, valid AAC (LC) `AudioTrack` that can be remuxed to fMP4 on
 * its own.
 *
 * A pure-video HEVC stream would otherwise leave the `<video>` element with no
 * media at all, so `currentTime` never advances and the soft renderer has no
 * clock. Injecting a silent AAC track keeps the native playback clock, seek and
 * `duration` semantics identical to a real stream.
 *
 * @param {{sampleRate?: number, channelCount?: number, codec?: string}} [options]
 */
export function createSilentAudioTrack(options = {}) {
  const sampleRate = options.sampleRate || DEFAULT_AUDIO_SAMPLE_RATE
  const channelCount = options.channelCount || DEFAULT_AUDIO_CHANNEL_COUNT
  const samplingIndex = AAC.getRateIndexByRate(sampleRate)
  if (samplingIndex < 0) {
    throw new Error(
      `[xgplayer-soft-decode] unsupported silent audio sample rate ${sampleRate}`
    )
  }
  const { config, codec } = AAC._getConfig(samplingIndex, channelCount, 2)

  const track = new AudioTrack()
  track.id = 2
  track.codec = options.codec || codec
  track.sampleRate = sampleRate
  track.channelCount = channelCount
  track.sampleRateIndex = samplingIndex
  track.objectType = 2
  track.timescale = sampleRate
  track.config = config
  track.present = true
  track.samples = []
  return track
}

/**
 * Append silent AAC frames covering `[from, to)` in the track timescale.
 * Unit buffers are shared between frames because they are read-only.
 *
 * @param {import('xgplayer-transmuxer').AudioTrack} track
 * @param {number} from start in track timescale
 * @param {number} to end (exclusive) in track timescale
 * @returns {number} the next frame PTS
 */
export function fillSilentAudio(track, from, to) {
  if (!track) return 0
  const frame = AAC.getSilentFrame(track.codec, track.channelCount)
  if (!frame) return from
  let pts = Math.max(0, Math.round(from))
  const end = Math.round(to)
  while (pts < end) {
    track.samples.push(new AudioSample(pts, frame, AAC_SAMPLES_PER_FRAME))
    pts += AAC_SAMPLES_PER_FRAME
  }
  return pts
}

/** Seconds -> timescale ticks. */
export function secondsToTicks(seconds, timescale) {
  return Math.round((seconds || 0) * (timescale || 0))
}
