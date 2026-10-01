import { createDecoderWorker, createWorkerControl } from 'xgplayer-soft-decode'

describe('createDecoderWorker', () => {
  test('returns null when Worker is unavailable', () => {
    const original = globalThis.Worker
    try {
      delete globalThis.Worker
      expect(createDecoderWorker({ decoderWorkerUrl: '/w.js' })).toBeNull()
    } finally {
      globalThis.Worker = original
    }
  })

  test('prefers an injected factory over a URL', () => {
    const original = globalThis.Worker
    const created = { tag: 'factory' }
    const seen = []
    try {
      globalThis.Worker = function Worker (url, opts) {
        seen.push({ url, opts })
        return { tag: 'url' }
      }
      const worker = createDecoderWorker({
        decoderWorkerUrl: '/decoder.worker.js',
        decoderWorkerFactory: () => created
      })
      expect(worker).toBe(created)
      expect(seen).toHaveLength(0)
    } finally {
      globalThis.Worker = original
    }
  })

  test('builds a module worker from decoderWorkerUrl', () => {
    const original = globalThis.Worker
    const seen = []
    try {
      globalThis.Worker = function Worker (url, opts) {
        seen.push({ url, opts })
        return { tag: 'url' }
      }
      const worker = createDecoderWorker({ decoderWorkerUrl: '/assets/decoder.worker.js' })
      expect(worker).toEqual({ tag: 'url' })
      expect(seen).toEqual([
        { url: '/assets/decoder.worker.js', opts: { type: 'module' } }
      ])
    } finally {
      globalThis.Worker = original
    }
  })

  test('returns null without a URL or factory (worker is opt-in)', () => {
    const original = globalThis.Worker
    try {
      globalThis.Worker = function Worker () {
        throw new Error('should not be constructed')
      }
      expect(createDecoderWorker()).toBeNull()
      expect(createDecoderWorker({})).toBeNull()
    } finally {
      globalThis.Worker = original
    }
  })

  test('swallows construction errors and falls back to the main thread', () => {
    const original = globalThis.Worker
    try {
      globalThis.Worker = function Worker () {
        throw new Error('blocked by CSP')
      }
      expect(createDecoderWorker({ decoderWorkerUrl: '/w.js' })).toBeNull()
    } finally {
      globalThis.Worker = original
    }
  })
})

describe('createWorkerControl', () => {
  test('wraps a worker in the request/response bridge', () => {
    const original = globalThis.Worker
    const listeners = []
    const worker = {
      addEventListener: (type, listener) => listeners.push({ type, listener })
    }
    try {
      globalThis.Worker = function Worker () {
        return worker
      }
      const control = createWorkerControl({ decoderWorkerUrl: '/w.js' })
      expect(control).not.toBeNull()
      expect(control.worker).toBe(worker)
      expect(listeners).toHaveLength(1)
      expect(listeners[0].type).toBe('message')
    } finally {
      globalThis.Worker = original
    }
  })

  test('returns null when no worker can be created', () => {
    const original = globalThis.Worker
    try {
      delete globalThis.Worker
      expect(createWorkerControl()).toBeNull()
    } finally {
      globalThis.Worker = original
    }
  })
})
