# xgplayer-soft-decode

HEVC (H.265) 软件解码 sink，供 `xgplayer-flv` / `xgplayer-hls` 使用。解码内核为
[libmedia](https://github.com/zhaohappy/libmedia)（FFmpeg 的 wasm 构建），画面由覆盖在
`<video>` 上的 canvas 呈现。

默认仍然走浏览器硬解（MSE + 原生 `<video>`）。只有在探测不到 HEVC 硬解能力，或硬解在运行中
失败时，才回退到本包的 wasm 软解，业务侧无需干预。

## 安装

```bash
yarn add xgplayer-soft-decode
```

## 使用

```js
import Player from 'xgplayer'
import 'xgplayer-flv'
import 'xgplayer-soft-decode' // import 即注册，之后 softDecode 默认为 'auto'

new Player({
  url: 'https://example.com/live/stream.flv',
  isLive: true,
  // 'auto' 探测（默认）/ true 强制软解 / false 关闭软解
  softDecode: 'auto',
  onSoftDecodeFallback (info) {
    // { reason, from: 'mse', to: 'soft', ... }
    console.log('已回退软解', info.reason)
  }
})
```

UMD：

```html
<script src="xgplayer/dist/xgplayer.min.js"></script>
<script src="xgplayer-flv/dist/xgplayer-flv.min.js"></script>
<script src="xgplayer-soft-decode/dist/index.min.js"></script>
```

## 解码状态

`player.plugins.flv.core` / `player.plugins.hls.core` 上：

- `isSoftDecoding`：当前是否处于软解。
- `softDecodeStats`：`{ decoded, rendered, dropped, queue, pending, decoder, variant }`。

手动触发回退：`player.forceSoftDecode(reason)`。

## wasm 资源与自托管

npm 依赖里只有 JS 胶水（`@libmedia/avcodec`、`@libmedia/avutil`、`@libmedia/cheap`），
wasm 二进制不在包内，首次回退时按需加载，默认基址：

```text
https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@1.3.1/dist
```

`decode/hevc{,-simd,-atomic,-64}.wasm` 会按 `simd → atomic → baseline` 逐个下载、
`WebAssembly.validate` 后编译，选第一个能用的；导入本包不会产生任何网络请求。

自托管或离线部署：

```js
new Player({
  // ...
  softDecodeOptions: {
    wasmBaseUrl: 'https://static.example.com/libmedia/1.3.1', // 指到含 decode/ 的 dist
    decoderWasmUrl: '',   // 或直接指定单个二进制，跳过能力阶梯
    wasmBytes: null,      // 或直接给 Uint8Array / ArrayBuffer，零网络
    wasmModule: null,     // 或已编译的 WebAssemblyResource
    loadWasm: null,       // 或自定义加载器
    fetchImpl: null,      // CSP / file: 场景下替换 fetch
    wasmVariant: 'auto'   // 'auto' | 'simd' | 'atomic' | 'baseline' | '64'
  }
})
```

升级 libmedia 时，npm 依赖版本、`LIBMEDIA_WASM_VERSION` 与包内按值固定的 FFmpeg 常量需要一起改。

在本仓库里验证这条路径：`yarn dev:wasm`（默认 8098，托管同级的 `libmedia/dist`），demo 上加
`?softDecode=true&wasmBaseUrl=http://127.0.0.1:8098`，此时 wasm 只从本地来源加载。

## 主要选项

| 选项 | 默认 | 说明 |
|------|------|------|
| `worker` | `'auto'` | 需配 `decoderWorkerUrl` 或 `decoderWorkerFactory` 才进 Worker，否则主线程解码 |
| `renderer` | `'canvas'` | 软解画面统一走 canvas |
| `maxSoftResolution` | `1080` | 超过该高度不启用软解，0 关闭限制 |
| `dropLateFrames` | `true` | 落后于音频时钟的帧丢弃 |
| `lateFrameThreshold` | `0.12` | 迟到判定阈值（秒） |
| `maxFrameQueue` | `24` | 解码帧队列上限 |
| `maxQueuedBytes` | `96 MiB` | 解码帧字节上限 |
| `audioThrough` | `'mse-native'` | AAC 仍走原生音频-only MSE，`<video>` 保持播放时钟 |
| `openLog` | `false` | 输出可恢复的解码告警 |

完整列表见 `src/config.js`。

## 音频

音频不做软解：AAC 经 `FMP4Remuxer` 打包成音频-only MSE 挂在同一个 `<video>` 上，因此
`currentTime` / `duration` / `buffered` / seek / 倍速全部沿用原生语义，播放器的 controls、
progress、stats 等插件不受影响。纯视频流会注入一条静音 AAC 轨来维持时钟。

## 许可

- 本包：MIT。
- libmedia 及其 wasm 二进制：LGPL-3.0-or-later（内含 FFmpeg 组件）。wasm 以独立资源形式在
  运行时动态加载，不嵌入本包产物；使用者需保留上游许可声明，并自行确认所加载的构建未包含
  GPL 组件。分发时请同时提供 libmedia 源码获取方式与所用版本（见 `src/decoder/libmedia.js`
  中的 `LIBMEDIA_WASM_VERSION`）。
