#!/usr/bin/env bash
# Build a multi-bitrate HLS ladder for Watchy.
#
# Run this on YOUR machine, not on the VPS. The CX22 has 2 vCPU: encoding three
# variants of a two-hour film there takes hours, competes with playback, and
# fills a 40 GB disk. Encode here, then ship the result with publish-hls.sh.
#
#   ./scripts/transcode-hls.sh /path/to/film.mkv
#   ./scripts/publish-hls.sh   /path/to/film.mkv
#
# What you get: <film>.hls/master.m3u8 with 1080p / 720p / 480p rungs sharing
# one timeline (identical keyframe positions and segment boundaries), plus every
# audio track as a separate rendition. hls.js drops to a lower rung on its own
# when her line weakens, without buffering and without losing his quality —
# and because the rungs share segment boundaries, the two players stay aligned.
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: transcode-hls.sh <fichier vidéo> [options]

  --preset <p>    preset x264 (défaut: slow ; veryfast si vous êtes pressé)
  --crf-mode      qualité constante par échelon au lieu d'un débit plafonné
  --max-height N  ne pas produire d'échelon au-dessus de N (défaut: source)
  --out <dir>     dossier de sortie (défaut: <fichier sans extension>.hls)
  --force         réencoder même si le dossier existe déjà
USAGE
}

if [[ $# -lt 1 ]]; then usage; exit 1; fi

SRC=""; PRESET="slow"; CRF_MODE=0; MAX_HEIGHT=0; OUT=""; FORCE=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --preset) PRESET="$2"; shift 2 ;;
    --crf-mode) CRF_MODE=1; shift ;;
    --max-height) MAX_HEIGHT="$2"; shift 2 ;;
    --out) OUT="$2"; shift 2 ;;
    --force) FORCE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) SRC="$1"; shift ;;
  esac
done

[[ -f "$SRC" ]] || { echo "Fichier introuvable: $SRC" >&2; exit 1; }
command -v ffmpeg  >/dev/null || { echo "ffmpeg manquant" >&2; exit 1; }
command -v ffprobe >/dev/null || { echo "ffprobe manquant" >&2; exit 1; }

DIR="$(cd "$(dirname "$SRC")" && pwd)"
BASE="$(basename "$SRC")"
STEM="${BASE%.*}"
OUT="${OUT:-$DIR/${STEM}.hls}"

if [[ -f "$OUT/master.m3u8" && $FORCE -eq 0 ]]; then
  echo "Déjà encodé: $OUT/master.m3u8 (relancer avec --force pour refaire)"
  exit 0
fi

# --- Source ------------------------------------------------------------------
HEIGHT="$(ffprobe -v error -select_streams v:0 -show_entries stream=height -of csv=p=0 "$SRC" | head -1)"
FPS_RAW="$(ffprobe -v error -select_streams v:0 -show_entries stream=r_frame_rate -of csv=p=0 "$SRC" | head -1)"
DURATION="$(ffprobe -v error -show_entries format=duration -of csv=p=0 "$SRC" | head -1)"
AUDIO_COUNT="$(ffprobe -v error -select_streams a -show_entries stream=index -of csv=p=0 "$SRC" | wc -l | tr -d ' ')"
HEIGHT="${HEIGHT:-1080}"
AUDIO_COUNT="${AUDIO_COUNT:-0}"
[[ "$AUDIO_COUNT" -gt 0 ]] || { echo "Aucune piste audio dans $BASE" >&2; exit 1; }

# Frames per second, rounded — used to pin the GOP so every rung cuts at the
# same instant. Without that, switching rungs would shift the timeline.
FPS="$(awk -F/ '{ if (NF==2 && $2>0) printf "%d", ($1/$2)+0.5; else printf "%d", $1+0.5 }' <<<"$FPS_RAW")"
[[ "$FPS" -gt 0 ]] 2>/dev/null || FPS=25
SEG=4                     # seconds per segment
GOP=$(( FPS * SEG ))

[[ "$MAX_HEIGHT" -gt 0 ]] && (( HEIGHT > MAX_HEIGHT )) && HEIGHT=$MAX_HEIGHT

# --- Ladder ------------------------------------------------------------------
# Never upscale: a 720p source gets 720p and 480p, not a fake 1080p rung.
LADDER_H=(); LADDER_V=(); LADDER_MAX=(); LADDER_BUF=(); LADDER_A=()
add_rung() { LADDER_H+=("$1"); LADDER_V+=("$2"); LADDER_MAX+=("$3"); LADDER_BUF+=("$4"); LADDER_A+=("$5"); }

