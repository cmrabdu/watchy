import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import {
  emptyEntry,
  loadCatalog,
  posterUrl,
  type AudioTrackMeta,
} from "./catalog.js";
import { config } from "./config.js";
import { listProgress } from "./progress.js";
import { subtitlesFromEntries, type SubtitleTrack } from "./subtitles.js";
import { audioTracksFromMeta, readHlsMeta } from "./hlsmeta.js";

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mkv", ".m4v"]);

export type Movie = {
  id: string;
  title: string;
  description: string;
  filename: string;
  size: number;
  hasHls: boolean;
  hlsPath?: string;
  posterUrl: string | null;
  subtitles: SubtitleTrack[];
  audioTracks: AudioTrackMeta[];
  preferredAudio: number | null;
  indexedAt: number | null;
  tmdbId: number | null;
  metadataSource: "tmdb" | "manual" | "frame" | null;
  /** Seconds into the film if previously watched */
  progressTime: number | null;
  progressAt: number | null;
  /**
   * true when only the HLS ladder was shipped to the server, with no source
   * video next to it. Playback works; /api/stream/:id does not exist for it.
   */
  hlsOnly: boolean;
  /** Ladder heights, e.g. [1080, 720, 480]. Empty for a plain file. */
  variants: number[];
  /** Seconds, when the encoder recorded it. */
  duration: number | null;
};

export async function listMovies(): Promise<Movie[]> {
  await fs.mkdir(config.mediaDir, { recursive: true });
  // One readdir, one catalog parse, one progress read for the whole listing.
  // Doing it per film meant O(n²) disk access on every 8 s poll, on 2 vCPU.
  const entries = await fs.readdir(config.mediaDir, { withFileTypes: true });
  const names = entries.map((e) => e.name);
  const [progress, catalog] = await Promise.all([listProgress(), loadCatalog()]);
  const movies: Movie[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (entry.name.endsWith(".part")) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (!VIDEO_EXTS.has(ext)) continue;
    const full = path.join(config.mediaDir, entry.name);
    const st = await fs.stat(full);
    const id = Buffer.from(entry.name).toString("base64url");
    const stem = entry.name.replace(/\.[^.]+$/, "");
    const hlsMaster = path.join(config.mediaDir, `${stem}.hls`, "master.m3u8");
    // Derive from the playlist actually on disk. Trusting catalog.hlsReady sent
    // the client through hls.js on an MP4 URL after the .hls dir was deleted.
    const hlsPath = existsSync(hlsMaster)
      ? `${stem}.hls/master.m3u8`
      : undefined;
    const meta = catalog.movies[entry.name] ?? emptyEntry(entry.name);
    const prog = progress[id];
    movies.push({
      id,
      title: meta.title,
      description: meta.description,
      filename: entry.name,
      size: st.size,
      hasHls: Boolean(hlsPath),
      hlsPath,
      posterUrl: (() => {
        const base = posterUrl(meta.poster);
        if (!base) return null;
        const v = meta.indexedAt ?? meta.tmdbId ?? 0;
        return `${base}?v=${v}`;
      })(),
      subtitles: subtitlesFromEntries(entry.name, names),
      audioTracks: meta.audioTracks,
      preferredAudio: meta.preferredAudio,
      indexedAt: meta.indexedAt,
      tmdbId: meta.tmdbId ?? null,
      metadataSource: meta.metadataSource ?? null,
      progressTime: prog && prog.mediaTime > 20 ? prog.mediaTime : null,
      progressAt: prog?.updatedAt ?? null,
      hlsOnly: false,
      variants: hlsPath ? ((await readHlsMeta(stem))?.variants ?? []) : [],
      duration: hlsPath ? ((await readHlsMeta(stem))?.duration ?? null) : null,
    });
  }

  // Films shipped as a ladder only: encoded on the owner's PC and rsynced here
  // without the 8 GB source. Without this they would be invisible in the
  // catalogue, and "the VPS only serves files" would be impossible on 22 GB.
  const videoStems = new Set(
    names
      .filter((n) => VIDEO_EXTS.has(path.extname(n).toLowerCase()))
      .map((n) => n.replace(/\.[^.]+$/, "")),
  );
  for (const entry of entries) {
    if (!entry.isDirectory() || !entry.name.endsWith(".hls")) continue;
    const stem = entry.name.slice(0, -".hls".length);
    if (videoStems.has(stem)) continue;
    const dir = path.join(config.mediaDir, entry.name);
    // The master lands last during rsync, so a half-transferred film never
    // shows up in the catalogue.
    if (!existsSync(path.join(dir, "master.m3u8"))) continue;

    const virtualName = entry.name; // "<stem>.hls" is the catalogue key
    const id = Buffer.from(virtualName).toString("base64url");
    const meta = catalog.movies[virtualName] ?? emptyEntry(virtualName);
    const hls = await readHlsMeta(stem);
    const prog = progress[id];
    movies.push({
      id,
      title: meta.title,
      description: meta.description,
      filename: virtualName,
      size: await dirBytes(dir),
      hasHls: true,
      hlsPath: `${entry.name}/master.m3u8`,
      posterUrl: (() => {
        const base = posterUrl(meta.poster);
        if (!base) return null;
        const v = meta.indexedAt ?? meta.tmdbId ?? 0;
        return `${base}?v=${v}`;
      })(),
      subtitles: subtitlesFromEntries(`${stem}.mkv`, names),
      audioTracks: meta.audioTracks.length
        ? meta.audioTracks
        : hls
          ? audioTracksFromMeta(hls)
          : [],
      preferredAudio: meta.preferredAudio,
      indexedAt: meta.indexedAt,
      tmdbId: meta.tmdbId ?? null,
      metadataSource: meta.metadataSource ?? null,
      progressTime: prog && prog.mediaTime > 20 ? prog.mediaTime : null,
      progressAt: prog?.updatedAt ?? null,
      hlsOnly: true,
      variants: hls?.variants ?? [],
      duration: hls?.duration ?? null,
    });
  }

  return movies.sort((a, b) => {
    const ap = a.progressAt ?? 0;
    const bp = b.progressAt ?? 0;
    if (ap !== bp) return bp - ap;
    return a.title.localeCompare(b.title, "fr");
  });
}

