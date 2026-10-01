import {
  MediaSink,
  MseSink,
  SinkKind,
  SinkManager,
  SinkSwitchReason,
  reasonFromError
} from '../src/sink'

describe('MediaSink', () => {
  test('exposes inert defaults', async () => {
    const sink = new MediaSink()
    expect(sink.kind).toBe('unknown')
    expect(sink.blobUrl).toBe(null)
    expect(sink.media).toBe(null)
    expect(sink.isOpened).toBe(false)
    expect(sink.isFull('video')).toBe(false)
    await expect(sink.endOfStream()).resolves.toBeUndefined()
    await expect(sink.reset()).resolves.toBeUndefined()
    await expect(sink.destroy()).resolves.toBeUndefined()
  })
})

describe('MseSink', () => {
  test('wraps an MSE instance without touching the DOM', () => {
    const sink = new MseSink()
    expect(sink.kind).toBe(SinkKind.MSE)
    expect(sink.mse).toBeTruthy()
    expect(sink.isOpened).toBe(false)
    // Forwarded primitives must stay safe before a media element is attached.
    expect(sink.bufferEnd('video')).toBe(0)
    expect(sink.isFull('video')).toBe(false)
  })

  test('destroy detaches and drops the MSE reference', async () => {
    const sink = new MseSink()
    await sink.destroy()
    expect(sink.mse).toBe(null)
    expect(sink.blobUrl).toBe(null)
  })
})

describe('reasonFromError', () => {
  test('classifies the common failure shapes', () => {
    expect(reasonFromError({ name: 'NotSupportedError' })).toBe(
      SinkSwitchReason.UNSUPPORTED
    )
    expect(reasonFromError({ type: 'updateError' })).toBe(
      SinkSwitchReason.APPEND_ERROR
    )
    expect(reasonFromError(new Error('MEDIA_ELEMENT_ERROR: Format error'))).toBe(
      SinkSwitchReason.MEDIA_ERROR
    )
    expect(reasonFromError({ type: 'lowdecode' })).toBe(
      SinkSwitchReason.LOWDECODE
    )
  })
})

describe('SinkManager', () => {
  const createMseSink = () => ({
    kind: SinkKind.MSE,
    mse: { name: 'mse' },
    destroy: jest.fn(async () => {})
  })

  test('starts on the MSE sink and lazily builds it', () => {
    const factory = jest.fn(createMseSink)
    const manager = new SinkManager({ createMseSink: factory })
    expect(factory).not.toHaveBeenCalled()
    expect(manager.kind).toBe(SinkKind.MSE)
    expect(manager.mse).toBe(null)

    manager.ensureMse()
    expect(factory).toHaveBeenCalledTimes(1)
    expect(manager.mse).toEqual({ name: 'mse' })
    expect(manager.isSoft).toBe(false)
  })

  test('switchToSoft installs the soft sink, retires MSE and reports the fallback', async () => {
    const mseDestroy = jest.fn(async () => {})
    const softSink = { kind: SinkKind.SOFT, destroy: jest.fn(async () => {}) }
    const createSoftSink = jest.fn(() => softSink)
    const onFallback = jest.fn()
    const manager = new SinkManager({
      createMseSink: () => ({ kind: SinkKind.MSE, mse: {}, destroy: mseDestroy }),
      createSoftSink,
      onFallback
    })
    manager.ensureMse()

    const result = await manager.switchToSoft(SinkSwitchReason.UNSUPPORTED, {
      codec: 'hev1.1.6.L120.90'
    })

    expect(result).toBe(softSink)
    expect(manager.isSoft).toBe(true)
    expect(manager.soft).toBe(softSink)
    expect(manager.mse).toBe(null)
    expect(mseDestroy).toHaveBeenCalledTimes(1)
    expect(onFallback).toHaveBeenCalledWith({
      reason: SinkSwitchReason.UNSUPPORTED,
      from: SinkKind.MSE,
      to: SinkKind.SOFT,
      codec: 'hev1.1.6.L120.90'
    })
  })

  test('switchToSoft is a no-op once already soft', async () => {
    const createSoftSink = jest.fn(() => ({ kind: SinkKind.SOFT, destroy: jest.fn() }))
    const manager = new SinkManager({
      createMseSink: createMseSink,
      createSoftSink
    })
    await manager.switchToSoft()
    await manager.switchToSoft()
    expect(createSoftSink).toHaveBeenCalledTimes(1)
  })

  test('switchToSoft returns null when no factory is configured', async () => {
    const manager = new SinkManager({ createMseSink })
    expect(manager.canSoftDecode).toBe(false)
    await expect(manager.switchToSoft()).resolves.toBe(null)
  })

  test('handleError maps the error to a switch reason', async () => {
    const softSink = { kind: SinkKind.SOFT, destroy: jest.fn() }
    const manager = new SinkManager({
      createMseSink,
      createSoftSink: () => softSink
    })
    manager.ensureMse()
    await manager.handleError({ name: 'NotSupportedError' })
    expect(manager.fallbackInfo.reason).toBe(SinkSwitchReason.UNSUPPORTED)
    expect(manager.fallbackInfo.message).toBe('NotSupportedError')
  })

  test('destroy tears down the active sink', async () => {
    const destroy = jest.fn(async () => {})
    const manager = new SinkManager({
      createMseSink: () => ({ kind: SinkKind.MSE, mse: {}, destroy })
    })
    manager.ensureMse()
    await manager.destroy()
    expect(destroy).toHaveBeenCalledTimes(1)
    expect(manager.sink).toBe(null)
  })

  // The `auto` regression: the playlist publishes the real duration while the
  // MSE sink is still live, and only the first HEVC append falls back. The soft
  // sink has to be told the number or the progress bar reads `00:00`.
  test('updateDuration publishes on the live sink and replays after a later fallback', async () => {
    const mseUpdateDuration = jest.fn(async () => {})
    const softUpdateDuration = jest.fn(async () => {})
    const manager = new SinkManager({
      createMseSink: () => ({
        kind: SinkKind.MSE,
        mse: {},
        destroy: jest.fn(),
        updateDuration: mseUpdateDuration
      }),
      createSoftSink: () => ({
        kind: SinkKind.SOFT,
        destroy: jest.fn(),
        updateDuration: softUpdateDuration
      })
    })
    manager.ensureMse()

    await manager.updateDuration(2011.97)
    expect(mseUpdateDuration).toHaveBeenCalledWith(2011.97)
    expect(softUpdateDuration).not.toHaveBeenCalled()

    await manager.switchToSoft(SinkSwitchReason.UNSUPPORTED)
    expect(softUpdateDuration).toHaveBeenCalledWith(2011.97)
    expect(manager.duration).toBe(2011.97)
  })

  test('ensureMse replays a duration published before any sink existed', async () => {
    const updateDuration = jest.fn(async () => {})
    const manager = new SinkManager({
      createMseSink: () => ({
        kind: SinkKind.MSE,
        mse: {},
        destroy: jest.fn(),
        updateDuration
      })
    })

    await manager.updateDuration(268)
    expect(updateDuration).not.toHaveBeenCalled()

    manager.ensureMse()
    expect(updateDuration).toHaveBeenCalledWith(268)
  })
})
