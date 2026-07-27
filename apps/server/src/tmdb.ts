import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";

/** Same idea as Jellyfin: strip release tags, keep title + year. */
const JUNK =
  /\b(multi|vf\d*|vff|truefrench|vo|vostfr|bluray|blu-ray|bdrip|brrip|dvdrip|webrip|web-dl|webdl|hdtv|hdrip|remux|proper|repack|extended|unrated|directors?.cut|1080p|720p|2160p|4k|uhd|x265|x264|h\.?264|h\.?265|hevc|avc|aac|dts|ac3|atmos|hdr10?|dv|hdr|10bit|8bit|xvid|divx|mkv|mp4|kfl|yify|rarbg|sparks|ntb|flux|amzn|nf|dsnp)\b/gi;

export type ParsedFilename = {
  title: string;
  year: number | null;
  tmdbId: number | null;
};

export type TmdbMovieHit = {
  id: number;
  title: string;
  original_title?: string;
  overview: string;
  release_date?: string;
  poster_path: string | null;
  vote_average?: number;
};

export function parseMovieFilename(filename: string): ParsedFilename {
  const stem = filename.replace(/\.[^.]+$/, "");
  const tmdbMatch = /\[(?:tmdb(?:id)?|themoviedb)[^\d]*(\d+)\]/i.exec(stem);
  const tmdbId = tmdbMatch ? Number(tmdbMatch[1]) : null;

  let cleaned = stem
    .replace(/\[(?:tmdb(?:id)?|imdbid?|tvdbid?)[^\]]*\]/gi, " ")
    .replace(/[._]+/g, " ")
    .replace(JUNK, " ")
    .replace(/\s+/g, " ")
    .trim();

  let year: number | null = null;
  const yearParen = /\((\d{4})\)/.exec(cleaned);
  const yearBare = /(?:^|\s)((?:19|20)\d{2})(?:\s|$)/.exec(cleaned);
  if (yearParen) {
    year = Number(yearParen[1]);
    cleaned = cleaned.replace(yearParen[0], " ").replace(/\s+/g, " ").trim();
  } else if (yearBare) {
    year = Number(yearBare[1]);
    cleaned = cleaned.replace(yearBare[1], " ").replace(/\s+/g, " ").trim();
  }

  return {
    title: cleaned || stem.replace(/[._]+/g, " ").trim(),
    year,
    tmdbId,
  };
}

function requireKey(): string {
  const key = config.tmdbApiKey;
  if (!key) {
    throw new Error(
      "TMDB_API_KEY manquante — crée une clé gratuite sur themoviedb.org/settings/api",
    );
  }
  return key;
}

async function tmdbGet<T>(
  apiPath: string,
  query: Record<string, string> = {},
): Promise<T> {
  const key = requireKey();
  const url = new URL(`https://api.themoviedb.org/3${apiPath}`);
  url.searchParams.set("api_key", key);
  url.searchParams.set("language", "fr-FR");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`TMDB ${res.status}: ${await res.text().catch(() => "")}`);
  }
  return res.json() as Promise<T>;
}

export async function searchTmdbMovies(
  query: string,
  year?: number | null,
): Promise<TmdbMovieHit[]> {
  const q = query.trim();
  if (!q) return [];
  const params: Record<string, string> = { query: q, include_adult: "false" };
  if (year) params.year = String(year);
  const data = await tmdbGet<{ results: TmdbMovieHit[] }>("/search/movie", params);
  return data.results ?? [];
}

export async function getTmdbMovie(id: number): Promise<TmdbMovieHit> {
  return tmdbGet<TmdbMovieHit>(`/movie/${id}`);
}

function scoreHit(hit: TmdbMovieHit, title: string, year: number | null): number {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const want = norm(title);
  const got = norm(hit.title || "");
  const orig = norm(hit.original_title || "");
  let score = 0;
  if (got === want || orig === want) score += 100;
  else if (got.includes(want) || want.includes(got)) score += 40;
  else if (orig.includes(want) || want.includes(orig)) score += 35;
  const hitYear = hit.release_date ? Number(hit.release_date.slice(0, 4)) : null;
  if (year && hitYear) {
    if (hitYear === year) score += 50;
    else if (Math.abs(hitYear - year) === 1) score += 10;
    else score -= 30;
  }
  score += Math.min(15, (hit.vote_average ?? 0) * 1.5);
  return score;
}

/** Auto-pick best TMDB match from a release filename (Jellyfin-style). */
export async function matchMovieFromFilename(
  filename: string,
): Promise<TmdbMovieHit | null> {
  if (!config.tmdbApiKey) return null;
  const parsed = parseMovieFilename(filename);
  if (parsed.tmdbId) {
    try {
      return await getTmdbMovie(parsed.tmdbId);
    } catch {
      /* fall through to search */
    }
  }

  const queries = [parsed.title];
  const words = parsed.title.split(" ").filter(Boolean);
  if (words.length > 3) queries.push(words.slice(0, 3).join(" "));
  if (words.length > 2) queries.push(words.slice(0, 2).join(" "));

  let best: { hit: TmdbMovieHit; score: number } | null = null;
  for (const q of queries) {
    const hits = await searchTmdbMovies(q, parsed.year);
    for (const hit of hits.slice(0, 8)) {
      const s = scoreHit(hit, parsed.title, parsed.year);
      if (!best || s > best.score) best = { hit, score: s };
    }
    if (best && best.score >= 120) break;
  }
  if (!best || best.score < 60) return null;
  return best.hit;
}

export function posterLocalName(filename: string): string {
  return `${Buffer.from(filename).toString("base64url")}.jpg`;
}

export async function downloadTmdbPoster(
  filename: string,
  posterPath: string,
): Promise<string | null> {
  const postersDir = path.join(config.mediaDir, "posters");
  await fs.mkdir(postersDir, { recursive: true });
  const name = posterLocalName(filename);
  const dest = path.join(postersDir, name);
  const url = `https://image.tmdb.org/t/p/w500${posterPath}`;
  const res = await fetch(url);
  if (!res.ok) return null;
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 2000) return null;
  await fs.writeFile(dest, buf);
  return `posters/${name}`;
}

export async function saveUploadedPoster(
  filename: string,
  bytes: Buffer,
): Promise<string> {
  const postersDir = path.join(config.mediaDir, "posters");
  await fs.mkdir(postersDir, { recursive: true });
  const name = posterLocalName(filename);
  const dest = path.join(postersDir, name);
  await fs.writeFile(dest, bytes);
  return `posters/${name}`;
}

export function hasTmdb(): boolean {
  return Boolean(config.tmdbApiKey);
}

export function posterFileExists(filename: string): boolean {
  return existsSync(
    path.join(config.mediaDir, "posters", posterLocalName(filename)),
  );
}
