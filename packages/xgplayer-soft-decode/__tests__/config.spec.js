import {
  DEFAULT_SOFT_DECODE_CODECS,
  DEFAULT_SOFT_DECODE_OPTIONS,
  codecFamilyOf,
  getSoftDecodeOptions,
  exceedsSoftResolution,
  isSoftDecodableCodec
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

describe('codec capability', () => {
  test('only ships an HEVC decoder', () => {
    expect(DEFAULT_SOFT_DECODE_CODECS).toEqual(['hevc'])
    expect(DEFAULT_SOFT_DECODE_OPTIONS.softDecodeCodecs).toEqual(['hevc'])
  })

  test('maps codec strings, mime types and tracks to a family', () => {
    expect(codecFamilyOf('hev1.1.6.L120.90')).toBe('hevc')
    expect(codecFamilyOf('hvc1.1.6.L93.B0')).toBe('hevc')
    expect(codecFamilyOf('video/mp4;codecs="hev1.1.6.L120.90"')).toBe('hevc')
    expect(codecFamilyOf('avc1.64001f')).toBe('avc')
    expect(codecFamilyOf('video/mp4;codecs="avc1.42E01E"')).toBe('avc')
    expect(codecFamilyOf('av01.0.05M.08')).toBe('av1')
    expect(codecFamilyOf('vvc1.1.6.L93.B0')).toBe('vvc')
    expect(codecFamilyOf({ codec: 'hev1.1.6.L120.90' })).toBe('hevc')
    expect(codecFamilyOf({ codecType: 'hevc' })).toBe('hevc')
    expect(codecFamilyOf('')).toBe('')
    expect(codecFamilyOf(null)).toBe('')
    expect(codecFamilyOf('mp4a.40.2')).toBe('')
  })

  test('declares HEVC decodable and everything else not', () => {
    expect(isSoftDecodableCodec('hev1.1.6.L120.90')).toBe(true)
    expect(isSoftDecodableCodec({ codec: 'hvc1.1.6.L93.B0' })).toBe(true)
    // The regression this guards: `softDecode: true` on H.264 used to install a
    // sink that can never paint, leaving audio over a black canvas.
    expect(isSoftDecodableCodec('avc1.64001f')).toBe(false)
    expect(isSoftDecodableCodec('av01.0.05M.08')).toBe(false)
    expect(isSoftDecodableCodec('')).toBe(false)
    expect(isSoftDecodableCodec(undefined)).toBe(false)
  })

  test('honours a caller supplied family list', () => {
    expect(isSoftDecodableCodec('avc1.64001f', ['avc', 'hevc'])).toBe(true)
    expect(isSoftDecodableCodec('hev1.1.6.L120.90', ['avc'])).toBe(false)
    expect(isSoftDecodableCodec('hev1.1.6.L120.90', null)).toBe(true)
  })

  test('copies the codec list so a caller cannot edit the default', () => {
    const options = getSoftDecodeOptions()
    options.softDecodeCodecs.push('avc')
    expect(DEFAULT_SOFT_DECODE_OPTIONS.softDecodeCodecs).toEqual(['hevc'])
    expect(getSoftDecodeOptions({ softDecodeCodecs: ['avc'] }).softDecodeCodecs).toEqual(['avc'])
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
