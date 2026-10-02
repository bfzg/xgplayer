import {
  buildHevcExtradata,
  buildHevcPackets,
  hasIrap,
  hevcNalType,
  timeBaseOf,
  unitsToAnnexB
} from 'xgplayer-soft-decode'

const bytes = (...values) => new Uint8Array(values)

describe('unitsToAnnexB', () => {
  test('prefixes every unit with a 4-byte start code', () => {
    const out = unitsToAnnexB([bytes(0xaa), bytes(0xbb, 0xcc)])
    expect(Array.from(out)).toEqual([
      0, 0, 0, 1, 0xaa,
      0, 0, 0, 1, 0xbb, 0xcc
    ])
  })

  test('skips empty and missing units', () => {
    expect(unitsToAnnexB([null, bytes(), bytes(0x01)])).toEqual(bytes(0, 0, 0, 1, 0x01))
    expect(unitsToAnnexB([])).toEqual(new Uint8Array(0))
    expect(unitsToAnnexB(undefined)).toEqual(new Uint8Array(0))
  })
})

describe('buildHevcExtradata', () => {
  test('orders VPS, SPS, PPS', () => {
    const out = buildHevcExtradata({
      vps: [bytes(0x01)],
      sps: [bytes(0x02)],
      pps: [bytes(0x03)]
    })
    expect(Array.from(out)).toEqual([
      0, 0, 0, 1, 1,
      0, 0, 0, 1, 2,
      0, 0, 0, 1, 3
    ])
  })

  test('tolerates a missing track', () => {
    expect(buildHevcExtradata(undefined)).toEqual(new Uint8Array(0))
  })
})

describe('timeBaseOf', () => {
  test('uses the container timescale as the denominator of an AVRational', () => {
    expect(timeBaseOf(90000)).toEqual({ num: 1, den: 90000 })
    expect(timeBaseOf(1000)).toEqual({ num: 1, den: 1000 })
  })

  test('falls back to 90kHz for a missing or broken timescale', () => {
    expect(timeBaseOf(0)).toEqual({ num: 1, den: 90000 })
    expect(timeBaseOf(undefined)).toEqual({ num: 1, den: 90000 })
    expect(timeBaseOf(-1)).toEqual({ num: 1, den: 90000 })
  })
})

describe('hevcNalType', () => {
  test('reads the six bit type from the two byte header', () => {
    expect(hevcNalType(bytes(0x40, 0x01))).toBe(32) // VPS
    expect(hevcNalType(bytes(0x42, 0x01))).toBe(33) // SPS
    expect(hevcNalType(bytes(0x44, 0x01))).toBe(34) // PPS
    expect(hevcNalType(bytes(0x26))).toBe(19) // IDR_W_RADL
    expect(hevcNalType(bytes(0x02))).toBe(1) // TRAIL_R
  })

  test('reports nothing for an unreadable unit', () => {
    expect(hevcNalType(bytes())).toBe(-1)
    expect(hevcNalType(null)).toBe(-1)
  })
})

describe('hasIrap', () => {
  test('accepts every random access picture type', () => {
    // 16 << 1 .. 23 << 1, the BLA, IDR, CRA and reserved IRAP headers.
    for (const header of [0x20, 0x22, 0x24, 0x26, 0x28, 0x2a, 0x2c, 0x2e]) {
      expect(hasIrap([bytes(header, 0x01)])).toBe(true)
    }
  })

  test('rejects predicted pictures and parameter sets', () => {
    expect(hasIrap([bytes(0x02)])).toBe(false) // TRAIL_R
    // An access unit of parameter sets only carries no picture at all.
    expect(hasIrap([bytes(0x40), bytes(0x42), bytes(0x44)])).toBe(false)
    expect(hasIrap([bytes(0x4e)])).toBe(false) // SEI_PREFIX, 39
  })

  test('tolerates a missing or empty unit list', () => {
    expect(hasIrap([])).toBe(false)
    expect(hasIrap(undefined)).toBe(false)
    expect(hasIrap([null, bytes()])).toBe(false)
  })
})

describe('buildHevcPackets', () => {
  test('converts samples to Annex B packets on the rebased timeline', () => {
    // The demuxer fixers rebase `pts`/`dts` onto a zero clock and leave
    // `originPts`/`originDts` as the raw container stamp. Handing the raw value
    // to the decoder puts every picture ahead of the audio clock, so the pacer
    // never finds a frame that is due and drops the whole queue.
    const track = {
      samples: [
        { units: [bytes(0x26)], originPts: 1148800, originDts: 1148800, pts: 0, dts: 0 },
        { units: [bytes(0x02)], originPts: 1151800, originDts: 1151800, pts: 3000, dts: 3000 }
      ]
    }
    const packets = buildHevcPackets(track)
    expect(packets).toHaveLength(2)
    expect(Array.from(packets[0].data)).toEqual([0, 0, 0, 1, 0x26])
    expect(packets[0].pts).toBe(0)
    expect(packets[0].dts).toBe(0)
    expect(packets[1].pts).toBe(3000)
    expect(packets[1].dts).toBe(3000)
  })

  test('falls back to the origin stamps for tracks with no rebased pts', () => {
    const track = {
      samples: [
        { units: [bytes(0x01)], originPts: 10, originDts: 5 },
        { units: [], originPts: 20, originDts: 20 },
        { units: [bytes(0x03)], pts: 30 }
      ]
    }
    const packets = buildHevcPackets(track)
    expect(packets).toHaveLength(2)
    expect(packets[0].pts).toBe(10)
    expect(packets[0].dts).toBe(5)
    expect(packets[1].pts).toBe(30)
    // A sample without a dts cannot be reordered, so it paced as its pts.
    expect(packets[1].dts).toBe(30)
  })

  test('derives the keyframe flag when the container stays silent', () => {
    // Some `hvc1` tracks, GB28181 recordings among them, carry no sample flag.
    // Without a derived key the catch-up logic has nothing to anchor a decode
    // run on, sheds the backlog to an unanchored point, and the canvas is black.
    const packets = buildHevcPackets({
      samples: [
        {
          units: [bytes(0x40), bytes(0x42), bytes(0x44), bytes(0x26)],
          pts: 0,
          dts: 0
        },
        { units: [bytes(0x02)], pts: 3000, dts: 3000 }
      ]
    })

    expect(packets.map((packet) => packet.keyframe)).toEqual([true, false])
  })

  test('keeps a keyframe flagged by the container', () => {
    const packets = buildHevcPackets({
      samples: [{ units: [bytes(0x02)], pts: 0, dts: 0, keyframe: true }]
    })

    expect(packets[0].keyframe).toBe(true)
  })
})
