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
      hevc-64.wasm
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
