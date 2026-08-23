export type SyncState = {
  movieId: string | null;
  playing: boolean;
  mediaTime: number;
  /**
   * Event time, not arrival time: the instant the reported position was true,
   * already compensated for that peer's one-way latency. Clients keep using
   * `serverNow - updatedAt` to project the position forward.
   */
  updatedAt: number;
  updatedBy: string | null;
  /** Informational only — both peers can drive */
  host: string | null;
};

export type ClientMessage =
  | { type: "hello"; username: string }
  | { type: "join"; movieId: string }
  | { type: "leave" }
  | { type: "play"; mediaTime: number }
  | { type: "pause"; mediaTime: number }
  | { type: "seek"; mediaTime: number; playing: boolean }
  | { type: "heartbeat"; mediaTime: number; playing: boolean }
  | { type: "reload" }
  | { type: "reaction"; emoji: string }
  | { type: "stall"; stalled: boolean }
  | { type: "ready"; ready: boolean }
  | { type: "away"; away: boolean; reason?: string };

/** A reaction, kept with the exact moment of the film it belongs to. */
export type SessionReaction = {
  emoji: string;
  from: string;
  /** Wall-clock instant */
  at: number;
  /** Position in the film, in seconds */
  mediaTime: number;
};

/**
 * One evening in front of one film. `togetherSeconds` counts only the time
 * both of them were actually watching the same film while it was playing —
 * not the time the tab was open.
 */
export type WatchSessionEvent = {
  id: string;
  movieId: string;
  startedAt: number;
  endedAt: number;
  togetherSeconds: number;
  peers: string[];
  reactions: SessionReaction[];
  /** false while the evening is still running (periodic flush) */
  closed: boolean;
};

export type PeerInfo = {
  name: string;
  watching: string | null;
  stalled: boolean;
  ready: boolean;
  away: boolean;
  awayReason?: string;
};

export type ServerMessage =
  | { type: "state"; state: SyncState; serverNow: number; peers: PeerInfo[] }
  | { type: "peers"; peers: PeerInfo[] }
  | { type: "countdown"; startsAt: number; movieId: string }
  | { type: "reload" }
  | { type: "reaction"; emoji: string; from: string; at: number }
  | { type: "error"; message: string };

type Peer = {
  username: string;
  watching: string | null;
  stalled: boolean;
  ready: boolean;
  away: boolean;
  awayReason?: string;
  /** Half the measured WebSocket round-trip, in ms. */
  halfRttMs: number;
  send: (msg: ServerMessage) => void;
};

const defaultState = (): SyncState => ({
  movieId: null,
  playing: false,
  mediaTime: 0,
  updatedAt: Date.now(),
  updatedBy: null,
  host: null,
});

const REACTION_OK = new Set(["❤️", "😂", "👀", "🔥", "👏", "😱"]);

/** Contract: rebroadcast state every 4 s while at least one peer is watching. */
const REBROADCAST_MS = 4000;
/** Contract: persist progress from heartbeats, throttled to 15 s per movie. */
const PROGRESS_THROTTLE_MS = 15000;
/**
 * A dropped connection is not a "leave". Keep the shared position this long
 * before forgetting it, so a 4G blip does not send anyone back to 0:00.
 */
const DISCONNECT_GRACE_MS = 10 * 60 * 1000;
/**
 * Two clicks landing within this window are treated as simultaneous: the
 * earlier *intent* wins, not the packet that happened to arrive last. Without
 * it the higher-latency side always wins every race.
 */
const TIE_WINDOW_MS = 1000;
const MAX_HALF_RTT_MS = 1500;
/** How often a running evening is written to history.json. */
const SESSION_FLUSH_MS = 60000;
/** Contract: the countdown lands about 3 s in the future. */
const COUNTDOWN_LEAD_MS = 3000;

