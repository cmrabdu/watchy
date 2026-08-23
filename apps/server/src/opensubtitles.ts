import fsp from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import { normalizeLang } from "./subtitles.js";

/**
 * OpenSubtitles — probably the most useful feature for this particular couple:
 * she is an Arabic speaker and western MKVs almost never carry Arabic.
 *
 * The API key is optional. Without OPENSUBTITLES_API_KEY the feature reports
 * itself as unconfigured and every route answers 503 with a clear message;
 * nothing else in the server changes behaviour.
 */

const API = "https://api.opensubtitles.com/api/v1";
const UA = "Watchy v1.0";

export function hasOpenSubtitles(): boolean {
  return Boolean(config.openSubtitlesApiKey);
}

export class OpenSubtitlesDisabled extends Error {
  constructor() {
    super(
      "OpenSubtitles non configuré — posez OPENSUBTITLES_API_KEY dans .env " +
        "(clé gratuite sur opensubtitles.com/consumers).",
    );
    this.name = "OpenSubtitlesDisabled";
  }
}

/**
 * The OpenSubtitles hash: file size, plus the 64-bit little-endian words of
 * the first and last 64 KB, summed modulo 2^64. Matching on it is what finds
 * subtitles already in sync with this exact rip, instead of a title match that
 * drifts by two seconds.
 */
export async function movieHash(
  filePath: string,
): Promise<{ hash: string; size: number }> {
  const CHUNK = 65536;
  const handle = await fsp.open(filePath, "r");
  try {
    const { size } = await handle.stat();
    if (size < CHUNK * 2) throw new Error("Fichier trop petit pour un hash");
    const mask = (1n << 64n) - 1n;
    let sum = BigInt(size) & mask;

    const head = Buffer.alloc(CHUNK);
    await handle.read(head, 0, CHUNK, 0);
    const tail = Buffer.alloc(CHUNK);
    await handle.read(tail, 0, CHUNK, size - CHUNK);

    for (const buf of [head, tail]) {
      for (let off = 0; off < CHUNK; off += 8) {
        sum = (sum + buf.readBigUInt64LE(off)) & mask;
      }
    }
    return { hash: sum.toString(16).padStart(16, "0"), size };
  } finally {
    await handle.close();
  }
}

type OsFile = { file_id: number; file_name?: string };
type OsAttributes = {
  language?: string;
  release?: string;
  download_count?: number;
  hearing_impaired?: boolean;
  from_trusted?: boolean;
  moviehash_match?: boolean;
  ratings?: number;
  files?: OsFile[];
  feature_details?: { title?: string; year?: number };
};
type OsSearchResponse = { data?: { attributes?: OsAttributes }[] };

export type SubtitleCandidate = {
  fileId: number;
  lang: string;
  release: string;
  title: string;
  downloads: number;
  rating: number;
  hearingImpaired: boolean;
  fromTrusted: boolean;
  /** true when it matched this exact rip by hash, not just by title. */
  hashMatch: boolean;
};

async function osFetch(
  urlPath: string,
  init: RequestInit = {},
): Promise<Response> {
  if (!hasOpenSubtitles()) throw new OpenSubtitlesDisabled();
  const headers: Record<string, string> = {
    "Api-Key": config.openSubtitlesApiKey,
    "User-Agent": UA,
    Accept: "application/json",
    ...((init.headers as Record<string, string>) ?? {}),
  };
  const res = await fetch(`${API}${urlPath}`, { ...init, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`OpenSubtitles ${res.status}: ${body.slice(0, 200)}`);
  }
  return res;
}

export async function searchSubtitles(opts: {
  hash?: string;
  query?: string;
  languages: string[];
}): Promise<SubtitleCandidate[]> {
  const params = new URLSearchParams();
  if (opts.hash) params.set("moviehash", opts.hash);
  if (opts.query) params.set("query", opts.query);
  if (opts.languages.length) params.set("languages", opts.languages.join(","));
  params.set("order_by", "download_count");
  params.set("order_direction", "desc");

  const res = await osFetch(`/subtitles?${params.toString()}`);
  const json = (await res.json()) as OsSearchResponse;
  const out: SubtitleCandidate[] = [];
  for (const item of json.data ?? []) {
    const a = item.attributes;
    const file = a?.files?.[0];
    if (!a || !file?.file_id) continue;
    out.push({
      fileId: file.file_id,
      lang: normalizeLang(a.language),
      release: a.release ?? file.file_name ?? "",
      title: a.feature_details?.title ?? "",
      downloads: a.download_count ?? 0,
      rating: a.ratings ?? 0,
      hearingImpaired: Boolean(a.hearing_impaired),
      fromTrusted: Boolean(a.from_trusted),
      hashMatch: Boolean(a.moviehash_match),
    });
  }
  // A hash match is already in sync with this rip: always float it to the top.
  return out.sort((x, y) => {
    if (x.hashMatch !== y.hashMatch) return x.hashMatch ? -1 : 1;
    return y.downloads - x.downloads;
  });
}

/**
 * Subtitle files are frequently in a legacy codepage — windows-1256 for Arabic
 * is the common case. Decode to UTF-8 before writing, or the player shows
 * mojibake and she cannot read a word.
 */
export function decodeSubtitle(bytes: Buffer, lang: string): string {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return text.replace(/^﻿/, "");
  } catch {
    const fallback =
      lang === "ar" ? "windows-1256" : lang === "he" ? "windows-1255" : "windows-1252";
    try {
      return new TextDecoder(fallback).decode(bytes).replace(/^﻿/, "");
    } catch {
      return bytes.toString("latin1");
    }
  }
}

export type DownloadedSubtitle = {
  filename: string;
  lang: string;
  bytes: number;
  replaced: boolean;
  remaining: number | null;
};

/** Saves as `<stem>.<lang>.srt` — exactly what listSubtitles already expects. */
export async function downloadSubtitle(opts: {
  fileId: number;
  stem: string;
  lang: string;
}): Promise<DownloadedSubtitle> {
  const res = await osFetch("/download", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file_id: opts.fileId, sub_format: "srt" }),
  });
  const json = (await res.json()) as {
    link?: string;
    remaining?: number;
  };
  if (!json.link) throw new Error("OpenSubtitles n'a pas renvoyé de lien");

  const fileRes = await fetch(json.link, { headers: { "User-Agent": UA } });
  if (!fileRes.ok) throw new Error(`Téléchargement ${fileRes.status}`);
  const bytes = Buffer.from(await fileRes.arrayBuffer());

  const lang = normalizeLang(opts.lang);
  const filename = `${opts.stem}.${lang}.srt`;
  const dest = path.join(config.mediaDir, filename);
  const replaced = existsSync(dest);
  await fsp.mkdir(config.mediaDir, { recursive: true });
  await fsp.writeFile(dest, decodeSubtitle(bytes, lang), "utf8");

  return {
    filename,
    lang,
    bytes: bytes.length,
    replaced,
    remaining: typeof json.remaining === "number" ? json.remaining : null,
  };
}
