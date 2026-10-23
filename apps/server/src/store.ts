import fs from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { config } from "./config.js";

/**
 * Small JSON files living next to the media (watchlist, history).
 * Same shape as progress.ts/catalog.ts: read-modify-write through a temp file
 * so a crash mid-write cannot leave a truncated file behind.
 */

export function mediaFile(name: string): string {
  return path.join(config.mediaDir, name);
}

export async function readJson<T>(name: string, fallback: T): Promise<T> {
  const file = mediaFile(name);
  if (!existsSync(file)) return fallback;
  try {
    return JSON.parse(await fs.readFile(file, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export async function writeJsonAtomic(name: string, data: unknown): Promise<void> {
  await fs.mkdir(config.mediaDir, { recursive: true });
  const file = mediaFile(name);
  const tmp = `${file}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2));
  await fs.rename(tmp, file);
}

/**
 * Serialise writes per file. Both peers hit these endpoints from two
 * continents; a read-modify-write race would silently drop an entry.
 */
const queues = new Map<string, Promise<unknown>>();

export function withLock<T>(name: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  queues.set(
    name,
    next.catch(() => undefined),
  );
  return next;
}
