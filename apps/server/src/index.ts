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
import { setProgress } from "./progress.js";
import { resolveSubtitlePath, srtToVtt } from "./subtitles.js";
import { room, type ClientMessage, type ServerMessage } from "./sync.js";
import {
  getTmdbMovie,
  hasTmdb,
  saveUploadedPoster,
  searchTmdbMovies,
} from "./tmdb.js";
import { sanitizeUploadName, saveUploadStream } from "./upload.js";

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

app.get("/api/health", (c) =>
  c.json({ ok: true, peers: room.peerCount(), peersList: room.peerNames() }),
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
    peers: room.peerNames(),
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
    const saved = await saveUploadStream(name, c.req.raw.body);
    const isVideo = /\.(mp4|webm|mkv|m4v)$/i.test(saved.filename);
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
  await fsp.unlink(resolved.moviePath);
  await removeEntry(resolved.filename);
  return c.json({ ok: true });
});

// Persist watch progress from sync controls (shared couple resume)
room.setProgressHandler((movieId, mediaTime, by) => {
  try {
    const filename = Buffer.from(movieId, "base64url").toString("utf8");
    void setProgress(movieId, filename, mediaTime, by);
  } catch {
    /* ignore bad id */
  }
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

const wss = new WebSocketServer({ server, path: "/ws" });

wss.on("connection", (socket: WebSocket, req) => {
  const session = readSessionFromCookieValue(
    cookieFromHeader(req.headers.cookie, SESSION_COOKIE),
  );
  const peerId = nanoid();

  if (!session) {
    socket.send(JSON.stringify({ type: "error", message: "Unauthorized" } satisfies ServerMessage));
    socket.close();
    return;
  }

  const send = (msg: ServerMessage) => {
    if (socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(msg));
    }
  };

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
    room.disconnect(peerId);
  });
});
