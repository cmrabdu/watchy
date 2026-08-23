import fsp from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import type { AudioTrackMeta } from "./catalog.js";

/**
 * Descriptor written by scripts/transcode-hls.sh next to the ladder.
 * It exists so the VPS never has to probe anything: a film can live on the
 * server as a bare .hls folder, with no 8 GB source alongside it.
 */
export type HlsMeta = {
  version: 1;
  stem: string;
  source: string;
  duration: number;
  sourceHeight: number;
  segmentSeconds: number;
  variants: number[];
  audioTracks: { index: number; lang: string; title?: string; codec?: string }[];
  encodedAt: number;
};

export function hlsDirFor(stem: string): string {
  return path.join(config.mediaDir, `${stem}.hls`);
}

export function hasHlsLadder(stem: string): boolean {
  return existsSync(path.join(hlsDirFor(stem), "master.m3u8"));
}

export async function readHlsMeta(stem: string): Promise<HlsMeta | null> {
  const file = path.join(hlsDirFor(stem), "watchy.json");
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(await fsp.readFile(file, "utf8")) as HlsMeta;
    return Array.isArray(raw.variants) ? raw : null;
  } catch {
    return null;
  }
}

const LANG_LABELS: Record<string, string> = {
  fre: "Français",
  fra: "Français",
  fr: "Français",
  eng: "English",
  en: "English",
  ara: "العربية",
  ar: "العربية",
  spa: "Español",
  es: "Español",
  ger: "Deutsch",
  deu: "Deutsch",
  de: "Deutsch",
  ita: "Italiano",
  it: "Italiano",
  und: "Piste",
};

/** Audio renditions declared in the ladder, in catalog shape. */
export function audioTracksFromMeta(meta: HlsMeta): AudioTrackMeta[] {
  return meta.audioTracks.map((t, i) => {
    const lang = (t.lang || "und").toLowerCase();
    const base = LANG_LABELS[lang] || lang.toUpperCase();
    return {
      index: t.index ?? i,
      lang,
      label: t.title ? `${base} — ${t.title}` : `${base} (${i + 1})`,
      codec: t.codec,
    };
  });
}
