import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "watchy-hist-"));
process.env.MEDIA_DIR = dir;
process.env.SESSION_SECRET = "test-secret-abcdefgh";

const { recordSession, listEvenings, setEveningNote } = await import("../dist/history.js");
const { SyncRoom } = await import("../dist/sync.js");
const { listWatchlist, addToWatchlist, removeFromWatchlist } = await import("../dist/watchlist.js");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("12 — la salle mesure le temps regardé ensemble et garde les réactions", async () => {
  const room = new SyncRoom();
  const events = [];
  room.setSessionHandler((ev) => events.push(ev));
  const mk = (id, name) => { room.connect(id, name, () => {}); room.handle(id, { type: "hello", username: name }); };
  mk("a", "lui"); mk("b", "elle");
  room.handle("a", { type: "join", movieId: "FILM" });
  room.handle("b", { type: "join", movieId: "FILM" });
  room.handle("a", { type: "play", mediaTime: 600 });
  await sleep(1200);
  room.handle("b", { type: "reaction", emoji: "❤️" });
  await sleep(400);
  room.handle("a", { type: "leave" });
  room.handle("b", { type: "leave" });
  room.stop();

  assert.equal(events.length, 1, "une soirée close émise");
  const ev = events[0];
  assert.equal(ev.movieId, "FILM");
  assert.ok(ev.togetherSeconds >= 1, `temps ensemble mesuré (${ev.togetherSeconds}s)`);
  assert.deepEqual([...ev.peers].sort(), ["elle", "lui"]);
  assert.equal(ev.reactions.length, 1);
  assert.equal(ev.reactions[0].emoji, "❤️");
  assert.equal(ev.reactions[0].from, "elle");
  assert.ok(ev.reactions[0].mediaTime >= 600, `réaction horodatée dans le film (${ev.reactions[0].mediaTime}s)`);
});

test("12 — le temps seul ne compte pas comme du temps ensemble", async () => {
  const room = new SyncRoom();
  const events = [];
  room.setSessionHandler((ev) => events.push(ev));
  room.connect("a", "lui", () => {});
  room.handle("a", { type: "hello", username: "lui" });
  room.handle("a", { type: "join", movieId: "SEUL" });
  room.handle("a", { type: "play", mediaTime: 0 });
  await sleep(800);
  room.handle("a", { type: "reaction", emoji: "🔥" });
  room.handle("a", { type: "leave" });
  room.stop();
  assert.equal(events[0].togetherSeconds, 0, "regarder seul ne remplit pas Nos soirées");
});

test("12 — l'historique survit à la suppression du film", async () => {
  const movieId = Buffer.from("Film Test.mkv").toString("base64url");
  await recordSession({
    id: "s1", movieId, startedAt: Date.now() - 7200e3, endedAt: Date.now() - 100e3,
    togetherSeconds: 5400, peers: ["lui", "elle"],
    reactions: [{ emoji: "❤️", from: "elle", at: Date.now(), mediaTime: 1200 }],
    closed: true,
  });
  // Le fichier vidéo n'a jamais existé ici : l'entrée doit tenir toute seule.
  const evenings = await listEvenings();
  assert.equal(evenings.length, 1);
  assert.equal(evenings[0].togetherSeconds, 5400);
  assert.equal(evenings[0].reactions[0].mediaTime, 1200);
  assert.ok(fs.existsSync(path.join(dir, "history.json")));

  await setEveningNote("s1", "notre premier film");
  assert.equal((await listEvenings())[0].note, "notre premier film");
});

test("12 — deux tronçons de la même soirée sont regroupés", async () => {
  const movieId = Buffer.from("Suite.mkv").toString("base64url");
  const base = Date.now() - 3 * 3600e3;
  await recordSession({ id: "t1", movieId, startedAt: base, endedAt: base + 1800e3,
    togetherSeconds: 1800, peers: ["lui"], reactions: [], closed: true });
  await recordSession({ id: "t2", movieId, startedAt: base + 1900e3, endedAt: base + 3600e3,
    togetherSeconds: 1700, peers: ["elle"], reactions: [], closed: true });
  const ev = (await listEvenings()).find((e) => e.id === "t1");
  assert.ok(ev, "regroupé sous le premier tronçon");
  assert.equal(ev.togetherSeconds, 3500, "les durées s'additionnent");
  assert.deepEqual([...ev.peers].sort(), ["elle", "lui"]);
});

test("11 — watchlist: ajout, doublon, listing, retrait", async () => {
  const a = await addToWatchlist({ tmdbId: 603, title: "Matrix", year: "1999", overview: "x", posterUrl: null }, "elle");
  assert.equal(a.already, false);
  const dup = await addToWatchlist({ tmdbId: 603, title: "Matrix", year: "1999" }, "lui");
  assert.equal(dup.already, true, "pas de doublon TMDB");
  await addToWatchlist({ tmdbId: 604, title: "Matrix Reloaded" }, "lui");
  let items = await listWatchlist();
  assert.equal(items.length, 2);
  assert.equal(items.find((i) => i.tmdbId === 603).addedBy, "elle");
  assert.equal(await removeFromWatchlist(a.item.id, "lui"), true);
  items = await listWatchlist();
  assert.equal(items.length, 1, "retrait par tombstone");
  const raw = JSON.parse(fs.readFileSync(path.join(dir, "watchlist.json"), "utf8"));
  assert.equal(raw.items.length, 2, "le fichier reste en append, rien n'est effacé");
});
