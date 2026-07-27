#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
OUT="${1:-$ROOT/media/demo-sync.mp4}"
mkdir -p "$(dirname "$OUT")"

ffmpeg -y -f lavfi -i "testsrc2=size=1280x720:rate=30" \
  -f lavfi -i "sine=frequency=440:sample_rate=44100" \
  -t 30 -c:v libx264 -pix_fmt yuv420p -c:a aac -shortest "$OUT"

echo "Wrote $OUT"
