# xgplayer HEVC (H.265) 软解构建包

FLV / HLS 的 H.265 播放补丁包。默认仍然优先使用浏览器硬解（MSE + 原生 `<video>`），
只在探测不到 HEVC 硬解能力、或硬解运行中失败时，自动回退到 wasm 软解 + canvas 渲染。
解码内核为 [libmedia](https://github.com/zhaohappy/libmedia)（FFmpeg 的 wasm 构建）1.3.1。

## 目录结构

```text
umd/        脚本标签直接用，4 个 JS + 1 个 CSS，无 npm 依赖
es/         打包器（webpack / vite）用的 ESM 产物 + 各自 package.json
wasm/decode HEVC wasm 二进制，自托管用（约 4 MB）
demo.html   自检页，填地址即可验证硬解 / 软解两条路径
```

整目录是重新生成的：改完源码跑 `yarn build` 后再跑 `node ./scripts/pack-soft-decode.js` 覆盖即可。

## 方式一：脚本标签（推荐）

把 `umd/` 和 `wasm/` 一起放到静态目录，按顺序引入。`xgplayer` 在最前，软解包必须在
hls/flv 之前（它只注册一个全局，插件创建时读取）。

```html
<link rel="stylesheet" href="./umd/xgplayer.min.css">
<script src="./umd/xgplayer.min.js"></script>
<script src="./umd/xgplayer-soft-decode.min.js"></script>
<script src="./umd/xgplayer-hls.min.js"></script>
<script src="./umd/xgplayer-flv.min.js"></script>

<script>
  new Player({
    id: 'player',
    url: 'https://host/live/stream.flv',
    isLive: true,
    autoplay: true,
    autoplayMuted: true,
    plugins: [FlvPlayer],            // HLS 用 HlsPlayer
    softDecode: 'auto',              // 'auto' 探测回退 / true 强制软解 / false 关闭
    softDecodeOptions: { wasmBaseUrl: './wasm' },
    onSoftDecodeFallback (info) { console.log('回退软解', info.reason) }
  })
</script>
```

全局变量：`Player` / `HlsPlayer` / `FlvPlayer` / `SoftDecode`。
解封装与流式基础包已内联进 hls/flv 产物，不需要单独引入。

## 方式二：打包器

把 `es/` 下 6 个目录覆盖到项目 `node_modules` 里的同名包（覆盖后别再有全新 install，
否则会被还原；要长期固化就发内部 npm 或做 patch 包）：

```bash
cp -R es/* <你的项目>/node_modules/
```

`es/` 保留裸包名 import，项目里需要这些依赖：

```text
eventemitter3                              xgplayer / hls / flv 用
@libmedia/avcodec@1.3.1                    软解 wasm 胶水
@libmedia/avutil@1.3.1
@libmedia/cheap@1.3.1
danmu.js / delegate / xgplayer-subtitles   xgplayer 用
```

```js
import Player from 'xgplayer'
import HlsPlayer from 'xgplayer-hls'
import 'xgplayer-soft-decode'          // import 即注册全局

new Player({ url, plugins: [HlsPlayer], softDecode: 'auto', softDecodeOptions: { wasmBaseUrl: '/wasm' } })
```

## wasm 部署

`wasm/decode/` 里是 `hevc-simd.wasm`、`hevc-atomic.wasm`、`hevc.wasm`、`hevc-64.wasm`，
按 `simd -> atomic -> baseline` 逐个下载并 `WebAssembly.validate`，取第一个能编译的。
只有 HEVC 会被拉取，音频走浏览器原生解码，不需要 aac 二进制。

- `wasmBaseUrl` 指向**包含 `decode/` 的那一层**，例如 `/wasm` 会请求 `/wasm/decode/hevc-simd.wasm`。
- 响应头需要 `Content-Type: application/wasm`，跨域时补 CORS。
- 不配 `wasmBaseUrl` 就走包内置默认值
  `https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@1.3.1/dist`，内网部署必须自托管。
- 想完全不下载：`softDecodeOptions.wasmBytes`（`Uint8Array`）、`decoderWasmUrl`（单个二进制）、
  `loadWasm`（自定义加载器，可应对 CSP / `file:` 场景）。

## 配置项

```js
softDecode: 'auto' | true | false,
softDecodeOptions: {
  wasmBaseUrl: './wasm',
  maxDecodeSliceMs: 12,       // 单次事件循环里最多同步解码多少毫秒，调低更跟手
  maxFrameQueue: 24,          // 内存中保留的已解码帧数
  maxQueuedBytes: 167772160,  // 已解码帧字节上限
  maxPendingPackets: 600,     // 落后于时钟的压缩包上限，超出会裁到最近关键帧
  dropLateFrames: true,
  lateFrameThreshold: 0.12,
  wasmVariant: 'auto',        // 'auto' | 'simd' | 'atomic' | 'baseline' | '64'
  openLog: false,             // 打开可恢复解码问题的告警
  decoderWorkerUrl: ''        // 仅打包器方式可用：把解码挪到 worker
}
```

完整清单见 `es/xgplayer-soft-decode/config.d.ts`。

### 录像时间轴起点不是 0

GB28181 这类录像的分片带着很大的 `baseMediaDecodeTime`，直接喂给播放器会让进度条从两个
多小时开始走。硬解和软解两条路径都会自动把时间轴平移到播放列表的位置，不需要额外配置：

```js
hls: {
  preloadTime: 60
}
```

## 运行时接口

```js
player.plugins.hls.core.isSoftDecoding   // 当前是否软解
player.plugins.hls.core.softDecodeStats  // { decoded, rendered, dropped, queue, pending, variant }
player.forceSoftDecode('自定义原因')        // 主动切软解
player.on('core.softdecodefallback', function (info) {})
```

录像/直播同时建议设 `preloadTime` 与 `bufferBehind`：软解预缓冲会占内存，
268 s 录像整段预载约 113 MB，调到 30~60 s 会明显下降。

## 自检

wasm 不能用 `file://` 加载，起一个 http 服务：

```bash
npx http-server -p 8123 --silent .
# 打开 http://127.0.0.1:8123/demo.html
```

页面右上角显示当前浏览器的 HEVC MSE 支持情况；右下状态面板给出解码方式、wasm 变体、
解码/渲染/丢帧计数、`buffered` 区间数和卡顿计数。判断标准：`wasm 变体` 非空、
`已渲染` 持续增长、`丢帧` 接近 0、`卡顿` 为 0、缓冲区间不出现空洞。
