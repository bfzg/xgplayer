#!/usr/bin/env node
/**
 * Stage a copy-and-use bundle for the HEVC wasm soft-decode build.
 *
 * The repo builds in place under packages/name/dist and packages/name/es, which
 * suits a monorepo but is awkward for an integrator who wants to drop the patched
 * player into another project. This collects the packages that carry
 * soft-decode changes, plus the wasm binaries fetched at runtime, into one
 * directory and drops in a self-check demo page.
 *
 *   node ./scripts/pack-soft-decode.js
 *   node ./scripts/pack-soft-decode.js --out ../xgplayer-soft --maps
 *   node ./scripts/pack-soft-decode.js --wasm /path/to/libmedia/dist
 *
 * Requires `yarn build` to have run first; stale build output is warned about
 * rather than rebuilt, so this stays a packaging step and not a build step.
 */
const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')

/** UMD files, in script-tag load order. */
const UMD_PACKAGES = ['xgplayer', 'xgplayer-hls', 'xgplayer-flv', 'xgplayer-soft-decode']

/** Packages a bundler consumer needs; hls/flv inline the streaming layer. */
const ES_PACKAGES = [...UMD_PACKAGES, 'xgplayer-transmuxer', 'xgplayer-streaming-shared']

/** Capability ladder binaries, best first. Only HEVC is ever fetched. */
const WASM_FILES = ['hevc-simd.wasm', 'hevc-atomic.wasm', 'hevc.wasm', 'hevc-64.wasm']

function arg (argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

function log (msg) {
  console.log(`[pack-soft-decode] ${msg}`)
}

function fail (msg) {
  console.error(`[pack-soft-decode] ${msg}`)
  process.exitCode = 1
  throw new Error(msg)
}

/** Newest mtime under a directory, used to spot stale build output. */
function newestMtime (dir) {
  let max = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) max = Math.max(max, newestMtime(full))
    else max = Math.max(max, fs.statSync(full).mtimeMs)
  }
  return max
}

function sizeMb (bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

function dirBytes (dir) {
  let total = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    total += entry.isDirectory() ? dirBytes(full) : fs.statSync(full).size
  }
  return total
}

function prepare (dir) {
  // The target is deleted first, so keep it away from the checkout that owns it.
  const resolved = path.resolve(dir)
  if (resolved === ROOT || ROOT.startsWith(resolved + path.sep)) {
    fail(`refusing to wipe ${resolved}, it holds this checkout`)
  }
  if (fs.existsSync(path.join(resolved, '.git')) || fs.existsSync(path.join(resolved, 'yarn.lock'))) {
    fail(`refusing to wipe what looks like a project root: ${resolved}`)
  }
  fs.rmSync(dir, { recursive: true, force: true })
  fs.mkdirSync(dir, { recursive: true })
}

/** Where the libmedia wasm tree lives: flag, env, sibling checkout, package cache. */
function resolveWasmRoot (explicit) {
  const candidates = [
    explicit,
    process.env.LIBMEDIA_DIST,
    path.resolve(ROOT, '../libmedia/dist'),
    path.join(ROOT, 'packages/xgplayer-soft-decode/wasm')
  ].filter(Boolean)
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'decode', 'hevc-simd.wasm'))) return dir
    if (fs.existsSync(path.join(dir, 'hevc-simd.wasm'))) return path.dirname(dir)
  }
  return null
}

function main () {
  const argv = process.argv.slice(2)
  const outDir = path.resolve(ROOT, arg(argv, '--out') || path.join('release', 'soft-decode'))
  const withMaps = argv.includes('--maps')
  const templateDir = path.join(ROOT, 'scripts/pack-soft-decode')

  const stale = []
  for (const name of ES_PACKAGES) {
    const distFile = path.join(ROOT, 'packages', name, 'dist', 'index.min.js')
    const esDir = path.join(ROOT, 'packages', name, 'es')
    const srcDir = path.join(ROOT, 'packages', name, 'src')
    for (const built of [distFile, esDir]) {
      if (!fs.existsSync(built)) fail(`missing build output for ${name}: ${built} (run yarn build)`)
    }
    if (fs.existsSync(srcDir) && fs.existsSync(distFile)) {
      if (newestMtime(srcDir) > fs.statSync(distFile).mtimeMs + 1000) stale.push(name)
    }
  }
  if (stale.length) {
    log(`WARNING build output older than sources for: ${stale.join(', ')}; run yarn build and re-run`)
  }

  prepare(outDir)

  const umdDir = path.join(outDir, 'umd')
  fs.mkdirSync(umdDir)
  for (const name of UMD_PACKAGES) {
    const src = path.join(ROOT, 'packages', name, 'dist', 'index.min.js')
    fs.copyFileSync(src, path.join(umdDir, `${name}.min.js`))
    if (withMaps && fs.existsSync(`${src}.map`)) {
      fs.copyFileSync(`${src}.map`, path.join(umdDir, `${name}.min.js.map`))
    }
  }
  fs.copyFileSync(path.join(ROOT, 'packages/xgplayer/dist/index.min.css'), path.join(umdDir, 'xgplayer.min.css'))
  log(`umd: ${UMD_PACKAGES.length} scripts + css -> ${path.relative(ROOT, umdDir)}/`)

  const esOut = path.join(outDir, 'es')
  fs.mkdirSync(esOut)
  for (const name of ES_PACKAGES) {
    const dest = path.join(esOut, name)
    fs.cpSync(path.join(ROOT, 'packages', name, 'es'), dest, { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'packages', name, 'package.json'), path.join(dest, 'package.json'))
  }
  log(`es: ${ES_PACKAGES.length} packages -> ${path.relative(ROOT, esOut)}/`)

  const wasmRoot = resolveWasmRoot(arg(argv, '--wasm'))
  const decodeOut = path.join(outDir, 'wasm', 'decode')
  fs.mkdirSync(decodeOut, { recursive: true })
  if (!wasmRoot) {
    log(`WARNING no local libmedia wasm tree; ${path.relative(ROOT, decodeOut)}/ left empty, deploy binaries yourself`)
  } else {
    let copied = 0
    for (const file of WASM_FILES) {
      const src = path.join(wasmRoot, 'decode', file)
      if (!fs.existsSync(src)) continue
      fs.copyFileSync(src, path.join(decodeOut, file))
      copied++
    }
    log(`wasm: ${copied} binaries from ${wasmRoot} -> ${path.relative(ROOT, decodeOut)}/ (${sizeMb(dirBytes(decodeOut))})`)
  }

  for (const doc of ['README.md', 'demo.html']) {
    fs.copyFileSync(path.join(templateDir, doc), path.join(outDir, doc))
  }

  log(`done: ${outDir} (${sizeMb(dirBytes(outDir))})`)
  log('serve it over http, then open demo.html')
}

main()
