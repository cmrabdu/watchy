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
import { audioTracksFromMeta, readHlsMeta } from "./hlsmeta.js";

type FfprobeStream = {
  index: number;
  codec_type?: string;
  codec_name?: string;
  channels?: number;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  tags?: Record<string, string>;
  disposition?: Record<string, number>;
};

type FfprobeJson = {
  streams?: FfprobeStream[];
  format?: { duration?: string };
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
    "-show_format",
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
  // A film shipped as a ladder only has no source to probe: its metadata comes
  // from the descriptor the encoder wrote, and from TMDB by name.
  if (filename.endsWith(".hls")) return indexHlsFolder(filename);
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

/** Metadata for a film that exists on the server only as a .hls folder. */
async function indexHlsFolder(virtualName: string): Promise<void> {
  if (indexing.has(virtualName)) return;
  indexing.add(virtualName);
  try {
    const stem = virtualName.slice(0, -".hls".length);
    const master = path.join(config.mediaDir, virtualName, "master.m3u8");
    if (!existsSync(master)) return;

    const prev = await getEntry(virtualName);
    const meta = await readHlsMeta(stem);
    const audioTracks = meta ? audioTracksFromMeta(meta) : prev.audioTracks;

    let tmdbHit: TmdbMovieHit | null = null;
    if (hasTmdb() && prev.metadataSource !== "manual") {
      try {
        // Match on the original filename when we know it, else on the stem.
        tmdbHit = await matchMovieFromFilename(meta?.source || `${stem}.mkv`);
      } catch (err) {
        console.warn("TMDB match failed", virtualName, err);
      }
    }
    if (tmdbHit) {
      await applyTmdbMatch(virtualName, tmdbHit);
    } else {
      const poster =
        prev.poster && existsSync(path.join(config.mediaDir, prev.poster))
          ? prev.poster
          : // ffmpeg reads the playlist directly — no source file needed.
            await ensurePoster(virtualName, master);
      await upsertEntry(virtualName, {
        poster: poster ?? prev.poster,
        ...(poster && !prev.metadataSource
          ? { metadataSource: "frame" as const }
          : {}),
      });
    }

    await upsertEntry(virtualName, {
      audioTracks,
      preferredAudio: prev.preferredAudio ?? audioTracks[0]?.index ?? null,
      indexedAt: Date.now(),
      hlsReady: true,
    });
  } finally {
    indexing.delete(virtualName);
  }
}

/**
 * HLS ladder — the encoding that was built and then thrown away.
 *
 * The old code assembled a correct `args` array (native resolution, veryfast,
 * CRF 22, every audio track) then did `void args;` and ran `simpleArgs`
 * instead: ultrafast, CRF 23, scale=-2:720, one audio track. Every MKV was
 * watched in 720p ultrafast while the owner believed he was at full quality.
 *
 * This is the real ladder now, and it is the same one scripts/transcode-hls.sh
 * produces, so a film encoded upstream and one encoded here behave alike.
 */

export type LadderRung = {
  height: number;
  videoKbps: number;
  maxKbps: number;
  bufKbps: number;
};

/** Never upscale: a 720p source gets 720p and 480p, not a fake 1080p rung. */
export function ladderFor(sourceHeight: number): LadderRung[] {
  const rungs: LadderRung[] = [];
  if (sourceHeight >= 1080)
    rungs.push({ height: 1080, videoKbps: 5000, maxKbps: 5350, bufKbps: 7500 });
  if (sourceHeight >= 720)
    rungs.push({ height: 720, videoKbps: 2800, maxKbps: 3000, bufKbps: 4200 });
  if (sourceHeight >= 480 || !rungs.length)
    rungs.push({ height: 480, videoKbps: 1200, maxKbps: 1300, bufKbps: 1800 });
  return rungs;
}

export function buildLadderArgs(opts: {
  videoPath: string;
  outDir: string;
  rungs: LadderRung[];
  audioCount: number;
  audioLangs: string[];
  fps: number;
  preset: string;
  segmentSeconds: number;
}): string[] {
  const { videoPath, outDir, rungs, audioCount, audioLangs, fps, preset } = opts;
  const seg = opts.segmentSeconds;
  const gop = Math.max(1, Math.round(fps * seg));

  const args: string[] = ["-y", "-i", videoPath];
  args.push(
    "-filter_complex",
    rungs
      .map((r, i) => `[0:v]scale=-2:${r.height}:flags=bicubic[v${i}]`)
      .join(";"),
  );

  const varMap: string[] = [];
  rungs.forEach((r, i) => {
    args.push("-map", `[v${i}]`);
    args.push(
      `-c:v:${i}`, "libx264",
      "-preset", preset,
      `-profile:v:${i}`, "high",
      "-pix_fmt", "yuv420p",
      // Pinned GOP and no scene-cut keyframes: every rung cuts at the same
      // instant, which is what lets hls.js switch rungs without shifting the
      // timeline — and therefore without desynchronising the two of them.
      `-g:v:${i}`, String(gop),
      `-keyint_min:v:${i}`, String(gop),
      `-sc_threshold:v:${i}`, "0",
      `-force_key_frames:v:${i}`, `expr:gte(t,n_forced*${seg})`,
      `-b:v:${i}`, `${r.videoKbps}k`,
      `-maxrate:v:${i}`, `${r.maxKbps}k`,
      `-bufsize:v:${i}`, `${r.bufKbps}k`,
    );
    varMap.push(`v:${i},agroup:aud,name:${r.height}p`);
  });

  // Every audio track survives as a rendition shared by all rungs.
  for (let a = 0; a < audioCount; a += 1) {
    args.push("-map", `0:a:${a}`, `-c:a:${a}`, "aac", `-ac:a:${a}`, "2", `-b:a:${a}`, "128k");
    const lang = audioLangs[a] || "und";
    varMap.push(
      `a:${a},agroup:aud,name:${lang}_${a},language:${lang},default:${a === 0 ? "YES" : "NO"}`,
    );
  }

  args.push(
    "-f", "hls",
    "-hls_time", String(seg),
    "-hls_playlist_type", "vod",
    "-hls_flags", "independent_segments",
    "-hls_segment_type", "mpegts",
    "-hls_segment_filename", path.join(outDir, "stream_%v", "seg_%05d.ts"),
    "-master_pl_name", "master.m3u8",
    "-var_stream_map", varMap.join(" "),
    path.join(outDir, "stream_%v", "index.m3u8"),
  );
  return args;
}

export type PrepareOptions = {
  /**
   * Must be set explicitly. Encoding on the CX22 (2 vCPU) takes hours for a
   * two-hour film, competes with playback and fills a 40 GB disk — it is an
   * acknowledged fallback, never a silent default.
   */
  allowServerEncode: boolean;
  preset?: string;
  maxHeight?: number;
};

export class ServerEncodeRefused extends Error {
  constructor() {
    super(
      "Encodage serveur refusé : encodez sur votre machine avec " +
        "scripts/transcode-hls.sh puis scripts/publish-hls.sh. Pour forcer " +
        "malgré les 2 vCPU du VPS, renvoyez la requête avec {\"force\":true}.",
    );
    this.name = "ServerEncodeRefused";
  }
}

export function prepareHls(filename: string, opts: PrepareOptions): void {
  if (!opts.allowServerEncode) throw new ServerEncodeRefused();
  if (hlsJobs.get(filename)?.status === "running") return;
  hlsJobs.set(filename, { status: "running" });

  void (async () => {
    try {
      const videoPath = path.join(config.mediaDir, filename);
      const stem = filename.replace(/\.[^.]+$/, "");
      const outDir = path.join(config.mediaDir, `${stem}.hls`);
      await fs.mkdir(outDir, { recursive: true });

      const probe = await probeFile(videoPath);
      const streams = probe.streams ?? [];
      const audio = streams.filter((s) => s.codec_type === "audio");
      if (!audio.length) throw new Error("Aucune piste audio");
      const video = streams.find((s) => s.codec_type === "video");

      let height = Number(video?.height ?? 1080);
      if (!Number.isFinite(height) || height <= 0) height = 1080;
      if (opts.maxHeight && height > opts.maxHeight) height = opts.maxHeight;

      const fps = parseFps(video?.r_frame_rate);
      const rungs = ladderFor(height);
      const segmentSeconds = 4;

      const args = buildLadderArgs({
        videoPath,
        outDir,
        rungs,
        audioCount: audio.length,
        audioLangs: audio.map((s) => (s.tags?.language || "und").toLowerCase()),
        fps,
        preset: opts.preset ?? "veryfast",
        segmentSeconds,
      });

      const { code, stderr } = await run("ffmpeg", args);
      if (code !== 0) throw new Error(stderr.slice(-400) || "ffmpeg failed");

      // Same descriptor as the script, so both paths look identical to the server.
      const duration = Number(probe.format?.duration ?? 0);
      await fs.writeFile(
        path.join(outDir, "watchy.json"),
        JSON.stringify(
          {
            version: 1,
            stem,
            source: filename,
            duration,
            sourceHeight: height,
            segmentSeconds,
            variants: rungs.map((r) => r.height),
            audioTracks: audio.map((s, i) => ({
              index: i,
              lang: (s.tags?.language || "und").toLowerCase(),
              title: s.tags?.title ?? "",
              codec: s.codec_name ?? "aac",
            })),
            encodedAt: Date.now(),
          },
          null,
          2,
        ),
      );

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

function parseFps(raw: string | undefined): number {
  if (!raw) return 25;
  const [num, den] = raw.split("/").map(Number);
  if (!num) return 25;
  const fps = den ? num / den : num;
  return Number.isFinite(fps) && fps > 0 ? Math.round(fps) : 25;
}
