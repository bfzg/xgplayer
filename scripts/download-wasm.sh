#!/bin/bash
# 下载 HEVC 软解所需的 wasm 文件到指定目录
# 用法: bash scripts/download-wasm.sh [目标目录]

set -e
LIBMEDIA_VERSION="1.3.1"
BASE_URL="https://cdn.jsdelivr.net/gh/zhaohappy/libmedia@${LIBMEDIA_VERSION}/dist/decode"
TARGET="${1:-demo/wasm/decode}"

# 能力阶梯的二进制：simd -> atomic -> baseline，取第一个能编译的。
# hevc-64.wasm（wasm64 构建）不在阶梯里，只有显式 wasmVariant: '64' 才会用到，
# 因此不随 demo / 发布包分发；需要时自行从同一个 CDN 目录取。
FILES=(
  "hevc-simd.wasm"
  "hevc-atomic.wasm"
  "hevc.wasm"
)

mkdir -p "$TARGET"
echo "📥 下载 wasm 文件到 $TARGET ..."
for f in "${FILES[@]}"; do
  url="$BASE_URL/$f"
  out="$TARGET/$f"
  if [ -f "$out" ]; then
    echo "   ✅ $f 已存在，跳过"
    continue
  fi
  echo "   ⏳ $url"
  if command -v curl &>/dev/null; then
    curl -sLo "$out" "$url"
  elif command -v wget &>/dev/null; then
    wget -qO "$out" "$url"
  else
    echo "   ❌ 需要 curl 或 wget"
    exit 1
  fi
  echo "   ✅ $f 下载完成"
done
echo ""
echo "🎉 全部下载完成 ($(du -sh "$TARGET" | cut -f1))"
echo "📁 $TARGET"