(( HEIGHT >= 1080 )) && add_rung 1080 5000 5350 7500 160
(( HEIGHT >= 720  )) && add_rung 720  2800 3000 4200 128
add_rung 480 1200 1300 1800 96
if [[ ${#LADDER_H[@]} -eq 1 && $HEIGHT -lt 480 ]]; then
  LADDER_H=("$HEIGHT"); LADDER_V=(800); LADDER_MAX=(900); LADDER_BUF=(1200); LADDER_A=(96)
fi

echo "Source   : $BASE  (${HEIGHT}p, ${FPS} i/s, ${AUDIO_COUNT} piste(s) audio)"
echo "Échelons : ${LADDER_H[*]} (segments de ${SEG} s, GOP ${GOP})"
echo "Sortie   : $OUT"

mkdir -p "$OUT"

# --- ffmpeg ------------------------------------------------------------------
# One invocation, one decode, one timeline. Splitting this into several runs is
# exactly how the rungs drift apart from each other.
ARGS=(-y -i "$SRC")

FILTER=""
for i in "${!LADDER_H[@]}"; do
  FILTER+="[0:v]scale=-2:${LADDER_H[$i]}:flags=bicubic[v$i];"
done
ARGS+=(-filter_complex "${FILTER%;}")

VAR_MAP=""
for i in "${!LADDER_H[@]}"; do
  ARGS+=(-map "[v$i]")
  ARGS+=(-c:v:$i libx264 -preset "$PRESET" -profile:v high -pix_fmt yuv420p)
  # Pinned GOP + no scene-cut keyframes: identical segment boundaries on every
  # rung, which is what lets hls.js switch without a hiccup or a desync.
  ARGS+=(-g:v:$i "$GOP" -keyint_min:v:$i "$GOP" -sc_threshold:v:$i 0)
  ARGS+=(-force_key_frames:v:$i "expr:gte(t,n_forced*${SEG})")
  if [[ $CRF_MODE -eq 1 ]]; then
    ARGS+=(-crf:v:$i 21 -maxrate:v:$i "${LADDER_MAX[$i]}k" -bufsize:v:$i "${LADDER_BUF[$i]}k")
  else
    ARGS+=(-b:v:$i "${LADDER_V[$i]}k" -maxrate:v:$i "${LADDER_MAX[$i]}k" -bufsize:v:$i "${LADDER_BUF[$i]}k")
  fi
  VAR_MAP+="v:$i,agroup:aud,name:${LADDER_H[$i]}p "
done

# Every audio track survives as a rendition shared by all rungs, instead of the
# single track the old server-side path kept.
for ((a = 0; a < AUDIO_COUNT; a++)); do
  ARGS+=(-map "0:a:$a" -c:a:$a aac -ac:a:$a 2 -b:a:$a "${LADDER_A[0]}k")
  LANG="$(ffprobe -v error -select_streams "a:$a" -show_entries stream_tags=language -of csv=p=0 "$SRC" | head -1)"
  LANG="${LANG:-und}"
  DEF="NO"; [[ $a -eq 0 ]] && DEF="YES"
  VAR_MAP+="a:$a,agroup:aud,name:${LANG}_${a},language:${LANG},default:${DEF} "
done

ARGS+=(
  -f hls
  -hls_time "$SEG"
  -hls_playlist_type vod
  -hls_flags independent_segments
  -hls_segment_type mpegts
  -hls_segment_filename "$OUT/stream_%v/seg_%05d.ts"
  -master_pl_name master.m3u8
  -var_stream_map "${VAR_MAP% }"
  "$OUT/stream_%v/index.m3u8"
)

ffmpeg "${ARGS[@]}"

# --- Sidecar -----------------------------------------------------------------
# The VPS should not have to probe anything: it only serves files. This is what
# lets a film live on the server as a .hls folder with no 8 GB source next to it.
{
  printf '{\n'
  printf '  "version": 1,\n'
  printf '  "stem": "%s",\n' "$STEM"
  printf '  "source": "%s",\n' "$BASE"
  printf '  "duration": %s,\n' "${DURATION:-0}"
  printf '  "sourceHeight": %s,\n' "$HEIGHT"
  printf '  "segmentSeconds": %s,\n' "$SEG"
  printf '  "variants": [%s],\n' "$(IFS=,; echo "${LADDER_H[*]}")"
  printf '  "audioTracks": [\n'
  for ((a = 0; a < AUDIO_COUNT; a++)); do
    LANG="$(ffprobe -v error -select_streams "a:$a" -show_entries stream_tags=language -of csv=p=0 "$SRC" | head -1)"
    TITLE="$(ffprobe -v error -select_streams "a:$a" -show_entries stream_tags=title -of csv=p=0 "$SRC" | head -1)"
    CODEC="$(ffprobe -v error -select_streams "a:$a" -show_entries stream=codec_name -of csv=p=0 "$SRC" | head -1)"
    COMMA=","; [[ $a -eq $((AUDIO_COUNT - 1)) ]] && COMMA=""
    printf '    { "index": %s, "lang": "%s", "title": "%s", "codec": "%s" }%s\n' \
      "$a" "${LANG:-und}" "${TITLE//\"/}" "${CODEC:-aac}" "$COMMA"
  done
  printf '  ],\n'
  printf '  "encodedAt": %s000\n' "$(date +%s)"
  printf '}\n'
} > "$OUT/watchy.json"

echo
echo "Prêt : $OUT/master.m3u8"
echo "Taille : $(du -sh "$OUT" | cut -f1)"
echo "Ensuite : ./scripts/publish-hls.sh \"$SRC\""
