import {
  AudioOutput,
  createSilentAudioTrack,
  fillSilentAudio,
  AAC_SAMPLES_PER_FRAME
} from 'xgplayer-soft-decode'

class FakeMSE {
  constructor () {
    this.opens = 0
    this.sources = []
    this.appended = 0
    this.ended = 0
    this.unbound = 0
    this.duration = 0
    this.isOpened = false
    this.url = 'blob:soft-audio'
  }

  async open () {
    this.opens++
    this.isOpened = true
  }

  createSource (type, mime) {
    this.sources.push({ type, mime })
  }

  async append (type, buffer) {
    this.appended++
    this.lastBuffer = buffer
  }

  async updateDuration (value) {
    this.duration = value
  }

  async endOfStream () {
    this.ended++
  }

  async unbindMedia () {
    this.unbound++
  }

  async bindMedia (media) {
    // The real MSE creates the MediaSource and resolves on sourceopen here.
    this.opens++
    this.isOpened = true
    this.bound = media
  }

  clearAllBuffer () {}

  isFull () {
    return false
  }

  async clearBuffer () {}
}

const makeOutput = (options = {}) => new AudioOutput(null, options, { MSE: FakeMSE })

describe('AudioOutput._selectTrack', () => {
  test('passes through a real audio track untouched', () => {
    const output = makeOutput()
    const audio = createSilentAudioTrack()
    fillSilentAudio(audio, 0, AAC_SAMPLES_PER_FRAME)

    expect(output._selectTrack(audio, { from: 0, to: 1 })).toBe(audio)
  })

  test('synthesises a silent track and extends it past each video span', () => {
    const output = makeOutput()
    const track = output._selectTrack(null, { from: 0, to: 1 })

    expect(track.exist()).toBe(true)
    expect(track.sampleRate).toBe(48000)
    // 1s of video plus the 0.2s of runway the clock is allowed to read into.
    expect(track.samples).toHaveLength(57)

    output._selectTrack(null, { from: 1, to: 2 })
    expect(track.samples).toHaveLength(104)
    // A span that is already covered must not add anything, let alone rewind.
    expect(output._selectTrack(null, { from: 0, to: 0.5 })).toBe(track)
    expect(track.samples).toHaveLength(104)
  })

  test('never leaves a hole in the silent clock when a live batch is one picture', () => {
    const output = makeOutput()

    // A single picture spans 40ms, so `from === to` was once an empty append.
    const track = output._selectTrack(null, { from: 0, to: 0.04 })
    expect(track.samples.length).toBeGreaterThan(0)

    const before = track.samples.length
    output._selectTrack(null, { from: 0.04, to: 0.08 })
    expect(track.samples.length).toBeGreaterThan(before)

    const stamps = track.samples.map((sample) => sample.pts)
    expect(stamps[0]).toBe(0)
    stamps.slice(1).forEach((stamp, i) => {
      expect(stamp - stamps[i]).toBe(AAC_SAMPLES_PER_FRAME)
    })
  })

  test('anchors the silent clock at the video start and caps one chase', () => {
    // Live streams can carry an absolute stamp hours into a recording.
    const output = makeOutput()
    const track = output._selectTrack(null, { from: 3600, to: 3600.04 })

    expect(track.samples[0].pts).toBe(3600 * 48000)
    expect(track.samples.length).toBeLessThan(47 * 2)

    // A gap (seek, or a hole in the recording) fills rather than jumps, and one
    // append chases at most 10s of clock instead of hours.
    const grown = track.samples.length
    const tail = track.samples[grown - 1].pts
    output._selectTrack(null, { from: 7200, to: 7200.04 })

    const added = track.samples.length - grown
    expect(added).toBeGreaterThan(0)
    expect(added).toBeLessThanOrEqual(Math.ceil((10 * 48000) / AAC_SAMPLES_PER_FRAME))
    expect(track.samples[grown].pts - tail).toBe(AAC_SAMPLES_PER_FRAME)
  })
})

describe('AudioOutput', () => {
  test('append is a no-op when the selected track has no samples', async () => {
    const output = makeOutput()
    await expect(output.append(null, undefined)).resolves.toBe(false)
    expect(output.mse).toBe(null)
  })

  test('creates one audio source and reuses it across batches', async () => {
    const output = makeOutput()
    const audio = createSilentAudioTrack()
    fillSilentAudio(audio, 0, AAC_SAMPLES_PER_FRAME * 2)

    await expect(output.append(audio, { from: 0, to: 0.05 })).resolves.toBe(true)
    const mse = output.mse
    expect(mse.opens).toBe(1)
    expect(mse.sources).toHaveLength(1)
    expect(mse.sources[0].type).toBe('audio')
    expect(mse.sources[0].mime).toMatch(/^audio\/mp4;codecs=mp4a\.40\./)
    expect(mse.appended).toBeGreaterThanOrEqual(1)
    expect(output.isOpened).toBe(true)
    expect(output.blobUrl).toBe('blob:soft-audio')

    fillSilentAudio(audio, AAC_SAMPLES_PER_FRAME * 2, AAC_SAMPLES_PER_FRAME * 4)
    await expect(output.append(audio, { from: 0.05, to: 0.1 })).resolves.toBe(false)
    expect(output.mse).toBe(mse)
    expect(mse.opens).toBe(1)
    expect(mse.sources).toHaveLength(1)
  })

  test('a codec change retires the remuxer and recreates the source', async () => {
    const output = makeOutput()
    const stereo = createSilentAudioTrack({ sampleRate: 48000, channelCount: 2 })
    const mono = createSilentAudioTrack({ sampleRate: 48000, channelCount: 1 })
    fillSilentAudio(stereo, 0, AAC_SAMPLES_PER_FRAME)
    fillSilentAudio(mono, 0, AAC_SAMPLES_PER_FRAME)

    await output.append(stereo, { from: 0, to: 0.02 })
    const mse = output.mse
    await output.append(mono, { from: 0.02, to: 0.04 })

    expect(mse.sources).toHaveLength(2)
    expect(mse.sources[1].mime).not.toBe(mse.sources[0].mime)
  })

  test('updateDuration opens the MSE lazily and forwards the value', async () => {
    const output = makeOutput()
    await output.updateDuration(12.5)
    expect(output.mse).toBe(null)

    await output.bindMedia()
    await output.updateDuration(12.5)
    expect(output.mse.opens).toBe(1)
    expect(output.mse.duration).toBe(12.5)
  })

  test('endOfStream only closes a source that was actually created', async () => {
    const idle = makeOutput()
    await idle.endOfStream()
    expect(idle.mse).toBe(null)

    const output = makeOutput()
    const audio = createSilentAudioTrack()
    fillSilentAudio(audio, 0, AAC_SAMPLES_PER_FRAME)
    await output.append(audio, { from: 0, to: 0.02 })
    await output.endOfStream()
    expect(output.mse.ended).toBe(1)
  })

  test('evict and destroy clear the buffer and drop the MSE reference', async () => {
    const output = makeOutput()
    const audio = createSilentAudioTrack()
    fillSilentAudio(audio, 0, AAC_SAMPLES_PER_FRAME)
    await output.append(audio, { from: 0, to: 0.02 })

    await output.evict(0, 1)
    await output.destroy()
    expect(output.mse).toBe(null)
    expect(output.blobUrl).toBe(null)
  })
})
