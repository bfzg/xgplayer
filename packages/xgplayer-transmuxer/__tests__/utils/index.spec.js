import { concatUint8Array, getHevcCodec, readBig32, UTF8 } from '../../src/utils'

describe('Utils', () => {

  test('getHevcCodec', () => {
    // Main profile, level 3.1, typical 0x60000000 compatibility flags
    expect(getHevcCodec({
      generalProfileSpace: 0,
      generalProfileIdc: 1,
      generalProfileCompatibilityFlags: 0x60000000,
      generalTierFlag: 0,
      generalLevelIdc: 93,
      generalConstraintIndicatorFlags: [0xb0, 0, 0, 0, 0, 0]
    })).toBe('hev1.1.6.L93.B0')

    // Main10 (compatibility bit reversed to 0x4), high tier, hvc1 prefix
    expect(getHevcCodec({
      generalProfileSpace: 0,
      generalProfileIdc: 2,
      generalProfileCompatibilityFlags: 0x20000000,
      generalTierFlag: 1,
      generalLevelIdc: 120,
      generalConstraintIndicatorFlags: [0x90, 0, 0, 0, 0, 0]
    }, 'hvc1')).toBe('hvc1.2.4.H120.90')

    // Non-empty profile space ("A") and intermediate zero constraint bytes kept
    expect(getHevcCodec({
      generalProfileSpace: 1,
      generalProfileIdc: 1,
      generalProfileCompatibilityFlags: 0x60000000,
      generalTierFlag: 0,
      generalLevelIdc: 90,
      generalConstraintIndicatorFlags: [0x01, 0, 0x02, 0, 0, 0]
    })).toBe('hev1.A1.6.L90.01.00.02')

    // Empty descriptor stays syntactically valid
    expect(getHevcCodec()).toBe('hev1.0.0.L0')
  })

  test('concatUint8Array', () => {
    expect(concatUint8Array()).toEqual(new Uint8Array([]))
    expect(concatUint8Array(
      new Uint8Array([1, 2]),
      new Uint8Array([3, 4]),
      new Uint8Array([5, 6]),
      new Uint8Array([]),
      new Uint8Array([7]),
      new Uint8Array([8]),
    )).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]))
    expect(concatUint8Array(
      undefined,
      null,
      new Uint8Array([1]),
      0,
      false,
      new Uint8Array([2]),
      null,
      new Uint8Array([3]),
      ''
    )).toEqual(new Uint8Array([1, 2, 3]))
    expect(concatUint8Array(undefined, null)).toEqual(new Uint8Array())
  })
 
  test('readBig32', () => {
    expect(readBig32([0, 0, 0, 0])).toBe(0)
    expect(readBig32([0xff, 0xff, 0xff, 0xff])).toBe(0xffffffff)
    expect(readBig32([0x99, 0x88, 0x77, 0x66])).toBe(0x99887766)
    expect(readBig32([0x0, 0x1, 0x2, 0x3])).toBe(0x00010203)
    expect(readBig32([0x1, 0x2, 0x3])).toBe(0x01020300)
    expect(readBig32([0x1, 0x2, undefined, 0x3])).toBe(0x01020003)
    expect(readBig32([0x1, undefined, 0x2, 0])).toBe(0x01000200)
  })

  test('UTF8::decode', () => {
    const data = new Uint8Array([228, 184, 128, 228, 186, 140, 228, 184, 137, 97, 98, 99, 240, 160, 174, 183, 190, 223, 6320])
    expect(UTF8.decode(data)).toBe('一二三abc𠮷�߰')
  })

})
