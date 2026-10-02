const START_CODE = new Uint8Array([0, 0, 0, 1])

/**
 * HEVC nal_unit_type of a bare NAL unit. The two-byte header packs the type
 * into bits 1..6, so a read of the first byte alone would be off by one bit.
 * @param {Uint8Array} unit
 * @returns {number} `-1` when there is nothing to read
 */
export function hevcNalType(unit) {
  if (!unit?.length) return -1
  return (unit[0] >> 1) & 0x3f
}

/**
 * Does this access unit open with a random access point?
 *
 * Not every producer reports one: the mp4 box parser leaves `sample.keyframe`
 * unset for some `hvc1` tracks, which used to make every packet of a GB28181
 * recording look like a mid-GOP slice, so the catch-up logic could never anchor
 * a decode run and the canvas stayed black. The bitstream itself always knows,
 * so the flag is derived here rather than trusted from the container.
 *
 * 16..21 are BLA/IDR/CRA pictures, 22..23 are the reserved IRAP types.
 * @param {Uint8Array[]} units bare NAL units, as handed over by the demuxers
 * @returns {boolean}
 */
export function hasIrap(units) {
  for (const unit of units || []) {
    const type = hevcNalType(unit)
    if (type >= 16 && type <= 23) return true
  }
  return false
}

/**
 * Join raw NAL units into an Annex B elementary stream. FFmpeg's HEVC decoder
 * wants one consistently framed bitstream, and Annex B works for both FLV and
 * fMP4 sources because the demuxer already hands us bare NAL units.
 * @param {Uint8Array[]} units
 * @returns {Uint8Array}
 */
export function unitsToAnnexB(units) {
  let size = 0
  for (const unit of units || []) {
    if (unit?.byteLength) size += unit.byteLength + START_CODE.byteLength
  }
  const out = new Uint8Array(size)
  let offset = 0
  for (const unit of units || []) {
    if (!unit?.byteLength) continue
    out.set(START_CODE, offset)
    offset += START_CODE.byteLength
    out.set(unit, offset)
    offset += unit.byteLength
  }
  return out
}

/**
 * Decoder extradata for HEVC: VPS/SPS/PPS in Annex B framing.
 * @param {{vps?: Uint8Array[], sps?: Uint8Array[], pps?: Uint8Array[]}} track
 * @returns {Uint8Array}
 */
export function buildHevcExtradata(track) {
  return unitsToAnnexB([
    ...(track?.vps || []),
    ...(track?.sps || []),
    ...(track?.pps || [])
  ])
}

/**
 * The demuxer tracks use their container timescale (90kHz for TS, sample rate
 * for FLV). libmedia wants an `AVRational`, so expose it as a `{num, den}` pair
 * that can be written straight into `AVPacket.time_base`.
 * @param {number} timescale
 * @returns {{num: number, den: number}}
 */
export function timeBaseOf(timescale) {
  const den = timescale > 0 ? timescale : 90000
  return { num: 1, den }
}

/**
 * Build the packet list handed to the decoder. One entry is one access unit,
 * taken straight from a demuxer sample, which is what keeps picture boundaries
 * honest: regrouping NAL units by `first_slice_in_pic_flag` instead would
 * occasionally merge two pictures, and the decoder then reports "two slices
 * reporting being the first in the same frame".
 *
 * `pts` is the timeline the demuxer fixer actually publishes: `FlvFixer` and
 * `TsFixer` rebase `sample.pts`/`sample.dts` onto a zero-based clock but leave
 * `originPts`/`originDts` as the raw container stamp. Feeding that raw value to
 * the decoder puts every picture hours ahead of the audio clock, so the pacer
 * never finds a due frame and drops the whole queue. MP4 tracks have no fixer,
 * where `pts` is already derived from `tfdt`, and is used as is.
 * @param {import('xgplayer-transmuxer').VideoTrack} track
 * @returns {{data: Uint8Array, pts: number, dts: number}[]}
 */
export function buildHevcPackets(track) {
  const packets = []
  for (const sample of track.samples || []) {
    const units = sample.units || []
    if (!units.length) continue
    const pts = sample.pts ?? sample.originPts
    const dts = sample.dts ?? sample.originDts
    if (pts === undefined || pts === null) continue
    packets.push({
      data: unitsToAnnexB(units),
      pts,
      dts: dts === undefined || dts === null ? pts : dts,
      // Carried so the tail of a one-picture batch still spans a whole frame.
      // The container fixers fill this in; a raw mp4 sample brings its own.
      duration: sample.duration || 0,
      keyframe: !!sample.keyframe || hasIrap(units)
    })
  }
  return packets
}