export class SyncRoom {
  private state: SyncState = defaultState();
  private peers = new Map<string, Peer>();
  private ticker: ReturnType<typeof setInterval> | null = null;
  private graceTimer: ReturnType<typeof setTimeout> | null = null;
  private lastPersistAt = new Map<string, number>();
  /** Last known position per movie, so a rejoin does not restart from zero. */
  private lastKnown = new Map<string, number>();
  private countdown: { startsAt: number; movieId: string } | null = null;
  private countdownTimer: ReturnType<typeof setTimeout> | null = null;
  private session: {
    id: string;
    movieId: string;
    startedAt: number;
    togetherSeconds: number;
    togetherSince: number | null;
    peers: Set<string>;
    reactions: SessionReaction[];
    lastEmitAt: number;
  } | null = null;
  private onSession: ((ev: WatchSessionEvent) => void) | null = null;
  private onProgress:
    | ((movieId: string, mediaTime: number, by: string) => void)
    | null = null;
  private onResume: ((movieId: string) => Promise<number | null>) | null = null;

  setProgressHandler(
    fn: (movieId: string, mediaTime: number, by: string) => void,
  ) {
    this.onProgress = fn;
  }

  /** "Nos soirees": the room reports what was actually watched together. */
  setSessionHandler(fn: (ev: WatchSessionEvent) => void) {
    this.onSession = fn;
  }

  /** Cold-start resume: where progress.json says this movie was left. */
  setResumeHandler(fn: (movieId: string) => Promise<number | null>) {
    this.onResume = fn;
  }

  connect(id: string, username: string, send: (msg: ServerMessage) => void) {
    this.peers.set(id, {
      username,
      watching: null,
      stalled: false,
      ready: false,
      away: false,
      halfRttMs: 0,
      send,
    });
    this.clearGrace();
    send({
      type: "state",
      state: this.projectedState(),
      serverNow: Date.now(),
      peers: this.peerInfos(),
    });
    this.broadcastPeers();
  }

  disconnect(id: string) {
    const gone = this.peers.get(id);
    this.peers.delete(id);

    // Hand back control: otherwise the remaining viewer's heartbeats are
    // rejected forever while projectedState() keeps advancing on wall clock.
    if (
      gone &&
      this.state.updatedBy &&
      this.state.updatedBy.toLowerCase() === gone.username.toLowerCase() &&
      ![...this.peers.values()].some(
        (p) => p.username.toLowerCase() === gone.username.toLowerCase(),
      )
    ) {
      this.state = { ...this.state, updatedBy: null };
    }

    // A drop is not a leave: freeze, remember, and keep the position warm.
    this.reconcileRoom({ explicitLeave: false, by: gone?.username ?? null });
    this.broadcastPeers();
    this.broadcastState();
    this.syncTicker();
    this.evaluateCountdown();
    this.updateTogetherness();
  }

  /** Called from the transport on each pong. */
  setLatency(id: string, rttMs: number) {
    const peer = this.peers.get(id);
    if (!peer || !Number.isFinite(rttMs) || rttMs < 0) return;
    peer.halfRttMs = Math.min(MAX_HALF_RTT_MS, Math.round(rttMs / 2));
  }

  peerCount(): number {
    return this.peers.size;
  }

  peerNames(): string[] {
    return [...new Set([...this.peers.values()].map((p) => p.username))];
  }

  /**
   * One entry per username: a second tab from the same person must not look
   * like a second viewer. Merge rule — watching: first non-null; stalled/ready:
   * true if any connection says so; away: true only if every connection is away.
   */
  peerInfos(): PeerInfo[] {
    const byName = new Map<string, PeerInfo>();
    for (const p of this.peers.values()) {
      const prev = byName.get(p.username);
      if (!prev) {
        byName.set(p.username, {
          name: p.username,
          watching: p.watching,
          stalled: p.stalled,
          ready: p.ready,
          away: p.away,
          ...(p.away && p.awayReason ? { awayReason: p.awayReason } : {}),
        });
        continue;
      }
      const merged: PeerInfo = {
        name: prev.name,
        watching: prev.watching ?? p.watching,
        stalled: prev.stalled || p.stalled,
        ready: prev.ready || p.ready,
        away: prev.away && p.away,
      };
      const reason = prev.awayReason ?? (p.away ? p.awayReason : undefined);
      if (merged.away && reason) merged.awayReason = reason;
      byName.set(p.username, merged);
    }
    return [...byName.values()];
  }

