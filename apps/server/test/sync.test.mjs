import test from "node:test";
import assert from "node:assert/strict";
import { SyncRoom } from "../dist/sync.js";

function mkRoom() {
  const inbox = new Map();
  const room = new SyncRoom();
  const join = (id, name) => {
    inbox.set(id, []);
    room.connect(id, name, (m) => inbox.get(id).push(m));
    room.handle(id, { type: "hello", username: name });
    return id;
  };
  return { room, inbox, join, last: (id, t) => [...inbox.get(id)].reverse().find((m) => m.type === t) };
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test("C — join est diffusé aux autres pairs", () => {
  const { room, inbox, join, last } = mkRoom();
  join("a", "lui"); join("b", "elle");
  inbox.get("a").length = 0;
  room.handle("b", { type: "join", movieId: "FILM" });
  const st = last("a", "state");
  assert.ok(st, "lui doit recevoir un state quand elle ouvre un film");
  assert.equal(st.state.movieId, "FILM");
  assert.ok(last("a", "peers").peers.find((p) => p.name === "elle").watching === "FILM");
  room.stop();
});

test("3/4 — peers est PeerInfo[] avec watching/stalled/ready/away", () => {
  const { room, join, last } = mkRoom();
  join("a", "lui"); join("b", "elle");
  room.handle("a", { type: "join", movieId: "FILM" });
  room.handle("b", { type: "stall", stalled: true });
  room.handle("b", { type: "away", away: true, reason: "thé" });
  room.handle("a", { type: "ready", ready: true });
  const peers = last("b", "peers").peers;
  const lui = peers.find((p) => p.name === "lui");
  const elle = peers.find((p) => p.name === "elle");
  assert.deepEqual(lui, { name: "lui", watching: "FILM", stalled: false, ready: true, away: false });
  assert.equal(elle.watching, null, "restée au catalogue => watching null");
  assert.equal(elle.stalled, true);
  assert.equal(elle.away, true);
  assert.equal(elle.awayReason, "thé");
  room.stop();
});

test("5 — bug de téléportation: ouvrir un autre film n'écrase pas l'état partagé", () => {
  const { room, join, last } = mkRoom();
  join("a", "lui"); join("b", "elle");
  room.handle("a", { type: "join", movieId: "A" });
  room.handle("a", { type: "play", mediaTime: 2400 });   // 40 min
  room.handle("b", { type: "join", movieId: "B" });       // elle part au catalogue -> film B
  assert.equal(room.getState().movieId, "A", "l'état doit rester sur A");
  assert.ok(room.getState().mediaTime >= 2400, "et à 40 min");
  room.handle("b", { type: "join", movieId: "A" });       // elle revient sur A
  assert.ok(room.getState().mediaTime >= 2400, "revenir sur A ne remet pas à 0");
  room.handle("b", { type: "play", mediaTime: 2401 });
  assert.ok(last("a", "state").state.mediaTime > 2000, "lui n'est pas renvoyé à 0:00");
  room.stop();
});

test("B — une micro-coupure ne renvoie pas au début", () => {
  const { room, join } = mkRoom();
  join("a", "elle");
  room.handle("a", { type: "join", movieId: "FILM" });
  room.handle("a", { type: "play", mediaTime: 2530 });    // 42:10
  room.disconnect("a");                                   // 4G qui saute
  assert.equal(room.getState().movieId, "FILM", "l'état survit à la coupure");
  assert.equal(room.getState().playing, false, "gelé, pas à l'horloge murale");
  join("a2", "elle");
  room.handle("a2", { type: "join", movieId: "FILM" });
  assert.ok(room.getState().mediaTime > 2500, `reprise à ${room.getState().mediaTime}, pas 0`);
  room.stop();
});

test("D — l'autorité est rendue quand le contrôleur part", () => {
  const { room, join } = mkRoom();
  join("a", "lui"); join("b", "elle");
  room.handle("a", { type: "join", movieId: "F" });
  room.handle("b", { type: "join", movieId: "F" });
  room.handle("a", { type: "play", mediaTime: 100 });
  assert.equal(room.getState().updatedBy, "lui");
  room.disconnect("a");
  assert.equal(room.getState().updatedBy, null, "sinon les heartbeats d'elle sont rejetés à vie");
  room.handle("b", { type: "heartbeat", mediaTime: 250, playing: true });
  assert.ok(room.getState().mediaTime >= 250, "ses heartbeats sont de nouveau pris en compte");
  room.stop();
});

test("2 — persistProgress est appelé depuis heartbeat, throttlé à 15 s", async () => {
  const { room, join } = mkRoom();
  const calls = [];
  room.setProgressHandler((movieId, t) => calls.push([movieId, t]));
  join("a", "lui");
  room.handle("a", { type: "join", movieId: "F" });
  room.handle("a", { type: "play", mediaTime: 10 });      // 1 écriture (contrôle)
  const afterControl = calls.length;
  for (let i = 0; i < 40; i++) room.handle("a", { type: "heartbeat", mediaTime: 10 + i, playing: true });
  assert.equal(calls.length, afterControl, "40 heartbeats en rafale => throttlés");
  assert.ok(afterControl >= 1, "play/pause/seek écrit toujours");
  room.stop();
});

test("1 — rediffusion périodique toutes les 4 s, et arrêt propre", async () => {
  const { room, inbox, join } = mkRoom();
  join("a", "lui");
  room.handle("a", { type: "join", movieId: "F" });
  inbox.get("a").length = 0;
  await sleep(4600);
  const n = inbox.get("a").filter((m) => m.type === "state").length;
  assert.ok(n >= 1, `attendu >=1 rediffusion en 4,6 s, reçu ${n}`);
  room.handle("a", { type: "leave" });
  inbox.get("a").length = 0;
  await sleep(4600);
  assert.equal(inbox.get("a").filter((m) => m.type === "state").length, 0, "timer arrêté quand la salle se vide");
  room.stop();
});

test("F — le pair lointain ne gagne plus systématiquement la course", () => {
  const { room, join } = mkRoom();
  join("a", "lui"); join("b", "elle");
  room.handle("a", { type: "join", movieId: "F" });
  room.handle("b", { type: "join", movieId: "F" });
  room.setLatency("b", 400);          // elle: 200 ms aller simple
  room.handle("a", { type: "pause", mediaTime: 500 });
  room.handle("b", { type: "play", mediaTime: 500 });  // clic *antérieur*, arrivé après
  assert.equal(room.getState().playing, false, "le clic réellement premier gagne");
  room.stop();
});
