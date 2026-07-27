#!/usr/bin/env bash
# Creates a Hetzner CX22 (or override), firewall, and SSH-ready Ubuntu 24.04 VPS.
# Requires: hcloud CLI + HCLOUD_TOKEN (or `hcloud context use`)
set -euo pipefail

NAME="${WATCH_SERVER_NAME:-watch}"
LOCATION="${WATCH_LOCATION:-fsn1}"
TYPE="${WATCH_SERVER_TYPE:-cx22}"
IMAGE="${WATCH_IMAGE:-ubuntu-24.04}"
SSH_KEY_NAME="${WATCH_SSH_KEY_NAME:-cmrabdu}"
SSH_PUBKEY_FILE="${WATCH_SSH_PUBKEY:-$HOME/.ssh/id_ed25519.pub}"
STATE_DIR="$(cd "$(dirname "$0")/.." && pwd)/.deploy-state"
mkdir -p "$STATE_DIR"

if ! command -v hcloud >/dev/null; then
  echo "hcloud CLI missing. Install: brew install hcloud" >&2
  exit 1
fi

if [[ -z "${HCLOUD_TOKEN:-}" ]] && ! hcloud context active >/dev/null 2>&1; then
  echo "Set HCLOUD_TOKEN or run: hcloud context create watch" >&2
  echo "Create a token at https://console.hetzner.cloud/ → Security → API Tokens" >&2
  exit 1
fi

if [[ ! -f "$SSH_PUBKEY_FILE" ]]; then
  echo "SSH public key not found: $SSH_PUBKEY_FILE" >&2
  exit 1
fi

if ! hcloud ssh-key describe "$SSH_KEY_NAME" >/dev/null 2>&1; then
  echo "Uploading SSH key as '$SSH_KEY_NAME'..."
  hcloud ssh-key create --name "$SSH_KEY_NAME" --public-key-from-file "$SSH_PUBKEY_FILE"
fi

if ! hcloud firewall describe "$NAME-fw" >/dev/null 2>&1; then
  echo "Creating firewall..."
  hcloud firewall create --name "$NAME-fw"
  hcloud firewall add-rule --direction in --protocol tcp --port 22 --source-ips 0.0.0.0/0 --source-ips ::/0 "$NAME-fw"
  hcloud firewall add-rule --direction in --protocol tcp --port 80 --source-ips 0.0.0.0/0 --source-ips ::/0 "$NAME-fw"
  hcloud firewall add-rule --direction in --protocol tcp --port 443 --source-ips 0.0.0.0/0 --source-ips ::/0 "$NAME-fw"
  hcloud firewall add-rule --direction in --protocol icmp --source-ips 0.0.0.0/0 --source-ips ::/0 "$NAME-fw"
fi

if hcloud server describe "$NAME" >/dev/null 2>&1; then
  echo "Server '$NAME' already exists."
else
  echo "Creating server '$NAME' ($TYPE @ $LOCATION)..."
  hcloud server create \
    --name "$NAME" \
    --type "$TYPE" \
    --location "$LOCATION" \
    --image "$IMAGE" \
    --ssh-key "$SSH_KEY_NAME" \
    --firewall "$NAME-fw"
fi

IP="$(hcloud server ip "$NAME")"
echo "$IP" > "$STATE_DIR/server-ipv4.txt"
echo "Server IPv4: $IP"
echo "Next:"
echo "  1) Point your watchy subdomain A record to $IP"
echo "  2) ./scripts/bootstrap-vps.sh root@$IP"
