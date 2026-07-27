#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "Usage: $0 /path/to/movie.mp4 [user@host]"
  echo "Env: WATCH_SSH (default root@your-vps), WATCH_REMOTE_DIR (default /opt/watch/media)"
  exit 1
fi

SRC="$1"
HOST="${2:-${WATCH_SSH:-root@your-vps}}"
REMOTE_DIR="${WATCH_REMOTE_DIR:-/opt/watch/media}"
NAME="$(basename "$SRC")"

if [[ ! -f "$SRC" ]]; then
  echo "File not found: $SRC" >&2
  exit 1
fi

echo "Uploading $NAME -> $HOST:$REMOTE_DIR/"
rsync -avh --progress "$SRC" "$HOST:$REMOTE_DIR/$NAME"
echo "Done."
