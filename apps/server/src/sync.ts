export type SyncState = {
  movieId: string | null;
  playing: boolean;
  mediaTime: number;
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
  | { type: "reaction"; emoji: string };

export type ServerMessage =
  | { type: "state"; state: SyncState; serverNow: number; peers: string[] }
  | { type: "peers"; peers: string[] }
  | { type: "reload" }
  | { type: "reaction"; emoji: string; from: string; at: number }
  | { type: "error"; message: string };

type Peer = {
  username: string;
  watching: string | null;
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

export class SyncRoom {
  private state: SyncState = defaultState();
  private peers = new Map<string, Peer>();
  private onProgress:
    | ((movieId: string, mediaTime: number, by: string) => void)
    | null = null;

  setProgressHandler(
    fn: (movieId: string, mediaTime: number, by: string) => void,
  ) {
    this.onProgress = fn;
  }

  connect(id: string, username: string, send: (msg: ServerMessage) => void) {
    this.peers.set(id, { username, watching: null, send });
    send({
      type: "state",
      state: this.projectedState(),
      serverNow: Date.now(),
      peers: this.peerNames(),
    });
    this.broadcastPeers();
  }

  disconnect(id: string) {
    this.peers.delete(id);
    this.reconcileIdleRoom();
    this.broadcastPeers();
    this.broadcastState();
  }

  peerCount(): number {
    return this.peers.size;
  }

  peerNames(): string[] {
    return [...new Set([...this.peers.values()].map((p) => p.username))];
  }

  getState(): SyncState {
    return this.projectedState();
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
      case "join":
        peer.watching = msg.movieId;
        if (this.state.movieId !== msg.movieId) {
          this.state = {
            movieId: msg.movieId,
            playing: false,
            mediaTime: 0,
            updatedAt: Date.now(),
            updatedBy: peer.username,
            host: null,
          };
        }
        this.sendState(id);
        break;
      case "leave":
        peer.watching = null;
        this.reconcileIdleRoom();
        this.broadcastState();
        break;
      case "play":
      case "pause":
      case "seek": {
        if (msg.type === "play") {
          this.applyControl(peer.username, true, msg.mediaTime);
        } else if (msg.type === "pause") {
          this.applyControl(peer.username, false, msg.mediaTime);
        } else {
          this.applyControl(peer.username, msg.playing, msg.mediaTime);
        }
        this.persistProgress(peer.username);
        this.broadcastState();
        break;
      }
      case "heartbeat": {
        // Only the last controller soft-clocks — avoids dual teleport races.
        if (
          this.state.playing &&
          (!this.state.updatedBy ||
            this.state.updatedBy.toLowerCase() === peer.username.toLowerCase())
        ) {
          this.state.mediaTime = Math.max(0, msg.mediaTime);
          this.state.updatedAt = Date.now();
        }
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
        const payload: ServerMessage = {
          type: "reaction",
          emoji,
          from: peer.username,
          at: Date.now(),
        };
        for (const p of this.peers.values()) p.send(payload);
        break;
      }
      default:
        peer.send({ type: "error", message: "Unknown message" });
    }
  }

  private reconcileIdleRoom() {
    const anyoneWatching = [...this.peers.values()].some((p) => p.watching);
    if (!anyoneWatching) {
      this.state = defaultState();
    }
  }

  private persistProgress(by: string) {
    if (!this.state.movieId || !this.onProgress) return;
    this.onProgress(this.state.movieId, this.state.mediaTime, by);
  }

  private applyControl(username: string, playing: boolean, mediaTime: number) {
    this.state = {
      ...this.state,
      playing,
      mediaTime: Math.max(0, mediaTime),
      updatedAt: Date.now(),
      updatedBy: username,
      host: null,
    };
  }

  private projectedState(): SyncState {
    if (!this.state.playing) return { ...this.state };
    const elapsed = (Date.now() - this.state.updatedAt) / 1000;
    return {
      ...this.state,
      mediaTime: this.state.mediaTime + elapsed,
    };
  }

  private sendState(id: string) {
    const peer = this.peers.get(id);
    if (!peer) return;
    peer.send({
      type: "state",
      state: this.projectedState(),
      serverNow: Date.now(),
      peers: this.peerNames(),
    });
  }

  private broadcastState(exceptId?: string) {
    const payload: ServerMessage = {
      type: "state",
      state: this.projectedState(),
      serverNow: Date.now(),
      peers: this.peerNames(),
    };
    for (const [id, peer] of this.peers) {
      if (exceptId && id === exceptId) continue;
      peer.send(payload);
    }
  }

  private broadcastPeers() {
    const payload: ServerMessage = { type: "peers", peers: this.peerNames() };
    for (const peer of this.peers.values()) peer.send(payload);
  }
}

export const room = new SyncRoom();
