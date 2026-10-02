/**
 * The `<video>` element keeps the audio and the playback clock; the picture is
 * painted onto a canvas layered on top of it. Doing it here (instead of
 * replacing the element) means controls, stats and layout code in xgplayer keep
 * working against the same element they always did.
 */

export const OVERLAY_CLASS = 'xgplayer-soft-decode-canvas'

const docOf = (media) => media?.ownerDocument || globalThis.document || null

/**
 * Resolve or create the canvas the soft renderer draws into.
 * @param {HTMLMediaElement} media
 * @param {{canvas?: HTMLCanvasElement|null}} options
 * @param {{createCanvas?: () => HTMLCanvasElement}} [deps]
 * @returns {HTMLCanvasElement|null}
 */
export function ensureOverlayCanvas(media, options = {}, deps = {}) {
  if (options.canvas) return options.canvas
  if (deps.canvas) return deps.canvas
  if (deps.createCanvas) return deps.createCanvas(media)

  const doc = docOf(media)
  if (!doc) return null
  const canvas = doc.createElement('canvas')
  canvas.className = OVERLAY_CLASS
  const style = canvas.style
  if (style) {
    style.position = 'absolute'
    style.left = '0'
    style.top = '0'
    style.width = '100%'
    style.height = '100%'
    style.objectFit = 'contain'
    style.pointerEvents = 'none'
    style.zIndex = '1'
  }

  const parent = media?.parentNode
  if (parent) {
    try {
      const position = globalThis.getComputedStyle?.(parent)?.position
      if (!position || position === 'static') parent.style.position = 'relative'
    } catch (_error) {
      // getComputedStyle is unavailable in some embeds; children still lay out.
    }
    parent.appendChild(canvas)
  }
  return canvas
}

/** Show/hide the overlay without tearing the renderer down. */
export function setOverlayVisible(canvas, visible) {
  if (!canvas || !canvas.style) return
  canvas.style.display = visible ? '' : 'none'
}

/**
 * Remove an auto-created canvas. A caller-provided canvas is left in place.
 */
export function detachOverlayCanvas(canvas) {
  if (!canvas) return
  if (canvas.classList?.contains(OVERLAY_CLASS)) {
    canvas.parentNode?.removeChild(canvas)
  }
}

/**
 * Mirror the decoded size onto the `<video>` element. `videoWidth` is read by
 * xgplayer layout/stats code, and it stays 0 while only audio is attached.
 * @param {HTMLMediaElement} media
 * @param {{width:number,height:number}} size
 */
export function syncMediaSize(media, size) {
  if (!media || !size || !size.width || !size.height) return
  try {
    const current = media.videoWidth
    if (current === size.width && media.videoHeight === size.height) return
    Object.defineProperty(media, 'videoWidth', {
      configurable: true,
      get: () => size.width
    })
    Object.defineProperty(media, 'videoHeight', {
      configurable: true,
      get: () => size.height
    })
  } catch (_error) {
    // Non-configurable in a few hosts; the canvas still renders correctly.
  }
}
