import { FMP4Demuxer, FMP4Remuxer, TsDemuxer } from '../../src'
import { concatUint8Array } from '../../src/utils'
import { readMovie } from '../test-utils'

/**
 * Remux the same movie twice into two separate fragments and bolt them into one
 * buffer, which is the shape a GB28181 recorder ships: a single segment carrying
 * several hundred moof boxes, each with its own tfdt.
 */
function dualMoofSegment() {
  const [file] = readMovie('ts-avc.ts')
  const demuxer = new TsDemuxer()
  const remuxer = new FMP4Remuxer(demuxer.videoTrack, demuxer.audioTrack)

  demuxer.demuxAndFix(file)
  const timescale = demuxer.videoTrack.timescale
  const firstBase = demuxer.videoTrack.baseMediaDecodeTime
  const firstCount = demuxer.videoTrack.samples.length
  const first = remuxer.remux(true)

  demuxer.demuxAndFix(file)
  const offset = timescale * 10
  demuxer.videoTrack.samples.forEach((sample) => {
    sample.pts += offset
    sample.dts += offset
  })
  demuxer.videoTrack.baseMediaDecodeTime += offset
  const secondBase = demuxer.videoTrack.baseMediaDecodeTime
  const second = remuxer.remux(false)

  return {
    data: concatUint8Array(first.videoInitSegment, first.videoSegment, second.videoSegment),
    firstBase,
    firstCount,
    secondBase,
    offset
  }
}

describe('FMP4Demuxer.demux', () => {
  const setup = () => {
    const segment = dualMoofSegment()
    const demuxer = new FMP4Demuxer()
    const { videoTrack } = demuxer.demux(segment.data, null)
    return { segment, videoTrack }
  }

  test('walks every moof of a segment', () => {
    const { segment, videoTrack } = setup()

    expect(videoTrack.samples.length).toBe(segment.firstCount * 2)
  })

  test('stamps each fragment against its own tfdt', () => {
    const { segment, videoTrack } = setup()
    const samples = videoTrack.samples
    const lastOfFirst = samples[segment.firstCount - 1]
    const firstOfSecond = samples[segment.firstCount]

    // Without the per-moof base the second fragment would be stamped with the
    // first one's tfdt, and the two would sit on top of each other.
    expect(firstOfSecond.pts).toBe(segment.secondBase)
    expect(firstOfSecond.pts).toBeGreaterThan(lastOfFirst.pts)
    // The remuxer advances the base by the first fragment's duration, so the
    // second fragment cannot land at a plain "offset" past the first sample.
    expect(firstOfSecond.pts - samples[0].pts).toBeGreaterThan(segment.offset)
  })

  test('relays baseMediaDecodeTime to where the samples really start', () => {
    const { segment, videoTrack } = setup()
    const samples = videoTrack.samples

    // Walking the moofs leaves the field at the *last* tfdt, a whole fragment
    // past the batch. Both the soft sink's timeline lock and `MP4.traf` read it,
    // so a stale value delays the audio and opens a hole per segment boundary.
    expect(segment.secondBase).toBeGreaterThan(segment.firstBase)
    expect(videoTrack.baseMediaDecodeTime).toBe(samples[0].pts)
    expect(videoTrack.baseMediaDecodeTime).toBeLessThan(samples[samples.length - 1].pts)
  })
})
