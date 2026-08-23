import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { Hono } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { cors } from "hono/cors";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import type { Server as HttpServer } from "node:http";
import { nanoid } from "nanoid";
import { WebSocketServer, type WebSocket } from "ws";
import {
  SESSION_COOKIE,
  findUser,
  signSession,
  verifyPassword,
  verifySession,
} from "./auth.js";
import { config, type Role } from "./config.js";
import { removeEntry, upsertEntry } from "./catalog.js";
import {
  applyTmdbMatch,
  getHlsJob,
  indexMedia,
  prepareHls,
} from "./indexer.js";
import {
  listMovies,
  openRangeStream,
  resolveMediaRelative,
  resolveMoviePath,
} from "./media.js";
import { getProgress, setProgress } from "./progress.js";
import { listSubtitles, resolveSubtitlePath, srtToVtt } from "./subtitles.js";
import { room, type ClientMessage, type ServerMessage } from "./sync.js";
import {
  getTmdbMovie,
  hasTmdb,
  saveUploadedPoster,
  searchTmdbMovies,
} from "./tmdb.js";
import { isVideoName, sanitizeUploadName, saveUploadStream } from "./upload.js";

type Vars = { username: string; role: Role };

const app = new Hono<{ Variables: Vars }>();

app.use(
  "*",
  cors({
    origin: (origin) => origin || config.publicOrigin,
    credentials: true,
  }),
);

function cookieFromHeader(cookieHeader: string | undefined, name: string) {
  if (!cookieHeader) return undefined;
  const parts = cookieHeader.split(";").map((p) => p.trim());
  for (const part of parts) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    if (part.slice(0, eq) === name) return decodeURIComponent(part.slice(eq + 1));
  }
  return undefined;
}

function readSessionFromCookieValue(cookie: string | undefined) {
  return verifySession(cookie);
}

const requireAuth = async (
  c: {
    req: { header: (n: string) => string | undefined };
    json: (data: unknown, status?: number) => Response;
    set: (k: keyof Vars, v: string) => void;
  },
  next: () => Promise<void>,
) => {
  const session = readSessionFromCookieValue(getCookie(c as never, SESSION_COOKIE));
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  c.set("username", session.u);
  c.set("role", session.role);
  await next();
};

const requireAdmin = async (
  c: {
    get: (k: keyof Vars) => string;
    json: (data: unknown, status?: number) => Response;
  },
  next: () => Promise<void>,
) => {
  if (c.get("role") !== "admin") {
    return c.json({ error: "Admin uniquement" }, 403);
  }
  await next();
};

// Public probe: no peer identities here — it is reachable without a cookie.
app.get("/api/health", (c) => c.json({ ok: true }));

app.get("/api/presence", requireAuth, (c) =>
  c.json({ peerCount: room.peerCount(), peers: room.peerInfos() }),
);

app.get("/api/me", (c) => {
  const session = readSessionFromCookieValue(getCookie(c, SESSION_COOKIE));
  if (!session) return c.json({ user: null });
  return c.json({
    user: { username: session.u, role: session.role },
  });
});

app.post("/api/login", async (c) => {
  const body = await c.req.json<{ username?: string; password?: string }>();
  const username = body.username?.trim() ?? "";
  const password = body.password ?? "";
  const user = findUser(username);
  if (!user || !(await verifyPassword(user, password))) {
    return c.json({ error: "Identifiants invalides" }, 401);
  }
  const token = signSession(user);
  setCookie(c, SESSION_COOKIE, token, {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: "Lax",
    path: "/",
    maxAge: Math.floor(config.sessionTtlMs / 1000),
  });
  return c.json({ user: { username: user.username, role: user.role } });
});

app.post("/api/logout", (c) => {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
  return c.json({ ok: true });
});

app.get("/api/movies", requireAuth, async (c) => {
  const movies = await listMovies();
  return c.json({
    movies,
    // `peers` stays string[] for REST compatibility; `peerInfos` matches the
    // WebSocket contract (PeerInfo[]) and is the one to trust for presence.
    peers: room.peerNames(),
    peerInfos: room.peerInfos(),
    peerCount: room.peerCount(),
    sync: room.getState(),
  });
});

app.get("/api/stream/:id", requireAuth, async (c) => {
  const resolved = resolveMoviePath(c.req.param("id"));
  if (!resolved) return c.json({ error: "Not found" }, 404);
  const range = c.req.header("range");
  const { stream, status, headers } = openRangeStream(resolved.moviePath, range);
  return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
    status,
    headers,
  });
});