async function dirBytes(dir: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirBytes(full);
    else {
      const st = await fs.stat(full).catch(() => null);
      if (st) total += st.size;
    }
  }
  return total;
}

export type MovieRef = {
  /** Catalogue key: a real filename, or "<stem>.hls" for a ladder-only film. */
  filename: string;
  stem: string;
  kind: "video" | "hls";
  /** Absolute path to the source video, null when only the ladder was shipped. */
  moviePath: string | null;
  hlsDir: string;
};

/**
 * Resolve either a plain video or a ladder-only film. Routes that genuinely
 * need the source bytes (byte-range streaming, ffprobe) keep using
 * resolveMoviePath and 404 on ladder-only films; everything else — metadata,
 * poster, subtitles, deletion — goes through this.
 */
export function resolveMovieRef(id: string): MovieRef | null {
  let filename: string;
  try {
    filename = Buffer.from(id, "base64url").toString("utf8");
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
  if (filename.endsWith(".hls")) {
    const stem = filename.slice(0, -".hls".length);
    const hlsDir = path.join(config.mediaDir, filename);
    if (!existsSync(path.join(hlsDir, "master.m3u8"))) return null;
    return { filename, stem, kind: "hls", moviePath: null, hlsDir };
  }
  const video = resolveMoviePath(id);
  if (!video) return null;
  const stem = video.filename.replace(/\.[^.]+$/, "");
  return {
    filename: video.filename,
    stem,
    kind: "video",
    moviePath: video.moviePath,
    hlsDir: path.join(config.mediaDir, `${stem}.hls`),
  };
}

export function resolveMoviePath(id: string): { moviePath: string; filename: string } | null {
  let filename: string;
  try {
    filename = Buffer.from(id, "base64url").toString("utf8");
  } catch {
    return null;
  }
  if (
    filename.includes("..") ||
    filename.includes("/") ||
    filename.includes("\\") ||
    !VIDEO_EXTS.has(path.extname(filename).toLowerCase())
  ) {
    return null;
  }
  const moviePath = path.join(config.mediaDir, filename);
  if (!existsSync(moviePath)) return null;
  return { moviePath, filename };
}

export function resolveMediaRelative(rel: string): string | null {
  if (!rel || rel.includes("\0")) return null;
  const normalized = path.normalize(rel).replace(/^(\.\.(\/|\\|$))+/, "");
  if (normalized.startsWith("..")) return null;
  const full = path.join(config.mediaDir, normalized);
  if (!full.startsWith(config.mediaDir)) return null;
  if (!existsSync(full)) return null;
  return full;
}

export function openRangeStream(
  filePath: string,
  rangeHeader: string | undefined,
): {
  stream: NodeJS.ReadableStream;
  status: number;
  headers: Record<string, string>;
} {
  const st = statSync(filePath);
  const size = st.size;
  const contentType = filePath.endsWith(".m3u8")
    ? "application/vnd.apple.mpegurl"
    : filePath.endsWith(".ts")
      ? "video/mp2t"
      : filePath.endsWith(".webm")
        ? "video/webm"
        : filePath.endsWith(".jpg") || filePath.endsWith(".jpeg")
          ? "image/jpeg"
          : filePath.endsWith(".png")
            ? "image/png"
            : "video/mp4";

  // Playlists must not be cached while encode-while-watching grows them.
  const cacheControl = filePath.endsWith(".m3u8")
    ? "private, no-cache, max-age=0, must-revalidate"
    : filePath.endsWith(".ts")
      ? "private, max-age=86400, immutable"
      : filePath.endsWith(".jpg") || filePath.endsWith(".jpeg") || filePath.endsWith(".png")
        ? "private, no-cache, max-age=0, must-revalidate"
        : "private, max-age=3600";

  if (!rangeHeader) {
    return {
      stream: createReadStream(filePath),
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
        "Cache-Control": cacheControl,
      },
    };
  }

  const match = /bytes=(\d*)-(\d*)/.exec(rangeHeader);
  if (!match) {
    return {
      stream: createReadStream(filePath),
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(size),
        "Accept-Ranges": "bytes",
      },
    };
  }

  let start = match[1] ? Number(match[1]) : 0;
  let end = match[2] ? Number(match[2]) : size - 1;
  if (Number.isNaN(start) || Number.isNaN(end) || start > end || start >= size) {
    start = 0;
    end = size - 1;
  }
  end = Math.min(end, size - 1);
  const chunkSize = end - start + 1;

  return {
    stream: createReadStream(filePath, { start, end }),
    status: 206,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(chunkSize),
      "Content-Range": `bytes ${start}-${end}/${size}`,
      "Accept-Ranges": "bytes",
      "Cache-Control": cacheControl,
    },
  };
}
