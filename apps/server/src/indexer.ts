import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";
import {
  getEntry,
  upsertEntry,
  type AudioTrackMeta,
} from "./catalog.js";
import {
  downloadTmdbPoster,
  hasTmdb,
  matchMovieFromFilename,
  type TmdbMovieHit,
} from "./tmdb.js";

type FfprobeStream = {
  index: number;
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
};

type FfprobeJson = {
  streams?: FfprobeStream[];
};

const LANG_LABELS: Record<string, string> = {
  fre: "Français",
  fra: "Français",
  fr: "Français",
  eng: "English",
  en: "English",
  spa: "Español",
  es: "Español",
  ger: "Deutsch",
  deu: "Deutsch",
  de: "Deutsch",
  ita: "Italiano",
  it: "Italiano",
  ara: "العربية",
  ar: "العربية",
  jpn: "日本語",
  ja: "日本語",
  und: "Piste",
};

function run(
  cmd: string,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      stdout += String(d);
    });
    child.stderr.on("data", (d) => {
      stderr += String(d);
    });
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
}

function langLabel(lang: string, index: number, title?: string): string {
  const key = (lang || "und").toLowerCase();
  const base = LANG_LABELS[key] || lang.toUpperCase() || "Piste";
  if (title) return `${base} — ${title}`;
  return `${base} (${index})`;
}

export async function probeFile(filePath: string): Promise<FfprobeJson> {
  const { code, stdout } = await run("ffprobe", [
    "-v",
    "quiet",
    "-print_format",
    "json",
    "-show_streams",
    filePath,
  ]);
  if (code !== 0) return { streams: [] };
  try {
    return JSON.parse(stdout) as FfprobeJson;
  } catch {
    return { streams: [] };
  }
}

/** Netflix-style portrait still (2:3), center-cropped from the film. */
async function ensurePoster(
  filename: string,
  videoPath: string,
  force = false,
): Promise<string | null> {
  const postersDir = path.join(config.mediaDir, "posters");
  await fs.mkdir(postersDir, { recursive: true });
  const posterName = `${Buffer.from(filename).toString("base64url")}.jpg`;
  const posterPath = path.join(postersDir, posterName);
  if (!force && existsSync(posterPath)) return `posters/${posterName}`;

  // Portrait crop; try a few timestamps (skip black/credits-ish opens).
  const seeks = ["00:08:30", "00:15:00", "00:02:00", "00:00:45"];
  const vf =
    "scale=540:810:force_original_aspect_ratio=increase,crop=540:810";

  for (const ss of seeks) {
    const { code } = await run("ffmpeg", [
      "-y",
      "-ss",
      ss,
      "-i",
      videoPath,
      "-frames:v",
      "1",
      "-q:v",
      "2",
      "-vf",
      vf,
      posterPath,
    ]);
    if (code === 0 && existsSync(posterPath)) {
      return `posters/${posterName}`;
    }
  }
  return null;
}

/** Force a fresh frame poster (fallback only — prefer TMDB). */
export async function regeneratePoster(filename: string): Promise<string | null> {
  const videoPath = path.join(config.mediaDir, filename);
  if (!existsSync(videoPath)) return null;
  const prev = await getEntry(filename);
  if (prev.metadataSource === "tmdb" || prev.metadataSource === "manual") {
    return prev.poster;
  }
  const poster = await ensurePoster(filename, videoPath, true);
  if (poster) {
    await upsertEntry(filename, { poster, metadataSource: "frame" });
  }
  return poster;
}

async function extractTextSubtitles(
  filename: string,
  videoPath: string,
  streams: FfprobeStream[],
): Promise<void> {
  const stem = filename.replace(/\.[^.]+$/, "");
  const subs = streams.filter((s) => {
    const codec = (s.codec_name || "").toLowerCase();
    return (
      s.codec_type === "subtitle" &&
      ["subrip", "srt", "ass", "ssa", "webvtt", "mov_text"].includes(codec)
    );
  });

  // Prefer full tracks over "forced" / tiny ones, per language.
  const byLang = new Map<string, FfprobeStream[]>();
  for (const s of subs) {
    const lang = (s.tags?.language || "und").toLowerCase();
    const list = byLang.get(lang) ?? [];
    list.push(s);
    byLang.set(lang, list);
  }

  for (const [lang, list] of byLang) {
    const ranked = [...list].sort((a, b) => {
      const aForced = a.disposition?.forced ? 1 : 0;
      const bForced = b.disposition?.forced ? 1 : 0;
      if (aForced !== bForced) return aForced - bForced;
      const aTitle = (a.tags?.title || "").toLowerCase();
      const bTitle = (b.tags?.title || "").toLowerCase();
      const aFull = /full|complet/.test(aTitle) ? 1 : 0;
      const bFull = /full|complet/.test(bTitle) ? 1 : 0;
      return bFull - aFull;
    });
    const chosen = ranked[0];
    const out = path.join(config.mediaDir, `${stem}.${lang}.srt`);
    // Re-extract if missing or suspiciously tiny (forced-only leftovers).
    try {
      const st = existsSync(out) ? await fs.stat(out) : null;
      if (st && st.size > 2000) continue;
    } catch {
      /* extract */
    }
    await run("ffmpeg", [
      "-y",
      "-i",
      videoPath,
      "-map",
      `0:${chosen.index}`,
      out,
    ]);
  }
}

function audioTracksFromProbe(streams: FfprobeStream[]): AudioTrackMeta[] {
  return streams
    .filter((s) => s.codec_type === "audio")
    .map((s, idx) => {
      const lang = (s.tags?.language || "und").toLowerCase();
      const title = s.tags?.title;
      return {
        index: s.index,
        lang,
        label: langLabel(lang, idx + 1, title),
        codec: s.codec_name,
        channels: s.channels,
      };
    });
}

