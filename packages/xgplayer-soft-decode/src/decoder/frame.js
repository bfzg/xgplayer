/**
 * Turn one `AVFrame` pointer into a plain, tightly packed JavaScript object.
 *
 * libmedia hands back a raw pointer into the wasm heap, and that heap is the
 * decoder's own scratch space: it is reused as soon as the frame is released,
 * and from a worker it cannot cross the boundary at all. So every frame is
 * copied out into a `Uint8Array` of its own, with each plane at the tightest
 * stride (`width`, not `linesize`). That is what lets the canvas renderer slice
 * planes with a plain `subarray`, and what makes a decoded frame transferable.
 *
 * Bit depths above 8 are folded down to 8 bits while copying. Painting 10-bit
 * HEVC as if it were 8-bit looks wrong, so the shift is done here, explicitly,
 * instead of being hidden inside the renderer.
 */

import { AVFrame, destroyAVFrame, getAVPixelFormatDescriptor } from '@libmedia/avutil'
import { mapStruct, mapUint8Array } from '@libmedia/cheap'

/** Normalised 8-bit planar outputs that the canvas renderer knows how to paint. */
export const OUT_PIX_FMT = {
  YUV420P: 0,
  YUV422P: 4,
  YUV444P: 5,
  GRAY8: 8,
  YUVJ420P: 12
}

const FLAG_PLANAR = 16
const FLAG_RGB = 32

const number = (value) => (typeof value === 'bigint' ? Number(value) : value || 0)

function readSample(view, byteOffset, step, shift, depth) {
  let value
  if (step === 1) {
    value = view[byteOffset]
  } else if (step === 2) {
    value = view[byteOffset] | (view[byteOffset + 1] << 8)
  } else {
    value =
      view[byteOffset] +
      (view[byteOffset + 1] << 8) +
      (view[byteOffset + 2] << 16) +
      view[byteOffset + 3] * 16777216
  }
  if (shift) value >>= shift
  const excess = depth - 8
  if (excess > 0) value >>= excess
  return value & 0xff
}

/**
 * Pack a single component, de-interleaving and down-shifting when needed.
 * Semiplanar formats such as NV12 describe U and V as two components of one
 * plane, so each one is pulled out into its own contiguous byte plane.
 */
function packComponent(out, offset, src, linesize, comp, width, height) {
  if (comp.depth === 8 && comp.step === 1 && !comp.shift) {
    for (let row = 0; row < height; row++) {
      const from = row * linesize
      out.set(src.subarray(from, from + width), offset + row * width)
    }
    return
  }
  for (let row = 0; row < height; row++) {
    const from = row * linesize
    const base = offset + row * width
    for (let col = 0; col < width; col++) {
      out[base + col] = readSample(
        src,
        from + col * comp.step + comp.offset,
        comp.step,
        comp.shift,
        comp.depth
      )
    }
  }
}

/**
 * Map an FFmpeg pixel format onto the nearest 8-bit planar format, keeping the
 * full-range flag when the source asked for it.
 */
function normaliseFormat(descriptor, fullRange) {
  if (descriptor.flags & FLAG_RGB) return null
  const count = descriptor.comp.length
  if (count === 1) return OUT_PIX_FMT.GRAY8
  if (count < 3) return null
  if (descriptor.log2ChromaW === 1 && descriptor.log2ChromaH === 1) {
    return fullRange ? OUT_PIX_FMT.YUVJ420P : OUT_PIX_FMT.YUV420P
  }
  if (descriptor.log2ChromaW === 1 && descriptor.log2ChromaH === 0)
    return OUT_PIX_FMT.YUV422P
  if (descriptor.log2ChromaW === 0 && descriptor.log2ChromaH === 0)
    return OUT_PIX_FMT.YUV444P
  return null
}

