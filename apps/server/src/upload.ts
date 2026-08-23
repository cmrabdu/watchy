import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mkv", ".m4v"]);
const SUB_EXTS = new Set([".vtt", ".srt", ".ass", ".ssa"]);

/**
 * What to do when the destination already exists.
 * - "suffix": keep both, the new one becomes `name (2).ext` — used for video,
 *   where a silent rename could destroy an 8 GB file someone is watching.
 * - "overwrite": replace — used for subtitles, whose exact filename carries the
 *   language convention (`film.ar.srt`) and where re-uploading a fixed file is
 *   the normal workflow.
 */
export type ConflictPolicy = "suffix" | "overwrite" | "reject";

export type SavedUpload = {
  filename: string;
  size: number;
  /** true when an existing file of the same name was replaced */
  replaced: boolean;
};

export function sanitizeUploadName(raw: string): string | null {
  const base = path.basename(raw).replace(/[^\w.\- ()[\]]+/g, "_").trim();
  if (!base || base === "." || base === "..") return null;
  const ext = path.extname(base).toLowerCase();
  if (!VIDEO_EXTS.has(ext) && !SUB_EXTS.has(ext)) return null;
  if (base.length > 180) return null;
  return base;
}

export function isVideoName(filename: string): boolean {
  return VIDEO_EXTS.has(path.extname(filename).toLowerCase());
}

export function isSubtitleName(filename: string): boolean {
  return SUB_EXTS.has(path.extname(filename).toLowerCase());
}

/** `film.mkv` -> `film (2).mkv` -> `film (3).mkv` ... */
function uniqueName(dir: string, filename: string): string {
  const ext = path.extname(filename);
  const stem = filename.slice(0, filename.length - ext.length);
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem} (${n})${ext}`;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  throw new Error("Trop de fichiers de même nom");
}

export async function saveUploadStream(
  filename: string,
  body: ReadableStream<Uint8Array> | null,
  policy: ConflictPolicy = "suffix",
): Promise<SavedUpload> {
  if (!body) throw new Error("Empty body");
  await fsp.mkdir(config.mediaDir, { recursive: true });

  let target = filename;
  let replaced = false;
  const exists = fs.existsSync(path.join(config.mediaDir, filename));
  if (exists) {
    if (policy === "reject") {
      throw new Error(`${filename} existe déjà`);
    }
    if (policy === "suffix") {
      target = uniqueName(config.mediaDir, filename);
    } else {
      replaced = true;
    }
  }

  const dest = path.join(config.mediaDir, target);
  const tmp = `${dest}.${Date.now()}.part`;

  const nodeReadable = Readable.fromWeb(
    body as import("node:stream/web").ReadableStream,
  );
  let size = 0;
  nodeReadable.on("data", (chunk: Buffer) => {
    size += chunk.length;
    if (size > config.maxUploadBytes) {
      nodeReadable.destroy(new Error("File too large"));
    }
  });

  try {
    await pipeline(nodeReadable, fs.createWriteStream(tmp));
    await fsp.rename(tmp, dest);
    return { filename: target, size, replaced };
  } catch (err) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// --- Uploads reprenables -----------------------------------------------------
// An 8 GB film from a Belgian residential line takes 45 to 90 minutes. Losing
// it at 95 % because the link blinked is not acceptable, so the partial file is
// kept and the client asks where to restart.

/** Deterministic, so a resume finds the same partial file. */
export function partPath(filename: string): string {
  return path.join(config.mediaDir, `${filename}.part`);
}

/** Part files currently being written — one writer at a time per name. */
const inFlight = new Set<string>();

export type UploadStatus = {
  /** Bytes already stored: where the client must resume from. */
  offset: number;
  /** A finished file of that name already exists. */
  completed: boolean;
  updatedAt: number | null;
};

export async function uploadStatus(filename: string): Promise<UploadStatus> {
  const part = partPath(filename);
  let offset = 0;
  let updatedAt: number | null = null;
  if (fs.existsSync(part)) {
    const st = await fsp.stat(part);
    offset = st.size;
    updatedAt = st.mtimeMs;
  }
  return {
    offset,
    completed: fs.existsSync(path.join(config.mediaDir, filename)),
    updatedAt,
  };
}

export async function abortUpload(filename: string): Promise<boolean> {
  if (inFlight.has(filename)) throw new Error("Upload en cours");
  const part = partPath(filename);
  if (!fs.existsSync(part)) return false;
  await fsp.unlink(part).catch(() => undefined);
  return true;
}

export type ChunkResult =
  | { complete: false; offset: number }
  | ({ complete: true } & SavedUpload);

/**
 * Append one Content-Range chunk. `start` must equal the bytes already on
 * disk; anything else is a 409 carrying the real offset, never a silent
 * truncation. On error the partial file is kept — that is the whole point.
 */
export async function appendUploadChunk(
  filename: string,
  body: ReadableStream<Uint8Array> | null,
  start: number,
  end: number,
  total: number,
  policy: ConflictPolicy = "suffix",
): Promise<ChunkResult> {
  if (!body) throw new Error("Empty body");
  if (total > config.maxUploadBytes) throw new Error("File too large");
  if (start < 0 || end < start || end >= total) {
    throw new Error("Content-Range invalide");
  }
  if (inFlight.has(filename)) throw new Error("Un envoi est déjà en cours");

  await fsp.mkdir(config.mediaDir, { recursive: true });
  const part = partPath(filename);
  const current = fs.existsSync(part) ? (await fsp.stat(part)).size : 0;
  if (start !== current) {
    const err = new Error(
      `Reprise désalignée: le serveur a ${current} octets`,
    ) as Error & { offset?: number };
    err.offset = current;
    throw err;
  }

  inFlight.add(filename);
  try {
    const nodeReadable = Readable.fromWeb(
      body as import("node:stream/web").ReadableStream,
    );
    let written = 0;
    const expected = end - start + 1;
    nodeReadable.on("data", (chunk: Buffer) => {
      written += chunk.length;
      if (start + written > total) {
        nodeReadable.destroy(new Error("Chunk plus long que Content-Range"));
      }
    });
    // Append, never truncate: a failed chunk must leave the part intact.
    await pipeline(nodeReadable, fs.createWriteStream(part, { flags: "a" }));
    if (written !== expected) {
      throw new Error(
        `Chunk incomplet: ${written} octets recus pour ${expected} annoncés`,
      );
    }

    const size = start + written;
    if (size < total) return { complete: false, offset: size };

    let target = filename;
    let replaced = false;
    if (fs.existsSync(path.join(config.mediaDir, filename))) {
      if (policy === "reject") throw new Error(`${filename} existe déjà`);
      if (policy === "suffix") target = uniqueName(config.mediaDir, filename);
      else replaced = true;
    }
    await fsp.rename(part, path.join(config.mediaDir, target));
    return { complete: true, filename: target, size, replaced };
  } finally {
    inFlight.delete(filename);
  }
}
