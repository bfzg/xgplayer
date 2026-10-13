import {
  SoftSink,
  createSoftSinkFactory,
  snapshotVideo,
  createSilentAudioTrack,
  fillSilentAudio,
  AAC_SAMPLES_PER_FRAME
} from 'xgplayer-soft-decode'
import { SinkKind } from 'xgplayer-streaming-shared'

const bytes = (...values) => new Uint8Array(values)

const makeVideoTrack = () => ({
  codec: 'hev1.1.6.L120.90',
  width: 1280,
  height: 720,
  timescale: 90000,
  vps: [bytes(0x01)],
  sps: [bytes(0x02)],
  pps: [bytes(0x03)],
  samples: [],
  exist () {
    return true
  }
})

const withSamples = (track, ptsList) => {
  track.samples = ptsList.map((pts) => ({ units: [bytes(0x26)], pts, dts: pts }))
  return track
}

const settle = async (turns = 12) => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
}

const makeHarness = ({
  frames = [{ pts: 0 }, { pts: 0.01 }],
  decodeError = null,
  options = {}
} = {}) => {
  const rendered = []
  const renderer = {
    render (frame) {
      rendered.push(frame)
      return true
    },
    destroy () {}
  }
  const canvas = { style: {}, classList: { contains: () => false } }
  const calls = { decoded: 0, flush: 0, destroyed: 0 }
  const session = {
    async decode (packets) {
      calls.decoded += packets.length
      if (decodeError) throw decodeError
      return frames
    },
    async flush () {
      calls.flush++
      return []
    },
    async destroy () {
      calls.destroyed++
    }
  }
  const mseInstances = []
  class FakeMSE {
    constructor () {
      this.isOpened = false
      this.url = 'blob:soft-audio'
      this.appended = []
      this.sources = []
      this.ended = 0
      this.timeoffsets = []
      mseInstances.push(this)
    }

    async open () {
      this.isOpened = true
    }

    createSource (type, mime) {
      this.sources.push({ type, mime })
    }

    setTimeoffset (type, value, info) {
      this.timeoffsets.push({ type, value, info })
    }

    async append (type, buffer) {
      this.appended.push(buffer)
    }

    async updateDuration () {}

    async endOfStream () {
      this.ended++
    }

    async bindMedia (media) {
      this.isOpened = true
      this.bound = media
    }

    async unbindMedia () {}

    clearAllBuffer () {}

    isFull () {
      return false
    }

    async clearBuffer () {}
  }

  let rafCallback = null
  const media = { currentTime: 0 }
  const deps = {
    MSE: FakeMSE,
    createCanvas: () => canvas,
    createRenderer: () => renderer,
    createDecoderSession: async () => session,
    getClock: () => media.currentTime,
    requestAnimationFrame: (cb) => {
      rafCallback = cb
      return 1
    },
    cancelAnimationFrame: () => {}
  }
  const sink = new SoftSink(media, { audioSampleRate: 48000, ...options }, deps)
  return {
    sink,
    media,
    canvas,
    rendered,
    session,
    calls,
    mseInstances,
    tick: () => {
      const cb = rafCallback
      rafCallback = null
      if (cb) cb()
    }
  }
}

describe('snapshotVideo', () => {
  test('copies the packets out and drains the shared samples array', () => {
    const track = withSamples(makeVideoTrack(), [0, 3000])
    const snapshot = snapshotVideo(track)

    expect(track.samples).toEqual([])
    expect(snapshot.codec).toBe('hev1.1.6.L120.90')
    expect(snapshot.width).toBe(1280)
    expect(snapshot.timescale).toBe(90000)
    expect(snapshot.vps[0]).toEqual(bytes(0x01))
    expect(snapshot.packets).toHaveLength(2)
    expect(Array.from(snapshot.packets[0].data)).toEqual([0, 0, 0, 1, 0x26])
    expect(snapshot.span.from).toBe(0)
    expect(snapshot.span.to).toBeCloseTo(6000 / 90000)
    // `pts` marks the start of a picture, so the span runs one frame past the
    // last stamp: two pictures at 0 and 3000 occupy 0..6000.
    expect(snapshot.frameTicks).toBe(3000)
  })

  test('measures a one picture batch instead of reporting an empty span', () => {
    // What a live FLV reader hands over most of the time: one sample, and the
    // container's own duration is the only frame rate on offer.
    const track = withSamples(makeVideoTrack(), [0])
    track.samples[0].duration = 3600
    const single = snapshotVideo(track)

    expect(single.span).toEqual({ from: 0, to: 3600 / 90000 })
    expect(single.frameTicks).toBe(3600)

    // Nothing measurable in this batch, so the previous one is carried over.
    const carried = snapshotVideo(withSamples(makeVideoTrack(), [90000]), 1500)
    expect(carried.span).toEqual({ from: 1, to: 1 + 1500 / 90000 })
    expect(carried.frameTicks).toBe(1500)
  })

  test('returns null and clears samples for a non-present track', () => {
    const track = { exist: () => false, samples: [1, 2] }
    expect(snapshotVideo(track)).toBe(null)
    expect(track.samples).toEqual([])
    expect(snapshotVideo(null)).toBe(null)
  })
})

