import EventEmitter from 'eventemitter3'
import { EVENT } from '../event'
import { Logger } from '../logger'
import { NetError } from './error'
import { calculateSpeed, createResponse } from './helper'

const NORMAL_CLOSE = 1000

/**
 * Turn a WebSocket message payload into bytes.
 *
 * `binaryType = 'arraybuffer'` gives an ArrayBuffer in every browser that
 * matters, but a mock, an older runtime or a server that changed the type can
 * still hand us a Blob/typed array. Text frames are not FLV and are ignored by
 * the caller.
 *
 * @param {any} data
 * @returns {Promise<Uint8Array|null>}
 */
async function toBytes(data) {
  if (!data || typeof data === 'string') return null
  if (data instanceof ArrayBuffer) return new Uint8Array(data)
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
  }
  if (typeof data.arrayBuffer === 'function') {
    const buffer = await data.arrayBuffer()
    return buffer ? new Uint8Array(buffer) : null
  }
  return null
}

/**
 * WebSocket transport for a continuous FLV stream.
 *
 * The wire format is the FLV byte stream itself, one binary message per chunk,
 * with message boundaries unrelated to tag boundaries. Chunks are handed to
 * `onProgress` in arrival order and the promise resolves when the server closes
 * the socket normally, mirroring `FetchLoader`'s streaming contract.
 *
 * There is no HTTP status, no headers and no range support: a WebSocket FLV is a
 * live feed. A synthetic response keeps the shared `onProgress` signature
 * (`response.url`, `response.headers.get`) working for the FLV core.
 *
 * @example
 * const loader = new WsLoader()
 * loader.load({
 *   url: 'ws://host/live/stream.flv?token=...',
 *   onProgress: (chunk, done, info, response) => {},
 *   logger
 * })
 */
export class WsLoader extends EventEmitter {
  _socket = null

  _timeoutTimer = null

  _messageChain = Promise.resolve()

  _running = false

  _aborted = false

  _settled = false

  _receivedLength = 0

  _startTime = 0

  _firstByteTime = 0

  _logger = null

  _onProgress = null

  _onCancel = null

  _onTimeout = null

  _resolve = null

  _reject = null

  _response = null

  _chunks = null

  /** Guards callbacks from sockets left over by a retry/reload. */
  _loadToken = 0

  _index = -1

  _range = null

  _vid = ''

  _priOptions = {}

  curTimeout = 0

