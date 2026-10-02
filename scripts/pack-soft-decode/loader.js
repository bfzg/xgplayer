/**
 * Optional lazy loader for the soft-decode build.
 *
 * A page that does not want to carry the player scripts on every route loads
 * this file instead of the four script tags: it injects them in the required
 * order (core -> soft decode -> hls -> flv) the first time load() or create()
 * is called, then hands back the globals or a finished player.
 *
 *   <script src="/assets/player/loader.js"></script>
 *   <script>
 *     XgPlayerLoader.create({ id: 'player', url: '/live/x.flv', isLive: true })
 *   </script>
 *
 * The asset directories default to the layout this file ships in, i.e. sibling
 * umd/ and wasm/, derived from this file's own url so any publicPath works.
 * Keep a different layout on the tag instead of editing this file:
 *
 *   <script src="/assets/xgplayer/loader.js" data-js-dir="." data-wasm-dir="."></script>
 */
;(function (global) {
  'use strict'

  var JS_FILES = [
    'xgplayer.min.js',
    'xgplayer-soft-decode.min.js',
    'xgplayer-hls.min.js',
    'xgplayer-flv.min.js'
  ]
  var CSS_FILES = ['xgplayer.min.css']
  var OWN_TAG_RE = /\/loader\.js([?#]|$)/

  function ownScript () {
    var doc = global.document
    if (!doc) return null
    var current = doc.currentScript
    if (current && current.src) return current
    // deferred 或 import 进来的时候 currentScript 为 null，回退到页面上的 loader.js 标签
    var tags = doc.getElementsByTagName('script')
    for (var i = tags.length - 1; i >= 0; i--) {
      if (OWN_TAG_RE.test(tags[i].src || '')) return tags[i]
    }
    return null
  }

  // Resolved while this file is the script being executed: currentScript is only
  // valid synchronously, and the tags injected below would answer too late.
  var OWN = ownScript()
  var BASE = OWN && OWN.src
    ? OWN.src.replace(/[^/]*$/, '')
    : (function () {
        var doc = global.document
        var origin = doc && doc.baseURI ? doc.baseURI : global.location && global.location.href
        return origin ? new URL('./', origin).href : ''
      })()

  /** Attribute value -> directory url, relative to this file. */
  function dir (value, fallback) {
    if (!value) return fallback
    var joined
    try {
      joined = new URL(value, BASE).href
    } catch (e) {
      joined = String(value)
    }
    if (!/\/$/.test(joined)) joined += '/'
    return joined
  }

  function attr (name) {
    return OWN && OWN.getAttribute ? OWN.getAttribute(name) : null
  }

  var ASSETS = {
    js: dir(attr('data-js-dir'), BASE + 'umd/'),
    css: dir(attr('data-css-dir'), dir(attr('data-js-dir'), BASE + 'umd/')),
    wasm: dir(attr('data-wasm-dir'), BASE + 'wasm')
  }

  function loadStyle (href) {
    return new Promise(function (resolve) {
      var link = global.document.createElement('link')
      link.rel = 'stylesheet'
      link.href = href
      // A missing stylesheet only costs looks, it must not block playback.
      link.onload = function () { resolve() }
      link.onerror = function () { resolve() }
      global.document.head.appendChild(link)
    })
  }

  function loadScript (src) {
    return new Promise(function (resolve, reject) {
      var script = global.document.createElement('script')
      script.src = src
      // async=false keeps execution order for a script appended after parse.
      script.async = false
      script.onload = function () { resolve() }
      script.onerror = function () {
        reject(new Error('[xgplayer-loader] failed to load ' + src))
      }
      global.document.head.appendChild(script)
    })
  }

  function ready () {
    return !!(global.Player && global.HlsPlayer && global.FlvPlayer)
  }

  var pending = null

  function ensure () {
    if (ready()) return Promise.resolve(api)
    if (pending) return pending

    pending = Promise.all(CSS_FILES.map(function (file) {
      return loadStyle(ASSETS.css + file)
    }))
      .then(function () {
        // Order matters: the soft-decode package only publishes a global, and
        // the hls/flv plugins read it while their plugin instance is built.
        return JS_FILES.reduce(function (chain, file) {
          return chain.then(function () { return loadScript(ASSETS.js + file) })
        }, Promise.resolve())
      })
      .then(function () {
        if (!ready()) {
          throw new Error('[xgplayer-loader] player globals are missing, a script was blocked')
        }
        if (!global.SoftDecode) {
          global.console.warn('[xgplayer-loader] soft decode not registered, HEVC stays native')
        }
        pending = null
        return api
      })
      .catch(function (error) {
        // Never cache a failure; the next mount may succeed.
        pending = null
        throw error
      })
    return pending
  }

  /** Pick the streaming plugin from the container extension. */
  function pluginsFor (url) {
    var clean = String(url || '').replace(/[?#].*$/, '')
    if (/\.m3u8$/i.test(clean)) return [global.HlsPlayer]
    if (/\.flv$/i.test(clean)) return [global.FlvPlayer]
    return null
  }

  function withDefaults (opts) {
    var source = opts || {}
    var config = {}
    for (var key in source) {
      if (Object.prototype.hasOwnProperty.call(source, key)) config[key] = source[key]
    }
    if (!config.plugins) {
      var picked = pluginsFor(config.url)
      if (picked) config.plugins = picked
    }
    var soft = config.softDecodeOptions || {}
    if (!soft.wasmBaseUrl && !soft.decoderWasmUrl && !soft.wasmBytes && !soft.loadWasm) {
      soft = Object.assign({}, soft, { wasmBaseUrl: ASSETS.wasm })
    }
    config.softDecodeOptions = soft
    return config
  }

  var api = {
    /** Where the scripts, styles and wasm come from; pass a directory to move them. */
    assets: function (next) {
      if (!next) return Object.assign({}, ASSETS)
      if (next.js) ASSETS.js = dir(next.js, ASSETS.js)
      if (next.css) ASSETS.css = dir(next.css, ASSETS.css)
      if (next.wasm) ASSETS.wasm = dir(next.wasm, ASSETS.wasm)
      return Object.assign({}, ASSETS)
    },
    /** Directory this file was served from, for hand-written tags. */
    base: function () { return BASE },
    /** Load the scripts only. Resolves to this object. */
    load: ensure,
    /** Load if needed, then build a player. Resolves to the Player instance. */
    create: function (opts) {
      // Defaults are filled after load(): the plugin pick needs the globals.
      return ensure().then(function () {
        return new global.Player(withDefaults(opts))
      })
    }
  }

  global.XgPlayerLoader = api
})(typeof window !== 'undefined' ? window : globalThis)