  getState(): SyncState {
    return this.projectedState();
  }

  /** Test/shutdown hook: never leave a timer behind. */
  stop() {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.clearGrace();
    this.cancelCountdown();
    this.closeSession();
  }

  /** Exposed for the test bench. */
  pendingCountdown(): { startsAt: number; movieId: string } | null {
    return this.countdown;
  }

  /**
   * Countdown: when every peer watching the current film says it is ready, the
   * server names a start instant about 3 s out and everyone counts down to it.
   * The "Pret ?" click doubles as the browser user-gesture that authorises
   * playback, so it must not be skipped even when only one person is watching.
   */
  private evaluateCountdown() {
    const movieId = this.state.movieId;
    if (!movieId) {
      this.cancelCountdown();
      return;
    }
    const watchers = this.watchersOf(movieId);
    const allReady = watchers.length > 0 && watchers.every((p) => p.ready);

    if (!allReady) {
      // Someone un-readied or walked away before the start: call it off.
      this.cancelCountdown();
      return;
    }
    // Already counting down on this film — do not restart the clock.
    if (
      this.countdown &&
      this.countdown.movieId === movieId &&
      this.countdown.startsAt > Date.now()
    ) {
      return;
    }

    const startsAt = Date.now() + COUNTDOWN_LEAD_MS;
    this.countdown = { startsAt, movieId };
    const payload: ServerMessage = { type: "countdown", startsAt, movieId };
    for (const p of watchers) p.send(payload);

    this.cancelCountdownTimer();
    this.countdownTimer = setTimeout(() => {
      this.countdownTimer = null;
      this.countdown = null;
      // Contract step 4: ready flags go back to false once we have started.
      let changed = false;
      for (const p of this.peers.values()) {
        if (p.ready) {
          p.ready = false;
          changed = true;
        }
      }
      if (changed) this.broadcastPeers();
    }, COUNTDOWN_LEAD_MS);
    this.countdownTimer.unref?.();
  }

  private cancelCountdown() {
    this.countdown = null;
    this.cancelCountdownTimer();
  }

  private cancelCountdownTimer() {
    if (this.countdownTimer) {
      clearTimeout(this.countdownTimer);
      this.countdownTimer = null;
    }
  }

