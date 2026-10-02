/**
 * The assembled package api plus the global registration helper.
 *
 * `xgplayer-flv` and `xgplayer-hls` refuse to import this package, because a
 * player that never needs HEVC software decoding has no business downloading a
 * wasm binary. They find the sink factory through a global instead, so the
 * object built here is what a page sees as `SoftDecode` / `XGPlayerSoftDecode`.
 *
 * This module is pure: the automatic registration lives in `index.js`, the file
 * package.json marks as side-effectful, so a bundler keeps it and cannot shake
 * half of the wiring away.
 */

import * as audioOutput from './audio/audio-output'
import * as silentTrack from './audio/silent-track'
import * as config from './config'
import * as avSync from './decoder/av-sync'
import * as frame from './decoder/frame'
import * as hevcDecoder from './decoder/hevc-decoder'
import * as libmedia from './decoder/libmedia'
import * as nalu from './decoder/nalu'
import * as session from './decoder/session'
import * as workerControl from './decoder/worker-control'
import * as workerFactory from './decoder/worker-factory'
import * as canvasRenderer from './render/canvas-renderer'
import * as overlay from './render/overlay'
import * as pixelFormats from './render/pixel-formats'
import * as softSink from './soft-sink'

/** Names the streaming plugins probe, most specific first. */
export const SOFT_DECODE_GLOBALS = ['XGPlayerSoftDecode', 'SoftDecode']

/**
 * Every public member of the package as one plain object. The spreads are
 * deliberate: a module namespace object is frozen, and a consumer that tacks a
 * `createSoftSink` onto the global would otherwise fail quietly.
 */
export const softDecodeApi = {
  ...config,
  ...softSink,
  ...session,
  ...hevcDecoder,
  ...libmedia,
  ...frame,
  ...nalu,
  ...avSync,
  ...workerControl,
  ...workerFactory,
  ...canvasRenderer,
  ...pixelFormats,
  ...overlay,
  ...audioOutput,
  ...silentTrack
}

/**
 * Publish the package on a global so the plugins can find it.
 *
 * Both names are set. `SoftDecode` is the name the UMD build already gets from
 * `libd.umdName`, `XGPlayerSoftDecode` is the unambiguous spelling for a page
 * that loads other libraries under short names. A frozen or sandboxed global
 * must not break an otherwise working player, so each assignment is guarded and
 * the `softDecodeOptions.createSoftSink` seam always remains available.
 *
 * @param {any} [target] defaults to `globalThis`
 * @param {object} [value] defaults to `softDecodeApi`
 * @returns {object|null} the registered api, or `null` when there is no target
 */
export function registerSoftDecode(target = globalThis, value = softDecodeApi) {
  const scope = target || null
  if (!scope) return null
  for (const key of SOFT_DECODE_GLOBALS) {
    try {
      scope[key] = value
    } catch (_error) {
      // ignore, then try the next name
    }
  }
  return value
}
