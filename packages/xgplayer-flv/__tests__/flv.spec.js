jest.mock('xgplayer-streaming-shared')
jest.mock('xgplayer-transmuxer')
jest.mock('../src/flv/services/buffer-service.js')

import { NetLoader, BandwidthService, SeiService, getVideoPlaybackQuality, Buffer, MSE, Logger } from 'xgplayer-streaming-shared'
import { Logger as TransmuxerLogger } from 'xgplayer-transmuxer'
import { Flv } from '../src/flv'
import { BufferService } from '../src/flv/services'

describe('Flv', () => {
  const { EVENT } = jest.requireActual('xgplayer-streaming-shared')

  Buffer.info = () => ({ start: 1, buffers: [] })

  getVideoPlaybackQuality.mockImplementation(() => {
    return {
      droppedVideoFrames: 1,
      totalVideoFrames: 1,
      creationTime: 1
    }
  })

  MSE.mockImplementation(() => {
    return {
      isSupported: () => true
    }
  })

  const loggerEnable = jest.fn()
  const loggerDisable = jest.fn()
  Logger.enable = loggerEnable
  Logger.disable = loggerDisable

  const tLoggerEnable = jest.fn()
  const tLoggerDisable = jest.fn()
  TransmuxerLogger.enable = tLoggerEnable
  TransmuxerLogger.disable = tLoggerDisable

  const bufferServiceReset = jest.fn()
  const endOfStream = jest.fn()
  const bufferDestroy = jest.fn()
  const seamlessSwitch = jest.fn()
  const isFull = jest.fn()
  const resetSeamlessSwitchStats = jest.fn()
  BufferService.mockImplementation(() => {
    return {
      reset: bufferServiceReset,
      endOfStream,
      seamlessSwitch,
      isFull,
      resetSeamlessSwitchStats,
      destroy: bufferDestroy
    }
  })

  const seiServiceReset = jest.fn()
  SeiService.mockImplementation(() => {
    return {
      reset: seiServiceReset
    }
  })

  const bandwidthServiceReset = jest.fn()
  const appendBuffer = jest.fn()
  BandwidthService.mockImplementation(() => {
    return {
      reset: bandwidthServiceReset,
      appendBuffer,
      addChunkRecord: jest.fn(),
      getLatestSpeed () { return 1 },
      getAvgSpeed () { return 1 },
      getTotalSize () { return 0 },
      getTotalCost () { return 0 }
    }
  })

  let loaderOnProgress
  const loaderLoad = jest.fn().mockImplementation(() => {
    loaderOnProgress(new Uint8Array([1,2,3]), true, {}, {})
  })
  const loaderCancel = jest.fn()
  NetLoader.mockImplementation(({ onProgress }) => {
    loaderOnProgress = onProgress
    return {
      load: loaderLoad,
      cancel: loaderCancel
    }
  })

  const settle = async (turns = 8) => {
    for (let i = 0; i < turns; i += 1) await Promise.resolve()
  }

  const media = document.createElement('video')

  afterEach(() => {
    jest.clearAllMocks()
  })

  test('public properties', () => {
    const flv = new Flv({ media, isLive: true })
    expect(flv.media).toBe(media)
    expect(flv.version).toBe('test')
    expect(flv.isLive).toBe(true)
    expect(flv.seekable).toBe(false)
  })

  test('info methods', () => {
    const flv = new Flv({ media })
    expect(flv.speedInfo()).toEqual({ speed: 1, avgSpeed: 1, totalSize: 0, totalCost: 0 })
    expect(flv.bufferInfo()).toEqual({ start: 1, buffers: [] })
    expect(flv.playbackQuality()).toEqual({
      droppedVideoFrames: 1,
      totalVideoFrames: 1,
      creationTime: 1
    })
  })

  test('load', async () => {
    const flv = new Flv({ media, isLive: true })
    const emit = jest.spyOn(flv, 'emit')
    await flv.load('url')
    expect(bufferServiceReset).toHaveBeenCalled()
    expect(seiServiceReset).toHaveBeenCalled()
    expect(bandwidthServiceReset).toHaveBeenCalled()
    expect(loaderCancel).toHaveBeenCalled()
    expect(loaderLoad).toHaveBeenLastCalledWith({ url: 'url', "range": [] })
    expect(emit).toHaveBeenCalledWith(EVENT.LOAD_START, { url: 'url', 'seamlessSwitching': false })
  })

  test('replay', async () => {
    const flv = new Flv({ media, url: 'url' })
    const load = jest.spyOn(flv, 'load')
    media.play = jest.fn(()=> Promise.resolve())
    await flv.replay()
    expect(load).toHaveBeenCalled()
    expect(media.play).toHaveBeenCalled()
    jest.useFakeTimers()
    await flv.replay(true)
    expect(load).toHaveBeenCalledTimes(1)
    expect(loaderCancel).toHaveBeenCalledTimes(3)
    jest.runAllTimers()
    expect(seamlessSwitch).toHaveBeenCalledTimes(1)
  })

  test('disconnect', async () => {
    const flv = new Flv()
    await flv.disconnect()
    expect(resetSeamlessSwitchStats).toHaveBeenCalled()
    expect(loaderCancel).toHaveBeenCalled()
  })

  test('switchURL', async () => {
    const flv = new Flv({ media, isLive: true })
    const load = jest.spyOn(flv, 'load')
    media.play = jest.fn(()=> Promise.resolve())
    await flv.switchURL('url')
    expect(load).toHaveBeenCalled()
    expect(media.play).toHaveBeenCalled()
    jest.useFakeTimers()
    await flv.switchURL('url', true)
    expect(load).toHaveBeenCalledTimes(1)
    expect(loaderCancel).toHaveBeenCalledTimes(3)
    jest.runAllTimers()
    expect(seamlessSwitch).toHaveBeenCalledTimes(1)
  })

  test('isSupported', () => {
    expect(Flv.isSupported()).toBe(undefined)
  })

  test('enableLogger', () => {
    Flv.enableLogger()
    expect(loggerEnable).toHaveBeenCalled()
    expect(tLoggerEnable).toHaveBeenCalled()
  })

  test('disableLogger', () => {
    Flv.disableLogger()
    expect(loggerDisable).toHaveBeenCalled()
    expect(tLoggerDisable).toHaveBeenCalled()
  })

  test('destroy', async () => {
    const flv = new Flv({ media, url: 'url' })
    const removeAllListeners = jest.spyOn(flv, 'removeAllListeners')
    await flv.destroy()
    expect(bufferDestroy).toHaveBeenCalled()
    expect(removeAllListeners).toHaveBeenCalled()
  })

  test('_onProgress keeps overlapping chunks in arrival order', async () => {
    const flv = new Flv({ media, url: 'url' })
    const order = []
    const gates = []
    flv._bufferService = {
      appendBuffer: jest.fn((chunk) => new Promise((resolve) => {
        order.push(['enter', chunk[0]])
        gates.push(() => {
          order.push(['exit', chunk[0]])
          resolve()
        })
      })),
      evictBuffer: jest.fn()
    }
    const response = { headers: { get: () => null }, url: 'url' }

    const first = flv._onProgress(new Uint8Array([1]), false, {}, response)
    const second = flv._onProgress(new Uint8Array([2]), false, {}, response)

    await settle()
    // The loader does not await the callback, so the second chunk must wait.
    expect(order).toEqual([['enter', 1]])

    gates[0]()
    await first
    await settle()
    expect(order).toEqual([['enter', 1], ['exit', 1], ['enter', 2]])

    gates[1]()
    await second
    expect(order).toEqual([['enter', 1], ['exit', 1], ['enter', 2], ['exit', 2]])
  })

  test('_onProgress drops work invalidated by a load reset', async () => {
    const flv = new Flv({ media, url: 'url' })
    const appendBuffer = jest.fn(() => Promise.resolve())
    flv._bufferService = { appendBuffer, evictBuffer: jest.fn() }
    const response = { headers: { get: () => null }, url: 'url' }

    const pending = flv._onProgress(new Uint8Array([1]), false, {}, response)
    flv._progressToken += 1

    await pending
    expect(appendBuffer).not.toHaveBeenCalled()
  })

})
