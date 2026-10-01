import { shouldUseWorker, descriptorOf, createDecoder } from 'xgplayer-soft-decode'

const descriptor = {
  timescale: 90000,
  width: 1280,
  height: 720,
  codec: 'hev1.1.6.L60.90',
  vps: [new Uint8Array([1])],
  sps: [new Uint8Array([2])],
  pps: [new Uint8Array([3])]
}

const onePacket = [{ data: new Uint8Array([1]), pts: 0, dts: 0 }]

describe('shouldUseWorker', () => {
  test('an injected worker control always wins', () => {
    expect(shouldUseWorker(false, { createWorkerControl: () => null })).toBe(false)
    expect(shouldUseWorker(true, { createWorkerControl: () => null })).toBe(true)
    expect(shouldUseWorker('auto', { createWorkerControl: () => null })).toBe(true)
  })

  test('auto follows the Worker global', () => {
    const original = globalThis.Worker
    try {
      globalThis.Worker = function FakeWorker () {}
      expect(shouldUseWorker('auto')).toBe(true)
      delete globalThis.Worker
      expect(shouldUseWorker('auto')).toBe(false)
    } finally {
      if (original) globalThis.Worker = original
      else delete globalThis.Worker
    }
  })

  test('off and false disable the worker even when one is available', () => {
    const original = globalThis.Worker
    globalThis.Worker = function FakeWorker () {}
    try {
      expect(shouldUseWorker(false)).toBe(false)
      expect(shouldUseWorker('off')).toBe(false)
      expect(shouldUseWorker(undefined)).toBe(true)
    } finally {
      if (original) globalThis.Worker = original
      else delete globalThis.Worker
    }
  })
})

describe('descriptorOf', () => {
  test('copies the fields a decoder needs, defaulting the timescale', () => {
    const out = descriptorOf({ width: 1920, height: 1080, codec: 'hvc1', sps: [1] })
    expect(out).toEqual({
      timescale: 90000,
      width: 1920,
      height: 1080,
      codec: 'hvc1',
      vps: [],
      sps: [1],
      pps: []
    })
  })

  test('tolerates a missing snapshot', () => {
    expect(descriptorOf(undefined).timescale).toBe(90000)
    expect(descriptorOf(undefined).width).toBe(0)
  })
})

describe('createDecoder', () => {
  test('uses an injected decoder session on the main thread', async () => {
    const calls = []
    const decoder = await createDecoder({
      video: descriptor,
      options: { worker: false },
      deps: {
        createDecoderSession: async ({ track, options }) => {
          calls.push(['session', track.timescale, options.worker])
          return {
            variant: 'simd',
            decode: (packets) => {
              calls.push(['decode', packets.length])
              return [{ pts: 0 }]
            },
            flush: () => [],
            destroy: async () => calls.push(['destroy'])
          }
        }
      }
    })
    expect(decoder.kind).toBe('main')
    expect(decoder.variant).toBe('simd')
    await expect(decoder.decode(onePacket)).resolves.toHaveLength(1)
    expect(calls[0]).toEqual(['session', 90000, false])
    expect(calls[1]).toEqual(['decode', 1])
    await decoder.destroy()
    expect(calls[2]).toEqual(['destroy'])
  })

  test('routes through an injected worker control and hands it the options', async () => {
    const calls = []
    const decoder = await createDecoder({
      video: descriptor,
      options: { worker: true, maxFrameBytes: 4096 },
      deps: {
        createWorkerControl: async () => ({
          init: async (desc, options) => {
            calls.push(['init', desc.width, options.maxFrameBytes])
            return { width: desc.width, height: desc.height, variant: 'atomic' }
          },
          decode: async (packets) => {
            calls.push(['decode', packets.length])
            return [{ pts: 1 }]
          },
          flush: async () => [],
          destroy: () => calls.push(['destroy'])
        })
      }
    })
    expect(decoder.kind).toBe('worker')
    expect(decoder.variant).toBe('atomic')
    expect(calls[0]).toEqual(['init', 1280, 4096])
    await expect(decoder.decode(onePacket)).resolves.toHaveLength(1)
    expect(calls[1]).toEqual(['decode', 1])
    await decoder.destroy()
    expect(calls[2]).toEqual(['destroy'])
  })

  test('an injected worker control that fails to boot is reported', async () => {
    await expect(
      createDecoder({
        video: descriptor,
        options: { worker: true },
        deps: {
          createWorkerControl: async () => ({
            init: async () => {
              throw new Error('worker boom')
            },
            destroy: () => {}
          })
        }
      })
    ).rejects.toThrow('worker boom')
  })

  test('normalises a session that returns nothing', async () => {
    const decoder = await createDecoder({
      video: descriptor,
      options: { worker: false },
      deps: {
        createDecoderSession: async () => ({
          decode: () => undefined,
          flush: () => undefined,
          destroy: undefined
        })
      }
    })
    await expect(decoder.decode(onePacket)).resolves.toEqual([])
    await expect(decoder.flush()).resolves.toEqual([])
    await expect(decoder.destroy()).resolves.toBeUndefined()
  })
})
