import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { SyncState } from "./api";

export type ReactionEvent = {
  emoji: string;
  from: string;
  at: number;
  id: number;
};

/** Contrat docs/PROTOCOLE-SYNC.md — peers passe de string[] a PeerInfo[]. */
export type PeerInfo = {
  name: string;
  watching: string | null;
  stalled: boolean;
  ready: boolean;
  away: boolean;
  awayReason?: string;
};

export type Countdown = { startsAt: number; movieId: string };

type RawPeer = string | Partial<PeerInfo>;

type ServerMessage =
  | { type: "state"; state: SyncState; serverNow: number; peers: RawPeer[] }
  | { type: "peers"; peers: RawPeer[] }
  | { type: "countdown"; startsAt: number; movieId: string }
  | { type: "reload" }
  | { type: "reaction"; emoji: string; from: string; at: number }
  | { type: "error"; message: string };

export type SyncStatus = "connecting" | "synced" | "resync" | "offline";

const RETRY_BASE = 800;
const RETRY_MAX = 15000;

function normalizePeers(list: RawPeer[] | undefined): PeerInfo[] {
  if (!Array.isArray(list)) return [];
  const out: PeerInfo[] = [];
  for (const raw of list) {
    if (typeof raw === "string") {
      out.push({
        name: raw,
        watching: null,
        stalled: false,
        ready: false,
        away: false,
      });
      continue;
    }
    if (!raw || typeof raw.name !== "string") continue;
    out.push({
      name: raw.name,
      watching: raw.watching ?? null,
      stalled: Boolean(raw.stalled),
      ready: Boolean(raw.ready),
      away: Boolean(raw.away),
      awayReason: raw.awayReason,
    });
  }
  return out;
}

function isFatalError(message: string): boolean {
  return /unauthor|forbidden|session|expir/i.test(message);
}