app.get("/api/hls/*", requireAuth, async (c) => {
  const rel = c.req.path.replace(/^\/api\/hls\//, "");
  const full = resolveMediaRelative(rel);
  if (!full) return c.json({ error: "Not found" }, 404);
  const range = c.req.header("range");
  const { stream, status, headers } = openRangeStream(full, range);
  return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
    status,
    headers,
  });
});

app.get("/api/subtitles/:trackId", requireAuth, async (c) => {
  const full = resolveSubtitlePath(c.req.param("trackId"));
  if (!full) return c.json({ error: "Not found" }, 404);
  const raw = await fsp.readFile(full, "utf8");
  const isSrt = full.toLowerCase().endsWith(".srt");
  const vtt = isSrt ? srtToVtt(raw) : raw.startsWith("WEBVTT") ? raw : `WEBVTT\n\n${raw}`;
  return new Response(vtt, {
    headers: {
      "Content-Type": "text/vtt; charset=utf-8",
      "Cache-Control": "private, max-age=3600",
    },
  });
});

app.put("/api/upload", requireAuth, requireAdmin, async (c) => {
  const name = sanitizeUploadName(c.req.query("name") ?? "");
  if (!name) {
    return c.json(
      { error: "Nom de fichier invalide (mp4/webm/mkv/m4v/vtt/srt)" },
      400,
    );
  }
  try {
    // Video: never clobber — a same-named upload used to silently destroy a
    // file that might be playing right now. Subtitles: replacing is the point.
    const saved = await saveUploadStream(
      name,
      c.req.raw.body,
      isVideoName(name) ? "suffix" : "overwrite",
    );
    const isVideo = isVideoName(saved.filename);
    if (isVideo) {
      void indexMedia(saved.filename).catch((err) =>
        console.error("index failed", saved.filename, err),
      );
    }
    return c.json({ ok: true, ...saved });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Upload failed";
    return c.json({ error: message }, 400);
  }
});

app.patch("/api/movies/:id", requireAuth, requireAdmin, async (c) => {
  const resolved = resolveMoviePath(c.req.param("id"));
  if (!resolved) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{
    title?: string;
    description?: string;
    preferredAudio?: number | null;
  }>();
  const patch: {
    title?: string;
    description?: string;
    preferredAudio?: number | null;
    metadataSource?: "manual";
  } = {};
  if (typeof body.title === "string" && body.title.trim()) {
    patch.title = body.title.trim().slice(0, 140);
    patch.metadataSource = "manual";
  }
  if (typeof body.description === "string") {
    patch.description = body.description.trim().slice(0, 2000);
    patch.metadataSource = "manual";
  }
  if (body.preferredAudio === null || typeof body.preferredAudio === "number") {
    patch.preferredAudio = body.preferredAudio;
  }
  const entry = await upsertEntry(resolved.filename, patch);
  return c.json({ ok: true, entry });
});

app.post("/api/movies/:id/index", requireAuth, requireAdmin, async (c) => {
  const resolved = resolveMoviePath(c.req.param("id"));
  if (!resolved) return c.json({ error: "Not found" }, 404);
  // Allow re-match even if previously manual: wipe lock for this scan
  await upsertEntry(resolved.filename, { metadataSource: null });
  await indexMedia(resolved.filename);
  return c.json({ ok: true, tmdb: hasTmdb() });
});

app.get("/api/tmdb/status", requireAuth, (c) =>
  c.json({ configured: hasTmdb() }),
);

app.get("/api/tmdb/search", requireAuth, requireAdmin, async (c) => {
  if (!hasTmdb()) {
    return c.json({ error: "TMDB_API_KEY non configurée" }, 503);
  }
  const q = String(c.req.query("q") ?? "").trim();
  const yearRaw = c.req.query("year");
  const year = yearRaw ? Number(yearRaw) : null;
  if (q.length < 2) return c.json({ results: [] });
  try {
    const results = await searchTmdbMovies(q, year && !Number.isNaN(year) ? year : null);
    return c.json({
      results: results.slice(0, 12).map((r) => ({
        id: r.id,
        title: r.title,
        year: r.release_date?.slice(0, 4) ?? null,
        overview: r.overview,
        posterUrl: r.poster_path
          ? `https://image.tmdb.org/t/p/w185${r.poster_path}`
          : null,
      })),
    });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "TMDB error" },
      502,
    );
  }
});

