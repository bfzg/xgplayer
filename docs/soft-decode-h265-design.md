# xgplayer H.265 软解方案（FLV / HLS，HTTP / HTTPS）

## 1. 背景与目标

`xgplayer-flv` 与 `xgplayer-hls` 已经预留了一条 `softDecode` 分支，但 OSS 版本始终缺少与之配套的软解媒体元素，实际跑不起来：

- `softDecode` 判定逻辑：[plugin.js](../packages/xgplayer-flv/src/plugin.js)（`mediaType` 非 `video/audio/offscreen-video` 即为软解）
- FLV 软解分支：[buffer-service.js](../packages/xgplayer-flv/src/flv/services/buffer-service.js#L278) 直接调用 `this._softVideo.appendBuffer(videoTrack, audioTrack)`
- HLS 软解分支：[buffer-service/index.js](../packages/xgplayer-hls/src/hls/buffer-service/index.js#L239) 同构
- 软解元素来源是 `hls.media` / `flv.media`，即 `player.media`（由 [mediaProxy.js](../packages/xgplayer/src/mediaProxy.js) 创建）

本方案补齐 H.265（HEVC）软件解码，覆盖 FLV、HLS，兼顾 HTTP 与 HTTPS，并保证默认仍走硬解。

### 需求

1. 默认硬解，优先使用原生 `<video>` + MSE。
2. 浏览器不支持 HEVC 硬解时，自动回退到 wasm 软解，业务侧无需干预。
3. 同时支持 FLV 与 HLS。
4. 同时支持 HTTP（明文）与 HTTPS。
5. 视频 HEVC，音频 AAC。
6. 软解渲染优先复用 `<video>`，无法复用时使用 canvas。

### 非目标

- 不做服务端转码。
- 不接管网络层：拉流、HLS 播放列表解析、Range、重试仍由 `NetLoader`（`xgplayer-streaming-shared`）负责。
- 第一版不支持 DRM / 加密流。

## 2. 设计前提（关键结论）

这几条决定了整套方案的形状，先明确：

1. **MSE 只接受「编码后的容器片段」**（带 init segment 的 fMP4 / WebM / TS），浏览器负责解封装与解码。它没有「送解码帧」的入口。因此「wasm 解码 + MSE」**只能**通过中间再编码（HEVC → wasm 重编码 AVC/AV1 → fMP4 → MSE）成立。
2. **MSE 与 `<video>` 不是 HTTPS 专属**，HTTP 页面同样可用。所以「HTTP 只能用 canvas、HTTPS 才能用 video」不成立。
3. **HTTPS 相对 HTTP 的真正增益在解码侧**：`SharedArrayBuffer`（需 `COOP/COEP` 跨源隔离，而跨源隔离需安全上下文）解锁多线程 wasm 解码；`WebCodecs` 也签了 `[SecureContext]`。其余如 WebGL/WebGPU、OffscreenCanvas、WASM SIMD 两边都可用。
4. **canvas 渲染不是降级**。主流 Web 软解（B 站、快手等）均以 WebGL/WebGPU canvas 输出，配合 OffscreenCanvas 可全程留在 worker，主线程零拷贝参与。

## 3. 总体架构

目标是把「拉流 + 解封装」与「解码 + 渲染」彻底解耦：前者复用现有实现，后者收敛到一个可切换的 Sink 抽象。

```text
                       ┌──────────────────── xgplayer core ────────────────────┐
HTTP / HLS / FLV ─► NetLoader ─► transmuxer(demux) ─► MediaSink.append(video, audio)
                       └───────────────────────────────────────────────────────┘
                                                       │
                     ┌─────────────────────────────────┴─────────────────────────────────┐
                     ▼ MseSink（硬解，默认）                                               ▼ SoftSink（回退）
            FMP4Remuxer ─► MSE ─► 原生 <video>                        ┌────────────────────────────────────┐
                                                                       │ HEVC ─► libmedia wasm（worker / 主线程）│
                                                                       │      ─► canvas + WebGL              │
                                                                       │ AAC  ─► FMP4Remuxer（仅音频）        │
                                                                       │      ─► 音频-only MSE ─► <video>    │
                                                                       └────────────────────────────────────┘
```

要点：

- 硬解路径把 demux 产物交给 `MseSink`，内部完成 `FMP4Remuxer → MSE → <video>`。
- 软解路径把同一份 demux 产物交给 `SoftSink`，内部完成 HEVC 软解渲染与 AAC 音频输出。
- `player.media` **始终是原生 `<video>`**，两条路径都不替换它；软解时 `<video>` 承载音频-only MSE 并充当播放时钟，画面由覆盖在其上的 canvas 呈现。这样 controls / progress / stats 等既有插件不受影响。
- 硬解与软解之间的切换发生在 Sink 内部，不需要重建 Flv / Hls core，网络与播放列表状态得以保留。

## 4. 解码决策阶梯

按顺序判定，任一失败进入下一级：

1. **HEVC MSE 硬解**：`MediaSource.isTypeSupported('video/mp4; codecs="hvc1.<profile>.<level>"')`（`hev1.` 变体也探测一次）。成功即走 `MseSink` → 原生 `<video>`。
2. **WebCodecs 硬解**：`VideoDecoder.isConfigSupported({ codec, hardwareAcceleration: 'prefer-hardware' })`。成功则解码产物为 `VideoFrame`，交给渲染层。
3. **wasm 软解**：上述均失败时启用 `SoftSink`。

其中第 1 步的 codec 字符串当前不可靠：`xgplayer-transmuxer` 里 HEVC 的 `codec` 是写死的 `hev1.1.6.L93.B0`（[hevc.js](../packages/xgplayer-transmuxer/src/codec/hevc.js#L130)、[mp4-parser.js](../packages/xgplayer-transmuxer/src/mp4/mp4-parser.js#L644)），必须改成由 SPS 的真实 `generalProfileIdc / generalLevelIdc / generalProfileCompatibilityFlags` 推导，探测才准确。

### 触发方式（`softDecode` 与 `softDecodeMode` 的双语义）

历史上 `softDecode` 只有一个含义：**业务侧自己提供了软解媒体元素**（`mediaType` 取
`video/audio/offscreen-video` 之外的值，例如 `'flv-soft'`），命中后走 `_softVideo.appendBuffer`。
内置 wasm 软解是另一件事，因此拆成两个互不干扰的语义：

- **旧语义**：`flv.softDecode` / `hls.softDecode`（或由 `mediaType` 自动推断）= 外部软解元素，
  行为与既有版本完全一致。
- **新语义**：顶层 `softDecode: 'auto' | true | false`，等价写法为 `flv.softDecodeMode` /
  `hls.softDecodeMode` = 内置 wasm 软解请求。
  - `true`：强制软解（对应 §6 的 `FORCED`）。
  - `'auto'`：按上面的阶梯探测，仅当平台无法硬解 HEVC 时回退；**注册软解包后这是默认值**。
  - `false`：显式关闭，即使硬解失败也不回退。

两条关键行为：

1. **注册即自动**：只要软解包已注册（UMD 全局 `XGPlayerSoftDecode` / `SoftDecode`，或通过
   `softDecodeOptions.createSoftSink` 注入），且调用方从未提及 `softDecode`，就默认按 `'auto'`
   启用；显式 `false` 仍然优先。
2. **没有包就退回硬解**：配置为 `'auto'` / `true` 但找不到软解工厂时只记一条 warning，
   保持原生解码，不会让播放直接失败。

### 运行时兜底

除主动探测外，以下信号同样触发回退：

- `sourceBuffer.appendBuffer` 抛 codec-not-supported / `MediaSource` 打开失败。
- `<video>` 报 `MEDIA_ELEMENT_ERROR: Format error`，或 `readyState` 在预期时间内长期为 0。
- 既有降级信号：`lowdecode` / `player.forceDegradeToVideo`（参见 [plugin-extension.js](../packages/xgplayer-flv/src/plugin-extension.js) 与 HLS 中同名扩展）。

### 回退动作（不重建 core）

`SinkManager` 收到失败信号后：

1. 停用并销毁 `MseSink`（`unbindMedia`、释放 SourceBuffer）。
2. 构建 `SoftSink`（复用同一个 `<video>` 与同一份配置）。
3. **重放初始化信息**：缓存最近一次的序列头（HEVC 的 VPS/SPS/PPS、AAC 的 ASC）与最近一个 IDR。
4. VOD：从 `currentTime` 回溯到最近关键帧重新拉取；直播：等待下一个 IDR 续上。
5. 派发回退事件（见 §10），供业务侧埋点或提示。

整个过程对上层只有一次短暂卡顿，URL、播放列表、统计口径均不重置。

## 5. 能力探测

新增独立模块，建议放在 `xgplayer-streaming-shared`：`src/media-capability.js`，对外暴露：

```js
supportsHevcMse(codecString)        // MediaSource.isTypeSupported，含 hvc1/hev1 变体
supportsHevcWebCodecs(codecString)  // VideoDecoder.isConfigSupported
canUseThreads()                     // crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined'
```

`canUseThreads()` 用于探测站点是否处于跨源隔离环境（`crossOriginIsolated` 且存在
`SharedArrayBuffer`）。当前 libmedia 的 wasm 构建不带 `threadModule`，解码固定以
`threadCount = 1` 打开，因此该探测只作为站点侧的可选信息，**软解不依赖跨源隔离**，普通
HTTP / HTTPS 页面都能直接跑。

## 6. 统一 Sink 抽象

在 Flv / Hls 的 BufferService 中，把当前「按 `softDecode` 二选一」的分支（构造期即固定）替换为运行时可切换的 Sink。

```ts
interface MediaSink {
  append(videoTrack, audioTrack): Promise<void>
  endOfStream(): Promise<void>
  setDuration(duration: number): void
  reset(reuseSink?: boolean): Promise<void>
  isFull(type: 'video' | 'audio'): boolean
  evict(start: number, end: number): Promise<void>
  destroy(): Promise<void>
  readonly kind: 'mse' | 'soft'
  readonly blobUrl?: string
}
```

- `MseSink`：内部持有 `FMP4Remuxer` 与 `MSE`，把现有硬解行为原样搬进来。
- `SoftSink`：内部持有 wasm 解码会话与渲染器，并向 `<video>` 挂接音频-only MSE。
- `SinkManager`：持有当前 Sink，负责 `mse → soft` 的一次性切换与初始化信息重放。

这样 Flv / Hls 的核心循环只剩一句 `sink.append(video, audio)`，不再感知解码方式。

**迁移顺序**：先引入 `MediaSink` 接口与 `MseSink`（纯搬家，行为不变，靠现有测试兜底），再加 `SoftSink`，最后接线回退。这样每一步都可独立验证和回滚。

## 7. 软解渲染

实现路径：解码在 worker 或主线程完成，解码出的帧缓冲通过 `postMessage` + `Transferable`
（transfer 而非拷贝）交回主线程，由 `canvas-renderer` 建立 WebGL 上下文，把 YUV 平面
`texImage2D` / `texSubImage2D` 上传，shader 做 YUV → RGB，画到覆盖在 `<video>` 上的 canvas。

- worker 解码为**可选**：默认关闭，需显式配置 `decoderWorkerUrl` / `decoderWorkerFactory`
  （见 §10）；未配置时在主线程解码，其余流程不变。
- 渲染固定走 canvas（`renderer: 'canvas'`）；`<video>` 仍承载音频-only MSE，充当播放时钟并
  保留 controls / progress / stats。

后续可优化：把 `<canvas>` 通过 `transferControlToOffscreen()` 交给 worker，让解码 + 渲染
全程留在 worker、主线程只参与最终合成，做到零逐帧拷贝。`canvas-renderer` 已兼容
`OffscreenCanvas` 入参，接上 transfer 即可。

分辨率策略：默认软解上限 1080p，低端设备（`navigator.hardwareConcurrency` 与内存启发式）默认降到 720p；提供 `maxSoftResolution` 配置覆盖。开启丢帧时，渲染队列落后于音频时钟超过阈值即丢非关键帧。

## 8. 音频

第一版 AAC 不软解，走原生：

- `FMP4Remuxer` 只输出音频 init/segment，喂给音频-only MSE，挂到同一个 `<video>`。
- 直接复用原生音频时钟做 A/V 同步，`currentTime`、`buffered`、`duration`、seek、playbackRate 全部原生，播放器既有逻辑零改动。

边界情况：

- **纯视频流（无音轨）**：注入一条静音 AAC 轨维持原生时钟，避免自建时钟；比手动驱动 `currentTime` 更稳。
- **音频也解不了**（极少数）：作为二期能力，切换到 wasm AAC 解码 + WebAudio 输出，自建时钟。

## 10. 配置与对外接口

```js
new Player({
  url,
  isLive,
  // 新语义：内置 wasm 软解。注册软解包后默认 'auto'；true 强制；false 关闭。
  softDecode: 'auto',
  softDecodeOptions: {
    worker: 'auto',          // 'auto' | true | false；未接线 worker 时主线程解码
    decoderWorkerUrl,        // 可选：指向 es/decoder/decoder.worker.js，配了才用 Worker
    decoderWorkerFactory,    // 可选：自己 new Worker，绕开 url 解析
    renderer: 'canvas',      // 软解画面统一走 canvas
    maxSoftResolution: 1080, // 软解分辨率上限（按高度），0 关闭
    dropLateFrames: true,
    lateFrameThreshold: 0.12,
    maxFrameQueue: 24,       // 解码帧队列上限
    maxQueuedBytes,          // 解码帧字节上限，默认 96 MiB
    maxDecodeBatch: 8,       // 每次 pump 喂给解码器的包数
    maxFrameBytes,           // 单帧上限，默认 32 MiB
    audioThrough: 'mse-native', // AAC 走原生音频-only MSE
    canvas: null,            // 外部画布，缺省由 sink 创建覆盖层
    wasmBaseUrl,             // 自托管根目录，指向含 decode/ 的 libmedia dist
    decoderWasmUrl,          // 指定单个 wasm 二进制，跳过能力阶梯
    wasmBytes,               // 直接给二进制，零网络
    wasmModule,              // 已编译的 WebAssemblyResource
    wasmVariant: 'auto',     // 'auto' | 'simd' | 'atomic' | 'baseline' | '64'
    wasmDecoderOptions,      // 透传给 WasmVideoDecoder.open
    loadWasm,                // 高级：自定义 wasm 加载器
    fetchImpl,               // 高级：自定义 fetch（CSP / file: 场景）
    createDecoderSession,    // 高级：整体替换解码会话
    createSoftSink,          // 高级：直接注入 sink 工厂
    openLog: false           // 打开软解告警日志
  },
  // 旧语义：外部软解媒体元素，保持原行为
  flv: { softDecode: 'my-soft-element' },
  hls: { softDecode: 'my-soft-element' },
  onSoftDecodeFallback (info) {} // { reason, from, to, codec, resolution }
})
```

`softDecode` 与 `flv.softDecodeMode` / `hls.softDecodeMode` 等价；后一种写法可以避免和旧语义在
同一层配置里混淆。注册软解包有三种方式：

关于 worker：`worker` 默认 `'auto'`，但**解码 worker 需要显式接线**。ES 产物自带
`es/decoder/decoder.worker.js`，把 `decoderWorkerUrl` 指过去即可；或用 `decoderWorkerFactory`
注入自己的 `Worker` 实例。两者都没提供时不会被构造，解码退回主线程（`worker` 的判定仍会
先尝试）。之所以不在库内用 `import.meta.url` 自动解析，是因为 UMD 是单文件产物、没有同级
worker 模块，而引用 `import.meta.url` 会迫使打包器产出 UMD 无法表达的 code-split worker chunk。

```js
import 'xgplayer-soft-decode'                       // ESM：import 即自动注册
// 或 <script src="xgplayer-soft-decode/dist/index.min.js"></script>
// 或手动：registerSoftDecode(globalThis)
```

同时暴露事件 `SOFT_DECODE_FALLBACK`，与既有 `lowdecode` / `forceDegradeToVideo` 复用同一套降级通道；
需要手动触发时调用 `player.forceSoftDecode(reason)`。

## 11. 改动清单

| 位置 | 改动 |
|------|------|
| `packages/xgplayer-transmuxer/src/codec/hevc.js` | 由 SPS 推导真实 codec 字符串，替换写死的 `hev1.1.6.L93.B0` |
| `packages/xgplayer-transmuxer/src/mp4/mp4-parser.js` | 同上，hvc1 解析路径 |
| `packages/xgplayer-streaming-shared/src/media-capability.js` | 新增能力探测 |
| `packages/xgplayer-streaming-shared/src/mse.js` | 抽出可被 Sink 复用的 MSE 封装（如需） |
| `packages/xgplayer-flv/src/flv/services/buffer-service.js` | 改为 `SinkManager` + `MediaSink` |
| `packages/xgplayer-hls/src/hls/buffer-service/index.js` | 同上 |
| `packages/xgplayer-flv/src/plugin.js`、`packages/xgplayer-hls/src/plugin.js` | `softDecode` 由布尔扩展为 `'auto'`；接线回退与事件 |
| `packages/xgplayer-soft-decode/`（新包） | wasm 解码会话、canvas（WebGL）渲染器、`SoftSink`、媒体元素适配 |

## 12. 分期计划

1. **能力探测 + codec 字符串修正**：`softDecode: 'auto'` 写入配置但不改变现有行为，可独立验证探测准确性。
2. **Sink 抽象重构**：引入 `MediaSink` / `MseSink`，行为不变，跑通现有 FLV / HLS 测试。
3. **SoftSink**：新包实现 libmedia wasm 解码、canvas（WebGL）渲染、音频-only MSE。
4. **自动回退接线**：探测失败 / append 失败 / `lowdecode` 触发回退，接通事件与统计。
5. **可选**：wasm AAC 音频（彻底去除 MSE 依赖）。

## 13. 风险与取舍

- **许可**：libmedia 为 LGPL-3.0-or-later，wasm 二进制内含 FFmpeg 组件。JS 侧只以 npm 依赖形式引入 `@libmedia/{avcodec,avutil,cheap}`，wasm 二进制不进仓库、运行时按需动态加载并保留许可声明，且不得编入 GPL 构建（`--enable-gpl` 的 x265 等）。若需规避 LGPL，可将 HEVC 解码换成 openh265（BSD-2），代价是工具链与 10-bit / HDR 支持要另行处理。
- **播放器集成**：`<video>` 承载音频-only MSE 时 `videoWidth/videoHeight` 为 0，需要由软解层覆盖并同步给布局与 stats，否则画面尺寸/统计异常。
- **COOP/COEP 无副作用**：解码固定单线程，不需要 `SharedArrayBuffer`，因此不要求站点开启跨源隔离，第三方脚本与 iframe 嵌入不受影响。libmedia 自带的 `test/sw.js`（coi-serviceworker）只在它自己的多线程示例里需要。
- **性能下限**：1080p50/60 HEVC 单线程解码在低端设备上会掉帧，依赖丢帧策略与默认 1080 分辨率上限兜底；需要更高吞吐时把解码挪进 worker（见 §10）。

> 说明：不采用「软解 → 重编码 → MSE → `<video>`」路线。MSE 只接受编码后的容器片段，要让软解画面由原生 `<video>` 渲染必须额外插入一路 wasm 编码，CPU 与延迟代价过高，收益不匹配。软解画面统一由 canvas 呈现。

## 14. 验收标准

- HTTP 与 HTTPS、FLV 与 HLS、HEVC 流，在无平台 HEVC 硬解能力的 Chrome / Firefox 上可正常播放。
- 具备 HEVC 硬解能力的浏览器仍走原生 `<video>`，无回归。
- 回退自动触发，业务侧无感知；触发后 URL、播放列表、统计不重置。
- 音画同步误差在 ±100ms 内，seek 可用，`currentTime / duration / buffered` 语义与硬解一致。
- 无 `COOP/COEP` 的普通页面即可播放；解码进 worker 时帧缓冲以 `Transferable` 转移，不逐帧拷贝。

## 15. 实现进度

### 第 1 期（已完成）

- `xgplayer-transmuxer` 新增 `getHevcCodec(hvcC, prefix)`，按 ISO/IEC 14496-15
  Annex E 由 SPS 的 profile / tier / level / compatibility / constraint 推导
  codec 字符串，替换了 `hevc.js` 与 `mp4-parser.js` 中写死的 `hev1.1.6.L93.B0`。
  顺带修正了 `mp4-parser.js` 里 `generalProfileCompatibility` 字段名与
  `mp4.js` 读取的 `generalProfileCompatibilityFlags` 不一致的问题。
- `xgplayer-streaming-shared` 新增 `src/media-capability.js`，导出
  `supportsHevcMse` / `supportsHevcWebCodecs` / `canUseThreads` / `swapHevcPrefix`。
- `Sniffer.isHevcSupported(codecString)` / `Player.isHevcSupported(codecString)`
  支持传入真实 codec 串，并自动探测 `hvc1` / `hev1` 两种变体。
- 补单测：`getHevcCodec`、`media-capability`、`Sniffer.isHevcSupported`；
  同步 `ts-hevc` 快照（真实 level 为 2.0，旧值 3.1 系硬编码错误）。

### 第 2 期（已完成）

`xgplayer-streaming-shared/src/sink/` 新增 Sink 抽象层，FLV / HLS 的软解分支与硬解分支
统一收敛到这里：

- `media-sink.js`：`MediaSink` 基类，定义 `append(videoTrack, audioTrack)` /
  `endOfStream()` / `reset()` / `destroy()` 契约。
- `mse-sink.js`：`MseSink`，把 demux 产物经 `FMP4Remuxer` 喂给 MSE + 原生 `<video>`，
  即原有硬解行为的等价封装。
- `sink-manager.js`：`SinkManager` 持有当前 sink，`switchToSoft()` 单向切到软解，
  `ensureMse()` 只保证 MSE 就绪（不切路径），并把最近一次切换记为
  `_fallbackInfo = { reason, from, to, ...info }`。
- `index.js`：统一出口。

`xgplayer-flv/src/flv/services/buffer-service.js` 与
`xgplayer-hls/src/hls/buffer-service/index.js` 改为经 `SinkManager` + `MediaSink`
append，行为对现有硬解路径保持不变，原有 FLV / HLS buffer 测试全部通过。

### 第 3 期（已完成）

新增 `packages/xgplayer-soft-decode/`，解码内核为 **libmedia**（`@libmedia/{avcodec,avutil,cheap}`
1.3.1，FFmpeg 的 wasm 构建，LGPL-3.0-or-later）。选型理由：公开可用、npm 可直接安装、
一个只含 HEVC 解码器的二进制约 1.2 MB，且提供 `WasmVideoDecoder` 这样可自控生命周期的
低级接口，便于把 pts / 帧序 / 丢帧策略握在播放器手里。

- `decoder/`：
  `libmedia.js`（wasm 资源解析：`wasmModule` → `loadWasm` → `wasmBytes` → `decoderWasmUrl`
  → `wasmBaseUrl` 能力阶梯 `simd` / `atomic` / `baseline`，逐个 `WebAssembly.validate`
  后 `compileResource`，按 url / 名称缓存，首次回退才发请求）、
  `hevc-decoder.js`（由 track 构造 `AVCodecParameters`：`AV_CODEC_ID_HEVC` +
  `AV_CODECPAR_FLAG_H26X_ANNEXB` + H.264/HEVC 走 Annex B；`open(ptr, 1, opts)` 固定单线程）、
  `nalu.js`（裸 NAL → Annex B，容忍空 units）、
  `frame.js`（`AVFrame` 映射 + `crop{Top,Bottom,Left,Right}` + `pts` BigInt 归一，
  10-bit / HDR 降到 8-bit 呈帧）、
  `session.js`（`wrapSession` / `wrapControl`，`decode` / `flush` 返回 Promise）、
  `av-sync.js`（libmedia 按 **解码序** 回调，`pts` 无效时为 `NOPTS_VALUE = -1`；
  排序后 `take()` 丢弃迟到帧，无效 pts 只弹队首一帧立即渲染）、
  `worker-factory.js` / `worker-control.js` / `decoder.worker.js`（worker 为可选：
  配了 `decoderWorkerUrl` / `decoderWorkerFactory` 才进 Worker，否则主线程解码）。
- `render/`：`pixel-formats.js`（`describeFrame` / `slicePlane` / `resolvePixFmt` / `PIX_FMT`，
  pix_fmt 取值为 libavutil 的位置常量，按构建固定）、
  `canvas-renderer.js`（canvas 2D 直绘 + WebGL `texImage2D` / YUV→RGB shader 两条路径）、
  `overlay.js`（`OVERLAY_CLASS='xgplayer-soft-decode-canvas'`，`pointer-events:none`，`z-index:1`）。
- `audio/`：`audio-output.js`（AAC 走音频-only MSE → 原生 `<video>`，含 `_selectTrack` 静音轨、
  codec 变化重建源、`updateDuration`、`endOfStream`、`evict`）、`silent-track.js`。
- `soft-sink.js`：`createSoftSinkFactory` 组装解码会话 + 渲染器 + 音频输出；
  `<video>` 始终挂音频-only MSE 当播放时钟，画面由覆盖其上的 canvas 呈现；
  `snapshotVideo` 在 `<video>` 上镜像 `videoWidth/Height`；`decode` 失败落 `lastError`，
  `endOfStream` drain 队列，`reset` / `destroy` 幂等。
- `config.js` / `index.js` / `index.umd.js` / `register.js`：默认配置、导出与全局注册；
  `import 'xgplayer-soft-decode'` 即自动注册。

补单测 11 个 spec：`config`、`libmedia`、`hevc-decode`、`nalu`、`pixel-formats`、`session`、
`av-sync`、`silent-track`、`audio-output`、`soft-sink`、`worker-factory`。

两条与 libmedia 有关的硬约束，改动时不要踩：

1. **禁止 `import '@libmedia/avutil/enum'`**。它是 TypeScript `const enum`，产物里没有运行时
   对象，ESM 下直接报错。需要的常量一律在本包里自己按值固定（`AV_CODEC_ID_HEVC = 173`、
   `AVMEDIA_TYPE_VIDEO = 0`、`AV_PKT_FLAG_KEY = 1`、`AV_CODECPAR_FLAG_H26X_ANNEXB = 1`、
   `AVColorRange.JPEG = 2` 等），并注明来源版本。
2. **`threadCount` 只能是 `1`**。libmedia 的解码二进制编译时不带 `threadModule`，传 `> 1`
   会走到空的 `wasm_pthread_create`。

### 第 4 期（已完成）

- `xgplayer-flv/src/plugin.js` 与 `xgplayer-hls/src/plugin.js` 把 `softDecode` 扩展为
  `boolean | 'auto'`，并保留旧语义：`mediaType` 非 `video/audio/offscreen-video` 或显式传入
  外部软解元素时，仍走 `_softVideo` 分支。
- `softDecodeMode` 缺省 `false`，注册软解包后默认 `'auto'`：`legacySoftVideo` → 旧语义、
  显式 `false` → 关闭、其余按 `requestedMode` 落到 `effectiveMode`。
- 运行时兜底：HEVC MSE / WebCodecs 探测失败，或 append / SourceBuffer 创建失败、
  `MEDIA_ELEMENT_ERROR`、`readyState` 长期为 0、`lowdecode`，都经 `SinkManager.switchToSoft`
  触发回退（单向，不重建 core，URL / 播放列表 / 统计不重置）。
- 回退结果经 `EVENT.SOFT_DECODE_FALLBACK`（`core.softdecodefallback`）抛出，plugin 透传给
  Player（`player.on(EVENT.SOFT_DECODE_FALLBACK)` / `onSoftDecodeFallback`），
  并暴露 `player.forceSoftDecode(reason)` 供手动触发。
- `softDecodeOptions` 全量透传；`createSoftSink` 未提供时不注册软解包，走回旧行为。

### 第 5 期（可选）

wasm 侧音频解码（彻底去除音频-only MSE 依赖）。当前 AAC 走原生 MSE 就足够，暂不排期。

### libmedia wasm 资源

JS 侧（`@libmedia/avcodec` / `@libmedia/avutil` / `@libmedia/cheap`，固定 1.3.1）走 npm 依赖；
**wasm 二进制不进仓库**，运行时才按需加载，默认基址为锁定版本的 jsDelivr 镜像：

```text
https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@1.3.1/dist/decode/hevc{,-simd,-atomic,-64}.wasm
```

`DEFAULT_WASM_BASE_URL` 就是这个 `dist` 根目录，`wasmUrlFor()` 在其后拼
`decode/<codec><suffix>.wasm`。首次真正回退到软解时才发请求，导入包不产生任何网络行为。

自托管按需用这几个配置，优先级从高到低：`wasmModule`（已编译资源）→ `loadWasm`（自定义加载器）
→ `wasmBytes`（本地字节，零网络）→ `decoderWasmUrl`（单个二进制）→ `wasmBaseUrl` + `wasmVariant`
（能力阶梯）。把整份 libmedia `dist/` 放到自己站点后指一次 `wasmBaseUrl` 即可：

```js
softDecodeOptions: { wasmBaseUrl: 'https://static.example.com/libmedia/1.3.1' }
```

需要覆盖 CSP 或 `file://` 环境时用 `fetchImpl` / `wasmBytes`，别让包自己去猜。

**用源码树产物**（本仓库开发期最直接）：libmedia 仓库 `packages/*` 的版本与 npm 依赖同为
1.3.1，其 `dist/decode/hevc*.wasm` 与 CDN 上的字节完全一致，因此可以直接把本地 `dist/` 当
自托管源，验证不依赖任何 CDN。仓库带了个只用于开发的静态托管脚本
[scripts/serve-wasm.js](/Volumes/cc/code/xgplayer/scripts/serve-wasm.js)，按显式传参、
`$LIBMEDIA_DIST`、`../libmedia/dist`（与本仓库同级的那份 checkout）的顺序找根目录，
所有响应都带 CORS 头，`decode/*.wasm` 的 `Content-Type` 为 `application/wasm`：

```bash
yarn dev:wasm                            # 默认 8098，root 就是 libmedia 的 dist
yarn dev:wasm /path/to/libmedia/dist -p 9000

# demo 里把软解基址指过去并强制软解，确认 wasm 只从本地来源加载
yarn dev:hls
# http://127.0.0.1:8081/fixtures/hls/index.html?url=...&softDecode=true&wasmBaseUrl=http://127.0.0.1:8098
```

`libmedia/test/` 里的 `sw.js` 是 coi-serviceworker，只为它自己的多线程示例补
`COOP/COEP`；软解走单线程，不需要照搬这套头。

升级 libmedia 时同步这三处：npm 依赖版本、`LIBMEDIA_WASM_VERSION`（决定 CDN 锁的版本号）、
以及本包内按值固定的那批 FFmpeg 常量；三者不一致的表现是 `open()` 返回错误码或解出花屏，
不会以异常形式暴露。

## 16. 验证与开发注意

demo（`fixtures/hls`、`fixtures/flv`）已支持从 query string 驱动，便于脚本化验证，也保留
localStorage 记忆：

```text
?url=...&softDecode=true&softDecodeMode=auto&autoplay=true&isLive=false
&manualLoad=false&wasmBaseUrl=...&decoderWasmUrl=...&decoderWorkerUrl=...&openLog=true&worker=false
```

`softDecode` / `softDecodeMode` 支持 `true` / `false` / `auto` 三种值，`auto` 下用
`MediaSource.isTypeSupported` 打桩即可模拟「无 HEVC 硬解」的浏览器，验证自动回退；回退后
`core.isSoftDecoding` 为 true，`core.softDecodeStats` 给出 `decoded / rendered / dropped /
queue / variant`，截图能看到 canvas 上的真实解出画面即为通过。

两条环境约束：

- `@libmedia` 的 ESM 产物用 BigInt 字面量表示 pts/dts，Vite 预打包依赖默认按
  `es2019`（`modules`）转译，esbuild 无法降级 BigInt 语法。已在
  [scripts/utils/config.js](../scripts/utils/config.js#L129) 的 `optimizeDeps.esbuildOptions.target`
  固定 `es2020`；新增 demo 或改构建目标时不要把它降回去。
- 本仓库 `yarn lint` 会重写全仓 200+ 文件，改动后只做定点格式化：
  `npx biome check --write <本次涉及的路径>`，然后 `git diff --stat` 确认没有波及无关文件。
