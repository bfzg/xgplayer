import {
  createSilentAudioTrack,
  fillSilentAudio,
  secondsToTicks,
  AAC_SAMPLES_PER_FRAME,
  DEFAULT_AUDIO_SAMPLE_RATE,
  DEFAULT_AUDIO_CHANNEL_COUNT
} from 'xgplayer-soft-decode'

describe('createSilentAudioTrack', () => {
  test('builds a present AAC track that can clock the <video>', () => {
    const track = createSilentAudioTrack()
    expect(track.present).toBe(true)
    expect(track.sampleRate).toBe(DEFAULT_AUDIO_SAMPLE_RATE)
    expect(track.channelCount).toBe(DEFAULT_AUDIO_CHANNEL_COUNT)
    expect(track.timescale).toBe(DEFAULT_AUDIO_SAMPLE_RATE)
    expect(track.samples).toEqual([])
    expect(track.codec).toMatch(/^mp4a\.40\./)
    expect(track.config.length).toBeGreaterThan(1)
  })

  test('accepts a custom sample rate', () => {
    const track = createSilentAudioTrack({ sampleRate: 44100, channelCount: 1 })
    expect(track.timescale).toBe(44100)
    expect(track.channelCount).toBe(1)
  })

  test('rejects a sample rate the AAC table cannot express', () => {
    expect(() => createSilentAudioTrack({ sampleRate: 12345 })).toThrow(/sample rate/)
  })
})

describe('fillSilentAudio', () => {
  test('fills frames of 1024 samples and reports the next pts', () => {
    const track = createSilentAudioTrack()
    const next = fillSilentAudio(track, 0, 48000)
    expect(track.samples.length).toBe(47)
    expect(track.samples[0].pts).toBe(0)
    expect(track.samples[1].pts).toBe(AAC_SAMPLES_PER_FRAME)
    expect(track.samples[0].data).toBe(track.samples[1].data)
    expect(next).toBe(48128)
  })

  test('starts from the requested offset and is a no-op for an empty span', () => {
    const track = createSilentAudioTrack()
    fillSilentAudio(track, 2048, 3072)
    expect(track.samples).toHaveLength(1)
    expect(track.samples[0].pts).toBe(2048)
    expect(fillSilentAudio(track, 5000, 5000)).toBe(5000)
  })
})

describe('secondsToTicks', () => {
  test('rounds seconds into timescale ticks', () => {
    expect(secondsToTicks(1.5, 1000)).toBe(1500)
    expect(secondsToTicks(0, 90000)).toBe(0)
    expect(secondsToTicks(undefined, 90000)).toBe(0)
  })
})
