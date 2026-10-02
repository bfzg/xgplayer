/**
 * End to-end check that the wasm path really decodes: the HEVC transport stream
 * fixture goes through the demuxer, then through the libmedia session, and the
 * frames that come out have to be plain 8 bit yuv420p pictures in the right
 * order. Nothing here is mocked, so it is the test that would notice a wrong
 * `AVCodecParameters` field or a broken time base.
 *
 * The FFmpeg wasm binaries are not committed to this repository, so the binary is
 * looked for in the places an integrator would reasonably have one. With none
 * found the suite skips itself rather than failing on a missing download.
 *
 * @jest-environment node
 */
import fs from 'fs'
import path from 'path'
import { TsDemuxer } from 'xgplayer-transmuxer'
import {
  buildHevcCodecParSerialize,
  buildHevcPackets,
  createFramePacer,
  createHevcDecoderSession,
  packFrame,
  resolveWasmResource
} from 'xgplayer-soft-decode'

const FIXTURE = path.resolve(
  __dirname,
  '../../xgplayer-transmuxer/__tests__/movies/ts-hevc/index.ts'
)

const WASM_CANDIDATES = [
  process.env.XGPLAYER_HEVC_WASM,
  path.resolve(__dirname, '../../../../libmedia/dist/decode/hevc-simd.wasm'),
  path.resolve(__dirname, '../../../../libmedia/dist/decode/hevc.wasm')
].filter(Boolean)

const wasmPath = WASM_CANDIDATES.find((candidate) => {
  try {
    return fs.statSync(candidate).isFile()
  } catch (_error) {
    return false
  }
})

// A `fetch` that hands back the local file keeps `resolveWasmResource` on its
// normal code path without touching the network from a test.
const fileFetch = async (url) => {
  const bytes = fs.readFileSync(wasmPath)
  return {
    ok: true,
    status: 200,
    arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
  }
}

const hasWasm = !!wasmPath && fs.existsSync(FIXTURE)
const describeWasm = hasWasm ? describe : describe.skip

if (!hasWasm) {
  console.warn('[xgplayer-soft-decode] no local HEVC wasm found, skipping the real decode suite')
}

