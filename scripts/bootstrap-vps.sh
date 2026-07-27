#!/usr/bin/env bash
# Installs Docker on the VPS and deploys the watch stack.
set -euo pipefail

HOST="${1:-${WATCH_SSH:-}}"
if [[ -z "$HOST" ]]; then
  echo "Usage: $0 root@SERVER_IP" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
REMOTE_DIR="${WATCH_REMOTE_ROOT:-/opt/watch}"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing $ROOT/.env — copy .env.example and fill AUTH_USERS / SESSION_SECRET" >&2
  exit 1
fi

# Docker Compose interpolates $VAR in env files; bcrypt hashes must use $$.
if grep -q '^AUTH_USERS=' "$ROOT/.env" && ! grep -q '^AUTH_USERS=.*\$\$' "$ROOT/.env"; then
  python3 - <<'PY' "$ROOT/.env"
from pathlib import Path
import sys
p = Path(sys.argv[1])
lines = []
for line in p.read_text().splitlines():
    if line.startswith("AUTH_USERS="):
        key, val = line.split("=", 1)
        # Avoid double-escaping already-escaped $$
        if "$$" not in val:
            val = val.replace("$", "$$")
        lines.append(f"{key}={val}")
    else:
        lines.append(line)
p.write_text("\n".join(lines) + "\n")
print("Escaped $ in AUTH_USERS for docker compose")
PY
fi

echo "Ensuring Docker on $HOST..."
ssh -o StrictHostKeyChecking=accept-new "$HOST" 'bash -s' <<'REMOTE'
set -euo pipefail
if ! command -v docker >/dev/null; then
  apt-get update
  apt-get install -y ca-certificates curl rsync
  install -m 0755 -d /etc/apt/keyrings
  curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  chmod a+r /etc/apt/keyrings/docker.asc
  . /etc/os-release
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $VERSION_CODENAME stable" > /etc/apt/sources.list.d/docker.list
  apt-get update
  apt-get install -y docker-ce docker-ce-cli containerd.io docker-compose-plugin
fi
mkdir -p /opt/watch/media
REMOTE

echo "Syncing project..."
rsync -az --delete \
  --exclude node_modules \
  --exclude .git \
  --exclude media \
  --exclude .deploy-state \
  "$ROOT/" "$HOST:$REMOTE_DIR/"

rsync -az "$ROOT/.env" "$HOST:$REMOTE_DIR/.env"

echo "Building & starting stack..."
ssh "$HOST" "cd $REMOTE_DIR && docker compose -f deploy/docker-compose.yml up -d --build"

echo "Deployed. When DNS is ready, open your PUBLIC_ORIGIN URL."
