import { describeFrame, slicePlane, PIX_FMT, resolvePixFmt } from 'xgplayer-soft-decode'

describe('describeFrame', () => {
  test('describes planar 4:2:0 as three planes', () => {
    const described = describeFrame(PIX_FMT.YUV420P, 1920, 1080)
    expect(described.mode).toBe('yuv420p')
    expect(described.range).toBe('limited')
    expect(described.planes).toEqual([
      { width: 1920, height: 1080, kind: 'luma' },
      { width: 960, height: 540, kind: 'chroma' },
      { width: 960, height: 540, kind: 'chroma' }
    ])
  })

  test('full-range JPEG YUV uses the same planes with a full range flag', () => {
    expect(describeFrame(PIX_FMT.YUVJ420P, 640, 360).range).toBe('full')
  })

  test('NV12 and NV21 share one interleaved chroma plane, NV21 swapped', () => {
    const nv12 = describeFrame(PIX_FMT.NV12, 640, 360)
    const nv21 = describeFrame(PIX_FMT.NV21, 640, 360)
    expect(nv12.planes).toHaveLength(2)
    expect(nv12.planes[1]).toEqual({ width: 320, height: 180, kind: 'chroma-pair' })
    expect(nv12.swapUV).toBeFalsy()
    expect(nv21.swapUV).toBe(true)
  })

  test('BGRA is described as a swizzled rgba plane', () => {
    const described = describeFrame(PIX_FMT.BGRA, 100, 50)
    expect(described.mode).toBe('rgba')
    expect(described.swizzle).toBe('bgra')
  })

  test('an unknown pixel format yields null', () => {
    expect(describeFrame(9999, 100, 100)).toBeNull()
  })
})

describe('resolvePixFmt', () => {
  test('prefers the constants a live libav instance exposes', () => {
    const resolved = resolvePixFmt({ AV_PIX_FMT_NV12: 123, AV_PIX_FMT_YUV420P: 42 })
    expect(resolved.NV12).toBe(123)
    expect(resolved.YUV420P).toBe(42)
    expect(resolved.BGRA).toBe(PIX_FMT.BGRA)
  })
})

describe('slicePlane', () => {
  test('slices a plane out of the packed frame buffer using the layout offsets', () => {
    const data = new Uint8Array(16)
    data.fill(1, 0, 8)
    data.fill(2, 8, 16)
    const frame = {
      data,
      layout: [{ offset: 0 }, { offset: 8 }]
    }
    const luma = slicePlane(frame, 0, { width: 4, height: 2, kind: 'luma' })
    const chroma = slicePlane(frame, 1, { width: 2, height: 2, kind: 'chroma-pair' })
    expect(Array.from(luma)).toEqual([1, 1, 1, 1, 1, 1, 1, 1])
    expect(Array.from(chroma)).toEqual([2, 2, 2, 2, 2, 2, 2, 2])
  })

  test('returns null when there is no data', () => {
    expect(slicePlane({}, 0, { width: 1, height: 1, kind: 'luma' })).toBeNull()
  })
})
