/**
 * Public surface of the software decoding package.
 *
 * Importing the package registers it on `globalThis`, which is how
 * `xgplayer-flv` and `xgplayer-hls` arm their HEVC fallback without taking a
 * hard dependency on this package. Every internal is exported as well, so an
 * integrator who wants to self-host the wasm, swap the renderer, or drive the
 * decoder outside a player can do it without reaching into `src/`.
 */
import { registerSoftDecode } from './register'

export * from './audio/audio-output'
export * from './audio/silent-track'
export * from './config'
export * from './decoder/av-sync'
export * from './decoder/frame'
export * from './decoder/hevc-decoder'
export * from './decoder/libmedia'
export * from './decoder/nalu'
export * from './decoder/session'
export * from './decoder/worker-control'
export * from './decoder/worker-factory'
export * from './register'
export * from './render/canvas-renderer'
export * from './render/overlay'
export * from './render/pixel-formats'
export * from './soft-sink'

try {
  registerSoftDecode()
} catch (_error) {
  // Registration is a convenience. A page that cannot publish a global can
  // always pass `softDecodeOptions.createSoftSink` to the plugin instead.
}
