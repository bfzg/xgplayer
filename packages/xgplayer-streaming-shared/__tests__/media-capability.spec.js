import {
  canUseThreads,
  supportsHevcMse,
  supportsHevcWebCodecs,
  swapHevcPrefix
} from '../src/media-capability'

describe('media-capability', () => {
  const originalMediaSource = globalThis.MediaSource
  const originalVideoDecoder = globalThis.VideoDecoder
  const originalSab = globalThis.SharedArrayBuffer
  const originalIsolated = globalThis.crossOriginIsolated

  afterEach(() => {
    globalThis.MediaSource = originalMediaSource
    globalThis.VideoDecoder = originalVideoDecoder
    globalThis.SharedArrayBuffer = originalSab
    globalThis.crossOriginIsolated = originalIsolated
    jest.restoreAllMocks()
  })

  test('swapHevcPrefix flips hvc1 / hev1', () => {
    expect(swapHevcPrefix('hev1.1.6.L93.B0')).toBe('hvc1.1.6.L93.B0')
    expect(swapHevcPrefix('hvc1.2.4.L120.90')).toBe('hev1.2.4.L120.90')
    expect(swapHevcPrefix('avc1.42e01e')).toBe('')
    expect(swapHevcPrefix(undefined)).toBe('')
  })

  test('supportsHevcMse is false without MediaSource', () => {
    delete globalThis.MediaSource
    expect(supportsHevcMse('hev1.1.6.L93.B0')).toBe(false)
  })

  test('supportsHevcMse probes the hvc1/hev1 variant of the given codec', () => {
    globalThis.MediaSource = {
      isTypeSupported: jest.fn(
        (mime) => mime === 'video/mp4; codecs="hvc1.1.6.L93.B0"'
      )
    }
    expect(supportsHevcMse('hev1.1.6.L93.B0')).toBe(true)
    expect(globalThis.MediaSource.isTypeSupported).toHaveBeenCalledWith(
      'video/mp4; codecs="hvc1.1.6.L93.B0"'
    )
  })

  test('supportsHevcMse falls back to the built-in probe list', () => {
    const isTypeSupported = jest.fn(() => false)
    globalThis.MediaSource = { isTypeSupported }
    expect(supportsHevcMse()).toBe(false)
    expect(isTypeSupported).toHaveBeenCalled()
  })

  test('supportsHevcWebCodecs resolves true when a config is supported', async () => {
    globalThis.VideoDecoder = {
      isConfigSupported: jest.fn(async (config) => ({
        supported: config.codec === 'hev1.1.6.L93.B0'
      }))
    }
    await expect(supportsHevcWebCodecs('hev1.1.6.L93.B0')).resolves.toBe(true)
  })

  test('supportsHevcWebCodecs resolves false without VideoDecoder', async () => {
    delete globalThis.VideoDecoder
    await expect(supportsHevcWebCodecs('hev1.1.6.L93.B0')).resolves.toBe(false)
  })

  test('canUseThreads requires crossOriginIsolated and SharedArrayBuffer', () => {
    globalThis.SharedArrayBuffer = function SharedArrayBuffer () {}
    globalThis.crossOriginIsolated = false
    expect(canUseThreads()).toBe(false)

    globalThis.crossOriginIsolated = true
    expect(canUseThreads()).toBe(true)

    delete globalThis.SharedArrayBuffer
    expect(canUseThreads()).toBe(false)
  })
})
