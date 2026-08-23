import fsp from "node:fs/promises";
import path from "node:path";
import { existsSync } from "node:fs";
import { getEntry, posterUrl } from "./catalog.js";
import { config } from "./config.js";
import { readJson, withLock, writeJsonAtomic } from "./store.js";
import type { SessionReaction, WatchSessionEvent } from "./sync.js";

const FILE = "history.json";
/**
 * Two stretches of the same film closer than this are one evening: a pause for
 * tea, or a 4G drop, must not become two rows.
 */
const SAME_EVENING_GAP_MS = 90 * 60 * 1000;

/** One continuous stretch, exactly as the sync room measured it. */
export type HistorySession = {
  id: string;
  movieId: string;
  filename: string;
  title: string;
  /** Local snapshot, deliberately decoupled from the film's own poster. */
  poster: string | null;
  tmdbId: number | null;
  startedAt: number;
  endedAt: number;
  togetherSeconds: number;
  peers: string[];
  reactions: SessionReaction[];
  note?: string;
};

/** What the client shows: stretches of the same night folded together. */
export type HistoryEvening = {
  id: string;
  movieId: string;
  title: string;
  posterUrl: string | null;
  tmdbId: number | null;
  startedAt: number;
  endedAt: number;
  togetherSeconds: number;
  peers: string[];
  reactions: SessionReaction[];
  note: string | null;
};

type HistoryFile = { version: 1; sessions: HistorySession[] };

const empty = (): HistoryFile => ({ version: 1, sessions: [] });

async function load(): Promise<HistoryFile> {
  const raw = await readJson<HistoryFile>(FILE, empty());
  return Array.isArray(raw.sessions) ? raw : empty();
}

/**
 * Copy the film's poster under a name of our own. Freeing disk space by
 * deleting a 4 GB film must never erase the memory of the night they watched it.
 */
async function snapshotPoster(
  sessionId: string,
  entryPoster: string | null,
): Promise<string | null> {
  const target = `posters/soiree-${sessionId}.jpg`;
  const targetPath = path.join(config.mediaDir, target);
  if (existsSync(targetPath)) return target;
  if (!entryPoster) return null;
  const source = path.join(config.mediaDir, entryPoster);
  if (!existsSync(source)) return null;
  try {
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.copyFile(source, targetPath);
    return target;
  } catch {
    return null;
  }
}

/** Upsert by session id: the room flushes the same evening as it goes. */
export async function recordSession(ev: WatchSessionEvent): Promise<void> {
  await withLock(FILE, async () => {
    const data = await load();
    let filename = "";
    try {
      filename = Buffer.from(ev.movieId, "base64url").toString("utf8");
    } catch {
      filename = "";
    }
    const meta = filename ? await getEntry(filename) : null;
    const existing = data.sessions.find((s) => s.id === ev.id);
    const poster =
      existing?.poster ?? (await snapshotPoster(ev.id, meta?.poster ?? null));

    const session: HistorySession = {
      id: ev.id,
      movieId: ev.movieId,
      filename,
      title: existing?.title ?? meta?.title ?? filename,
      poster,
      tmdbId: existing?.tmdbId ?? meta?.tmdbId ?? null,
      startedAt: existing?.startedAt ?? ev.startedAt,
      endedAt: ev.endedAt,
      togetherSeconds: Math.max(existing?.togetherSeconds ?? 0, ev.togetherSeconds),
      peers: [...new Set([...(existing?.peers ?? []), ...ev.peers])],
      reactions: ev.reactions.length ? ev.reactions : (existing?.reactions ?? []),
      ...(existing?.note ? { note: existing.note } : {}),
    };

    if (existing) {
      data.sessions[data.sessions.indexOf(existing)] = session;
    } else {
      data.sessions.push(session);
    }
    await writeJsonAtomic(FILE, data);
  });
}

export async function listEvenings(): Promise<HistoryEvening[]> {
  const data = await load();
  const sessions = [...data.sessions].sort((a, b) => a.startedAt - b.startedAt);
  const evenings: HistoryEvening[] = [];

  for (const s of sessions) {
    const prev = evenings[evenings.length - 1];
    if (
      prev &&
      prev.movieId === s.movieId &&
      s.startedAt - prev.endedAt < SAME_EVENING_GAP_MS
    ) {
      prev.endedAt = Math.max(prev.endedAt, s.endedAt);
      prev.togetherSeconds += s.togetherSeconds;
      prev.peers = [...new Set([...prev.peers, ...s.peers])];
      prev.reactions = [...prev.reactions, ...s.reactions].sort(
        (a, b) => a.mediaTime - b.mediaTime,
      );
      prev.note = prev.note ?? s.note ?? null;
      if (!prev.posterUrl && s.poster) prev.posterUrl = posterUrl(s.poster);
      continue;
    }
    evenings.push({
      id: s.id,
      movieId: s.movieId,
      title: s.title,
      posterUrl: posterUrl(s.poster),
      tmdbId: s.tmdbId,
      startedAt: s.startedAt,
      endedAt: s.endedAt,
      togetherSeconds: s.togetherSeconds,
      peers: [...s.peers],
      reactions: [...s.reactions].sort((a, b) => a.mediaTime - b.mediaTime),
      note: s.note ?? null,
    });
  }

  return evenings.reverse();
}

export async function setEveningNote(
  id: string,
  note: string,
): Promise<boolean> {
  return withLock(FILE, async () => {
    const data = await load();
    const session = data.sessions.find((s) => s.id === id);
    if (!session) return false;
    const trimmed = note.trim().slice(0, 500);
    if (trimmed) session.note = trimmed;
    else delete session.note;
    await writeJsonAtomic(FILE, data);
    return true;
  });
}
