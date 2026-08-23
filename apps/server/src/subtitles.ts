import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";

export type SubtitleTrack = {
  id: string;
  label: string;
  /** Normalised to ISO 639-1 when known ("fre" -> "fr"), else "und". */
  lang: string;
  /**
   * Exactly what belongs in `<track srclang>` — or "und" when the real language
   * is unknown. The server never guesses "fr": an unlabelled track stays "und"
   * and the client must not pretend otherwise.
   */
  srcLang: string;
  filename: string;
  format: "vtt" | "srt";
};

/** ISO 639-2/B and /T -> ISO 639-1, for the languages this library sees. */
const ISO3_TO_ISO1: Record<string, string> = {
  fre: "fr",
  fra: "fr",
  eng: "en",
  spa: "es",
  ger: "de",
  deu: "de",
  ita: "it",
  ara: "ar",
  por: "pt",
  dut: "nl",
  nld: "nl",
  rus: "ru",
  jpn: "ja",
  kor: "ko",
  chi: "zh",
  zho: "zh",
  tur: "tr",
  pol: "pl",
  swe: "sv",
  dan: "da",
  nor: "no",
  fin: "fi",
  heb: "he",
  hin: "hi",
  ell: "el",
  gre: "el",
  ron: "ro",
  rum: "ro",
  ces: "cs",
  cze: "cs",
  hun: "hu",
  ukr: "uk",
  vie: "vi",
  tha: "th",
  ind: "id",
  fas: "fa",
  per: "fa",
};

export function normalizeLang(raw: string | undefined | null): string {
  const key = (raw || "").trim().toLowerCase();
  if (!key || key === "und" || key === "unknown") return "und";
  if (ISO3_TO_ISO1[key]) return ISO3_TO_ISO1[key];
  if (/^[a-z]{2}$/.test(key)) return key;
  if (/^[a-z]{3}$/.test(key)) return key;
  return "und";
}

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
  // Unknown language: say so, do not borrow a flag we cannot justify.
  return `Sous-titres (${filename})`;
}

export async function listSubtitles(
  movieFilename: string,
): Promise<SubtitleTrack[]> {
  return subtitlesFromEntries(movieFilename, await fs.readdir(config.mediaDir));
}

/**
 * Same as listSubtitles but reuses a directory listing the caller already has.
 * listMovies() used to readdir() the whole media dir once per film — O(n²)
 * disk churn on 2 vCPU while ffmpeg encodes.
 */
export function subtitlesFromEntries(
  movieFilename: string,
  entries: string[],
): SubtitleTrack[] {
  const stem = movieFilename.replace(/\.[^.]+$/, "");
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
        lang = normalizeLang(m[1]);
      }
    }

    if (!matched) continue;
    const format = lower.endsWith(".vtt") ? "vtt" : "srt";
    tracks.push({
      id: Buffer.from(name).toString("base64url"),
      label: labelFor(lang, name),
      lang,
      srcLang: lang,
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

/**
 * Browsers cannot display SubStation Alpha. She sends what she finds, so an
 * uploaded .ass/.ssa is converted to .srt (the name listSubtitles expects) and
 * the original is dropped. Returns the filename actually kept.
 */
export async function convertToSrtIfNeeded(filename: string): Promise<string> {
  const ext = path.extname(filename).toLowerCase();
  if (ext !== ".ass" && ext !== ".ssa") return filename;
  const source = path.join(config.mediaDir, filename);
  const target = `${filename.slice(0, -ext.length)}.srt`;
  const targetPath = path.join(config.mediaDir, target);
  const code = await new Promise<number>((resolve) => {
    const child = spawn("ffmpeg", ["-y", "-i", source, targetPath], {
      stdio: ["ignore", "ignore", "ignore"],
    });
    child.on("close", (c) => resolve(c ?? 1));
    child.on("error", () => resolve(1));
  });
  if (code !== 0 || !existsSync(targetPath)) {
    await fs.unlink(source).catch(() => undefined);
    throw new Error("Conversion du sous-titre impossible (ffmpeg)");
  }
  await fs.unlink(source).catch(() => undefined);
  return target;
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
