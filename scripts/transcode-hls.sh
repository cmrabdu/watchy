#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /path/to/movie.mp4"
  exit 1
fi

SRC="$1"
if [[ ! -f "$SRC" ]]; then
  echo "File not found: $SRC" >&2
  exit 1
fi

DIR="$(cd "$(dirname "$SRC")" && pwd)"
BASE="$(basename "$SRC")"
STEM="${BASE%.*}"
OUT="$DIR/${STEM}.hls"
mkdir -p "$OUT"

ffmpeg -y -i "$SRC" \
  -c:v libx264 -preset veryfast -crf 20 -pix_fmt yuv420p \
  -c:a aac -b:a 160k \
  -hls_time 4 -hls_playlist_type vod \
  -hls_segment_filename "$OUT/seg_%05d.ts" \
  "$OUT/master.m3u8"

echo "HLS ready: $OUT/master.m3u8"
