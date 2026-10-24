import { WsLoader } from '../../src/net/ws'
import { isWsUrl } from '../../src/net/helper'
import { NetLoader } from '../../src/net'

const logger = {
  debug: jest.fn(),
  warn: jest.fn(),
  error: jest.fn(),
  log: jest.fn()
}

class MockWebSocket {
  static instances = []

  constructor (url, protocols) {
    this.url = url
    this.protocols = protocols
    this.binaryType = ''
    this.readyState = 0
    this.listeners = {}
    this.closed = null
    MockWebSocket.instances.push(this)
  }

  addEventListener (type, handler) {
    ;(this.listeners[type] = this.listeners[type] || []).push(handler)
  }

  emit (type, event) {
    ;(this.listeners[type] || []).forEach((handler) => handler(event))
  }

  open () {
    this.readyState = 1
    this.emit('open', {})
  }

  message (data) {
    this.emit('message', { data })
  }

  error (message) {
    this.emit('error', { message })
  }

  close (code = 1000, reason = '') {
    if (this.closed) return
    this.closed = { code, reason }
    this.readyState = 3
    this.emit('close', { code, reason })
  }
}

const flush = async (turns = 12) => {
  for (let i = 0; i < turns; i += 1) await Promise.resolve()
}

function createLoader (config = {}) {
  const onProgress = jest.fn()
  const loader = new WsLoader()
  const promise = loader.load({
    url: 'ws://example.com/live/stream.flv?token=x',
    logger,
    onProgress,
    createWebSocket: (url, protocols) => new MockWebSocket(url, protocols),
    ...config
  })
  const socket = MockWebSocket.instances[MockWebSocket.instances.length - 1]
  return { loader, onProgress, promise, socket }
}

describe('isWsUrl', () => {
  test('detects ws and wss only', () => {
    expect(isWsUrl('ws://host/live.flv')).toBe(true)
    expect(isWsUrl('wss://host/live.flv?token=1')).toBe(true)
    expect(isWsUrl(' WSS://host/live.flv ')).toBe(true)
    expect(isWsUrl('https://host/live.flv')).toBe(false)
    expect(isWsUrl('')).toBe(false)
    expect(isWsUrl(undefined)).toBe(false)
  })
})

describe('WsLoader', () => {
  beforeEach(() => {
    MockWebSocket.instances = []
    logger.debug.mockClear()
    logger.warn.mockClear()
    logger.error.mockClear()
  })

  test('streams binary chunks in order and finishes on a normal close', async () => {
    const { onProgress, promise, socket } = createLoader()

    socket.open()
    expect(socket.binaryType).toBe('arraybuffer')

    socket.message(new Uint8Array([1, 2, 3]))
    socket.message(new Uint8Array([4, 5]).buffer)
    await flush()

    expect(onProgress).toHaveBeenCalledTimes(2)
    const first = onProgress.mock.calls[0]
    expect(Array.from(first[0])).toEqual([1, 2, 3])
    expect(first[1]).toBe(false)
    expect(first[2]).toMatchObject({ vid: 'ws://example.com/live/stream.flv?token=x' })
    expect(first[3].url).toContain('ws://')
    expect(first[3].headers.get('content-length')).toBe(null)
    expect(Array.from(onProgress.mock.calls[1][0])).toEqual([4, 5])

    socket.close(1000)
    const result = await promise

    expect(onProgress).toHaveBeenCalledTimes(3)
    const doneCall = onProgress.mock.calls[2]
    expect(doneCall[0]).toBeUndefined()
    expect(doneCall[1]).toBe(true)
    expect(result.done).toBe(true)
  })

  test('collects the whole body when no onProgress callback is given', async () => {
    const loader = new WsLoader()
    const promise = loader.load({
      url: 'ws://example.com/live.flv',
      logger,
      createWebSocket: () => new MockWebSocket('ws://example.com/live.flv')
    })
    const socket = MockWebSocket.instances[0]

    socket.open()
    socket.message(new Uint8Array([1, 2]))
    socket.message(new Uint8Array([3]))
    await flush()
    socket.close(1000)

    const result = await promise
    expect(Array.from(result.data)).toEqual([1, 2, 3])
    expect(loader.receiveLen).toBe(3)
    expect(loader.running).toBe(false)
  })

  test('rejects on an abnormal close', async () => {
    const { promise, socket } = createLoader()

    socket.open()
    socket.message(new Uint8Array([1]))
    await flush()
    socket.close(1006, 'abnormal')

    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining('websocket closed, code=1006')
    })
  })

  test('rejects when the socket errors before any data', async () => {
    const { promise, socket } = createLoader()

    socket.error('boom')

    await expect(promise).rejects.toMatchObject({ message: 'boom' })
  })

  test('rejects a normal close that delivered no data', async () => {
    const { promise, socket } = createLoader()

    socket.open()
    socket.close(1000, 'empty')

    await expect(promise).rejects.toMatchObject({
      message: expect.stringContaining('before any data')
    })
  })

  test('times out while waiting for the socket to open', async () => {
    jest.useFakeTimers()
    try {
      const { promise } = createLoader({ timeout: 1000 })
      jest.advanceTimersByTime(1000)
      await expect(promise).rejects.toMatchObject({ message: 'timeout', isTimeout: true })
    } finally {
      jest.useRealTimers()
    }
  })

  test('does not treat the load timeout as a stream timeout after open', async () => {
    jest.useFakeTimers()
    try {
      const { onProgress, socket } = createLoader({ timeout: 1000 })
      socket.open()
      jest.advanceTimersByTime(5000)
      socket.message(new Uint8Array([1]))
      await flush()
      expect(onProgress).toHaveBeenCalled()
    } finally {
      jest.useRealTimers()
    }
  })

  test('cancel closes the socket and resolves without reporting completion', async () => {
    const { loader, onProgress, promise, socket } = createLoader()

    socket.open()
    socket.message(new Uint8Array([1]))
    await flush()
    await loader.cancel()

    const result = await promise
    expect(socket.closed).toBeTruthy()
    expect(result.done).toBe(false)
    expect(loader.running).toBe(false)
    expect(onProgress).toHaveBeenCalledTimes(1)
  })

  test('converts Blob payloads asynchronously without reordering them', async () => {
    const { onProgress, socket } = createLoader()

    const blob = (bytes, delay) => ({
      arrayBuffer: () =>
        new Promise((resolve) => {
          setTimeout(() => resolve(new Uint8Array(bytes).buffer), delay)
        })
    })

    socket.open()
    socket.message(blob([1, 2], 10))
    socket.message(blob([3], 0))
    await new Promise((resolve) => setTimeout(resolve, 30))
    await flush()

    expect(onProgress).toHaveBeenCalledTimes(2)
    expect(Array.from(onProgress.mock.calls[0][0])).toEqual([1, 2])
    expect(Array.from(onProgress.mock.calls[1][0])).toEqual([3])
  })

  test('ignores text frames', async () => {
    const { onProgress, socket } = createLoader()

    socket.open()
    socket.message('{"type":"pong"}')
    socket.message(new Uint8Array([9]))
    await flush()

    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(Array.from(onProgress.mock.calls[0][0])).toEqual([9])
  })

  test('a stale socket from a previous load cannot finish the new one', async () => {
    const loader = new WsLoader()
    const onProgress = jest.fn()
    const config = {
      url: 'ws://example.com/live.flv',
      logger,
      onProgress,
      createWebSocket: () => new MockWebSocket('ws://example.com/live.flv')
    }

    loader.load(config)
    const first = MockWebSocket.instances[0]
    first.open()
    first.message(new Uint8Array([1]))
    await flush()

    const second = loader.load(config)
    MockWebSocket.instances[1].open()
    MockWebSocket.instances[1].message(new Uint8Array([2]))
    await flush()
    first.close(1000)
    MockWebSocket.instances[1].close(1000)

    await expect(second).resolves.toMatchObject({ done: true })
    expect(MockWebSocket.instances[1].closed).toBeTruthy()
  })
})