  handle(id: string, msg: ClientMessage) {
    const peer = this.peers.get(id);
    if (!peer) return;

    switch (msg.type) {
      case "hello":
        peer.username = msg.username;
        this.broadcastPeers();
        this.broadcastState();
        break;
      case "join": {
        // Teleport fix: opening another film from the catalog must not wipe the
        // shared state while someone else is still watching the current one.
        const othersOnCurrent =
          this.state.movieId !== null &&
          [...this.peers.entries()].some(
            ([otherId, other]) =>
              otherId !== id && other.watching === this.state.movieId,
          );
        peer.watching = msg.movieId;
        peer.ready = false;
        peer.stalled = false;
        this.clearGrace();
        if (this.state.movieId !== msg.movieId && !othersOnCurrent) {
          this.rememberPosition();
          this.state = this.freshState(msg.movieId, peer.username);
        }
        // Everyone must learn that someone opened a film — otherwise the other
        // side keeps showing "Reprendre" and a click on it seeks them backwards.
        this.broadcastState();
        this.broadcastPeers();
        this.syncTicker();
        this.evaluateCountdown();
        this.updateTogetherness();
        break;
      }
      case "leave":
        peer.watching = null;
        peer.ready = false;
        peer.stalled = false;
        this.reconcileRoom({ explicitLeave: true, by: peer.username });
        this.broadcastPeers();
        this.broadcastState();
        this.syncTicker();
        this.evaluateCountdown();
        this.updateTogetherness();
        break;
      case "play":
      case "pause":
      case "seek": {
        // A peer sitting on another film must not drive this one's state.
        if (peer.watching !== null && peer.watching !== this.state.movieId) break;
        const playing =
          msg.type === "play" ? true : msg.type === "pause" ? false : msg.playing;
        if (!this.applyControl(peer, playing, msg.mediaTime)) break;
        this.persistProgress(peer.username);
        this.updateTogetherness();
        this.broadcastState();
        break;
      }
      case "heartbeat": {
        if (peer.watching !== null && peer.watching !== this.state.movieId) break;
        // Only the last controller soft-clocks — avoids dual teleport races.
        if (
          this.state.playing &&
          (!this.state.updatedBy ||
            this.state.updatedBy.toLowerCase() === peer.username.toLowerCase())
        ) {
          this.state.mediaTime = Math.max(0, msg.mediaTime);
          this.state.updatedAt = Date.now() - peer.halfRttMs;
        }
        this.rememberPosition();
        this.updateTogetherness();
        // 50 minutes of uninterrupted playback used to never reach progress.json.
        this.persistProgress(peer.username, PROGRESS_THROTTLE_MS);
        break;
      }
      case "stall": {
        peer.stalled = Boolean(msg.stalled);
        this.broadcastPeers();
        break;
      }
      case "ready": {
        peer.ready = Boolean(msg.ready);
        this.broadcastPeers();
        this.evaluateCountdown();
        break;
      }
      case "away": {
        peer.away = Boolean(msg.away);
        const reason =
          typeof msg.reason === "string" ? msg.reason.slice(0, 80) : "";
        peer.awayReason = peer.away && reason ? reason : undefined;
        this.broadcastPeers();
        break;
      }
      case "reload": {
        const payload: ServerMessage = { type: "reload" };
        for (const p of this.peers.values()) p.send(payload);
        break;
      }
      case "reaction": {
        const emoji = String(msg.emoji || "").slice(0, 8);
        if (!REACTION_OK.has(emoji)) return;
        const at = Date.now();
        const payload: ServerMessage = {
          type: "reaction",
          emoji,
          from: peer.username,
          at,
        };
        for (const p of this.peers.values()) p.send(payload);
        // Reactions used to be forwarded and dropped. They are the only trace
        // of the evening, so they are kept with their timecode.
        if (this.state.movieId) {
          const session = this.ensureSession(this.state.movieId);
          session.peers.add(peer.username);
          if (session.reactions.length < 2000) {
            session.reactions.push({
              emoji,
              from: peer.username,
              at,
              mediaTime: Math.round(this.projectedState().mediaTime),
            });
          }
        }
        break;
      }
      default:
        peer.send({ type: "error", message: "Unknown message" });
    }
  }

  private freshState(movieId: string, by: string): SyncState {
    const remembered = this.lastKnown.get(movieId);
    if (remembered == null) this.hydrateFromProgress(movieId);
    return {
      movieId,
      playing: false,
      mediaTime: remembered ?? 0,
      updatedAt: Date.now(),
      updatedBy: by,
      host: null,
    };
  }

  /** Server restart / first open of the evening: seed from progress.json. */
  private hydrateFromProgress(movieId: string) {
    if (!this.onResume) return;
    void this.onResume(movieId)
      .then((seconds) => {
        if (seconds == null || seconds <= 20) return;
        if (this.state.movieId !== movieId) return;
        if (this.state.playing || this.state.mediaTime > 1) return;
        this.state = {
          ...this.state,
          mediaTime: seconds,
          updatedAt: Date.now(),
        };
        this.lastKnown.set(movieId, seconds);
        this.broadcastState();
      })
      .catch(() => undefined);
  }

  private rememberPosition() {
    if (!this.state.movieId) return;
    this.lastKnown.set(this.state.movieId, this.projectedState().mediaTime);
  }

