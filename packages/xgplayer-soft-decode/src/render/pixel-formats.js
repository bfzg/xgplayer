/**
 * The subset of `AVPixelFormat` values the renderer understands. The numbers are
 * positional in libavutil, so they are pinned from the FFmpeg build libmedia
 * compiles its wasm against. `packFrame` only ever emits the 8 bit planar
 * entries, and the semiplanar and RGB rows are here so a hand built frame, a
 * test fixture or a caller supplied decoder, still paints.
 */
export const PIX_FMT = {
  YUV420P: 0,
  RGB24: 2,
  YUV422P: 4,
  YUV444P: 5,
  GRAY8: 8,
  YUVJ420P: 12,
  NV12: 23,
  NV21: 24,
  ARGB: 25,
  RGBA: 26,
  ABGR: 27,
  BGRA: 28
}

/**
 * A private copy of the format table for one renderer.
 *
 * Each renderer gets its own copy so a caller that has to remap a value, an
 * older wasm build or a decoder of their own, can hand over a patched table
 * without touching the constants every other instance shares.
 *
 * @param {Record<string, number>} [overrides]
 * @returns {Record<string, number>}
 */
export function resolvePixFmt(overrides) {
  const out = { ...PIX_FMT }
  if (overrides) {
    for (const key of Object.keys(PIX_FMT)) {
      const value = overrides[key] ?? overrides[`AV_PIX_FMT_${key}`]
      if (typeof value === 'number') out[key] = value
    }
  }
  return out
}

const half = (n) => Math.ceil(n / 2)

const BYTES_PER_TEXEL = {
  luma: 1,
  chroma: 1,
  'chroma-pair': 2,
  rgba: 4
}

/**
 * Describe how a decoded frame is laid out so the renderer knows which planes
 * to upload and which shader to use.
 * @param {number} format AVPixelFormat
 * @param {number} width
 * @param {number} height
 * @param {object} [pixFmt]
 */
export function describeFrame(format, width, height, pixFmt = PIX_FMT) {
  const w = Math.max(1, width | 0)
  const h = Math.max(1, height | 0)
  switch (format) {
    case pixFmt.YUV420P:
      return { mode: 'yuv420p', range: 'limited', planes: plane3(w, h, 420) }
    case pixFmt.YUVJ420P:
      return { mode: 'yuv420p', range: 'full', planes: plane3(w, h, 420) }
    case pixFmt.YUV422P:
      return { mode: 'yuv420p', range: 'limited', planes: plane3(w, h, 422) }
    case pixFmt.YUV444P:
      return { mode: 'yuv420p', range: 'limited', planes: plane3(w, h, 444) }
    case pixFmt.NV12:
    case pixFmt.NV21:
      return {
        mode: 'nv12',
        range: 'limited',
        swapUV: format === pixFmt.NV21,
        planes: [
          { width: w, height: h, kind: 'luma' },
          { width: half(w), height: half(h), kind: 'chroma-pair' }
        ]
      }
    case pixFmt.GRAY8:
      return {
        mode: 'gray',
        range: 'limited',
        planes: [{ width: w, height: h, kind: 'luma' }]
      }
    case pixFmt.RGBA:
      return {
        mode: 'rgba',
        range: 'full',
        planes: [{ width: w, height: h, kind: 'rgba' }]
      }
    case pixFmt.BGRA:
      return {
        mode: 'rgba',
        range: 'full',
        swizzle: 'bgra',
        planes: [{ width: w, height: h, kind: 'rgba' }]
      }
    default:
      return null
  }
}

function plane3(w, h, subsample) {
  if (subsample === 444) {
    return [
      { width: w, height: h, kind: 'luma' },
      { width: w, height: h, kind: 'chroma' },
      { width: w, height: h, kind: 'chroma' }
    ]
  }
  if (subsample === 422) {
    return [
      { width: w, height: h, kind: 'luma' },
      { width: half(w), height: h, kind: 'chroma' },
      { width: half(w), height: h, kind: 'chroma' }
    ]
  }
  return [
    { width: w, height: h, kind: 'luma' },
    { width: half(w), height: half(h), kind: 'chroma' },
    { width: half(w), height: half(h), kind: 'chroma' }
  ]
}

/**
 * Slice one plane out of a packed frame buffer.
 *
 * `packFrame` copies each plane at its tight stride, so `layout[i].offset` is
 * the plane start and `width * height * bytesPerTexel` is exactly its length.
 *
 * @param {any} frame
 * @param {number} planeIndex
 * @param {{width:number,height:number,kind:string}} plane
 */
export function slicePlane(frame, planeIndex, plane) {
  const data = frame?.data
  if (!data) return null
  const entry = frame.layout?.[planeIndex]
  const offset = entry ? entry.offset : 0
  const bytesPerTexel = BYTES_PER_TEXEL[plane.kind] || 1
  const bytes = plane.width * plane.height * bytesPerTexel
  // A frame that is shorter than its own description would upload as a clamped
  // subarray, which WebGL rejects while leaving the previous texture in place;
  // reporting it lets the renderer skip the picture instead.
  if (data.length < offset + bytes) return null
  return data.subarray(offset, offset + bytes)
}
