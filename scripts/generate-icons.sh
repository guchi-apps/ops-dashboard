#!/usr/bin/env bash
# public/icons/*.svg から PWA・iOS 用の PNG を書き出す。#164
#
# 使い方: ./scripts/generate-icons.sh
#   デザインを変えるときは public/icons/icon.svg と icon-maskable.svg の両方を直してから実行し、
#   生成された PNG もあわせてコミットする（配信するのは PNG のため）。
#
# 必要なコマンド: rsvg-convert（Ubuntu では librsvg2-bin）
set -euo pipefail

cd "$(dirname "$0")/.."
ICONS_DIR="public/icons"

if ! command -v rsvg-convert >/dev/null 2>&1; then
  echo "rsvg-convert が見つかりません。sudo apt install librsvg2-bin を実行してください。" >&2
  exit 1
fi

render() {
  local src="$1" size="$2" out="$3"
  rsvg-convert -w "$size" -h "$size" "$ICONS_DIR/$src" -o "$ICONS_DIR/$out"
  echo "  $out (${size}x${size}) <- $src"
}

echo "アイコンを書き出します:"
# PWA の purpose="any"。角丸あり・四隅は透過
render icon.svg 192 icon-192.png
render icon.svg 512 icon-512.png
# Android のアダプティブアイコン（purpose="maskable"）。全面が地色
render icon-maskable.svg 512 icon-maskable-512.png
# iOS のホーム画面。透過部分が黒く出るため全面が地色のものを使う
render icon-maskable.svg 180 apple-touch-icon.png
echo "完了しました。"