  private watchersOf(movieId: string): Peer[] {
    return [...this.peers.values()].filter((p) => p.watching === movieId);
  }

  /**
   * Keep the shared state pointed at something someone is actually watching,
   * and never let it run on the wall clock with nobody in the room.
   */
  private reconcileRoom(opts: { explicitLeave: boolean; by: string | null }) {
    const watched = [
      ...new Set(
        [...this.peers.values()]
          .map((p) => p.watching)
          .filter((m): m is string => Boolean(m)),
      ),
    ];

    if (this.state.movieId && watched.includes(this.state.movieId)) {
      this.clearGrace();
      return;
    }

    // Nobody is on the current film any more: freeze it where it stands.
    if (this.state.movieId) {
      this.rememberPosition();
      if (this.state.playing) {
        this.state = {
          ...this.state,
          playing: false,
          mediaTime: this.projectedState().mediaTime,
          updatedAt: Date.now(),
          updatedBy: null,
        };
      }
      this.persistProgress(opts.by ?? this.state.updatedBy ?? "");
    }

    if (watched.length) {
      // Someone moved on to another film — adopt it rather than stay stuck.
      this.clearGrace();
      const next = watched[0];
      const adopter = this.watchersOf(next)[0];
      this.state = this.freshState(next, adopter?.username ?? "");
      return;
    }

    if (opts.explicitLeave) {
      this.state = defaultState();
      this.lastPersistAt.clear();
      this.clearGrace();
      return;
    }

    // Dropped connection: hold the position for a while before forgetting it.
    this.scheduleGrace();
  }

