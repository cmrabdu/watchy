import { nanoid } from "nanoid";
import { readJson, withLock, writeJsonAtomic } from "./store.js";

const FILE = "watchlist.json";

export type WatchlistItem = {
  id: string;
  tmdbId: number | null;
  title: string;
  year: string | null;
  overview: string;
  /** Absolute TMDB image URL — no video file needed for a wish. */
  posterUrl: string | null;
  addedBy: string;
  addedAt: number;
  /** Soft delete: the file is append-only, removals are tombstones. */
  removedAt?: number;
  removedBy?: string;
};

type WatchlistFile = {
  version: 1;
  items: WatchlistItem[];
};

const empty = (): WatchlistFile => ({ version: 1, items: [] });

async function load(): Promise<WatchlistFile> {
  const raw = await readJson<WatchlistFile>(FILE, empty());
  return Array.isArray(raw.items) ? raw : empty();
}

/** Active wishes, newest first. */
export async function listWatchlist(): Promise<WatchlistItem[]> {
  const data = await load();
  return data.items
    .filter((it) => !it.removedAt)
    .sort((a, b) => b.addedAt - a.addedAt);
}

export type NewWatchlistItem = {
  tmdbId: number | null;
  title: string;
  year?: string | null;
  overview?: string;
  posterUrl?: string | null;
};

export async function addToWatchlist(
  input: NewWatchlistItem,
  addedBy: string,
): Promise<{ item: WatchlistItem; already: boolean }> {
  return withLock(FILE, async () => {
    const data = await load();
    if (input.tmdbId != null) {
      const dup = data.items.find(
        (it) => !it.removedAt && it.tmdbId === input.tmdbId,
      );
      if (dup) return { item: dup, already: true };
    }
    const item: WatchlistItem = {
      id: nanoid(10),
      tmdbId: input.tmdbId,
      title: input.title.slice(0, 140),
      year: input.year ?? null,
      overview: (input.overview ?? "").slice(0, 2000),
      posterUrl: input.posterUrl ?? null,
      addedBy,
      addedAt: Date.now(),
    };
    data.items.push(item);
    await writeJsonAtomic(FILE, data);
    return { item, already: false };
  });
}

export async function removeFromWatchlist(
  id: string,
  removedBy: string,
): Promise<boolean> {
  return withLock(FILE, async () => {
    const data = await load();
    const item = data.items.find((it) => it.id === id && !it.removedAt);
    if (!item) return false;
    item.removedAt = Date.now();
    item.removedBy = removedBy;
    await writeJsonAtomic(FILE, data);
    return true;
  });
}
