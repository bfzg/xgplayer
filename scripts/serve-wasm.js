/**
 * Dev-only static server for a self-hosted libmedia wasm tree.
 *
 * The wasm soft-decode package needs `decode/hevc*.wasm` over HTTP with CORS, so
 * a local run needs a second origin, or the CDN, to fetch them from. This mirrors
 * a `libmedia/dist` directory (default: the sibling checkout of this repo) so the
 * demos can point `wasmBaseUrl` at it and exercise the same path an integrator
 * uses in production.
 *
 *   node ./scripts/serve-wasm.js [dir] [-p 8098]
 *   http://127.0.0.1:<port>/decode/hevc-simd.wasm
 *
 * Nothing here is part of a shipped bundle.
 */
const fs = require('fs')
const http = require('http')
const path = require('path')

const TYPES = {
  '.wasm': 'application/wasm',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.map': 'application/json',
  '.wat': 'text/plain',
  '.html': 'text/html'
}

function arg(argv, flag) {
  const i = argv.indexOf(flag)
  return i >= 0 ? argv[i + 1] : undefined
}

// Default to the upstream release tree next to this repo, then a local copy of
// the binaries under the soft-decode package.
function resolveRoot(explicit) {
  const cwd = process.cwd()
  const candidates = [
    explicit,
    process.env.LIBMEDIA_DIST,
    path.resolve(cwd, '../libmedia/dist'),
    path.resolve(cwd, 'packages/xgplayer-soft-decode/dist-wasm')
  ].filter(Boolean)
  for (const dir of candidates) {
    const abs = path.resolve(dir)
    if (fs.existsSync(path.join(abs, 'decode'))) return abs
  }
  return null
}

function serve(req, res, root) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': '*',
    'Access-Control-Expose-Headers': 'Content-Length'
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, cors)
    return res.end()
  }
  const rel = decodeURIComponent(new URL(req.url, 'http://localhost').pathname)
  const file = path.join(root, path.normalize(rel))
  if (file !== root && !file.startsWith(root + path.sep)) {
    res.writeHead(403, cors)
    return res.end('forbidden')
  }
  let stat
  try {
    stat = fs.statSync(file)
  } catch (_error) {
    res.writeHead(404, cors)
    return res.end(`not found: ${rel}`)
  }
  if (stat.isDirectory()) {
    res.writeHead(403, cors)
    return res.end('directory listing is disabled')
  }
  res.writeHead(200, {
    ...cors,
    'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream',
    'Content-Length': String(stat.size),
    'Cache-Control': 'no-cache'
  })
  fs.createReadStream(file).pipe(res)
}

const root = resolveRoot(process.argv[2])
if (!root) {
  console.error(
    '[serve-wasm] no libmedia dist found; pass the directory that holds ' +
      'decode/hevc*.wasm, for example:\n' +
      '  node ./scripts/serve-wasm.js /path/to/libmedia/dist'
  )
  process.exit(1)
}

const port = Number(arg(process.argv, '-p') || arg(process.argv, '--port') || 8098)
http
  .createServer((req, res) => serve(req, res, root))
  .listen(port, '127.0.0.1', () => {
    console.log(`[serve-wasm] root  ${root}`)
    console.log(`[serve-wasm] file    http://127.0.0.1:${port}/decode/hevc-simd.wasm`)
    console.log(`[serve-wasm] demo    ?wasmBaseUrl=http://127.0.0.1:${port}`)
  })