export function useSync(username: string | null, movieId: string | null) {
  const [state, setState] = useState<SyncState | null>(null);
  const [peers, setPeers] = useState<PeerInfo[]>([]);
  const [status, setStatus] = useState<SyncStatus>("connecting");
  const [reactions, setReactions] = useState<ReactionEvent[]>([]);
  const [countdown, setCountdown] = useState<Countdown | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const ignoreUntil = useRef(0);
  const lastOwnActionAt = useRef(0);
  const usernameRef = useRef(username);
  const reactionSeq = useRef(0);
  /** Instant local (epoch ms) de reception du dernier `state`. */
  const stateAt = useRef(0);
  /** serverNow - Date.now() a la reception : decalage d'horloge + latence aller. */
  const clockOffset = useRef(0);
  const clockSeen = useRef(false);
  /** Derniere commande de controle perdue faute de socket ouverte. */
  const pending = useRef<Record<string, unknown> | null>(null);
  /** Etats declaratifs a rejouer apres une reconnexion. */
  const declared = useRef({
    stalled: false,
    ready: false,
    away: false,
    awayReason: undefined as string | undefined,
  });
  /** Erreur bloquante (session expiree) : on arrete de marteler le serveur. */
  const fatal = useRef(false);
  usernameRef.current = username;

  useEffect(() => {
    if (!username) return;

    let closed = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let attempt = 0;
    fatal.current = false;

    const connect = () => {
      setStatus((s) => (s === "offline" ? "offline" : "connecting"));
      const proto = location.protocol === "https:" ? "wss" : "ws";
      const ws = new WebSocket(`${proto}://${location.host}/ws`);
      wsRef.current = ws;

      ws.onopen = () => {
        if (closed) return;
        attempt = 0;
        setLastError(null);
        ws.send(JSON.stringify({ type: "hello", username }));
        if (movieId) {
          ws.send(JSON.stringify({ type: "join", movieId }));
        } else {
          ws.send(JSON.stringify({ type: "leave" }));
        }
        // Rejoue l'etat declaratif : le serveur l'a perdu avec la socket.
        const d = declared.current;
        if (d.stalled) ws.send(JSON.stringify({ type: "stall", stalled: true }));
        if (d.ready) ws.send(JSON.stringify({ type: "ready", ready: true }));
        if (d.away) {
          ws.send(
            JSON.stringify({ type: "away", away: true, reason: d.awayReason }),
          );
        }
        // Rejoue la commande perdue pendant la coupure : sans ca, une pause
        // envoyee au mauvais moment disparait en silence.
        if (pending.current) {
          ws.send(JSON.stringify(pending.current));
          pending.current = null;
        }
        setStatus("synced");
      };

      ws.onmessage = (evt) => {
        if (closed) return;
        let msg: ServerMessage;
        try {
          msg = JSON.parse(String(evt.data)) as ServerMessage;
        } catch {
          return;
        }
        if (msg.type === "state") {
          const now = Date.now();
          stateAt.current = now;
          if (typeof msg.serverNow === "number") {
            const sample = msg.serverNow - now;
            // On retient le plus petit ecart observe : c'est l'echantillon
            // qui a subi la plus faible latence.
            clockOffset.current = clockSeen.current
              ? Math.min(clockOffset.current, sample)
              : sample;
            clockSeen.current = true;
          }
          const mine =
            msg.state.updatedBy === usernameRef.current &&
            now - lastOwnActionAt.current < 900;
          if (mine && now < ignoreUntil.current) {
            setState(msg.state);
            setPeers(normalizePeers(msg.peers));
            return;
          }
          setState(msg.state);
          setPeers(normalizePeers(msg.peers));
          setStatus("synced");
        } else if (msg.type === "peers") {
          setPeers(normalizePeers(msg.peers));
        } else if (msg.type === "countdown") {
          setCountdown({ startsAt: msg.startsAt, movieId: msg.movieId });
        } else if (msg.type === "reload") {
          location.reload();
        } else if (msg.type === "error") {
          setLastError(msg.message);
          if (isFatalError(msg.message)) {
            fatal.current = true;
            setStatus("offline");
            ws.close();
          }
        } else if (msg.type === "reaction") {
          const id = ++reactionSeq.current;
          setReactions((prev) => [
            ...prev.slice(-8),
            { emoji: msg.emoji, from: msg.from, at: msg.at, id },
          ]);
          window.setTimeout(() => {
            setReactions((prev) => prev.filter((r) => r.id !== id));
          }, 2600);
        }
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        setStatus("offline");
        if (closed || fatal.current) return;
        const delay = Math.min(RETRY_MAX, RETRY_BASE * 2 ** attempt);
        attempt += 1;
        retry = setTimeout(connect, delay + Math.random() * 250);
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

  const send = useCallback(
    (payload: Record<string, unknown>, kind: "control" | "soft" = "control") => {
      const ws = wsRef.current;
      const open = ws && ws.readyState === WebSocket.OPEN;
      if (!open) {
        // Une commande de controle perdue = les deux lecteurs divergent sans
        // que personne ne le sache. On la garde pour la reconnexion.
        if (kind === "control") {
          pending.current = payload;
          setStatus((s) => (s === "offline" ? s : "resync"));
        }
        return false;
      }
      if (kind === "control") {
        lastOwnActionAt.current = Date.now();
        ignoreUntil.current = Date.now() + 700;
      }
      ws.send(JSON.stringify(payload));
      return true;
    },
    [],
  );

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
      send({ type: "heartbeat", mediaTime, playing }, "soft"),
    [send],
  );
  const reloadAll = useCallback(() => send({ type: "reload" }, "soft"), [send]);
  const react = useCallback(
    (emoji: string) => send({ type: "reaction", emoji }, "soft"),
    [send],
  );

  /** Mise en tampon — signale seulement, ne met jamais l'autre en pause. */
  const stall = useCallback(
    (stalled: boolean) => {
      if (declared.current.stalled === stalled) return;
      declared.current.stalled = stalled;
      send({ type: "stall", stalled }, "soft");
    },
    [send],
  );

  const setReady = useCallback(
    (ready: boolean) => {
      declared.current.ready = ready;
      send({ type: "ready", ready }, "soft");
    },
    [send],
  );

  const setAway = useCallback(
    (away: boolean, reason?: string) => {
      declared.current.away = away;
      declared.current.awayReason = reason;
      send({ type: "away", away, reason }, "soft");
    },
    [send],
  );

  /** Date.now() du serveur, estimee. Utilisee par le decompte. */
  const serverTime = useCallback(() => Date.now() + clockOffset.current, []);

  const clearCountdown = useCallback(() => setCountdown(null), []);
  const clearError = useCallback(() => setLastError(null), []);

  // Objet stable : il sert de dependance d'effet dans Player. Un objet neuf a
  // chaque rendu relancait l'effet de synchro a chaque tick du catalogue et
  // faisait reculer le film. Ne pas retirer ce useMemo.
  return useMemo(
    () => ({
      state,
      stateAt,
      peers,
      status,
      reactions,
      countdown,
      lastError,
      ignoreUntil,
      setStatus,
      play,
      pause,
      seek,
      heartbeat,
      reloadAll,
      react,
      stall,
      setReady,
      setAway,
      serverTime,
      clearCountdown,
      clearError,
    }),
    [
      state,
      peers,
      status,
      reactions,
      countdown,
      lastError,
      play,
      pause,
      seek,
      heartbeat,
      reloadAll,
      react,
      stall,
      setReady,
      setAway,
      serverTime,
      clearCountdown,
      clearError,
    ],
  );
}