describe('NetLoader websocket selection', () => {
  const realWebSocket = global.WebSocket

  beforeEach(() => {
    MockWebSocket.instances = []
  })

  afterEach(() => {
    global.WebSocket = realWebSocket
    MockWebSocket.instances = []
  })

  test('uses the WebSocket transport for ws urls', async () => {
    global.WebSocket = class extends MockWebSocket {}
    const loader = new NetLoader({ logger, retry: 0 })
    const onProgress = jest.fn()
    const promise = loader.load({
      url: 'ws://example.com/live.flv',
      onProgress
    })

    const socket = MockWebSocket.instances[0]
    expect(socket).toBeTruthy()
    socket.open()
    socket.message(new Uint8Array([7]))
    await flush()
    socket.close(1000)

    await expect(promise).resolves.toMatchObject({ done: true })
    expect(onProgress).toHaveBeenCalled()
  })

  test('retries an abnormal close on a fresh socket', async () => {
    global.WebSocket = class extends MockWebSocket {}
    const loader = new NetLoader({ logger, retry: 1, retryDelay: 0 })
    const promise = loader.load({
      url: 'ws://example.com/live.flv',
      onProgress: jest.fn()
    })

    MockWebSocket.instances[0].open()
    MockWebSocket.instances[0].close(1006, 'proxy restart')
    await new Promise((resolve) => setTimeout(resolve, 10))

    expect(MockWebSocket.instances.length).toBe(2)
    MockWebSocket.instances[1].open()
    MockWebSocket.instances[1].message(new Uint8Array([9]))
    await flush()
    MockWebSocket.instances[1].close(1000)

    await expect(promise).resolves.toMatchObject({ done: true })
  })

  test('does not retry after bytes arrived (the demuxer must reset first)', async () => {
    global.WebSocket = class extends MockWebSocket {}
    const loader = new NetLoader({
      logger,
      retry: 3,
      retryDelay: 0,
      retryAfterData: false
    })
    const promise = loader.load({
      url: 'ws://example.com/live.flv',
      onProgress: jest.fn()
    })

    const socket = MockWebSocket.instances[0]
    socket.open()
    socket.message(new Uint8Array([1, 2, 3]))
    await flush()
    socket.close(1006, 'proxy restart')

    await expect(promise).rejects.toMatchObject({ received: 3 })
    expect(MockWebSocket.instances.length).toBe(1)
  })
})
