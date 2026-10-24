import {
  Buffer,
  ERR,
  MSE,
  MSEErrorType,
  StreamingError,
  supportsHevcMse
} from 'xgplayer-streaming-shared'
import { FMP4Remuxer, MP4Demuxer } from 'xgplayer-transmuxer'

export class BufferService {
  _demuxer = null
  _remuxer = null
  _mse = null
  _softVideo = null
  _softFactory = null
  _softDecode = false
  _needInitSegment = true
  _sourceCreated = false

  constructor(mp4, softDecode, softFactory) {
    this.mp4 = mp4
    this._softDecode = softDecode
    this._softFactory = typeof softFactory === 'function' ? softFactory : null
    // `softDecode` with a factory means "feed the wasm SoftSink"; without one it
    // is the legacy external soft media element (`appendBuffer` on the element).
    if (softDecode && !this._softFactory) {
      this._softVideo = mp4.media
    } else if (!softDecode) {
      this._mse = new MSE()
      this._mse.bindMedia(mp4.media)
    }
  }

  _useSoft(videoTrack) {
    if (!this._softFactory && !this._softVideo) return false
    if (this._softDecode === false) return false
    if (
      this._softDecode === 'auto' &&
      this._softFactory &&
      typeof this._softFactory.canDecode === 'function'
    ) {
      // Hardware first: Safari and other platforms with HEVC MSE should not be
      // pushed onto the wasm decoder just because a soft sink is available.
      if (supportsHevcMse(videoTrack.codec)) return false
      return !!this._softFactory.canDecode({ codec: videoTrack.codec })
    }
    return true
  }

  _ensureDemuxer() {
    if (this._demuxer) return this._demuxer
    const loader = this.mp4._loader
    this._demuxer = new MP4Demuxer(loader.videoSegments, loader.audioSegments, null, {
      memoryOpt: this.mp4._config.memoryOpt
    })
    if (this._mse) {
      this._remuxer = new FMP4Remuxer(this._demuxer.videoTrack, this._demuxer.audioTrack)
    }
    return this._demuxer
  }

  async appendBuffer(data, dataStart, videoFrames, audioFrames, moov) {
    if (!data || !data.length) return
    let videoIndexRange
    let audioIndexRange
    if (videoFrames) {
      videoIndexRange = [videoFrames[0].index, videoFrames[videoFrames.length - 1].index]
    }
    if (audioFrames) {
      audioIndexRange = [audioFrames[0].index, audioFrames[audioFrames.length - 1].index]
    }
    if (!videoIndexRange && !audioIndexRange) return
    const demuxer = this._ensureDemuxer()
    const { videoTrack, audioTrack } = demuxer.demux(
      data,
      dataStart,
      videoIndexRange,
      audioIndexRange,
      moov
    )
    const videoType = videoTrack.type
    const audioType = audioTrack.type
    const useSoft = this._useSoft(videoTrack)
    if (!useSoft && !this._mse) {
      this._mse = new MSE()
      this._mse.bindMedia(this.mp4.media)
      this._remuxer = new FMP4Remuxer(this._demuxer.videoTrack, this._demuxer.audioTrack)
    }

    const mse = this._mse
    if (mse) {
      if (!this._sourceCreated) {
        if (!mse.isOpened) {
          await mse.open()
        }
        if (videoTrack.exist()) {
          mse.createSource(videoType, `video/mp4;codecs=${videoTrack.codec}`)
          this._sourceCreated = true
        }
        if (audioTrack.exist()) {
          mse.createSource(audioType, `audio/mp4;codecs=${audioTrack.codec}`)
          this._sourceCreated = true
        }
      }

      let remuxResult
      try {
        remuxResult = this._remuxer.remux(this._needInitSegment)
      } catch (error) {
        throw new StreamingError(ERR.REMUX, ERR.SUB_TYPES.FMP4, error)
      }
      this._needInitSegment = false

      const p = []
      if (remuxResult.videoInitSegment)
        p.push(mse.append(videoType, remuxResult.videoInitSegment))
      if (remuxResult.audioInitSegment)
        p.push(mse.append(audioType, remuxResult.audioInitSegment))
      if (remuxResult.videoSegment)
        p.push(mse.append(videoType, remuxResult.videoSegment))
      if (remuxResult.audioSegment)
        p.push(mse.append(audioType, remuxResult.audioSegment))

      return Promise.all(p).catch((error) => {
        if (error.type === MSEErrorType.CANCELLED) return
        throw new StreamingError(ERR.MEDIA, ERR.SUB_TYPES.MSE_APPEND_BUFFER, error)
      })
    } else if (useSoft && this._softFactory) {
      if (!this._softVideo) {
        this._softVideo = this._softFactory({
          media: this.mp4.media,
          info: {
            codec: videoTrack.codec,
            width: videoTrack.width,
            height: videoTrack.height
          }
        })
        const duration = this.mp4._loader?.meta?.duration
        if (duration && Number.isFinite(duration)) {
          await this._softVideo.updateDuration(duration)
        }
      }
      await this._softVideo.appendBuffer(videoTrack, audioTrack)
    } else if (this._softVideo) {
      this._softVideo.appendBuffer(videoTrack, audioTrack)
    }
  }

  async evictBuffer(bufferBehind) {
    const media = this.mp4.media
    if (!this._mse || !this._demuxer || !media || !bufferBehind || bufferBehind < 0)
      return
    const currentTime = media.currentTime
    const removeEnd = currentTime - bufferBehind
    if (removeEnd <= 0) return
    const start = Buffer.start(Buffer.get(media))
    if (start + 1 >= removeEnd) return
    const demuxer = this._demuxer

    const p = []
    ;[demuxer.videoTrack, demuxer.audioTrack].forEach((track) => {
      if (track.exist()) {
        p.push(this._mse.remove(track.type, 0, removeEnd))
      }
    })

    return Promise.all(p).catch((error) => {
      if (error.type === MSEErrorType.CANCELLED) return
      throw new StreamingError(ERR.MEDIA, ERR.SUB_TYPES.MSE_OTHER, error)
    })
  }

  async reset() {
    if (this._mse) {
      await this._mse.unbindMedia()
      await this._mse.bindMedia(this.mp4.media)
      this._mseOpened = false
    }
    this._sourceCreated = false
    this._needInitSegment = true
    this._demuxer = null
    this._remuxer = null
  }

  async endOfStream() {
    if (this._mse) {
      if (this._sourceCreated) {
        try {
          await this._mse.endOfStream()
        } catch (error) {
          if (error.type === MSEErrorType.CANCELLED) return
          throw new StreamingError(ERR.MEDIA, ERR.SUB_TYPES.MSE_OTHER, error)
        }
      }
    }
    if (this._softVideo && typeof this._softVideo.endOfStream === 'function') {
      await this._softVideo.endOfStream()
    }
  }

  async destroy() {
    const mse = this._mse
    const soft = this._softVideo
    this._mse = null
    this._softVideo = null
    this._demuxer = null
    this._remuxer = null

    if (mse) {
      await mse.unbindMedia()
    }
    if (soft && typeof soft.destroy === 'function') {
      await soft.destroy()
    }
  }
}
