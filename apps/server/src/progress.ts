import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";

export type WatchProgress = {
  movieId: string;
  filename: string;
  mediaTime: number;
  updatedAt: number;
  updatedBy: string | null;
};

type ProgressFile = {
  version: 1;
  byMovieId: Record<string, WatchProgress>;
};

function progressPath() {
  return path.join(config.mediaDir, "progress.json");
}

async function load(): Promise<ProgressFile> {
  const file = progressPath();
  if (!existsSync(file)) return { version: 1, byMovieId: {} };
  try {
    const raw = JSON.parse(await fs.readFile(file, "utf8")) as ProgressFile;
    return raw.byMovieId ? raw : { version: 1, byMovieId: {} };
  } catch {
    return { version: 1, byMovieId: {} };
  }
}

async function save(data: ProgressFile) {
  await fs.mkdir(config.mediaDir, { recursive: true });
  const tmp = `${progressPath()}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, progressPath());
}

export async function getProgress(movieId: string): Promise<WatchProgress | null> {
  const data = await load();
  return data.byMovieId[movieId] ?? null;
}

export async function listProgress(): Promise<Record<string, WatchProgress>> {
  return (await load()).byMovieId;
}

export async function setProgress(
  movieId: string,
  filename: string,
  mediaTime: number,
  updatedBy: string | null,
): Promise<WatchProgress> {
  const data = await load();
  const prev = data.byMovieId[movieId];
  const next: WatchProgress = {
    movieId,
    filename,
    mediaTime: Math.max(0, mediaTime),
    updatedAt: Date.now(),
    updatedBy,
  };
  // Don't wipe a solid resume point with a near-zero scrub/join glitch
  if (prev && next.mediaTime < 20 && prev.mediaTime > 60) {
    return prev;
  }
  data.byMovieId[movieId] = next;
  await save(data);
  return next;
}

export async function clearProgress(movieId: string): Promise<void> {
  const data = await load();
  delete data.byMovieId[movieId];
  await save(data);
}
