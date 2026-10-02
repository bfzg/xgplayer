<div align="center">
    <img src="https://raw.githubusercontent.com/bytedance/xgplayer/master/xgplayer.png" width="384" height="96">
</div>
<div align="center">
    <a href="https://www.npmjs.com/package/xgplayer" target="_blank">
        <img src="https://img.shields.io/npm/v/xgplayer.svg" alt="npm">
    </a>
    <a href="https://www.npmjs.com/package/xgplayer" target="_blank">
        <img src="https://img.shields.io/npm/l/xgplayer.svg" alt="license">
    </a>
</div>

# xgplayer HEVC (H.265) Soft Decode Edition

xgplayer with H.265 soft decode for FLV / HLS. No transcoding, no browser plugins.
When hardware HEVC is available (Chrome/Edge with GPU HEVC, Safari 16+) it plays natively.
When it's not (Firefox, most China/domestic browsers, Linux without HEVC decoder) it transparently falls back to wasm soft decode
on a canvas overlay. Audio is always native, so volume, seek, subtitles, and playback rate all work normally.

---

## Quick Start (3 steps)

**1. Copy files.** Drop `umd/` and `wasm/` into your static directory:

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

`es/` and `loader.js` are optional (see below).

**2. Add scripts.** Order: core -> soft decode -> hls -> flv.

```html
<link rel="stylesheet" href="/umd/xgplayer.min.css">
<script src="/umd/xgplayer.min.js"></script>
<script src="/umd/xgplayer-soft-decode.min.js"></script>
<script src="/umd/xgplayer-hls.min.js"></script>
<script src="/umd/xgplayer-flv.min.js"></script>
```

**3. Create a player.**

```html
<div id="player" style="width:100%;height:480px"></div>
<script>
  var player = new Player({
    id: 'player',
    url: 'https://your-host/live/stream.flv',
    isLive: true,
    autoplay: true,
    autoplayMuted: true,
    plugins: [FlvPlayer],        // HlsPlayer for .m3u8
    softDecode: 'auto',          // 'auto' / true / false
    softDecodeOptions: { wasmBaseUrl: '/wasm' },
    flv: { targetLatency: 1, maxLatency: 3 }
  })
</script>
```

> wasm cannot load from `file://`, serve the page over http.

---

## Lazy Loading (optional)

Don't want every page to carry 1.2 MB of scripts? Use `loader.js` -- it injects everything on first call:

```html
<script src="/loader.js"></script>
<script>
  XgPlayerLoader.create({ id: 'player', url: '/live/stream.flv', isLive: true })
</script>
```

`loader.js` lives alongside `umd/` and `wasm/`. Different layout? Use tag attributes:

```html
<script src="/assets/xg/loader.js" data-js-dir="." data-wasm-dir="."></script>
```

Scripts only, no player: `await XgPlayerLoader.load()`.

---

## Configuration

| Option | Description |
|--------|-------------|
| `softDecode` | `'auto'`(default) fallback / `true` force soft / `false` disable |
| `softDecodeOptions.wasmBaseUrl` | Directory containing `decode/` |
| `softDecodeOptions.renderer` | `'canvas'`(default) / `'video'` |
| `softDecodeOptions.wasmVariant` | `'simd'` / `'atomic'` / `'baseline'` / `'64'` |
| `onSoftDecodeFallback` | Callback `function(info)` when soft decode kicks in |

---

## Runtime API

```js
player.forceSoftDecode(reason)         // Switch to soft decode at runtime
player.plugins.flv.core.isSoftDecoding // true/false
player.plugins.flv.core.softDecodeStats // decoded, rendered, dropped counters
player.getLiveLatency()                // Live latency in seconds
```

For HLS replace `flv` with `hls`.

---

## Directory structure

```
umd/      4 JS + 1 CSS, for script-tag usage
es/       6 ESM packages, for bundlers / internal npm
loader.js Optional lazy loader
wasm/     HEVC soft decode 4 variants (auto-selected)
demo.html Self-check page
```

Browser downloads: JS+CSS ≈1.2 MB + one wasm (861 KB - 1.16 MB). Wasm only fetched when soft decode is needed.