  /**
   * @param {object} config
   * @param {string} config.url
   * @param {(chunk: Uint8Array|undefined, done: boolean, info: object, response: object) => void} [config.onProgress]
   * @param {(error: Error, info: object) => void} [config.onTimeout]
   * @param {(info: object) => void} [config.onCancel]
   * @param {number} [config.timeout] milliseconds to wait for the socket to open
   * @param {number} [config.index]
   * @param {number[]} [config.range]
   * @param {string} [config.vid]
   * @param {object} [config.priOptions]
   * @param {string|string[]} [config.wsProtocols]
   * @param {((url: string, protocols?: string|string[]) => any)|null} [config.createWebSocket]
   *   inject a WebSocket implementation or factory. Defaults to `globalThis.WebSocket`.
   * @returns {Promise<{data: Uint8Array|null, done: boolean, options: object, response: object}>}
   */
  load(config = {}) {
    const {
      url,
      vid,
      timeout,
      onProgress,
      onTimeout,
      onCancel,
      index,
      range,
      priOptions,
      wsProtocols,
      createWebSocket
    } = config

    // A retried load reuses this instance; the old socket may still deliver a
    // queued close/error after the new one starts.
    const token = ++this._loadToken
    const isCurrent = () => token === this._loadToken
    closeSocket(this._socket)
    this._socket = null

    this._logger = config.logger || new Logger('WsLoader')
    this._onProgress = typeof onProgress === 'function' ? onProgress : null
    this._onTimeout = typeof onTimeout === 'function' ? onTimeout : null
    this._onCancel = typeof onCancel === 'function' ? onCancel : null
    // Streams are consumed chunk by chunk. Only a caller that asked for no
    // progress callback wants the whole body, so keep the chunks in that case.
    this._chunks = this._onProgress ? null : []
    this._index = index
    this._range = range || [0, 0]
    this._vid = vid || url
    this._priOptions = priOptions || {}
    this._aborted = false
    this._settled = false
    this._running = false
    this._receivedLength = 0
    this._firstByteTime = 0
    this._startTime = Date.now()
    this._messageChain = Promise.resolve()

    const response = (this._response = createWsResponse(url))

    return new Promise((resolve, reject) => {
      this._resolve = resolve
      this._reject = reject

      if (typeof url !== 'string' || !url) {
        this._finishError(
          new NetError(url || '', null, response, 'Source url is missing')
        )
        return
      }

      let socket = null
      try {
        if (typeof createWebSocket === 'function') {
          socket = createWebSocket(url, wsProtocols)
        }
        if (!socket) {
          if (typeof WebSocket === 'undefined') {
            throw new Error('WebSocket is not supported in this environment')
          }
          socket = wsProtocols ? new WebSocket(url, wsProtocols) : new WebSocket(url)
        }
      } catch (error) {
        this._finishError(
          error instanceof NetError
            ? error
            : new NetError(url, null, response, error?.message || String(error))
        )
        return
      }

      this._socket = socket
      try {
        socket.binaryType = 'arraybuffer'
      } catch (_error) {
        // A non-standard implementation may refuse the assignment; Blob
        // payloads are converted in `_consume` instead.
      }

      this._logger.debug('[ws load start]', url, this._range)

      const onOpen = () => {
        if (!isCurrent()) return
        clearTimeout(this._timeoutTimer)
        this._timeoutTimer = null
        this._running = true
        this._logger.debug('[ws open]', url)
      }
      const onMessage = (event) => {
        if (!isCurrent() || this._aborted || this._settled) return
        const payload =
          event && typeof event === 'object' && 'data' in event ? event.data : event
        const readStart = Date.now()
        this._messageChain = this._messageChain
          .then(() => (isCurrent() ? this._consume(payload, readStart) : undefined))
          .catch((error) => {
            this._logger.warn('[ws] message handling failed', error)
          })
      }
      const onError = (event) => {
        if (!isCurrent() || this._settled) return
        const message =
          event?.message || event?.error?.message || 'websocket connection failed'
        this._finishError(new NetError(url, null, response, message))
      }
      const onClose = (event) => {
        if (!isCurrent()) return
        if (this._aborted) {
          this._finishCancel()
          return
        }
        if (this._settled) return
        const code = event?.code
        const reason = event?.reason || ''
        const expectDone = code === NORMAL_CLOSE || code === undefined || code === 1005
        // Let chunks already converted reach `onProgress` before reporting the
        // end of the stream, otherwise the tail of the live buffer is lost.
        const finish = () => {
          if (!isCurrent() || this._settled) return
          // A normal close before the first byte means the endpoint accepted the
          // upgrade and then gave us nothing (bad token, empty stream). Reporting
          // completion would leave the player on a black frame with no error, so
          // hand it to the retry/error path instead.
          if (expectDone && this._receivedLength === 0) {
            const error = new NetError(
              url,
              null,
              response,
              `websocket closed before any data, code=${code}${reason ? `, reason=${reason}` : ''}`
            )
            error.code = code
            this._finishError(error)
            return
          }
          if (expectDone) {
            this._finishDone()
          } else {
            const error = new NetError(
              url,
              null,
              response,
              `websocket closed, code=${code}${reason ? `, reason=${reason}` : ''}`
            )
            error.code = code
            this._finishError(error)
          }
        }
        this._messageChain.then(finish, finish)
      }

      addSocketListener(socket, 'open', onOpen)
      addSocketListener(socket, 'message', onMessage)
      addSocketListener(socket, 'error', onError)
      addSocketListener(socket, 'close', onClose)

      if (timeout > 0) {
        this.curTimeout = timeout
        this._timeoutTimer = setTimeout(() => {
          if (!isCurrent() || this._settled || this._running) return
          const error = new NetError(url, null, response, 'timeout')
          error.isTimeout = true
          if (this._onTimeout) {
            this._onTimeout(error, {
              index: this._index,
              range: this._range,
              vid: this._vid,
              priOptions: this._priOptions
            })
          }
          this._finishError(error)
        }, timeout)
      }

      // Some implementations fire `open` before the listener registration
      // above (or the mock returns an already-open socket); catch that up.
      if (socket.readyState === 1) onOpen()
    })
  }

  /**
   * @param {any} payload
   * @param {number} readStart
   * @returns {Promise<void>}
   */
  async _consume(payload, readStart) {
    if (this._aborted || this._settled) return
    const bytes = await toBytes(payload)
    if (!bytes || !bytes.byteLength || this._aborted || this._settled) return

    this._receivedLength += bytes.byteLength
    if (this._chunks) this._chunks.push(bytes)
    const endTime = Date.now()
    if (!this._firstByteTime) this._firstByteTime = endTime

    const info = {
      range: this._chunkRange(bytes.byteLength),
      vid: this._vid,
      index: this._index,
      startTime: readStart,
      endTime,
      st: this._startTime,
      firstByteTime: this._firstByteTime,
      priOptions: this._priOptions
    }

    this._logger.debug(
      '[ws chunk]',
      this._range,
      info.range,
      'len',
      bytes.byteLength,
      'total',
      this._receivedLength
    )

    if (this._onProgress) {
      try {
        const ret = this._onProgress(bytes, false, info, this._response)
        if (ret && typeof ret.catch === 'function') {
          ret.catch((error) => this._logger.warn('[ws] onProgress failed', error))
        }
      } catch (error) {
        this._logger.warn('[ws] onProgress failed', error)
      }
    }
  }

