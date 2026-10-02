import { FetchLoader } from '../../src/net/fetch'
import { ResponseType } from '../../src/net/types'

const logger = {
  debug: jest.fn()
}

function createHeaders (headers) {
  return {
    get: jest.fn((key) => headers[key.toLowerCase()] || null)
  }
}

/**
 * Install a `fetch` mock whose body yields `chunks`, then reports done. A chunk
 * of `undefined` models the last read of a real stream, which carries no value.
 */
function mockStreamFetch (chunks, headers) {
  const reads = chunks.map((value, i) => ({ value, done: i === chunks.length - 1 }))
  const read = jest.fn(async () => reads.shift() || { value: undefined, done: true })
  global.fetch = jest.fn(async () => ({
    ok: true,
    status: 200,
    redirected: false,
    url: 'https://example.com/video.mp4',
    headers: createHeaders(headers || {}),
    body: { getReader: () => ({ read, cancel: jest.fn(async () => {}) }) }
  }))
  return read
}

describe('FetchLoader', () => {
  const realFetch = global.fetch

  beforeEach(() => {
    logger.debug.mockClear()
  })

  afterEach(() => {
    global.fetch = realFetch
  })

  test('rejects range request when status is not 206 and response is not redirected', async () => {
    const arrayBuffer = jest.fn(async () => new ArrayBuffer(10))
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      redirected: false,
      url: 'https://example.com/video.mp4',
      headers: createHeaders({ 'content-length': '10' }),
      arrayBuffer
    }))

    await expect(new FetchLoader().load({
      url: 'https://example.com/video.mp4',
      logger,
      range: [0, 0],
      responseType: ResponseType.ARRAY_BUFFER,
      rangeRequestMustReturn206: true
    })).rejects.toMatchObject({
      message: 'bad response,range request must return 206 unless redirected',
      response: {
        status: 200,
        redirected: false
      }
    })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  test('allows range request when redirected', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 200,
      redirected: true,
      url: 'https://redirected.example.com/video.mp4',
      headers: createHeaders({ 'content-length': '10' }),
      arrayBuffer: async () => new ArrayBuffer(10)
    }))

    const res = await new FetchLoader().load({
      url: 'https://example.com/video.mp4',
      logger,
      range: [0, 0],
      responseType: ResponseType.ARRAY_BUFFER,
      rangeRequestMustReturn206: true
    })

    expect(res.response.status).toBe(200)
    expect(res.response.url).toBe('https://redirected.example.com/video.mp4')
  })

  test('allows range request when status is 206', async () => {
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 206,
      redirected: false,
      url: 'https://example.com/video.mp4',
      headers: createHeaders({
        'content-length': '10',
        'content-range': 'bytes 0-9/100'
      }),
      arrayBuffer: async () => new ArrayBuffer(10)
    }))

    const res = await new FetchLoader().load({
      url: 'https://example.com/video.mp4',
      logger,
      range: [0, 0],
      responseType: ResponseType.ARRAY_BUFFER,
      rangeRequestMustReturn206: true
    })

    expect(res.response.status).toBe(206)
  })

  test('rejects range request when content-range and content-length do not match request range', async () => {
    const arrayBuffer = jest.fn(async () => new ArrayBuffer(10))
    global.fetch = jest.fn(async () => ({
      ok: true,
      status: 206,
      redirected: false,
      url: 'https://example.com/video.mp4',
      headers: createHeaders({
        'content-length': '10',
        'content-range': 'bytes 1-10/100'
      }),
      arrayBuffer
    }))

    await expect(new FetchLoader().load({
      url: 'https://example.com/video.mp4',
      logger,
      range: [0, 9],
      responseType: ResponseType.ARRAY_BUFFER,
      rangeRequestMustReturn206: true
    })).rejects.toMatchObject({
      message: 'bad response,response range start does not match request range',
      response: {
        status: 206,
        redirected: false
      }
    })
    expect(arrayBuffer).not.toHaveBeenCalled()
  })

  test('delivers every byte when a short stream lands in one chunk', async () => {
    const source = new Uint8Array(100)
    for (let i = 0; i < source.length; i++) source[i] = i % 251
    mockStreamFetch([source, undefined])
    const onProgress = jest.fn()

    await new FetchLoader().load({
      url: 'https://example.com/video.mp4',
      logger,
      responseType: ResponseType.ARRAY_BUFFER,
      firstMaxChunkSize: 40,
      onProgress
    })

    const payloads = onProgress.mock.calls.map((call) => call[0]).filter((data) => !!data)
    expect(payloads.length).toBe(2)
    expect(payloads.map((data) => data.byteLength)).toEqual([40, 60])
    expect(onProgress.mock.calls[onProgress.mock.calls.length - 1][1]).toBe(true)

    const merged = new Uint8Array(100)
    let offset = 0
    payloads.forEach((data) => {
      merged.set(data, offset)
      offset += data.byteLength
    })
    expect(merged).toEqual(source)
  })

  test('finishes a streamed request with an empty body', async () => {
    mockStreamFetch([undefined])
    const onProgress = jest.fn()

    const res = await new FetchLoader().load({
      url: 'https://example.com/video.mp4',
      logger,
      responseType: ResponseType.ARRAY_BUFFER,
      firstMaxChunkSize: 40,
      onProgress
    })

    expect(res.done).toBe(true)
    expect(onProgress).toHaveBeenCalledTimes(1)
    expect(onProgress.mock.calls[0][0]).toBeUndefined()
    expect(onProgress.mock.calls[0][1]).toBe(true)
  })
})