app.post("/api/movies/:id/tmdb", requireAuth, requireAdmin, async (c) => {
  if (!hasTmdb()) {
    return c.json({ error: "TMDB_API_KEY non configurée" }, 503);
  }
  const resolved = resolveMoviePath(c.req.param("id"));
  if (!resolved) return c.json({ error: "Not found" }, 404);
  const body = await c.req.json<{ tmdbId?: number }>();
  const tmdbId = Number(body.tmdbId);
  if (!tmdbId) return c.json({ error: "tmdbId requis" }, 400);
  try {
    const hit = await getTmdbMovie(tmdbId);
    await applyTmdbMatch(resolved.filename, hit);
    return c.json({ ok: true });
  } catch (err) {
    return c.json(
      { error: err instanceof Error ? err.message : "TMDB error" },
      502,
    );
  }
});

app.put("/api/movies/:id/poster", requireAuth, requireAdmin, async (c) => {
  const resolved = resolveMoviePath(c.req.param("id"));
  if (!resolved) return c.json({ error: "Not found" }, 404);
  const ct = c.req.header("content-type") || "";
  if (!ct.includes("image/")) {
    return c.json({ error: "Envoie une image (jpeg/png/webp)" }, 400);
  }
  const buf = Buffer.from(await c.req.arrayBuffer());
  if (buf.length < 1000 || buf.length > 8 * 1024 * 1024) {
    return c.json({ error: "Image invalide (1 Ko – 8 Mo)" }, 400);
  }
  const poster = await saveUploadedPoster(resolved.filename, buf);
  await upsertEntry(resolved.filename, {
    poster,
    metadataSource: "manual",
  });
  return c.json({ ok: true, poster });
});

app.post("/api/movies/:id/prepare", requireAuth, requireAdmin, async (c) => {
  const resolved = resolveMoviePath(c.req.param("id"));
  if (!resolved) return c.json({ error: "Not found" }, 404);
  prepareHls(resolved.filename);
  return c.json({ ok: true, job: getHlsJob(resolved.filename) });
});

app.get("/api/movies/:id/prepare", requireAuth, requireAdmin, async (c) => {
  const resolved = resolveMoviePath(c.req.param("id"));
  if (!resolved) return c.json({ error: "Not found" }, 404);
  return c.json({ job: getHlsJob(resolved.filename) });
});

app.get("/api/posters/:name", requireAuth, async (c) => {
  const name = c.req.param("name");
  if (name.includes("..") || name.includes("/") || name.includes("\\")) {
    return c.json({ error: "Not found" }, 404);
  }
  const full = resolveMediaRelative(`posters/${name}`);
  if (!full) return c.json({ error: "Not found" }, 404);
  const { stream, status, headers } = openRangeStream(full, undefined);
  return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
    status,
    headers,
  });
});

app.delete("/api/movies/:id", requireAuth, requireAdmin, async (c) => {
  const resolved = resolveMoviePath(c.req.param("id"));
  if (!resolved) return c.json({ error: "Not found" }, 404);

  // The .hls ladder is 2–4 GB and the extracted .srt sidecars pile up: deleting
  // only the video left the disk full on a 40 GB VPS.
  const stem = resolved.filename.replace(/\.[^.]+$/, "");
  const removed: string[] = [];
  const freedBefore = await dirSize(path.join(config.mediaDir, `${stem}.hls`));

  const sidecars = await listSubtitles(resolved.filename);
  for (const track of sidecars) {
    const full = path.join(config.mediaDir, track.filename);
    await fsp.unlink(full).catch(() => undefined);
    removed.push(track.filename);
  }

  const hlsDir = path.join(config.mediaDir, `${stem}.hls`);
  if (fs.existsSync(hlsDir)) {
    await fsp.rm(hlsDir, { recursive: true, force: true }).catch(() => undefined);
    removed.push(`${stem}.hls/`);
  }

  await fsp.unlink(resolved.moviePath);
  await removeEntry(resolved.filename);
  return c.json({ ok: true, removed, freedBytes: freedBefore });
});

async function dirSize(dir: string): Promise<number> {
  if (!fs.existsSync(dir)) return 0;
  let total = 0;
  const entries = await fsp.readdir(dir, { withFileTypes: true }).catch(() => []);
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(full);
    else {
      const st = await fsp.stat(full).catch(() => null);
      if (st) total += st.size;
    }
  }
  return total;
}

// Persist watch progress from sync controls (shared couple resume)
room.setProgressHandler((movieId, mediaTime, by) => {
  try {
    const filename = Buffer.from(movieId, "base64url").toString("utf8");
    void setProgress(movieId, filename, mediaTime, by);
  } catch {
    /* ignore bad id */
  }
});

