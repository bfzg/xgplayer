import {
  DEFAULT_SOFT_DECODE_OPTIONS,
  getSoftDecodeOptions,
  exceedsSoftResolution
} from 'xgplayer-soft-decode'

describe('getSoftDecodeOptions', () => {
  test('returns the defaults when nothing is passed', () => {
    expect(getSoftDecodeOptions()).toEqual(DEFAULT_SOFT_DECODE_OPTIONS)
    expect(getSoftDecodeOptions(null)).toEqual(DEFAULT_SOFT_DECODE_OPTIONS)
  })

  test('overrides only the provided keys and never mutates the defaults', () => {
    const options = getSoftDecodeOptions({ worker: false, openLog: true })
    expect(options.worker).toBe(false)
    expect(options.openLog).toBe(true)
    expect(options.dropLateFrames).toBe(DEFAULT_SOFT_DECODE_OPTIONS.dropLateFrames)
    expect(DEFAULT_SOFT_DECODE_OPTIONS.worker).toBe('auto')
  })

  test('arms the wasm lookup with a base url and nothing else', () => {
    expect(DEFAULT_SOFT_DECODE_OPTIONS.decoderWasmUrl).toBe('')
    expect(DEFAULT_SOFT_DECODE_OPTIONS.wasmVariant).toBe('auto')
    expect(DEFAULT_SOFT_DECODE_OPTIONS.wasmBaseUrl).toContain('/dist')
  })

  test('keeps the memory valves inside a sane budget', () => {
    expect(DEFAULT_SOFT_DECODE_OPTIONS.maxFrameQueue).toBe(24)
    expect(DEFAULT_SOFT_DECODE_OPTIONS.maxDecodeBatch).toBeLessThanOrEqual(
      DEFAULT_SOFT_DECODE_OPTIONS.maxFrameQueue
    )
    expect(DEFAULT_SOFT_DECODE_OPTIONS.maxQueuedBytes).toBeGreaterThan(
      DEFAULT_SOFT_DECODE_OPTIONS.maxFrameBytes
    )
  })
})

describe('exceedsSoftResolution', () => {
  test('1080p is inside the default budget', () => {
    expect(exceedsSoftResolution(1920, 1080, 1080)).toBe(false)
    expect(exceedsSoftResolution(1280, 720, 1080)).toBe(false)
  })

  test('4K and portrait 4K exceed it', () => {
    expect(exceedsSoftResolution(3840, 2160, 1080)).toBe(true)
    expect(exceedsSoftResolution(2160, 3840, 1080)).toBe(true)
  })

  test('a disabled or missing cap never rejects', () => {
    expect(exceedsSoftResolution(3840, 2160, 0)).toBe(false)
    expect(exceedsSoftResolution(3840, 2160, undefined)).toBe(false)
    expect(exceedsSoftResolution(3840, 2160, null)).toBe(false)
  })

  test('falls back to the width when the height is unknown', () => {
    expect(exceedsSoftResolution(2000, 0, 1080)).toBe(true)
    expect(exceedsSoftResolution(1000, 0, 1080)).toBe(false)
  })
})
