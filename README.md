<div align="center">
    <img src="https://raw.githubusercontent.com/bytedance/xgplayer/master/xgplayer.png" width="384" height="96">
</div>
<div align="center">
    <a href="https://www.npmjs.com/package/xgplayer" target="_blank">
        <img src="https://img.shields.io/npm/v/xgplayer.svg" alt="npm">
    </a>
    <a href="https://www.npmjs.com/package/xgplayer">
        <img src="https://img.shields.io/npm/dm/xgplaer.svg" alg="download">
    </a>
    <a href="https://www.npmjs.com/package/xgplayer" target="_blank">
        <img src="https://img.shields.io/npm/l/xgplayer.svg" alt="license">
    </a>
    <a href="https://commitizen.github.io/cz-cli/">
        <img src="https://img.shields.io/badge/commitizen-friendly-brightgreen.svg" alt="commitizen">
    </a>
</div>

# xgplayer HEVC (H.265) 软解版

西瓜播放器的 H.265 直接分发：FLV / HLS 里的 H.265 不用转码、不用装插件。浏览器能硬解就走原生 MSE，不能硬解（Firefox、国产/信创浏览器等）自动切 wasm 软解，音频由浏览器原生解码，音量、倍速、进度条一切照常。

---

## 三步接入

**1. 拷文件。** 把发布包里的 `umd/` 和 `wasm/` 直接放到项目静态目录：

```
your-project/public/
  umd/
    xgplayer.min.js
    xgplayer-soft-decode.min.js
    xgplayer-hls.min.js
    xgplayer-flv.min.js
    xgplayer.min.css
  wasm/
    decode/
      hevc-simd.wasm
      hevc-atomic.wasm
      hevc.wasm
```

`es/` 和 `loader.js` 可选（见下文）。

**2. 引脚本。** 顺序不能换，软解包先注注册表，hls/flv 再读它：

```html
<link rel="stylesheet" href="/umd/xgplayer.min.css">
<script src="/umd/xgplayer.min.js"></script>
<script src="/umd/xgplayer-soft-decode.min.js"></script>
<script src="/umd/xgplayer-hls.min.js"></script>
<script src="/umd/xgplayer-flv.min.js"></script>
```

**3. 建播放器。**

```html
<div id="player" style="width:100%;height:480px"></div>
<script>
  var player = new Player({
    id: 'player',
    url: 'https://your-host/live/stream.flv',
    isLive: true,
    autoplay: true,
    autoplayMuted: true,
    plugins: [FlvPlayer],        // .m3u8 用 HlsPlayer
    softDecode: 'auto',          // 'auto' 自动 / true 强制 / false 关闭
    softDecodeOptions: { wasmBaseUrl: '/wasm' },
    flv: { targetLatency: 1, maxLatency: 3 }
  })
</script>
```

> wasm 不能用 `file://`，页面必须走 http 服务。

### WebSocket FLV（`ws://` / `wss://`）

`url` 直接写 WebSocket 地址即可，播放器按协议自动选择 WebSocket 传输，不需要额外配置；`softDecode` / `wasmBaseUrl` 等参数和 HTTP-FLV 完全一致：

```js
var player = new Player({
  id: 'player',
  url: 'ws://192.168.1.4:8098/api/proxy/sms/pull/splw2lv.live.flv?token=...',
  isLive: true,
  autoplay: true,
  autoplayMuted: true,
  plugins: [FlvPlayer],
  softDecode: 'auto',
  softDecodeOptions: { wasmBaseUrl: '/wasm' },
  flv: {
    // 断线重连沿用 HTTP-FLV 的参数
    retryCount: 3,
    retryDelay: 1000,
    maxReaderInterval: 5000,
    // 直播流被服务端正常关闭后，缓冲播完自动重新拉流
    disconnectRetryCount: 3
  }
})
```

- 服务端每个 WebSocket 二进制帧就是一段 FLV 字节流，帧边界可以和 FLV tag 边界不一致。
- `ws://` 没有 HTTP 响应头，因此不参与 `Accept-Ranges` / 拖动预加载等点播逻辑，请按直播（`isLive: true`）使用。
- 需要握手子协议时，通过 `flv.fetchOptions.wsProtocols` 传入；需要替换 WebSocket 实现时，传 `flv.fetchOptions.createWebSocket`（`(url, protocols) => WebSocket`）。
- 还没收到数据就连接失败时按 `retryCount` 重试；已经收到数据后断开（重连会从新的 FLV 头开始）必须依靠 `disconnectRetryCount`：播放器会重建解复用器和解码器后自动重连，否则上报错误。
- 正常关闭（code 1000）按本次推流结束处理；设置 `disconnectRetryCount` 后，缓冲播完会自动重新拉流。

---

## 按需加载（可选）

SPA 不想每页背这 1.2 MB 脚本？用 `loader.js`，第一次调用时才注入：

```html
<script src="/loader.js"></script>
<script>
  XgPlayerLoader.create({ id: 'player', url: '/live/stream.flv', isLive: true })
</script>
```

`loader.js` 和 `umd/`、`wasm/` 平级，资源路径自己算出。目录不一样时用标签属性指一下：

```html
<script src="/assets/xg/loader.js" data-js-dir="." data-wasm-dir="."></script>
```

只加载不建播放器：`await XgPlayerLoader.load()`。

---

## 配置项

| 选项 | 说明 |
|------|------|
| `softDecode` | `'auto'`(默认) 自动回退 / `true` 强制软解 / `false` 关闭 |
| `softDecodeOptions.wasmBaseUrl` | wasm 所在目录，含 `decode/` 的那层 |
| `softDecodeOptions.renderer` | `'canvas'`(默认) / `'video'`(仅支持硬解) |
| `softDecodeOptions.wasmVariant` | `'simd'` / `'atomic'` / `'baseline'` / `'64'` |
| `onSoftDecodeFallback` | 回调 `function(info)`，切软解时通知 |

---

## 运行时接口

```js
player.forceSoftDecode(reason)         // 运行时切到软解
player.plugins.flv.core.isSoftDecoding // true/false
player.plugins.flv.core.softDecodeStats // 解码/渲染/丢帧计数
player.getLiveLatency()                // 直播延迟（秒）
```

hls 把 `flv` 换成 `hls`。

## 运行 Demo

克隆仓库后可直接运行演示页（无需额外下载）：

```bash
# 1. 安装依赖（首次）
yarn

# 2. 构建所有包
yarn build:all

# 3. 启动 demo（自动拷贝 JS + 下载 wasm）
cd demo
bash start.sh
# 浏览器打开 http://127.0.0.1:8080/demo/index.html
```

演示页支持 FLV（含 `ws://` / `wss://`）/ HLS 播放，可在界面切换硬解/软解模式，实时查看解码状态。

> wasm 文件由 `start.sh` 自动从 libmedia 官方仓库下载到 `demo/wasm/decode/`，支持离线使用。
> 也可以单独执行 `bash scripts/download-wasm.sh` 手动下载 wasm。

---

## 目录说明

```
umd/      4 个 JS + 1 个 CSS，标签引入用
es/       6 个包的 ESM 产物，打包器/内部 npm 用
loader.js 可选按需加载器
wasm/     HEVC 软解 4 个变体（浏览器自动选最优）
demo.html 自检页
```

浏览器实际下载：JS+CSS 约 1.2 MB + 一个 wasm（861 KB ~ 1.16 MB）。wasm 只在需要软解时才请求。
