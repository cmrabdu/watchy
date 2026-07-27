import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";

export type SubtitleTrack = {
  id: string;
  label: string;
  lang: string;
  filename: string;
  format: "vtt" | "srt";
};

const LANG_LABELS: Record<string, string> = {
  fr: "Français",
  fra: "Français",
  fre: "Français",
  en: "English",
  eng: "English",
  es: "Español",
  spa: "Español",
  de: "Deutsch",
  ger: "Deutsch",
  deu: "Deutsch",
  it: "Italiano",
  ita: "Italiano",
  ar: "العربية",
  ara: "العربية",
  pt: "Português",
  por: "Português",
  nl: "Nederlands",
  ru: "Русский",
  ja: "日本語",
  ko: "한국어",
  zh: "中文",
  tr: "Türkçe",
};

function labelFor(lang: string, filename: string): string {
  const key = lang.toLowerCase();
  if (LANG_LABELS[key]) return LANG_LABELS[key];
  if (lang && lang !== "und") return lang.toUpperCase();
  return filename;
}

export async function listSubtitles(movieFilename: string): Promise<SubtitleTrack[]> {
  const stem = movieFilename.replace(/\.[^.]+$/, "");
  const entries = await fs.readdir(config.mediaDir);
  const tracks: SubtitleTrack[] = [];

  for (const name of entries) {
    const lower = name.toLowerCase();
    if (!lower.endsWith(".vtt") && !lower.endsWith(".srt")) continue;

    // film.fr.vtt | film.en.srt | film.vtt | film.srt
    let matched = false;
    let lang = "und";

    if (name === `${stem}.vtt` || name === `${stem}.srt`) {
      matched = true;
      lang = "und";
    } else {
      const re = new RegExp(
        `^${escapeRegExp(stem)}\\.([A-Za-z]{2,3})\\.(vtt|srt)$`,
        "i",
      );
      const m = name.match(re);
      if (m) {
        matched = true;
        lang = m[1].toLowerCase();
      }
    }

    if (!matched) continue;
    const format = lower.endsWith(".vtt") ? "vtt" : "srt";
    tracks.push({
      id: Buffer.from(name).toString("base64url"),
      label: labelFor(lang, name),
      lang,
      filename: name,
      format,
    });
  }

  return tracks.sort((a, b) => a.label.localeCompare(b.label, "fr"));
}

export function resolveSubtitlePath(trackId: string): string | null {
  let filename: string;
  try {
    filename = Buffer.from(trackId, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\")
  ) {
    return null;
  }
  const lower = filename.toLowerCase();
  if (!lower.endsWith(".vtt") && !lower.endsWith(".srt")) return null;
  const full = path.join(config.mediaDir, filename);
  if (!existsSync(full)) return null;
  return full;
}

export function srtToVtt(srt: string): string {
  const body = srt
    .replace(/\r+/g, "")
    .replace(/^\uFEFF/, "")
    .replace(
      /(\d{2}):(\d{2}):(\d{2}),(\d{3})/g,
      "$1:$2:$3.$4",
    )
    .trim();
  return `WEBVTT\n\n${body}\n`;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
