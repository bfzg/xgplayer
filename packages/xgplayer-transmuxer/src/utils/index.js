/* c8 ignore next 4 */

export { BitReader } from './bit-reader'
export { ByteReader } from './byte-reader'
export * from './env'
export { ExpGolomb } from './exp-golomb'
export { Logger } from './logger'
export { UTF8 } from './utf8'

export function concatUint8Array(...arr) {
  arr = arr.filter(Boolean)
  const data = new Uint8Array(arr.reduce((p, c) => p + c.byteLength, 0))
  let prevLen = 0
  arr.forEach((d) => {
    data.set(d, prevLen)
    prevLen += d.byteLength
  })
  return data
}

export const MAX_SIZE = 2 ** 32

export function readBig16(data, i = 0) {
  return (data[i] << 8) + (data[i + 1] || 0)
}

export function readBig24(data, i = 0) {
  return (data[i] << 16) + (data[i + 1] << 8) + (data[i + 2] || 0)
}

export function readBig32(data, i = 0) {
  return (
    ((data[i] << 24) >>> 0) +
    (data[i + 1] << 16) +
    (data[i + 2] << 8) +
    (data[i + 3] || 0)
  )
}

export function readInt32(data, i = 0) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return dv.getInt32(i)
}

export function readBig64(data, i = 0) {
  return readBig32(data, i) * MAX_SIZE + readBig32(data, i + 4)
}

export function readInt64(data, i = 0) {
  const dv = new DataView(data.buffer, data.byteOffset, data.byteLength)
  return (dv.getUint32(i) << 32) | dv.getUint32(i + 4)
}

export function getAvcCodec(codecs) {
  let codec = 'avc1.'
  let h
  for (let i = 0; i < 3; i++) {
    h = codecs[i].toString(16)
    if (h.length < 2) h = `0${h}`
    codec += h
  }
  return codec
}

const HEVC_PROFILE_SPACE = ['', 'A', 'B', 'C']

function toHex(value) {
  let h = (value || 0).toString(16).toUpperCase()
  if (h.length < 2) h = `0${h}`
  return h
}

// ISO/IEC 14496-15 Annex E: reverse the 32 general_profile_compatibility_flags
// bits (the SPS stores them MSB-first, the codec string lists them LSB-first).
function reverseBits32(value) {
  value = value >>> 0
  value = ((value & 0x55555555) << 1) | ((value & 0xaaaaaaaa) >>> 1)
  value = ((value & 0x33333333) << 2) | ((value & 0xcccccccc) >>> 2)
  value = ((value & 0x0f0f0f0f) << 4) | ((value & 0xf0f0f0f0) >>> 4)
  value = ((value & 0x00ff00ff) << 8) | ((value & 0xff00ff00) >>> 8)
  value = ((value & 0x0000ffff) << 16) | ((value & 0xffff0000) >>> 16)
  return value >>> 0
}

/**
 * Build an RFC 6381 / ISO 14496-15 HEVC codec string from an hvcC descriptor.
 * Produces e.g. `hev1.1.6.L93.B0` instead of a hard-coded value.
 *
 * @param {object} hvcC
 * @param {number} [hvcC.generalProfileSpace]
 * @param {number} [hvcC.generalProfileIdc]
 * @param {number} [hvcC.generalProfileCompatibilityFlags]
 * @param {number} [hvcC.generalTierFlag]
 * @param {number} [hvcC.generalLevelIdc]
 * @param {number[]} [hvcC.generalConstraintIndicatorFlags]
 * @param {'hev1' | 'hvc1'} [prefix]
 * @returns {string}
 */
export function getHevcCodec(hvcC = {}, prefix = 'hev1') {
  const space = HEVC_PROFILE_SPACE[hvcC.generalProfileSpace || 0] || ''
  const profileIdc = hvcC.generalProfileIdc || 0
  const compatibility = reverseBits32(hvcC.generalProfileCompatibilityFlags || 0)
    .toString(16)
    .toUpperCase()
  const tier = hvcC.generalTierFlag ? 'H' : 'L'
  const levelIdc = hvcC.generalLevelIdc || 0

  let codec = `${prefix}.${space}${profileIdc}.${compatibility}.${tier}${levelIdc}`

  const constraints = hvcC.generalConstraintIndicatorFlags || []
  let last = constraints.length - 1
  while (last >= 0 && !constraints[last]) last--
  for (let i = 0; i <= last; i++) {
    codec += `.${toHex(constraints[i])}`
  }

  return codec
}

export function formatIV(arr) {
  let iv = ''
  arr.forEach((value) => {
    iv += bufferToString(value)
  })
  if (iv.length <= 32) {
    const len = 32 - iv.length
    for (let i = 0; i < len; i++) {
      iv += '0'
    }
  }
  return iv
}

export function parse(a) {
  if (!Array.isArray(a)) {
    const arr = []
    let value = ''
    for (let i = 0; i < a.length; i++) {
      if (i % 2) {
        value = a[i - 1] + a[i]
        arr.push(parseInt(value, 16))
        value = ''
      }
    }
    return arr
  }
  return a.map((item) => {
    return parseInt(item, 16)
  })
}
function bufferToString(value) {
  return ('0' + Number(value).toString(16)).slice(-2).toUpperCase()
}

export function hashVal(str) {
  let hash = 0
  let i
  let chr
  if (str.length === 0) return hash
  for (i = 0; i < str.length; i++) {
    chr = str.charCodeAt(i)
    hash = (hash << 5) - hash + chr
    hash |= 0
  }
  return hash
}

export function combineToFloat(integer, decimal) {
  return Number(integer + '.' + decimal)
}

export function toDegree(matrix) {
  if (matrix.length < 5) return 0
  const scaled0 = Math.hypot(matrix[0], matrix[3]),
    scaled1 = Math.hypot(matrix[1], matrix[4])
  return 0 === scaled0 || 0 === scaled1
    ? 0
    : (180 * Math.atan2(matrix[1] / scaled1, matrix[0] / scaled0)) / Math.PI
}
