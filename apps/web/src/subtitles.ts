/**
 * Reglages de sous-titres cote client.
 *
 * Le rendu natif `::cue` ne laisse regler ni la position, ni la direction du
 * texte : un `.srt` arabe recupere a la main s'affiche trop petit, sous la
 * barre de controle, et etiquete « fr ». On rend donc les cues nous-memes, ce
 * qui rend possible le decalage, la taille et le sens de lecture.
 */

const SCALE_KEY = "watchy.cueScale";
const BOX_KEY = "watchy.cueBox";
const OFFSET_PREFIX = "watchy.subOffset.";

export const CUE_SCALE_MIN = 0.7;
export const CUE_SCALE_MAX = 2.2;
export const OFFSET_STEP = 0.5;

export function readCueScale(): number {
  try {
    const v = Number(localStorage.getItem(SCALE_KEY));
    if (Number.isFinite(v) && v >= CUE_SCALE_MIN && v <= CUE_SCALE_MAX) return v;
  } catch {
    /* ignore */
  }
  return 1;
}

export function writeCueScale(v: number) {
  try {
    localStorage.setItem(SCALE_KEY, String(v));
  } catch {
    /* ignore */
  }
}

export function readCueBox(): boolean {
  try {
    return localStorage.getItem(BOX_KEY) !== "off";
  } catch {
    return true;
  }
}

export function writeCueBox(on: boolean) {
  try {
    localStorage.setItem(BOX_KEY, on ? "on" : "off");
  } catch {
    /* ignore */
  }
}

/** Le decalage se memorise par piste : un fichier decale l'est pour toujours. */
export function readOffset(trackId: string): number {
  try {
    const v = Number(localStorage.getItem(OFFSET_PREFIX + trackId));
    return Number.isFinite(v) ? v : 0;
  } catch {
    return 0;
  }
}

export function writeOffset(trackId: string, seconds: number) {
  try {
    if (seconds === 0) localStorage.removeItem(OFFSET_PREFIX + trackId);
    else localStorage.setItem(OFFSET_PREFIX + trackId, String(seconds));
  } catch {
    /* ignore */
  }
}

/** Decale toutes les cues d'une piste, en place. */
export function shiftCues(track: TextTrack, delta: number) {
  if (!delta) return;
  const cues = track.cues;
  if (!cues) return;
  for (let i = 0; i < cues.length; i += 1) {
    const cue = cues[i];
    const start = Math.max(0, cue.startTime + delta);
    const end = Math.max(start + 0.05, cue.endTime + delta);
    // L'ordre compte : reculer la fin avant le debut evite un etat invalide.
    if (delta < 0) {
      cue.startTime = start;
      cue.endTime = end;
    } else {
      cue.endTime = end;
      cue.startTime = start;
    }
  }
}

const ALLOWED = /&lt;(\/?)(i|b|u)&gt;/g;

/**
 * Le texte WebVTT accepte quelques balises. On echappe tout, puis on rend
 * uniquement i/b/u : aucun HTML tiers ne traverse.
 */
export function cueToHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return escaped.replace(ALLOWED, "<$1$2>").replace(/\n/g, "<br>");
}

/** Vrai si le texte contient de l'arabe ou de l'hebreu : sens de lecture. */
export function isRtlText(text: string): boolean {
  return /[\u0590-\u05FF\u0600-\u06FF\u0700-\u074F\u0750-\u077F\u08A0-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/.test(
    text,
  );
}