describe('createSoftSinkFactory', () => {
  test('builds a soft sink and copies the codec hint from the context', () => {
    const factory = createSoftSinkFactory({
      deps: {
        createCanvas: () => ({ style: {}, classList: { contains: () => false } })
      }
    })
    const sink = factory({
      media: null,
      info: { codec: 'hev1.1.6.L120.90' },
      options: { threads: 1 }
    })

    expect(sink).toBeInstanceOf(SoftSink)
    expect(sink.kind).toBe(SinkKind.SOFT)
    expect(sink.codec).toBe('hev1.1.6.L120.90')
    expect(sink.isOpened).toBe(false)
  })

  test('answers what it can decode without building a sink', () => {
    const factory = createSoftSinkFactory()
    expect(typeof factory.canDecode).toBe('function')
    expect(factory.canDecode({ codec: 'hev1.1.6.L120.90' })).toBe(true)
    expect(factory.canDecode({ codec: 'avc1.64001f' })).toBe(false)
    expect(factory.canDecode('hvc1.1.6.L93.B0')).toBe(true)
    expect(factory.canDecode(null)).toBe(false)
  })

  test('honours softDecodeCodecs from the base options', () => {
    const factory = createSoftSinkFactory({ softDecodeCodecs: ['avc'] })
    expect(factory.canDecode({ codec: 'avc1.64001f' })).toBe(true)
    expect(factory.canDecode({ codec: 'hev1.1.6.L120.90' })).toBe(false)
  })
})

describe('SoftSink capabilities', () => {
  test('canDecode accepts a codec string, a mime type or a track', () => {
    const harness = makeHarness()
    expect(harness.sink.canDecode('hev1.1.6.L120.90')).toBe(true)
    expect(harness.sink.canDecode({ codec: 'hvc1.1.6.L93.B0' })).toBe(true)
    expect(harness.sink.canDecode('avc1.64001f')).toBe(false)
    expect(harness.sink.canDecode('video/mp4;codecs="avc1.42E01E"')).toBe(false)
    expect(harness.sink.canDecode(null)).toBe(false)
  })

  test('follows the softDecodeCodecs option', () => {
    const harness = makeHarness({ options: { softDecodeCodecs: ['avc'] } })
    expect(harness.sink.canDecode('avc1.64001f')).toBe(true)
    expect(harness.sink.canDecode('hev1.1.6.L120.90')).toBe(false)
  })
})

