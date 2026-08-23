#!/usr/bin/env bash
# Ship an already-encoded HLS ladder to the VPS. The server only serves files.
#
#   ./scripts/transcode-hls.sh /chemin/film.mkv     # sur VOTRE machine
#   ./scripts/publish-hls.sh   /chemin/film.mkv     # puis on envoie
#
# Par défaut seul le dossier .hls part : c'est suffisant pour regarder le film,
# et ça évite de mettre 8 Go de source sur un disque de 40 Go. Ajoutez
# --with-source si vous voulez aussi la copie d'origine sur le serveur.
#
# Env : WATCH_SSH (défaut root@your-vps), WATCH_REMOTE_DIR (défaut /opt/watch/media)
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: publish-hls.sh <fichier vidéo | dossier .hls> [options]

  --with-source   envoyer aussi le fichier vidéo d'origine
  --subs          envoyer aussi les sous-titres <stem>.*.srt / .vtt à côté
  --host <cible>  user@host (défaut: $WATCH_SSH)
  --dry-run       montrer ce qui serait transféré, sans rien envoyer
USAGE
}

[[ $# -ge 1 ]] || { usage; exit 1; }

SRC=""; WITH_SOURCE=0; WITH_SUBS=0; DRY=""; HOST="${WATCH_SSH:-root@your-vps}"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --with-source) WITH_SOURCE=1; shift ;;
    --subs) WITH_SUBS=1; shift ;;
    --host) HOST="$2"; shift 2 ;;
    --dry-run) DRY="--dry-run"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) SRC="$1"; shift ;;
  esac
done

REMOTE_DIR="${WATCH_REMOTE_DIR:-/opt/watch/media}"
command -v rsync >/dev/null || { echo "rsync manquant" >&2; exit 1; }

if [[ -d "$SRC" ]]; then
  HLS="${SRC%/}"
  DIR="$(cd "$(dirname "$HLS")" && pwd)"
  STEM="$(basename "$HLS")"; STEM="${STEM%.hls}"
  VIDEO=""
else
  [[ -f "$SRC" ]] || { echo "Introuvable: $SRC" >&2; exit 1; }
  DIR="$(cd "$(dirname "$SRC")" && pwd)"
  BASE="$(basename "$SRC")"
  STEM="${BASE%.*}"
  HLS="$DIR/${STEM}.hls"
  VIDEO="$DIR/$BASE"
fi

[[ -f "$HLS/master.m3u8" ]] || {
  echo "Pas de master.m3u8 dans $HLS" >&2
  echo "Encodez d'abord : ./scripts/transcode-hls.sh \"$SRC\"" >&2
  exit 1
}

echo "Cible   : $HOST:$REMOTE_DIR/"
echo "Échelle : $HLS ($(du -sh "$HLS" | cut -f1))"

# --partial garde ce qui est déjà passé : une coupure ne recommence pas tout.
RSYNC=(rsync -avh --partial --progress --human-readable $DRY)

# Le master arrive en dernier : tant qu'il n'est pas là, listMovies ignore le
# dossier, donc on ne voit jamais un film à moitié transféré dans le catalogue.
"${RSYNC[@]}" --exclude 'master.m3u8' "$HLS/" "$HOST:$REMOTE_DIR/${STEM}.hls/"
"${RSYNC[@]}" "$HLS/master.m3u8" "$HOST:$REMOTE_DIR/${STEM}.hls/master.m3u8"

if [[ $WITH_SUBS -eq 1 ]]; then
  shopt -s nullglob
  SUBS=("$DIR/$STEM".*.srt "$DIR/$STEM".*.vtt "$DIR/$STEM.srt" "$DIR/$STEM.vtt")
  [[ ${#SUBS[@]} -gt 0 ]] && "${RSYNC[@]}" "${SUBS[@]}" "$HOST:$REMOTE_DIR/"
  shopt -u nullglob
fi

if [[ $WITH_SOURCE -eq 1 && -n "$VIDEO" ]]; then
  echo "Source  : $VIDEO ($(du -sh "$VIDEO" | cut -f1))"
  "${RSYNC[@]}" "$VIDEO" "$HOST:$REMOTE_DIR/"
fi

echo
echo "Envoyé. Le film apparaît au catalogue sans que le serveur ait rien à encoder."