/**
 * Copy one decoded frame out of the wasm heap and release it.
 *
 * The pointer is always destroyed, including when the format turns out to be
 * unpaintable: libmedia gives this callback ownership of the frame, and a leaked
 * `AVFrame` pins its reference-counted buffer until the heap is torn down.
 *
 * @param {number} ptr raw `AVFrame*`
 * @param {{maxFrameBytes?: number}} [limits]
 * @returns {object|null} the packed frame, or `null` when it cannot be painted
 */
export function packFrame(ptr, limits = {}) {
  if (!ptr) return null
  try {
    const frame = mapStruct(ptr, AVFrame)
    const codedWidth = number(frame.width)
    const codedHeight = number(frame.height)
    if (!codedWidth || !codedHeight) return null

    const format = number(frame.format)
    const descriptor = getAVPixelFormatDescriptor(format)
    if (!descriptor || !(descriptor.flags & FLAG_PLANAR)) return null
    if (descriptor.comp.some((comp) => !comp.step || comp.step > 4)) return null

    const width = Math.max(
      1,
      codedWidth - number(frame.cropLeft) - number(frame.cropRight)
    )
    const height = Math.max(
      1,
      codedHeight - number(frame.cropTop) - number(frame.cropBottom)
    )

    const num = number(frame.timeBase && frame.timeBase.num)
    const den = number(frame.timeBase && frame.timeBase.den)
    const pts = number(frame.pts)
    // libmedia's `NOPTS_VALUE_BIGINT` is `-1n`, so a missing pts lands on -1.
    const hasPts = Number.isFinite(pts) && pts >= 0
    const timestamp = hasPts && num && den ? (pts * num) / den : NaN

    const fullRange = number(frame.colorRange) === 2
    const outFormat = normaliseFormat(descriptor, fullRange)
    if (outFormat === null) return null

    const chromaWidth = Math.ceil(width / (1 << descriptor.log2ChromaW))
    const chromaHeight = Math.ceil(height / (1 << descriptor.log2ChromaH))
    const alphaIndex = descriptor.comp.length - 1

    const layout = []
    let bytes = 0
    for (let i = 0; i < descriptor.comp.length; i++) {
      const plane = descriptor.comp[i].plane
      const linesize = number(frame.linesize[plane])
      if (!linesize) return null
      const fullSize = i === 0 || (descriptor.comp.length === 4 && i === alphaIndex)
      const planeWidth = fullSize ? width : chromaWidth
      const planeHeight = fullSize ? height : chromaHeight
      const size = planeWidth * planeHeight
      layout.push({
        offset: bytes,
        size,
        plane,
        linesize,
        width: planeWidth,
        height: planeHeight
      })
      bytes += size
    }
    if (limits.maxFrameBytes > 0 && bytes > limits.maxFrameBytes) return null

    const out = new Uint8Array(bytes)
    for (let i = 0; i < layout.length; i++) {
      const entry = layout[i]
      const base = number(frame.data[entry.plane])
      if (!base) return null
      const src = mapUint8Array(base, entry.linesize * entry.height)
      packComponent(
        out,
        entry.offset,
        src,
        entry.linesize,
        descriptor.comp[i],
        entry.width,
        entry.height
      )
    }

    return {
      width,
      height,
      codedWidth,
      codedHeight,
      format: outFormat,
      sourceFormat: format,
      data: out,
      layout: layout.map((entry) => ({
        offset: entry.offset,
        size: entry.size,
        plane: entry.plane
      })),
      // -1 mirrors FFmpeg's marker for an absent timestamp, so
      // presentationTime can tell it apart from a legitimate zero.
      pts: hasPts ? pts : -1,
      timeBase: { num: num || 1, den: den || 90000 },
      timestamp,
      key: !!frame.keyFrame,
      picType: number(frame.pictType),
      fullRange,
      decodeError: !!number(frame.decodeErrorFlags),
      bytes
    }
  } catch (_error) {
    return null
  } finally {
    try {
      destroyAVFrame(ptr)
    } catch (_error) {
      // The heap can already be gone while tearing a session down.
    }
  }
}
