#!/bin/bash
set -e
cd "$(dirname "$0")"

echo "=============================="
echo " xgplayer HEVC 软解 Demo"
echo "=============================="

# 1. 检查/拷贝 JS/CSS 构建产物
if [ ! -f "umd/xgplayer.min.js" ]; then
  echo "🔧 拷贝构建产物到 demo/umd/ ..."
  mkdir -p umd
  if [ -f "../packages/xgplayer/dist/index.min.js" ]; then
    cp ../packages/xgplayer/dist/index.min.js umd/xgplayer.min.js
    cp ../packages/xgplayer/dist/index.min.css umd/xgplayer.min.css
    cp ../packages/xgplayer-soft-decode/dist/index.min.js umd/xgplayer-soft-decode.min.js
    cp ../packages/xgplayer-hls/dist/index.min.js umd/xgplayer-hls.min.js
    cp ../packages/xgplayer-flv/dist/index.min.js umd/xgplayer-flv.min.js
    echo "✅ 拷贝完成"
  else
    echo "❌ 构建产物不存在，请先执行:"
    echo "   cd .. && yarn && yarn build:all"
    exit 1
  fi
fi

# 2. 检查/下载 wasm 文件
WASM_DIR="wasm/decode"
if [ ! -f "$WASM_DIR/hevc-simd.wasm" ]; then
  echo "🔧 下载 wasm 软解文件 ..."
  bash ../scripts/download-wasm.sh "$WASM_DIR"
fi

# 3. 启动 HTTP 服务
echo ""
echo "✅ 就绪！启动 HTTP 服务..."
echo ""

PORT=${1:-8080}

if command -v python3 &>/dev/null; then
  cd ..
  echo "➡️  打开 http://127.0.0.1:$PORT/demo/index.html"
  echo "   按 Ctrl+C 停止"
  python3 -m http.server "$PORT"
elif command -v python &>/dev/null; then
  cd ..
  echo "➡️  打开 http://127.0.0.1:$PORT/demo/index.html"
  python -m SimpleHTTPServer "$PORT"
elif command -v npx &>/dev/null; then
  cd ..
  echo "➡️  打开 http://127.0.0.1:$PORT"
  npx serve . -p "$PORT"
else
  echo "❌ 未找到 python 或 npx，请手动启动 HTTP 服务"
  exit 1
fi
