import fs from "node:fs/promises";
import path from "node:path";
import { createReadStream, existsSync, statSync } from "node:fs";
import { getEntry, posterUrl, type AudioTrackMeta } from "./catalog.js";
import { config } from "./config.js";
import { listProgress } from "./progress.js";
import { listSubtitles, type SubtitleTrack } from "./subtitles.js";

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
};

export async function listMovies(): Promise<Movie[]> {
  await fs.mkdir(config.mediaDir, { recursive: true });
  const entries = await fs.readdir(config.mediaDir, { withFileTypes: true });
  const progress = await listProgress();
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
    const hasHls = existsSync(hlsMaster);
    const meta = await getEntry(entry.name);
    const prog = progress[id];
    movies.push({
      id,
      title: meta.title,
      description: meta.description,
      filename: entry.name,
      size: st.size,
      hasHls: hasHls || meta.hlsReady,
      hlsPath: hasHls ? `${stem}.hls/master.m3u8` : undefined,
      posterUrl: (() => {
        const base = posterUrl(meta.poster);
        if (!base) return null;
        const v = meta.indexedAt ?? meta.tmdbId ?? 0;
        return `${base}?v=${v}`;
      })(),
      subtitles: await listSubtitles(entry.name),
      audioTracks: meta.audioTracks,
      preferredAudio: meta.preferredAudio,
      indexedAt: meta.indexedAt,
      tmdbId: meta.tmdbId ?? null,
      metadataSource: meta.metadataSource ?? null,
      progressTime: prog && prog.mediaTime > 20 ? prog.mediaTime : null,
      progressAt: prog?.updatedAt ?? null,
    });
  }

  return movies.sort((a, b) => {
    const ap = a.progressAt ?? 0;
    const bp = b.progressAt ?? 0;
    if (ap !== bp) return bp - ap;
    return a.title.localeCompare(b.title, "fr");
  });
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
