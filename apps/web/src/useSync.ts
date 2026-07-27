import { useCallback, useEffect, useRef, useState } from "react";
import type { SyncState } from "./api";

export type ReactionEvent = {
  emoji: string;
  from: string;
  at: number;
  id: number;
};

type ServerMessage =
  | { type: "state"; state: SyncState; serverNow: number; peers: string[] }
  | { type: "peers"; peers: string[] }
  | { type: "reload" }
  | { type: "reaction"; emoji: string; from: string; at: number }
  | { type: "error"; message: string };

type SyncStatus = "connecting" | "synced" | "resync" | "offline";

export function useSync(username: string | null, movieId: string | null) {
  const [state, setState] = useState<SyncState | null>(null);
  const [peers, setPeers] = useState<string[]>([]);
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [reactions, setReactions] = useState<ReactionEvent[]>([]);
  const wsRef = useRef<WebSocket | null>(null);
  const ignoreUntil = useRef(0);
  const lastOwnActionAt = useRef(0);
  const usernameRef = useRef(username);
  const reactionSeq = useRef(0);
  usernameRef.current = username;

  useEffect(() => {
    if (!username) return;

    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      setStatus("connecting");
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (closed) return;
        ws.send(JSON.stringify({ type: "hello", username }));
        if (movieId) {
          ws.send(JSON.stringify({ type: "join", movieId }));
        } else {
          ws.send(JSON.stringify({ type: "leave" }));
        }
        setStatus("synced");
      };

      ws.onmessage = (evt) => {
        if (closed) return;
        const msg = JSON.parse(String(evt.data)) as ServerMessage;
        if (msg.type === "state") {
          const mine =
            msg.state.updatedBy === usernameRef.current &&
            Date.now() - lastOwnActionAt.current < 900;
          if (mine && Date.now() < ignoreUntil.current) {
            setState(msg.state);
            setPeers(msg.peers);
            return;
          }
          setState(msg.state);
          setPeers(msg.peers);
          setStatus("synced");
        } else if (msg.type === "peers") {
          setPeers(msg.peers);
        } else if (msg.type === "reload") {
          location.reload();
        } else if (msg.type === "reaction") {
          const id = ++reactionSeq.current;
          setReactions((prev) => [
            ...prev.slice(-8),
            { emoji: msg.emoji, from: msg.from, at: msg.at, id },
          ]);
          window.setTimeout(() => {
            setReactions((prev) => prev.filter((r) => r.id !== id));
          }, 2200);
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        setStatus("offline");
        if (!closed) retry = setTimeout(connect, 1200);
      };
    };

    connect();
    return () => {
      closed = true;
      clearTimeout(retry);
      wsRef.current?.close();
      wsRef.current = null;
    };
  }, [username, movieId]);

  const send = useCallback((payload: Record<string, unknown>, isHeartbeat = false) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (!isHeartbeat) {
      lastOwnActionAt.current = Date.now();
      ignoreUntil.current = Date.now() + 700;
    }
    ws.send(JSON.stringify(payload));
  }, []);

  const play = useCallback(
    (mediaTime: number) => send({ type: "play", mediaTime }),
    [send],
  );
  const pause = useCallback(
    (mediaTime: number) => send({ type: "pause", mediaTime }),
    [send],
  );
  const seek = useCallback(
    (mediaTime: number, playing: boolean) =>
      send({ type: "seek", mediaTime, playing }),
    [send],
  );
  const heartbeat = useCallback(
    (mediaTime: number, playing: boolean) =>
      send({ type: "heartbeat", mediaTime, playing }, true),
    [send],
  );
  const reloadAll = useCallback(() => send({ type: "reload" }), [send]);
  const react = useCallback(
    (emoji: string) => send({ type: "reaction", emoji }),
    [send],
  );

  return {
    state,
    peers,
    status,
    reactions,
    ignoreUntil,
    setStatus,
    play,
    pause,
    seek,
    heartbeat,
    reloadAll,
    react,
  };
}
