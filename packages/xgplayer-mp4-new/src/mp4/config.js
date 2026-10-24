export function getConfig(cfg) {
  const media = cfg?.media || document.createElement('video')
  return {
    softDecode: false,
    createSoftSink: null,
    tickInterval: 500,
    preloadTime: 10,
    bufferBehind: 10,
    segmentDuration: undefined,
    url: '',
    retry: 3,
    retryDelay: 100,
    ...cfg,
    media
  }
}