  private scheduleGrace() {
    this.clearGrace();
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null;
      const anyoneWatching = [...this.peers.values()].some((p) => p.watching);
      if (anyoneWatching) return;
      this.state = defaultState();
      this.lastPersistAt.clear();
    }, DISCONNECT_GRACE_MS);
    this.graceTimer.unref?.();
  }

  private clearGrace() {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer);
      this.graceTimer = null;
    }
  }

  /** Start the 4 s rebroadcast while someone watches; stop it when the room empties. */
  private syncTicker() {
    const anyoneWatching = [...this.peers.values()].some((p) => p.watching);
    if (anyoneWatching && !this.ticker) {
      this.ticker = setInterval(() => this.onTick(), REBROADCAST_MS);
      this.ticker.unref?.();
    } else if (!anyoneWatching && this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
  }

  private onTick() {
    if (!this.peers.size) {
      this.updateTogetherness();
      this.closeSession();
      this.syncTicker();
      return;
    }
    this.updateTogetherness();
    this.flushSession();
    this.broadcastState();
  }

  /** Keep history.json current: a server restart must not lose the evening. */
  private flushSession() {
    const s = this.session;
    if (!s || !this.onSession) return;
    const now = Date.now();
    if (now - s.lastEmitAt < SESSION_FLUSH_MS) return;
    const ev = this.sessionEvent(false);
    if (!ev || (ev.togetherSeconds < 60 && !ev.reactions.length)) return;
    s.lastEmitAt = now;
    this.onSession(ev);
  }

  private persistProgress(by: string, throttleMs = 0) {
    const movieId = this.state.movieId;
    if (!movieId || !this.onProgress) return;
    const now = Date.now();
    if (throttleMs > 0) {
      const last = this.lastPersistAt.get(movieId) ?? 0;
      if (now - last < throttleMs) return;
    }
    this.lastPersistAt.set(movieId, now);
    this.onProgress(movieId, this.projectedState().mediaTime, by);
  }

  /**
   * Timestamp the intent, not the packet. `updatedAt` is set to when the click
   * actually happened (arrival minus one-way latency), which both removes the
   * systematic bias against the low-latency side and makes simultaneous clicks
   * comparable.
   */
  private applyControl(peer: Peer, playing: boolean, mediaTime: number): boolean {
    const eventAt = Date.now() - peer.halfRttMs;
    const sameUser =
      this.state.updatedBy != null &&
      this.state.updatedBy.toLowerCase() === peer.username.toLowerCase();
    if (
      !sameUser &&
      this.state.updatedBy != null &&
      eventAt < this.state.updatedAt &&
      this.state.updatedAt - eventAt < TIE_WINDOW_MS
    ) {
      // Lost the race on intent time: the other click was genuinely first.
      return false;
    }
    this.state = {
      ...this.state,
      playing,
      mediaTime: Math.max(0, mediaTime),
      updatedAt: eventAt,
      updatedBy: peer.username,
      host: null,
    };
    this.rememberPosition();
    return true;
  }

  private distinctWatchers(movieId: string): string[] {
    return [
      ...new Set(this.watchersOf(movieId).map((p) => p.username.toLowerCase())),
    ];
  }

  private ensureSession(movieId: string) {
    if (this.session && this.session.movieId !== movieId) this.closeSession();
    if (!this.session) {
      this.session = {
        id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
        movieId,
        startedAt: Date.now(),
        togetherSeconds: 0,
        togetherSince: null,
        peers: new Set(),
        reactions: [],
        lastEmitAt: 0,
      };
    }
    return this.session;
  }

  /**
   * Start/stop the "watched together" stopwatch. Called on every state change
   * and on each tick, so a pause or a departure stops the count immediately
   * instead of being rounded to the nearest rebroadcast.
   */
  private updateTogetherness() {
    const movieId = this.state.movieId;
    if (this.session && this.session.movieId !== movieId) this.closeSession();

    const watchers = movieId ? this.distinctWatchers(movieId) : [];
    const together = Boolean(movieId) && this.state.playing && watchers.length >= 2;

    if (together && movieId) {
      const session = this.ensureSession(movieId);
      for (const name of this.watchersOf(movieId)) session.peers.add(name.username);
      if (session.togetherSince == null) session.togetherSince = Date.now();
      return;
    }

    if (this.session?.togetherSince != null) {
      this.session.togetherSeconds +=
        (Date.now() - this.session.togetherSince) / 1000;
      this.session.togetherSince = null;
    }
  }

  private sessionEvent(closed: boolean): WatchSessionEvent | null {
    const s = this.session;
    if (!s) return null;
    const pending =
      s.togetherSince != null ? (Date.now() - s.togetherSince) / 1000 : 0;
    return {
      id: s.id,
      movieId: s.movieId,
      startedAt: s.startedAt,
      endedAt: Date.now(),
      togetherSeconds: Math.round(s.togetherSeconds + pending),
      peers: [...s.peers],
      reactions: [...s.reactions],
      closed,
    };
  }

  private closeSession() {
    const s = this.session;
    if (!s) return;
    if (s.togetherSince != null) {
      s.togetherSeconds += (Date.now() - s.togetherSince) / 1000;
      s.togetherSince = null;
    }
    const ev = this.sessionEvent(true);
    this.session = null;
    // A film opened and abandoned in ten seconds is not a memory.
    if (ev && this.onSession && (ev.togetherSeconds >= 60 || ev.reactions.length)) {
      this.onSession(ev);
    }
  }

  private projectedState(): SyncState {
    if (!this.state.playing) return { ...this.state };
    const elapsed = (Date.now() - this.state.updatedAt) / 1000;
    return {
      ...this.state,
      mediaTime: this.state.mediaTime + Math.max(0, elapsed),
    };
  }

  private broadcastState(exceptId?: string) {
    const payload: ServerMessage = {
      type: "state",
      state: this.projectedState(),
      serverNow: Date.now(),
      peers: this.peerInfos(),
    };
    for (const [id, peer] of this.peers) {
      if (exceptId && id === exceptId) continue;
      peer.send(payload);
    }
  }

  private broadcastPeers() {
    const payload: ServerMessage = { type: "peers", peers: this.peerInfos() };
    for (const peer of this.peers.values()) peer.send(payload);
  }
}

export const room = new SyncRoom();
