import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mkv", ".m4v"]);
const SUB_EXTS = new Set([".vtt", ".srt"]);

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