  /**
   * @param {number} length
   * @returns {number[]}
   */
  _chunkRange(length) {
    const end = this._receivedLength
    return [end - length, end]
  }

  /**
   * Resolve the pending load promise after a normal socket close.
   */
  _finishDone() {
    if (this._settled) return
    this._settled = true
    this._running = false
    this._cleanup()
    closeSocket(this._socket)

    const now = Date.now()
    const firstByteTime = this._firstByteTime || now
    const info = {
      range: this._chunkRange(0),
      vid: this._vid,
      index: this._index,
      startTime: now,
      endTime: now,
      st: this._startTime,
      firstByteTime,
      priOptions: this._priOptions
    }
    const costTime = Math.max(1, now - (this._startTime || now))
    if (this._receivedLength > 0) {
      this.emit(EVENT.REAL_TIME_SPEED, {
        speed: calculateSpeed(this._receivedLength, costTime),
        len: this._receivedLength,
        time: costTime,
        vid: this._vid,
        index: this._index,
        range: this._range,
        priOptions: this._priOptions
      })
    }

    if (this._onProgress) {
      try {
        this._onProgress(undefined, true, info, this._response)
      } catch (error) {
        this._logger.warn('[ws] onProgress done failed', error)
      }
    }

    this._resolve(
      createResponse(
        concatChunks(this._chunks),
        true,
        this._response,
        this._receivedLength,
        null,
        this._startTime || now,
        firstByteTime,
        this._index,
        this._range,
        this._vid,
        this._priOptions
      )
    )
  }

  /**
   * Resolve the pending load promise without reporting the stream as complete.
   */
  _finishCancel() {
    if (this._settled) return
    this._settled = true
    this._running = false
    this._cleanup()
    this._resolve(
      createResponse(
        null,
        false,
        this._response,
        this._receivedLength,
        null,
        this._startTime,
        this._firstByteTime,
        this._index,
        this._range,
        this._vid,
        this._priOptions
      )
    )
  }

  /**
   * @param {Error} error
   */
  _finishError(error) {
    if (this._settled) return
    this._settled = true
    this._running = false
    this._cleanup()
    closeSocket(this._socket)
    this._logger.debug('[ws error]', error)
    this._reject(error)
  }

  _cleanup() {
    clearTimeout(this._timeoutTimer)
    this._timeoutTimer = null
  }

  async cancel() {
    if (this._aborted) return
    this._aborted = true
    this._running = false
    this._cleanup()
    closeSocket(this._socket)
    if (this._onCancel) {
      this._onCancel({
        index: this._index,
        range: this._range,
        vid: this._vid,
        priOptions: this._priOptions
      })
    }
    this._finishCancel()
  }

  get receiveLen() {
    return this._receivedLength
  }

  get running() {
    return this._running
  }

  set running(status) {
    this._running = status
  }

  static isSupported() {
    return typeof WebSocket !== 'undefined'
  }
}

/**
 * Concatenate buffered chunks without spreading them into a call, which would
 * overflow the argument limit for a long-running feed.
 * @param {Uint8Array[]|null} chunks
 * @returns {Uint8Array|null}
 */
function concatChunks(chunks) {
  if (!chunks || !chunks.length) return null
  if (chunks.length === 1) return chunks[0]
  const size = chunks.reduce((total, chunk) => total + chunk.byteLength, 0)
  const data = new Uint8Array(size)
  let offset = 0
  chunks.forEach((chunk) => {
    data.set(chunk, offset)
    offset += chunk.byteLength
  })
  return data
}

/**
 * Minimal `Response`-shaped object for the shared onProgress contract.
 * @param {string} url
 * @returns {{url: string, status: number, headers: Headers|{get: (name: string) => null}}}
 */
function createWsResponse(url) {
  let headers
  try {
    headers = typeof Headers !== 'undefined' ? new Headers() : null
  } catch (_error) {
    headers = null
  }
  return {
    url,
    status: 101,
    headers: headers || { get: () => null }
  }
}

/**
 * Bind a WebSocket event, tolerating implementations that only expose the
 * `on<event>` properties.
 * @param {any} socket
 * @param {string} type
 * @param {(event: any) => void} handler
 */
function addSocketListener(socket, type, handler) {
  if (typeof socket.addEventListener === 'function') {
    socket.addEventListener(type, handler)
  } else {
    socket[`on${type}`] = handler
  }
}

/**
 * @param {any} socket
 */
function closeSocket(socket) {
  if (!socket) return
  try {
    socket.close()
  } catch (_error) {
    // ignore
  }
}