describe('SoftSink', () => {
  test('decodes, mirrors the size and paints the due frame on tick', async () => {
    const harness = makeHarness()
    const track = withSamples(makeVideoTrack(), [0, 3000])

    await harness.sink.append(track, null)

    expect(harness.calls.decoded).toBe(2)
    expect(harness.sink.stats.decoded).toBe(2)
    expect(harness.sink.stats.decoder).toBe('main')
    expect(harness.sink.videoWidth).toBe(1280)
    expect(harness.sink.videoHeight).toBe(720)
    expect(harness.sink.canvas).toBe(harness.canvas)

    harness.tick()
    expect(harness.rendered).toHaveLength(1)
    expect(harness.sink.stats.rendered).toBe(1)
    expect(harness.sink.stats.queue).toBe(1)
  })

  test('routes a decode failure into lastError instead of rejecting', async () => {
    const harness = makeHarness({ decodeError: new Error('wasm boom') })
    const track = withSamples(makeVideoTrack(), [0])

    await expect(harness.sink.append(track, null)).resolves.toBeUndefined()
    expect(harness.sink.lastError).toBeInstanceOf(Error)
    expect(harness.sink.lastError.message).toBe('wasm boom')
  })

  test('endOfStream drains the decoder, flushes the pacer and ends audio', async () => {
    const harness = makeHarness({ frames: [{ pts: 0 }, { pts: 0.5 }] })
    const track = withSamples(makeVideoTrack(), [0, 3000])
    const audio = createSilentAudioTrack()
    fillSilentAudio(audio, 0, AAC_SAMPLES_PER_FRAME * 2)

    await harness.sink.append(track, audio)
    await harness.sink.endOfStream()

    expect(harness.mseInstances[0].ended).toBe(1)

    harness.tick()
    expect(harness.sink.stats.rendered).toBe(1)

    harness.media.currentTime = 1
    harness.tick()
    await settle()

    expect(harness.calls.flush).toBe(1)
    expect(harness.sink.stats.rendered).toBe(2)
    expect(harness.sink.stats.queue).toBe(0)
  })

  test('reset clears the queue and retires the decoder', async () => {
    const harness = makeHarness()
    const track = withSamples(makeVideoTrack(), [0])

    await harness.sink.append(track, null)
    expect(harness.sink.stats.queue).toBe(2)

    await harness.sink.reset(true)
    expect(harness.calls.destroyed).toBe(1)
    expect(harness.sink.stats.queue).toBe(0)
    expect(harness.sink.stats.rendered).toBe(0)
  })

  test('starts decoding at the first keyframe of a mid-GOP chunk', async () => {
    const harness = makeHarness()
    const track = makeVideoTrack()
    track.samples = [
      { units: [bytes(0x02)], pts: 0, dts: 0, keyframe: false },
      { units: [bytes(0x02)], pts: 3000, dts: 3000, keyframe: false },
      { units: [bytes(0x26)], pts: 6000, dts: 6000, keyframe: true },
      { units: [bytes(0x02)], pts: 9000, dts: 9000, keyframe: false }
    ]

    await harness.sink.append(track, null)

    expect(harness.calls.decoded).toBe(2)
    expect(harness.sink._videoStarted).toBe(true)
  })

  test('keeps every packet when no IRAP is in sight', async () => {
    const harness = makeHarness()
    const track = makeVideoTrack()
    // TRAIL_R pictures: neither the container nor the bitstream offers an anchor.
    track.samples = [
      { units: [bytes(0x02)], pts: 0, dts: 0 },
      { units: [bytes(0x02)], pts: 3000, dts: 3000 }
    ]

    await harness.sink.append(track, null)

    expect(harness.calls.decoded).toBe(2)
    expect(harness.sink._videoStarted).toBe(false)
  })

  test('anchors a late backlog on a keyframe read from the bitstream', async () => {
    // A GB28181 recording decoded in software: the container flags no sample as
    // a keyframe, so only the NAL headers can say where a decode run may start.
    const harness = makeHarness()
    harness.media.currentTime = 0.2
    const track = makeVideoTrack()
    track.samples = [
      { units: [bytes(0x26)], pts: 0, dts: 0 },
      { units: [bytes(0x02)], pts: 3000, dts: 3000 },
      { units: [bytes(0x02)], pts: 6000, dts: 6000 },
      { units: [bytes(0x02)], pts: 9000, dts: 9000 },
      { units: [bytes(0x26)], pts: 12000, dts: 12000 }
    ]

    await harness.sink.append(track, null)
    await settle()

    // The clock passed the first three pictures; the cut landed on the IRAP.
    expect(harness.sink.stats.caughtUp).toBe(4)
    expect(harness.calls.decoded).toBe(1)
    expect(harness.sink.stats.resyncing).toBe(false)
  })

  test('leaves a late backlog intact when no IRAP follows', async () => {
    const harness = makeHarness()
    harness.media.currentTime = 0.2
    const track = makeVideoTrack()
    track.samples = [
      { units: [bytes(0x26)], pts: 0, dts: 0 },
      { units: [bytes(0x02)], pts: 3000, dts: 3000 },
      { units: [bytes(0x02)], pts: 6000, dts: 6000 },
      { units: [bytes(0x02)], pts: 9000, dts: 9000 }
    ]

    await harness.sink.append(track, null)
    await settle()

    // Shedding those packets would strand the decoder mid-GOP for nothing.
    expect(harness.sink.stats.caughtUp).toBe(0)
    expect(harness.calls.decoded).toBe(4)
  })

  test('never sheds the prebuffer of a stream read ahead of playback', async () => {
    // What a video on demand load looks like: every segment lands in one burst
    // while the decoder is paced in real time. Cutting to the newest keyframe
    // here, as an earlier revision did, stranded the canvas on a picture from
    // the end of the file with the audio still playing.
    const harness = makeHarness({ options: { maxPendingPackets: 3 } })
    const track = makeVideoTrack()
    track.samples = [
      { units: [bytes(0x26)], pts: 0, dts: 0 },
      { units: [bytes(0x02)], pts: 3000, dts: 3000 },
      { units: [bytes(0x26)], pts: 6000, dts: 6000 },
      { units: [bytes(0x02)], pts: 9000, dts: 9000 }
    ]

    await harness.sink.append(track, null)
    await settle()

    expect(harness.sink.stats.caughtUp).toBe(0)
    expect(harness.calls.decoded).toBe(4)
  })

  test('cuts a late backlog at the clock when the queue is over budget', async () => {
    // No IRAP anywhere behind the playhead to anchor on, so the packets the
    // player has already passed are dropped where they stand.
    const harness = makeHarness({ options: { maxPendingPackets: 3 } })
    harness.media.currentTime = 0.2
    const track = makeVideoTrack()
    track.samples = [
      { units: [bytes(0x26)], pts: 0, dts: 0 },
      { units: [bytes(0x02)], pts: 3000, dts: 3000 },
      { units: [bytes(0x02)], pts: 6000, dts: 6000 },
      { units: [bytes(0x02)], pts: 9000, dts: 9000 }
    ]

    await harness.sink.append(track, null)
    await settle()

    expect(harness.sink.stats.caughtUp).toBe(3)
    expect(harness.calls.decoded).toBe(1)
    expect(harness.sink.stats.resyncing).toBe(true)
  })

  test('ends a resync on the key frame the decoder reports', () => {
    const harness = makeHarness()
    harness.sink._resyncing = true

    const frames = [{ pts: 1 }, { pts: 2, key: true }]
    expect(harness.sink._filterResync(frames)).toEqual([frames[1]])
    expect(harness.sink._resyncing).toBe(false)
    expect(harness.sink.stats.suppressed).toBe(1)
  })

  test('ends a resync when the batch carried an IRAP the decoder cannot confirm', () => {
    // libmedia leaves `AVFrame.keyFrame` unset for some builds; an IRAP in the
    // packets is proof enough, and the alternative is a black canvas.
    const harness = makeHarness()
    harness.sink._resyncing = true

    const frames = [{ pts: 1 }]
    expect(harness.sink._filterResync(frames, true)).toEqual(frames)
    expect(harness.sink._resyncing).toBe(false)
    expect(harness.sink.stats.resyncAbandoned).toBe(0)
  })

  test('paints rather than suppress forever when no anchor ever arrives', () => {
    const harness = makeHarness()
    harness.sink._resyncing = true
    const junk = Array.from({ length: 100 }, (_, i) => ({ pts: i }))

    expect(harness.sink._filterResync(junk)).toBe(null)
    expect(harness.sink.stats.suppressed).toBe(100)
    expect(harness.sink._filterResync(junk)).toEqual(junk)
    expect(harness.sink._resyncing).toBe(false)
    expect(harness.sink.stats.resyncAbandoned).toBe(1)
  })

  test('does not trim once decoding has started', async () => {
    const harness = makeHarness()
    const first = makeVideoTrack()
    first.samples = [{ units: [bytes(0x26)], pts: 0, dts: 0, keyframe: true }]
    await harness.sink.append(first, null)
    expect(harness.sink._videoStarted).toBe(true)

    const second = makeVideoTrack()
    second.samples = [
      { units: [bytes(0x02)], pts: 3000, dts: 3000, keyframe: false },
      { units: [bytes(0x26)], pts: 6000, dts: 6000, keyframe: true }
    ]
    await harness.sink.append(second, null)

    expect(harness.calls.decoded).toBe(3)
  })

  test('destroy is idempotent and detaches the overlay canvas', async () => {
    const harness = makeHarness()
    const track = withSamples(makeVideoTrack(), [0])

    await harness.sink.append(track, null)
    const first = harness.sink.destroy()
    const second = harness.sink.destroy()

    expect(second).toBe(first)
    await first
    expect(harness.calls.destroyed).toBe(1)
    expect(harness.sink.canvas).toBe(null)
    expect(harness.sink.renderer).toBe(null)
  })
})

