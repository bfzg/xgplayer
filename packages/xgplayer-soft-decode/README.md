# xgplayer-soft-decode

HEVC (H.265) 的 wasm 软件解码 sink，供 `xgplayer-flv` / `xgplayer-hls` 使用。解码内核为
[libmedia](https://github.com/zhaohappy/libmedia) 1.3.1（FFmpeg 的 wasm 构建），画面渲染在覆盖
于 `<video>` 上的 canvas。

默认仍然走浏览器硬解。只有探测不到 HEVC 硬解能力，或硬解在运行中报错时，才回退到本包的 wasm
软解，业务侧不需要写判断代码。音频一律不软解。

## 安装

```bash
yarn add xgplayer-soft-decode
```

## 使用

```js
import Player from 'xgplayer'
import 'xgplayer-flv'
import 'xgplayer-soft-decode' // import 即注册全局，之后 softDecode 默认为 'auto'

new Player({
  url: 'https://example.com/live/stream.flv',
  isLive: true,
  // 'auto' 探测回退（默认）/ true 强制软解 / false 彻底关闭
  softDecode: 'auto',
  softDecodeOptions: {
    wasmBaseUrl: '/wasm', // 指向包含 decode/ 的那一层，内网部署必须自托管
    openLog: true
  },
  onSoftDecodeFallback (info) {
    // { reason, from: 'mse', to: 'soft', codec, width, height, message }
    console.log('已回退软解', info.reason)
  }
})
```

UMD：

```html
<script src="xgplayer/dist/xgplayer.min.js"></script>
<script src="xgplayer-soft-decode/dist/index.min.js"></script>
<script src="xgplayer-hls/dist/xgplayer-hls.min.js"></script>
<script src="xgplayer-flv/dist/xgplayer-flv.min.js"></script>
```

脚本顺序必须是核心包 → 软解包 → hls → flv。软解包只往 `window` 注册
`SoftDecode` / `XGPlayerSoftDecode`，hls/flv 在创建插件实例时读取它。

## 回退是怎么发生的

1. 起流时读 `videoTrack.codec`，是 HEVC 且 `MediaSource.isTypeSupported` 为否 → 切软解。
2. 已选中的 sink 在 append 或解码阶段报错，`sinkManager.handleError` 同样切软解。
3. 切过去之后，解封装出的 Annex-B 交给 `WasmVideoDecoder` 解码，YUV 帧按音频时钟投给 canvas，
   迟到帧按 `lateFrameThreshold` 丢弃。
4. AAC 经 `FMP4Remuxer` 打成音频-only MSE 挂在同一个 `<video>` 上，`currentTime` / `duration` /
   `buffered` / seek / 倍速全部沿用原生语义，控件、进度、统计插件不受影响。
5. 纯视频流会注入一条静音 AAC 轨维持时钟，所以无音频的 FLV 也能正常播。

## 选项

| 选项 | 默认 | 说明 |
|------|------|------|
| `enabled` | `true` | 本 sink 的总开关 |
| `wasmBaseUrl` | libmedia CDN | `decode/hevc*.wasm` 的基址，自托管改这里 |
| `wasmVariant` | `'auto'` | `'auto' \| 'simd' \| 'atomic' \| 'baseline' \| '64'` |
| `worker` | `'auto'` | 仅在能建出 worker 时进 worker，否则主线程解码 |
| `renderer` | `'canvas'` | 软解画面统一走 canvas |
| `maxSoftResolution` | `0` | 高于该高度不启用软解，`0` 为不限制 |
| `maxDecodeSliceMs` | `12` | 每轮事件循环允许的同步解码毫秒数，调低更跟手 |
| `maxDecodeBatch` | `8` | 每轮交给解码器的压缩包数量 |
| `maxDecodeLead` | `1` | 解码允许跑在音频时钟前面的秒数，`0` 为不限 |
| `maxFrameQueue` | `24` | 内存中保留的已解码帧数 |
| `maxQueuedBytes` | `160 MiB` | 已解码帧字节上限，`0` 为不限 |
| `maxPendingPackets` | `600` | 落后于时钟的压缩包上限，超出裁到最近关键帧 |
| `dropLateFrames` | `true` | 丢弃落后于音频时钟的帧 |
| `lateFrameThreshold` | `0.12` | 迟到判定阈值（秒） |
| `audioThrough` | `'mse-native'` | 音频解码方式，目前只有这一种 |
| `audioSampleRate` / `audioChannelCount` | `48000` / `2` | 合成静音轨的参数 |
| `silentFillAhead` | `0.2` | 静音轨保持在前方的秒数 |
| `canvas` | `null` | 复用外部 canvas |
| `openLog` | `false` | 打印可恢复的解码告警 |

可插拔的接缝，用于换后端或自定义加载：`loadWasm`、`fetchImpl`、`wasmBytes`、`wasmModule`、
`decoderWasmUrl`、`wasmDecoderOptions`、`decoderWorkerFactory`、`decoderWorkerUrl`、
`createDecoderSession`（整条解码会话替换）。`xgplayer-flv` / `xgplayer-hls` 一侧还支持
`softDecodeOptions.createSoftSink` 直接注入 sink。

完整定义见 `src/config.js` 与 `es/config.d.ts`。

## wasm 资源

npm 依赖里只有 JS 胶水（`@libmedia/avcodec`、`@libmedia/avutil`、`@libmedia/cheap`），wasm 二进制
不在包内，首次真正需要软解时才按需加载。查找顺序：

```text
wasmBytes > wasmModule > loadWasm > decoderWasmUrl > wasmBaseUrl 下的能力阶梯
```

能力阶梯按 `simd -> atomic -> baseline` 逐个下载并 `WebAssembly.validate`，取第一个能编译的。
`hevc-64.wasm` 不在默认阶梯里，只有显式 `wasmVariant: '64'` 才会先试它。默认基址：

```text
https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@1.3.1/dist
```

只有 HEVC 会被拉取，没有 aac 二进制。导入本包不会产生任何网络请求。

内网 / 离线部署必须把 `wasm/decode/` 拷到自己的静态目录并设 `wasmBaseUrl`，否则回退时下载不到
二进制，画面停在黑屏并报 `no usable HEVC wasm below ...`。服务端需要给
`Content-Type: application/wasm`。

升级 libmedia 时，npm 依赖版本、`LIBMEDIA_WASM_VERSION` 和包内按值固定的 FFmpeg 常量要一起改。

## 运行时接口

```js
player.plugins.flv.core.isSoftDecoding   // 当前是否处于软解，hls 同理
player.plugins.flv.core.softDecodeStats  // { decoded, rendered, dropped, caughtUp, suppressed,
                                         //   queue, pending, resyncing, decoder, variant }
player.forceSoftDecode('自定义原因')        // 主动切软解
player.on('core.softdecodefallback', function (info) {})
player.root.querySelector('.xgplayer-soft-decode-canvas')
```

软解时 `<video>` 只挂音频轨，从 `video` 取像素的插件（`screenShot`、`dynamicBg`）会拿到黑帧，
需要改从上面这块 canvas 取。

## 在本仓库里验证

```bash
yarn build
yarn dev:wasm          # 8098，托管同级 libmedia/dist
yarn dev:flv           # 或 yarn dev:hls
# 播放页加 ?softDecode=true&wasmBaseUrl=http://127.0.0.1:8098
```

此时 wasm 只从本地来源加载。测试：

```bash
yarn jest packages/xgplayer-soft-decode
```

## 许可

- 本包：MIT。
- libmedia 及其 wasm 二进制：LGPL-3.0-or-later（内含 FFmpeg 组件）。wasm 以独立资源形式在运行时
  动态加载，不嵌入本包产物；使用者需保留上游许可声明，并自行确认所加载的构建未包含 GPL 组件。
  分发时请同时提供 libmedia 的源码获取方式与所用版本（`src/decoder/libmedia.js` 的
  `LIBMEDIA_WASM_VERSION`）。
