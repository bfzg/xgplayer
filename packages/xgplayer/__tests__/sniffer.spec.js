import Sniffer from '../src/utils/sniffer'

describe('Sniffer.isHevcSupported', () => {
  const originalMediaSource = globalThis.MediaSource

  afterEach(() => {
    globalThis.MediaSource = originalMediaSource
    jest.restoreAllMocks()
  })

  test('returns false without MediaSource', () => {
    delete globalThis.MediaSource
    expect(Sniffer.isHevcSupported()).toBe(false)
  })

  test('probes the hvc1/hev1 variant of a real codec string', () => {
    globalThis.MediaSource = {
      isTypeSupported: jest.fn(
        (mime) => mime === 'video/mp4;codecs="hvc1.1.6.L90.B0"'
      )
    }
    expect(Sniffer.isHevcSupported('hev1.1.6.L90.B0')).toBe(true)
    expect(globalThis.MediaSource.isTypeSupported).toHaveBeenCalledWith(
      'video/mp4;codecs="hvc1.1.6.L90.B0"'
    )
  })

  test('falls back to the built-in probe list', () => {
    const isTypeSupported = jest.fn(() => false)
    globalThis.MediaSource = { isTypeSupported }
    expect(Sniffer.isHevcSupported()).toBe(false)
    expect(isTypeSupported).toHaveBeenCalledWith(
      'video/mp4;codecs="hev1.1.6.L120.90"'
    )
  })
})
