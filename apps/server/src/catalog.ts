import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";

export type AudioTrackMeta = {
  index: number;
  lang: string;
  label: string;
  codec?: string;
  channels?: number;
};

export type CatalogEntry = {
  filename: string;
  title: string;
  description: string;
  poster: string | null;
  preferredAudio: number | null;
  audioTracks: AudioTrackMeta[];
  indexedAt: number | null;
  hlsReady: boolean;
  tmdbId: number | null;
  /** true when title/poster came from TMDB (user can still override) */
  metadataSource: "tmdb" | "manual" | "frame" | null;
};

type CatalogFile = {
  version: 1;
  movies: Record<string, CatalogEntry>;
};

const CATALOG_NAME = "catalog.json";

function catalogPath() {
  return path.join(config.mediaDir, CATALOG_NAME);
}

function defaultTitle(filename: string): string {
  return filename
    .replace(/\.[^.]+$/, "")
    .replace(/\./g, " ")
    .replace(/[._-]+/g, " ")
    .replace(/\b(multi|vf\d*|vo|bluray|1080p|720p|2160p|x265|x264|hevc|webrip|web-dl|kfl)\b/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function emptyEntry(filename: string): CatalogEntry {
  return {
    filename,
    title: defaultTitle(filename),
    description: "",
    poster: null,
    preferredAudio: null,
    audioTracks: [],
    indexedAt: null,
    hlsReady: false,
    tmdbId: null,
    metadataSource: null,
  };
}

export async function loadCatalog(): Promise<CatalogFile> {
  const file = catalogPath();
  if (!existsSync(file)) return { version: 1, movies: {} };
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as CatalogFile;
    if (!raw.movies) return { version: 1, movies: {} };
    return raw;
  } catch {
    return { version: 1, movies: {} };
  }
}

export async function saveCatalog(data: CatalogFile): Promise<void> {
  await fs.mkdir(config.mediaDir, { recursive: true });
  const tmp = `${catalogPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, catalogPath());
}

export async function getEntry(filename: string): Promise<CatalogEntry> {
  const cat = await loadCatalog();
  return cat.movies[filename] ?? emptyEntry(filename);
}

export async function upsertEntry(
  filename: string,
  patch: Partial<CatalogEntry>,
): Promise<CatalogEntry> {
  const cat = await loadCatalog();
  const current = cat.movies[filename] ?? emptyEntry(filename);
  const next = { ...current, ...patch, filename };
  cat.movies[filename] = next;
  await saveCatalog(cat);
  return next;
}

export async function removeEntry(filename: string): Promise<void> {
  const cat = await loadCatalog();
  const entry = cat.movies[filename];
  delete cat.movies[filename];
  await saveCatalog(cat);
  if (entry?.poster) {
    const posterPath = path.join(config.mediaDir, entry.poster);
    if (existsSync(posterPath)) await fs.unlink(posterPath).catch(() => undefined);
  }
}

export function posterUrl(poster: string | null): string | null {
  if (!poster) return null;
  const name = poster.replace(/^posters\//, "");
  return `/api/posters/${encodeURIComponent(name)}`;
}
