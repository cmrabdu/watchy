import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { config } from "./config.js";

const VIDEO_EXTS = new Set([".mp4", ".webm", ".mkv", ".m4v"]);
const SUB_EXTS = new Set([".vtt", ".srt"]);

export function sanitizeUploadName(raw: string): string | null {
  const base = path.basename(raw).replace(/[^\w.\- ()[\]]+/g, "_").trim();
  if (!base || base === "." || base === "..") return null;
  const ext = path.extname(base).toLowerCase();
  if (!VIDEO_EXTS.has(ext) && !SUB_EXTS.has(ext)) return null;
  if (base.length > 180) return null;
  return base;
}

export async function saveUploadStream(
  filename: string,
  body: ReadableStream<Uint8Array> | null,
): Promise<{ filename: string; size: number }> {
  if (!body) throw new Error("Empty body");
  await fsp.mkdir(config.mediaDir, { recursive: true });
  const dest = path.join(config.mediaDir, filename);
  const tmp = `${dest}.${Date.now()}.part`;

  const nodeReadable = Readable.fromWeb(body as import("node:stream/web").ReadableStream);
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
    return { filename, size };
  } catch (err) {
    await fsp.unlink(tmp).catch(() => undefined);
    throw err;
  }
}
