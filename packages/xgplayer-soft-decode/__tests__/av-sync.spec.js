import { presentationTime, createFramePacer } from 'xgplayer-soft-decode'

const frameAt = (pts, den = 90000) => ({ pts, timeBase: { num: 1, den } })

describe('presentationTime', () => {
  test('scales pts by the frame time base', () => {
    expect(presentationTime(frameAt(90000))).toBe(1)
    expect(presentationTime({ pts: 1500, timeBase: { num: 1, den: 3000 } })).toBe(0.5)
  })

  test('accepts the legacy snake case time base', () => {
    expect(presentationTime({ pts: 90000, time_base_num: 1, time_base_den: 90000 })).toBe(1)
  })

  test('prefers the seconds timestamp the packer already resolved', () => {
    expect(presentationTime({ pts: 90000, timestamp: 1.5, timeBase: { num: 1, den: 1 } })).toBe(1.5)
  })

  test('treats a negative pts as no timestamp', () => {
    expect(presentationTime({ pts: -1 })).toBeNaN()
    expect(presentationTime({ pts: -1, timeBase: { num: 1, den: 90000 } })).toBeNaN()
  })

  test('falls back to a plain pts, and NaN for nothing usable', () => {
    expect(presentationTime({ pts: 2.5 })).toBe(2.5)
    expect(presentationTime(null)).toBeNaN()
    expect(presentationTime({})).toBeNaN()
  })
})

describe('createFramePacer', () => {
  test('returns only the newest frame that is due', () => {
    const pacer = createFramePacer()
    pacer.push([frameAt(0), frameAt(9000), frameAt(18000)])
    const result = pacer.take(0.1)
    expect(result.frame).toBeDefined()
    expect(result.pts).toBe(0.1)
    expect(result.dropped).toBe(1)
    // The still-future 0.2s frame stays queued for the next tick.
    expect(pacer.size).toBe(1)
  })

  test('reorders frames that arrive in decode order', () => {
    // libmedia hands pictures back in decode order, so an IPB run shows up as
    // 10, 9, 11 and the renderer still has to see 9, 10, 11.
    const pacer = createFramePacer({ maxFrameQueue: 0 })
    pacer.push([frameAt(900000), frameAt(810000), frameAt(990000)])
    // The head is the earliest picture, not the first one decoded.
    expect(pacer.take(0).next).toBe(9)
    expect(pacer.take(9).pts).toBe(9)
    expect(pacer.take(10).pts).toBe(10)
    expect(pacer.take(11).pts).toBe(11)
    expect(pacer.size).toBe(0)
  })

  test('waits when the next frame is still in the future', () => {
    const pacer = createFramePacer()
    pacer.push([frameAt(90000)])
    const result = pacer.take(0)
    expect(result.wait).toBe(true)
    expect(result.frame).toBeNull()
    expect(pacer.size).toBe(1)
  })

  test('trims the backlog to maxFrameQueue', () => {
    const pacer = createFramePacer({ maxFrameQueue: 2 })
    pacer.push([frameAt(0), frameAt(9000), frameAt(18000), frameAt(27000)])
    expect(pacer.size).toBe(2)
  })

  test('trims the backlog to maxQueuedBytes', () => {
    const frame = (pts) => ({ ...frameAt(pts), bytes: 1000 })
    const pacer = createFramePacer({ maxFrameQueue: 0, maxQueuedBytes: 2500 })
    pacer.push([frame(0), frame(9000), frame(18000), frame(27000)])
    expect(pacer.size).toBe(2)
    expect(pacer.bytes).toBe(2000)
  })

  test('never empties the queue with a byte budget of zero frames', () => {
    const pacer = createFramePacer({ maxFrameQueue: 0, maxQueuedBytes: 1 })
    pacer.push([{ ...frameAt(90000), bytes: 5000 }])
    expect(pacer.size).toBe(1)
  })

  test('renders frames without a usable pts immediately', () => {
    const pacer = createFramePacer()
    pacer.push([{ pts: -1 }, frameAt(90000)])
    const result = pacer.take(0)
    expect(result.frame).toEqual({ pts: -1 })
    expect(result.wait).toBe(false)
    // The untimed frame must not push the timed one out of order.
    expect(pacer.take(1).pts).toBe(1)
  })

  test('flush drains the oldest pending frame, clear empties the queue', () => {
    const pacer = createFramePacer()
    pacer.push([frameAt(90000), frameAt(180000)])
    expect(pacer.flush().pts).toBe(1)
    pacer.clear()
    expect(pacer.size).toBe(0)
    expect(pacer.flush()).toBeNull()
  })

  test('keeps frames that are still ahead of the clock', () => {
    // Regression: the decoder hands back a whole segment at once while the
    // clock sits at 0, so trimming the tail used to throw the video away.
    const pacer = createFramePacer({ getClock: () => 0, maxFrameQueue: 0 })
    const frames = []
    for (let i = 1; i <= 50; i += 1) frames.push(frameAt(i * 512, 12800))
    pacer.push(frames)

    expect(pacer.size).toBe(50)
    const result = pacer.take(0)
    expect(result.wait).toBe(true)
    expect(pacer.size).toBe(50)
  })

  test('drops only frames the clock has already passed', () => {
    const pacer = createFramePacer({ getClock: () => 5 })
    pacer.push([frameAt(90000), frameAt(180000)])
    expect(pacer.size).toBe(0)
    expect(pacer.consumeDropped()).toBe(2)
    expect(pacer.consumeDropped()).toBe(0)
  })

  test('exposes the next presentation time while waiting', () => {
    const pacer = createFramePacer()
    pacer.push([frameAt(90000)])
    expect(pacer.take(0).next).toBe(1)
  })

  test('reports an empty queue as waiting with no next time', () => {
    const pacer = createFramePacer()
    const result = pacer.take(0)
    expect(result).toMatchObject({ frame: null, wait: true })
    expect(result.next).toBeNaN()
  })
})