const indexing = new Set<string>();
const hlsJobs = new Map<string, { status: "running" | "done" | "error"; message?: string }>();

export function getHlsJob(filename: string) {
  return hlsJobs.get(filename) ?? null;
}

/** Apply a TMDB hit: title, overview, official poster. */
export async function applyTmdbMatch(
  filename: string,
  hit: TmdbMovieHit,
): Promise<void> {
  let poster: string | null = null;
  if (hit.poster_path) {
    poster = await downloadTmdbPoster(filename, hit.poster_path);
  }
  const year = hit.release_date?.slice(0, 4);
  const title = year ? `${hit.title} (${year})` : hit.title;
  await upsertEntry(filename, {
    title: title.slice(0, 140),
    description: (hit.overview || "").slice(0, 2000),
    tmdbId: hit.id,
    metadataSource: "tmdb",
    ...(poster ? { poster } : {}),
  });
}

export async function indexMedia(filename: string): Promise<void> {
  if (indexing.has(filename)) return;
  indexing.add(filename);
  try {
    const videoPath = path.join(config.mediaDir, filename);
    if (!existsSync(videoPath)) return;

    const probe = await probeFile(videoPath);
    const streams = probe.streams ?? [];
    const audioTracks = audioTracksFromProbe(streams);
    const prev = await getEntry(filename);
    await extractTextSubtitles(filename, videoPath, streams);

    const stem = filename.replace(/\.[^.]+$/, "");
    const hlsReady = existsSync(
      path.join(config.mediaDir, `${stem}.hls`, "master.m3u8"),
    );

    // Jellyfin-style: match TMDB from filename unless user locked manual metadata
    let tmdbHit: TmdbMovieHit | null = null;
    if (hasTmdb() && prev.metadataSource !== "manual") {
      try {
        tmdbHit = await matchMovieFromFilename(filename);
      } catch (err) {
        console.warn("TMDB match failed", filename, err);
      }
    }
    if (tmdbHit) {
      await applyTmdbMatch(filename, tmdbHit);
    } else {
      const poster =
        prev.poster && existsSync(path.join(config.mediaDir, prev.poster))
          ? prev.poster
          : await ensurePoster(filename, videoPath);
      await upsertEntry(filename, {
        poster: poster ?? prev.poster,
        ...(poster && !prev.metadataSource
          ? { metadataSource: "frame" as const }
          : {}),
      });
    }

    await upsertEntry(filename, {
      audioTracks,
      preferredAudio: prev.preferredAudio ?? audioTracks[0]?.index ?? null,
      indexedAt: Date.now(),
      hlsReady,
    });
  } finally {
    indexing.delete(filename);
  }
}

/** Prepare browser-friendly HLS with all audio tracks (H.264/AAC). */
export function prepareHls(filename: string): void {
  if (hlsJobs.get(filename)?.status === "running") return;
  hlsJobs.set(filename, { status: "running" });

  void (async () => {
    try {
      const videoPath = path.join(config.mediaDir, filename);
      const stem = filename.replace(/\.[^.]+$/, "");
      const outDir = path.join(config.mediaDir, `${stem}.hls`);
      await fs.mkdir(outDir, { recursive: true });

      const probe = await probeFile(videoPath);
      const audio = (probe.streams ?? []).filter((s) => s.codec_type === "audio");
      if (!audio.length) throw new Error("Aucune piste audio");

      // Single-quality HLS, all audio mapped. Keep it light for CX23.
      const args = [
        "-y",
        "-i",
        videoPath,
        "-map",
        "0:v:0",
        ...audio.flatMap((_, i) => ["-map", `0:a:${i}`]),
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "22",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "aac",
        "-b:a",
        "160k",
        "-ac",
        "2",
        "-f",
        "hls",
        "-hls_time",
        "4",
        "-hls_playlist_type",
        "vod",
        "-hls_flags",
        "independent_segments",
        "-master_pl_name",
        "master.m3u8",
        "-var_stream_map",
        `v:0,a:0${audio.length > 1 ? audio.slice(1).map((_, i) => ` a:${i + 1}`).join("") : ""}`,
        path.join(outDir, "stream_%v.m3u8"),
      ];

      // Encode-while-watching: EVENT playlist grows; clients can play as segs appear.
      // Prefer English audio when present (index 2 on Multi Hotel Transylvania).
      const entry = await getEntry(filename);
      const audioIdx =
        entry.preferredAudio != null ? entry.preferredAudio : 0;

      const simpleArgs = [
        "-y",
        "-i",
        videoPath,
        "-map",
        "0:v:0",
        "-map",
        `0:a:${audioIdx}`,
        "-c:v",
        "libx264",
        "-preset",
        "ultrafast",
        "-crf",
        "23",
        "-pix_fmt",
        "yuv420p",
        "-vf",
        "scale=-2:720",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-ac",
        "2",
        "-f",
        "hls",
        "-hls_time",
        "6",
        "-hls_list_size",
        "0",
        "-hls_playlist_type",
        "event",
        "-hls_flags",
        "independent_segments",
        "-hls_segment_filename",
        path.join(outDir, "seg_%05d.ts"),
        path.join(outDir, "master.m3u8"),
      ];

      void args;
      const { code, stderr } = await run("ffmpeg", simpleArgs);
      if (code !== 0) throw new Error(stderr.slice(-400) || "ffmpeg failed");

      await upsertEntry(filename, { hlsReady: true });
      hlsJobs.set(filename, { status: "done" });
    } catch (err) {
      hlsJobs.set(filename, {
        status: "error",
        message: err instanceof Error ? err.message : "error",
      });
    }
  })();
}