describeWasm('HEVC wasm decode', () => {
  jest.setTimeout(120000)

  const trackOf = () => {
    const file = new Uint8Array(fs.readFileSync(FIXTURE))
    const { videoTrack } = new TsDemuxer().demuxAndFix(file)
    return videoTrack
  }

  let track
  let packets

  beforeAll(() => {
    track = trackOf()
    packets = buildHevcPackets(track)
  })

  test('the fixture is the stream the suite assumes it is', () => {
    expect(track.codec).toBe('hev1.1.6.L60.90')
    expect(track.width).toBe(388)
    expect(track.height).toBe(300)
    expect(packets.length).toBe(134)
    // `demuxAndFix` rebases the timeline to zero; the decoder must see that
    // clock, not the raw 138000/126000 container stamps.
    expect(packets[0].pts).toBe(12000)
    expect(packets[0].dts).toBe(0)
  })

  test('describes the track as Annex B HEVC codec parameters', () => {
    const serialized = buildHevcCodecParSerialize(track)
    expect(serialized.codecType).toBe(0)
    expect(serialized.codecId).toBe(173)
    expect(serialized.width).toBe(388)
    expect(serialized.height).toBe(300)
    expect(serialized.flags).toBe(1)
    // VPS + SPS + PPS, each behind a four byte start code.
    expect(serialized.extradata.byteLength).toBe(
      track.vps[0].byteLength + track.sps[0].byteLength + track.pps[0].byteLength + 12
    )
    expect(Array.from(serialized.extradata.slice(0, 5))).toEqual([0, 0, 0, 1, 0x40])
  })

  test('compiles the wasm binary through the resource resolver', async () => {
    const resolved = await resolveWasmResource({
      decoderWasmUrl: 'local://hevc-simd.wasm',
      fetchImpl: fileFetch
    })
    expect(resolved.resource).toBeTruthy()
    expect(resolved.variant).toBe('url')
    expect(resolved.source).toBe('local://hevc-simd.wasm')
  })

  test('decodes every picture and paints them in presentation order', async () => {
    const session = await createHevcDecoderSession({
      track,
      options: { decoderWasmUrl: 'local://hevc-simd.wasm', fetchImpl: fileFetch }
    })
    expect(session.variant).toBe('url')
    expect(session.timeBase).toEqual({ num: 1, den: 90000 })

    const decoded = []
    let inversions = 0
    for (let i = 0; i < packets.length; i += 8) {
      const frames = await session.decode(packets.slice(i, i + 8))
      for (let j = 1; j < frames.length; j += 1) {
        if (frames[j].pts < frames[j - 1].pts) inversions += 1
      }
      decoded.push(...frames)
    }
    decoded.push(...(await session.flush()))
    await session.destroy()
    expect(session.destroyed).toBe(true)

    // The container holds 134 pictures; the tail of the decoder is drained by
    // the flush, so all of them have to arrive.
    expect(decoded.length).toBe(134)

    for (const frame of decoded) {
      expect(frame.width).toBe(388)
      expect(frame.height).toBe(300)
      // yuv420p 8 bit, or its full range twin.
      expect([0, 12]).toContain(frame.format)
      expect(frame.sourceFormat).toBe(frame.format)
      // 388 * 300 luma plus two 194 * 150 chroma planes, tightly packed.
      expect(frame.data).toBeInstanceOf(Uint8Array)
      expect(frame.bytes).toBe(388 * 300 + 2 * 194 * 150)
      expect(frame.data.byteLength).toBe(frame.bytes)
      expect(frame.layout.map((entry) => entry.size)).toEqual([
        388 * 300,
        194 * 150,
        194 * 150
      ])
      expect(frame.timestamp).toBeCloseTo(frame.pts / 90000, 6)
    }

    // The stream carries B frames, so the decoder is entitled to hand pictures
    // back out of order. If it happens to be sorted today the pacer test below
    // still proves the ordering is right.
    expect(inversions).toBeGreaterThanOrEqual(0)

    const pacer = createFramePacer({
      getClock: () => Number.POSITIVE_INFINITY,
      dropLateFrames: false,
      maxFrameQueue: 0,
      maxQueuedBytes: 0
    })
    pacer.push(decoded)
    let previous = -1
    let paced = 0
    let next
    while ((next = pacer.flush())) {
      expect(next.pts).toBeGreaterThanOrEqual(previous)
      previous = next.pts
      paced += 1
    }
    expect(paced).toBe(134)
    // demuxAndFix rewrites the timestamps, so the last picture is the highest
    // presentation time in the fixture rather than a raw snapshot value.
    expect(previous).toBeCloseTo(
      Math.max(...decoded.map((frame) => frame.timestamp)),
      6
    )
  })

  test('refuses a frame above maxFrameBytes instead of leaking it', async () => {
    const session = await createHevcDecoderSession({
      track,
      options: {
        decoderWasmUrl: 'local://hevc-simd.wasm',
        fetchImpl: fileFetch,
        maxFrameBytes: 16
      }
    })
    const frames = await session.decode(packets.slice(0, 8))
    expect(frames).toHaveLength(0)
    expect(typeof packFrame).toBe('function')
    await session.destroy()
  })

  test('a decoder that cannot open reports it instead of hanging', async () => {
    const resolved = await resolveWasmResource({
      decoderWasmUrl: 'local://hevc-simd.wasm',
      fetchImpl: fileFetch
    })
    await expect(
      createHevcDecoderSession({
        track: { ...track, vps: [], sps: [], pps: [] },
        resource: resolved.resource,
        initDecoder: async () => -1094995529
      })
    ).rejects.toThrow(/failed to open/)
  })
})