describe('SoftSink timeline offset', () => {
  /**
   * FLV and TS stamp baseMediaDecodeTime as "pts(ms) * timescale / 1000" while
   * samples[].pts stays in milliseconds, so the two cannot be compared: taking
   * the smaller one puts the clock a factor of timescale/1000 off.
   */
  const makeStreamAudio = () => {
    const track = createSilentAudioTrack({ sampleRate: 16000 })
    fillSilentAudio(track, 0, AAC_SAMPLES_PER_FRAME * 2)
    track.samples.forEach((sample, i) => {
      sample.pts = 30000 + i * 64
      sample.dts = sample.pts
    })
    track.baseMediaDecodeTime = 30000 * (track.timescale / 1000)
    return track
  }

  test('locks the offset to the audio base in container seconds', async () => {
    const harness = makeHarness({ options: { maxDecodeBatch: 0 } })
    const video = withSamples(makeVideoTrack(), [2700000, 2703000])

    await harness.sink.append(video, makeStreamAudio())

    // 30s of container time, so the batch starts 30s before the media timeline
    // the audio MSE is asked to shift its own clock by.
    expect(harness.sink._offset).toBe(-30)
    const offsets = harness.mseInstances[0].timeoffsets
    expect(offsets).toHaveLength(1)
    expect(offsets[0].value).toBe(-30)
    // The pictures are moved onto that timeline as well: 30s of 90kHz ticks.
    expect(harness.sink._pending.map((packet) => packet.pts)).toEqual([0, 3000])
  })

  test('falls back to the video span when the stream has no audio', async () => {
    const harness = makeHarness({ options: { maxDecodeBatch: 0 } })
    const video = withSamples(makeVideoTrack(), [2700000, 2703000])

    await harness.sink.append(video, null)

    expect(harness.sink._offset).toBe(-30)
    expect(harness.mseInstances[0].timeoffsets[0].value).toBe(-30)
    expect(harness.sink._pending.map((packet) => packet.pts)).toEqual([0, 3000])
  })

  test('keeps the offset while the source keeps counting', async () => {
    const harness = makeHarness({ options: { maxDecodeBatch: 0 } })
    await harness.sink.append(withSamples(makeVideoTrack(), [2700000]), null, { start: 0 })
    expect(harness.sink._offset).toBe(-30)

    // The next segment continues the fragment file: 30s + 4s of container time
    // belongs at 4s of media time.
    await harness.sink.append(withSamples(makeVideoTrack(), [3060000]), null, {
      start: 4
    })

    expect(harness.sink._offset).toBe(-30)
    expect(harness.sink.stats.timelineJumps).toBe(0)
  })

  test('re-anchors when the source restarts its clock', async () => {
    const harness = makeHarness({ options: { maxDecodeBatch: 0 } })
    await harness.sink.append(withSamples(makeVideoTrack(), [2700000]), null, { start: 0 })

    // A recording backend that stamps every fragment file from zero: 1s into the
    // new file, while the playlist says 100s.
    const next = withSamples(makeVideoTrack(), [90000])
    await harness.sink.append(next, null, { start: 100 })

    expect(harness.sink._offset).toBe(99)
    expect(harness.sink.stats.timelineJumps).toBe(1)
    expect(harness.mseInstances[0].timeoffsets.map((o) => o.value)).toEqual([-30, 99])
    // The pictures of the new file land where the playlist says they play.
    expect(harness.sink._pending.map((packet) => packet.pts)).toEqual([0, 9000000])
  })

  test('keeps what is queued for the current file when a later one is read ahead', async () => {
    const harness = makeHarness({ options: { maxDecodeBatch: 0 } })
    await harness.sink.append(withSamples(makeVideoTrack(), [2700000]), null, { start: 0 })
    await harness.sink.append(withSamples(makeVideoTrack(), [2700000 + 90000]), null, {
      start: 1
    })
    const queued = harness.sink._pending.length

    // The preloader reaches the next file long before playback gets there.
    await harness.sink.append(withSamples(makeVideoTrack(), [0]), null, { start: 205 })

    expect(harness.sink.stats.timelineJumps).toBe(1)
    // Nothing is thrown away: the pictures already decoded and queued for the
    // current file are still ahead of the playhead and still needed.
    expect(harness.sink._pending.length).toBe(queued + 1)
    expect(harness.sink._pending[0].pts).toBe(0)
    expect(harness.sink._pending[queued].pts).toBe(205 * 90000)
  })

  test('drops the queue when the clock moves backwards', async () => {
    const harness = makeHarness({ options: { maxDecodeBatch: 0 } })
    await harness.sink.append(withSamples(makeVideoTrack(), [0, 3000]), null, { start: 0 })
    expect(harness.sink._pending.length).toBe(2)

    harness.media.currentTime = 60
    harness.sink._tick()
    harness.media.currentTime = 12
    harness.sink._tick()

    expect(harness.sink._pending).toEqual([])
    expect(harness.sink.stats.queue).toBe(0)
  })

  test('keeps the queue when the clock only advances', async () => {
    const harness = makeHarness({ options: { maxDecodeBatch: 0 } })
    await harness.sink.append(withSamples(makeVideoTrack(), [0, 3000]), null, { start: 0 })

    harness.media.currentTime = 1
    harness.sink._tick()
    harness.media.currentTime = 1.2
    harness.sink._tick()

    expect(harness.sink._pending.length).toBe(2)
  })
})