// Cold start / first open: resume where progress.json left off instead of 0:00
room.setResumeHandler(async (movieId) => {
  const prog = await getProgress(movieId).catch(() => null);
  return prog?.mediaTime ?? null;
});

// Index existing library on boot (non-blocking)
void listMovies()
  .then((movies) =>
    Promise.all(
      movies
        .filter(
          (m) =>
            !m.indexedAt ||
            (hasTmdb() && !m.tmdbId && m.metadataSource !== "manual"),
        )
        .map((m) =>
          indexMedia(m.filename).catch((err) =>
            console.error("boot index failed", m.filename, err),
          ),
        ),
    ),
  )
  .catch(() => undefined);

if (fs.existsSync(config.webDistDir)) {
  const relRoot = path.relative(process.cwd(), config.webDistDir) || ".";
  app.use("/assets/*", serveStatic({ root: relRoot }));
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api") || c.req.path === "/ws") {
      return c.json({ error: "Not found" }, 404);
    }
    const index = path.join(config.webDistDir, "index.html");
    if (!fs.existsSync(index)) return c.text("Web UI not built", 404);
    return c.html(fs.readFileSync(index, "utf8"));
  });
}

const server = serve(
  {
    fetch: app.fetch,
    hostname: config.host,
    port: config.port,
  },
  (info) => {
    console.log(`Watch server on http://${info.address}:${info.port}`);
    console.log(`Media dir: ${config.mediaDir}`);
  },
) as HttpServer;

const wss = new WebSocketServer({
  server,
  path: "/ws",
  // Refuse the upgrade *before* the handshake. Accepting it and checking the
  // cookie afterwards let an unauthenticated client reach the frame parser,
  // where a malformed frame raised an 'error' with no listener and killed the
  // process (all in-memory sync state with it).
  verifyClient: (info, done) => {
    const session = readSessionFromCookieValue(
      cookieFromHeader(info.req.headers.cookie, SESSION_COOKIE),
    );
    if (!session) {
      done(false, 401, "Unauthorized");
      return;
    }
    done(true);
  },
});

// An 'error' with no listener on an EventEmitter is an uncaught exception.
wss.on("error", (err) => console.error("wss error", err));

/** Application-level keepalive: sleeping phones never send FIN. */
const PING_MS = 30000;
type Liveness = { alive: boolean; pingAt: number; peerId: string };
const liveness = new Map<WebSocket, Liveness>();

const pinger = setInterval(() => {
  for (const socket of wss.clients) {
    const st = liveness.get(socket);
    if (!st) continue;
    if (!st.alive) {
      // Missed a full cycle: it is a ghost, not a viewer.
      socket.terminate();
      continue;
    }
    st.alive = false;
    st.pingAt = Date.now();
    try {
      socket.ping();
    } catch {
      socket.terminate();
    }
  }
}, PING_MS);
pinger.unref?.();
wss.on("close", () => clearInterval(pinger));

wss.on("connection", (socket: WebSocket, req) => {
  const session = readSessionFromCookieValue(
    cookieFromHeader(req.headers.cookie, SESSION_COOKIE),
  );
  const peerId = nanoid();

  // Never let a socket error escape: ws emits 'error' on malformed frames.
  socket.on("error", () => {
    try {
      socket.terminate();
    } catch {
      /* already gone */
    }
  });

  if (!session) {
    socket.send(
      JSON.stringify({ type: "error", message: "Unauthorized" } satisfies ServerMessage),
    );
    socket.close();
    return;
  }

  const send = (msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) {
      try {
        socket.send(JSON.stringify(msg));
      } catch {
        /* peer went away mid-write */
      }
    }
  };

  liveness.set(socket, { alive: true, pingAt: Date.now(), peerId });
  socket.on("pong", () => {
    const st = liveness.get(socket);
    if (!st) return;
    st.alive = true;
    // Round-trip time feeds latency compensation in the sync room.
    room.setLatency(peerId, Date.now() - st.pingAt);
  });

  room.connect(peerId, session.u, send);

  socket.on("message", (data) => {
    try {
      const msg = JSON.parse(String(data)) as ClientMessage;
      room.handle(peerId, msg);
    } catch {
      send({ type: "error", message: "Bad message" });
    }
  });

  socket.on("close", () => {
    liveness.delete(socket);
    room.disconnect(peerId);
  });
});
