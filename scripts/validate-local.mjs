import WebSocket from "ws";

const base = process.env.WATCH_URL ?? "http://127.0.0.1:8787";
const wsBase = base.replace(/^http/, "ws");

const username = process.env.WATCH_USER;
const password = process.env.WATCH_PASS;
if (!username || !password) {
  throw new Error("Set WATCH_USER and WATCH_PASS to run validate-local");
}

const loginRes = await fetch(`${base}/api/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ username, password }),
});
if (!loginRes.ok) throw new Error(`login failed: ${loginRes.status}`);
const cookie = loginRes.headers.getSetCookie?.()[0]?.split(";")[0]
  ?? [...loginRes.headers.entries()]
    .filter(([k]) => k.toLowerCase() === "set-cookie")
    .map(([, v]) => v.split(";")[0])[0];
if (!cookie) throw new Error("no session cookie");

const movies = await fetch(`${base}/api/movies`, {
  headers: { Cookie: cookie },
}).then((r) => r.json());
if (!movies.movies?.length) throw new Error("no movies in media/");

const movieId = movies.movies[0].id;
const range = await fetch(`${base}/api/stream/${movieId}`, {
  headers: { Cookie: cookie, Range: "bytes=0-1023" },
});
if (range.status !== 206) throw new Error(`stream expected 206, got ${range.status}`);

function connect(name) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${wsBase}/ws`, { headers: { Cookie: cookie } });
    ws.on("open", () => {
      ws.send(JSON.stringify({ type: "hello", username: name }));
      ws.send(JSON.stringify({ type: "join", movieId }));
    });
    ws.on("message", (data) => {
      const msg = JSON.parse(String(data));
      if (msg.type === "state") resolve({ ws, msg });
    });
    ws.on("error", reject);
    setTimeout(() => reject(new Error(`${name} timeout`)), 4000);
  });
}

const a = await connect("you");
const bWait = new Promise((resolve, reject) => {
  const ws = new WebSocket(`${wsBase}/ws`, { headers: { Cookie: cookie } });
  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "hello", username: "her" }));
    ws.send(JSON.stringify({ type: "join", movieId }));
  });
  ws.on("message", (data) => {
    const msg = JSON.parse(String(data));
    if (msg.type === "state" && msg.state.playing) resolve({ ws, msg });
  });
  ws.on("error", reject);
  setTimeout(() => reject(new Error("peer sync timeout")), 4000);
});
setTimeout(() => {
  a.ws.send(JSON.stringify({ type: "play", mediaTime: 5 }));
}, 200);
const b = await bWait;

console.log(
  JSON.stringify(
    {
      ok: true,
      movie: movies.movies[0].filename,
      stream: range.status,
      sync: {
        playing: b.msg.state.playing,
        mediaTime: b.msg.state.mediaTime,
        peers: b.msg.peers,
      },
    },
    null,
    2,
  ),
);
a.ws.close();
b.ws.close();
