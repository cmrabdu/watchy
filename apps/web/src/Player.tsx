import { useCallback, useEffect, useRef, useState } from "react";
import type { Movie, SyncState } from "./api";
import { streamUrl, subtitleUrl } from "./api";
import { useI18n } from "./i18n";
import type { useSync } from "./useSync";

type SyncApi = ReturnType<typeof useSync>;

type Props = {
  movie: Movie;
  sync: SyncApi;
  username: string;
  startAt?: number | null;
};

/** Contrat docs/PROTOCOLE-SYNC.md — table de correction de derive. */
const DRIFT_DEADBAND = 0.3;
const DRIFT_RESOLVED = 0.15;
const DRIFT_SEEK = 2.5;
const RATE_FAST = 1.02;
const RATE_SLOW = 0.98;

const REACTIONS = ["❤️", "😂", "👀", "🔥", "👏", "😱"] as const;
const SUB_LANG_KEY = "watchy.subtitleLang";

type HlsLike = {
  destroy: () => void;
  loadSource: (src: string) => void;
  attachMedia: (video: HTMLMediaElement) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
};

type DriftInfo = { drift: number; state: "synced" | "catching" | "off" };

function maxSeekable(video: HTMLVideoElement): number | null {
  const { seekable } = video;
  if (!seekable || seekable.length === 0) return null;
  return seekable.end(seekable.length - 1);
}

function clampTime(video: HTMLVideoElement, t: number): number {
  const end = maxSeekable(video);
  if (end == null || !Number.isFinite(end)) return Math.max(0, t);
  return Math.max(0, Math.min(t, Math.max(0, end - 0.5)));
}

function fmtSeconds(v: number, lang: string): string {
  const txt = v.toFixed(1);
  return lang === "fr" ? txt.replace(".", ",") : txt;
}

function readPreferredSubLang(): string {
  try {
    return localStorage.getItem(SUB_LANG_KEY) ?? "off";
  } catch {
    return "off";
  }
}

function writePreferredSubLang(lang: string) {
  try {
    localStorage.setItem(SUB_LANG_KEY, lang);
  } catch {
    /* ignore */
  }
}

/** Choisit la piste correspondant a la langue preferee, sinon rien. */
function pickTrack(movie: Movie, lang: string): string {
  if (lang === "off") return "off";
  const hit = movie.subtitles.find(
    (s) => s.lang.toLowerCase() === lang.toLowerCase(),
  );
  return hit ? hit.id : "off";
}

export function Player({ movie, sync, username, startAt }: Props) {
  const { t, lang } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsLike | null>(null);
  const applyingRef = useRef(false);
  const applyGen = useRef(0);
  const resumedRef = useRef(false);
  const appliedRef = useRef<SyncState | null>(null);
  /** Position distante ancree a un instant local : c'est ce qui permet de
   *  projeter la position attendue entre deux messages du serveur. */
  const anchorRef = useRef<{
    mediaTime: number;
    playing: boolean;
    at: number;
  } | null>(null);
  const correctingRef = useRef(false);

  const [prefLang, setPrefLang] = useState<string>(() => readPreferredSubLang());
  const [trackId, setTrackId] = useState<string>(() =>
    pickTrack(movie, readPreferredSubLang()),
  );
  const [readyHint, setReadyHint] = useState<string | null>(null);
  const [drift, setDrift] = useState<DriftInfo | null>(null);
  const [blocked, setBlocked] = useState(false);

  // Source figee a l'ouverture : si l'encodage HLS se termine pendant la
  // seance, on ne detruit pas le lecteur sous leurs pieds.
  const [pinned, setPinned] = useState(() => ({
    id: movie.id,
    url: streamUrl(movie),
    hls: movie.hasHls,
    nonce: 0,
  }));
  if (pinned.id !== movie.id) {
    setPinned({
      id: movie.id,
      url: streamUrl(movie),
      hls: movie.hasHls,
      nonce: 0,
    });
  }
  const upgradeAvailable = streamUrl(movie) !== pinned.url;

  const lastBy = sync.state?.updatedBy;

  const peerStalled = sync.peers.find(
    (p) =>
      p.name.toLowerCase() !== username.toLowerCase() &&
      p.stalled &&
      p.watching === movie.id,
  );

  useEffect(() => {
    const lang = readPreferredSubLang();
    setPrefLang(lang);
    setTrackId(pickTrack(movie, lang));
    resumedRef.current = false;
    anchorRef.current = null;
    appliedRef.current = null;
    correctingRef.current = false;
    setBlocked(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [movie.id]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const src = pinned.url;
    let destroyed = false;
    hlsRef.current?.destroy();
    hlsRef.current = null;

    const setup = async () => {
      if (pinned.hls) {
        const HlsMod = await import("hls.js");
        const Hls = HlsMod.default;
        if (destroyed) return;
        if (Hls.isSupported()) {
          const instance = new Hls({
            enableWorker: true,
            liveSyncDurationCount: 3,
            liveMaxLatencyDurationCount: 20,
            maxLiveSyncPlaybackRate: 1,
            liveDurationInfinity: false,
            manifestLoadingTimeOut: 20000,
            levelLoadingTimeOut: 20000,
            maxBufferLength: 90,
            backBufferLength: 60,
          }) as unknown as HlsLike;
          instance.loadSource(src);
          instance.attachMedia(video);
          hlsRef.current = instance;
          return;
        }
        if (video.canPlayType("application/vnd.apple.mpegurl")) {
          video.src = src;
          return;
        }
      }
      video.src = src;
    };

    void setup();
    return () => {
      destroyed = true;
      hlsRef.current?.destroy();
      hlsRef.current = null;
      video.playbackRate = 1;
      video.removeAttribute("src");
      video.load();
    };
  }, [pinned.url, pinned.hls, pinned.nonce]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    for (const track of [...video.textTracks]) track.mode = "disabled";
    if (trackId === "off") return;
    const el = video.querySelector(
      `track[data-id="${CSS.escape(trackId)}"]`,
    ) as HTMLTrackElement | null;
    if (el?.track) el.track.mode = "showing";
  }, [trackId, movie.subtitles]);

  const chooseTrack = useCallback(
    (id: string) => {
      setTrackId(id);
      const lang =
        id === "off"
          ? "off"
          : (movie.subtitles.find((s) => s.id === id)?.lang ?? "off");
      setPrefLang(lang);
      writePreferredSubLang(lang);
    },
    [movie.subtitles],
  );

  useEffect(() => {
    const video = videoRef.current;
    if (!video || resumedRef.current) return;
    if (startAt == null || startAt < 15) return;
    const tryResume = () => {
      if (resumedRef.current) return;
      const end = maxSeekable(video);
      if (end == null || end < 2) return;
      resumedRef.current = true;
      applyingRef.current = true;
      const time = clampTime(video, startAt);
      video.currentTime = time;
      sync.seek(time, false);
      window.setTimeout(() => {
        applyingRef.current = false;
      }, 500);
    };
    video.addEventListener("loadedmetadata", tryResume);
    video.addEventListener("canplay", tryResume);
    tryResume();
    return () => {
      video.removeEventListener("loadedmetadata", tryResume);
      video.removeEventListener("canplay", tryResume);
    };
  }, [startAt, pinned.url, sync.seek]);

  /** Position attendue maintenant, projetee depuis l'ancre. */
  const expectedNow = useCallback((): number | null => {
    const a = anchorRef.current;
    if (!a) return null;
    if (!a.playing) return a.mediaTime;
    return a.mediaTime + (Date.now() - a.at) / 1000;
  }, []);

  const startPlayback = useCallback(async (): Promise<boolean> => {
    const video = videoRef.current;
    if (!video) return false;
    try {
      await video.play();
      setBlocked(false);
      return true;
    } catch (err) {
      const name = (err as { name?: string } | null)?.name;
      // NotAllowedError = pas d'activation utilisateur. Ne jamais avaler :
      // sinon elle regarde une image figee sans explication.
      if (name === "NotAllowedError" || name === "NotSupportedError") {
        setBlocked(true);
      }
      return false;
    }
  }, []);

  // Application de l'etat distant : transitions play/pause et gros ecarts.
  useEffect(() => {
    const video = videoRef.current;
    const remote = sync.state;
    if (!video || !remote || remote.movieId !== movie.id) return;
    if (appliedRef.current === remote) return;
    appliedRef.current = remote;
    if (
      remote.updatedBy?.toLowerCase() === username.toLowerCase() &&
      Date.now() < sync.ignoreUntil.current
    ) {
      return;
    }

    // Le serveur envoie un mediaTime deja projete a `serverNow` : on repart
    // de l'instant de reception pour continuer a le projeter localement.
    anchorRef.current = {
      mediaTime: remote.mediaTime,
      playing: remote.playing,
      at: sync.stateAt.current || Date.now(),
    };

    const gen = ++applyGen.current;

    const apply = async () => {
      applyingRef.current = true;
      try {
        const end = maxSeekable(video);
        const expected = expectedNow() ?? remote.mediaTime;
        if (end != null && expected > end + 0.75) {
          setReadyHint(t("waitingEncode", { sec: Math.floor(end) }));
          return;
        }
        setReadyHint(null);

        const target = clampTime(video, expected);
        const gap = Math.abs(video.currentTime - target);

        if (gap > DRIFT_SEEK) {
          video.playbackRate = 1;
          correctingRef.current = false;
          video.currentTime = target;
          await new Promise<void>((resolve) => {
            const done = () => {
              video.removeEventListener("seeked", done);
              resolve();
            };
            video.addEventListener("seeked", done);
            window.setTimeout(done, 1200);
          });
        }

        if (applyGen.current !== gen) return;

        if (remote.playing && video.paused) {
          const ok = await startPlayback();
          if (!ok) return;
        } else if (!remote.playing && !video.paused) {
          video.pause();
          video.playbackRate = 1;
          correctingRef.current = false;
        }
        sync.setStatus("synced");
      } finally {
        if (applyGen.current === gen) {
          window.setTimeout(() => {
            if (applyGen.current === gen) applyingRef.current = false;
          }, 250);
        }
      }
    };

    void apply();
  }, [
    sync.state,
    sync.ignoreUntil,
    sync.stateAt,
    sync.setStatus,
    movie.id,
    username,
    t,
    expectedNow,
    startPlayback,
  ]);

  // Correction douce continue + mesure honnete de la derive.
  useEffect(() => {
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const expected = expectedNow();
      if (expected == null || video.readyState < 1) {
        setDrift(null);
        return;
      }
      const diff = video.currentTime - expected;
      const abs = Math.abs(diff);

      const nextState: DriftInfo["state"] =
        abs < DRIFT_DEADBAND ? "synced" : abs < DRIFT_SEEK ? "catching" : "off";
      setDrift((prev) => {
        const rounded = Math.round(abs * 10) / 10;
        if (prev && prev.state === nextState && prev.drift === rounded) {
          return prev;
        }
        return { drift: rounded, state: nextState };
      });

      const anchor = anchorRef.current;
      if (!anchor?.playing || video.paused || video.seeking) {
        if (video.playbackRate !== 1) video.playbackRate = 1;
        correctingRef.current = false;
        return;
      }
      if (applyingRef.current) return;

      if (abs >= DRIFT_SEEK) {
        // Saut assume : au-dela de 2,5 s la vitesse ne rattrapera jamais.
        correctingRef.current = false;
        video.playbackRate = 1;
        applyingRef.current = true;
        video.currentTime = clampTime(video, expected);
        window.setTimeout(() => {
          applyingRef.current = false;
        }, 700);
        return;
      }

      if (correctingRef.current) {
        if (abs < DRIFT_RESOLVED) {
          video.playbackRate = 1;
          correctingRef.current = false;
        } else {
          const rate = diff < 0 ? RATE_FAST : RATE_SLOW;
          if (video.playbackRate !== rate) video.playbackRate = rate;
        }
        return;
      }

      if (abs >= DRIFT_DEADBAND) {
        correctingRef.current = true;
        video.playbackRate = diff < 0 ? RATE_FAST : RATE_SLOW;
      } else if (video.playbackRate !== 1) {
        video.playbackRate = 1;
      }
    }, 250);
    return () => window.clearInterval(id);
  }, [expectedNow]);

  // Filet de securite : jamais de playbackRate coince au demontage.
  useEffect(() => {
    const video = videoRef.current;
    return () => {
      if (video) video.playbackRate = 1;
    };
  }, []);

  useEffect(() => {
    const id = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      if (applyingRef.current) return;
      if (video.paused) return;
      sync.heartbeat(video.currentTime, true);
    }, 4000);
    return () => window.clearInterval(id);
  }, [sync.heartbeat]);

  const emit = (fn: () => void) => {
    if (applyingRef.current) return;
    fn();
  };

  return (
    <div className="player-stack">
      <div className="player-wrap">
        <video
          ref={videoRef}
          controls
          playsInline
          preload="auto"
          crossOrigin="use-credentials"
          onPlay={() => {
            setBlocked(false);
            emit(() => {
              const v = videoRef.current!;
              sync.play(clampTime(v, v.currentTime));
            });
          }}
          onPause={() => {
            // Verrouillage d'ecran ou appel entrant : le navigateur met en
            // pause. Ne pas propager, sinon l'autre est arrete sans raison.
            if (document.visibilityState === "hidden") return;
            emit(() => {
              const v = videoRef.current!;
              if (v.readyState < 3 && !v.seeking) return;
              const end = maxSeekable(v);
              if (end != null && v.currentTime >= end - 0.6) return;
              v.playbackRate = 1;
              correctingRef.current = false;
              sync.pause(clampTime(v, v.currentTime));
            });
          }}
          onSeeked={() => {
            emit(() => {
              const v = videoRef.current!;
              const expected = expectedNow();
              if (expected != null && Math.abs(v.currentTime - expected) < 1.2) {
                return;
              }
              v.playbackRate = 1;
              correctingRef.current = false;
              sync.seek(clampTime(v, v.currentTime), !v.paused);
            });
          }}
          onWaiting={() => {
            setReadyHint(t("buffering"));
            sync.stall(true);
          }}
          onPlaying={() => {
            setReadyHint(null);
            sync.stall(false);
          }}
        >
          {movie.subtitles.map((tr) => (
            <track
              key={tr.id}
              data-id={tr.id}
              kind="subtitles"
              srcLang={tr.lang === "und" ? "" : tr.lang}
              label={tr.label}
              src={subtitleUrl(tr)}
            />
          ))}
        </video>

        <div className="reaction-layer" aria-live="polite">
          {sync.reactions.map((r) => {
            const mine = r.from.toLowerCase() === username.toLowerCase();
            return (
              <span key={r.id} className="reaction-bubble">
                <span className="reaction-emoji">{r.emoji}</span>
                {!mine && <span className="reaction-from">{r.from}</span>}
              </span>
            );
          })}
        </div>
      </div>

      {blocked && (
        <div className="play-blocked">
          <span>{t("playBlocked")}</span>
          <button
            type="button"
            className="primary-btn"
            onClick={() => void startPlayback()}
          >
            {t("tapToJoin")}
          </button>
        </div>
      )}

      <div className="player-tools">
        <span
          className="sync-badge"
          data-state={
            drift == null
              ? "idle"
              : drift.state === "synced"
                ? "synced"
                : drift.state === "catching"
                  ? "resync"
                  : "offline"
          }
        >
          {drift == null
            ? t("sharedControl")
            : drift.state === "synced"
              ? t("driftSynced", { d: fmtSeconds(drift.drift, lang) })
              : drift.state === "catching"
                ? t("driftCatching", { d: fmtSeconds(drift.drift, lang) })
                : t("driftOff", { d: fmtSeconds(drift.drift, lang) })}
          {lastBy ? ` · ${t("lastBy")} : ${lastBy}` : ""}
        </span>
        {peerStalled && (
          <span className="sub-hint peer-stalled">
            {t("peerLoading", { name: peerStalled.name })}
          </span>
        )}
        {readyHint && <span className="sub-hint">{readyHint}</span>}
        {upgradeAvailable && (
          <button
            type="button"
            className="ghost-btn"
            onClick={() =>
              setPinned({
                id: movie.id,
                url: streamUrl(movie),
                hls: movie.hasHls,
                nonce: pinned.nonce + 1,
              })
            }
          >
            {t("sourceUpgraded")}
          </button>
        )}

        <div className="reaction-bar">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="reaction-btn"
              onClick={() => sync.react(emoji)}
            >
              {emoji}
            </button>
          ))}
        </div>

        <button
          type="button"
          className="ghost-btn"
          onClick={() => location.reload()}
        >
          {t("refreshMe")}
        </button>
        <button
          type="button"
          className="ghost-btn"
          onClick={() => sync.reloadAll()}
        >
          {t("refreshAll")}
        </button>

        <label className="sub-select">
          <span>{t("subtitles")}</span>
          <select value={trackId} onChange={(e) => chooseTrack(e.target.value)}>
            <option value="off">{t("subsOff")}</option>
            {movie.subtitles.map((tr) => (
              <option key={tr.id} value={tr.id}>
                {tr.label}
              </option>
            ))}
          </select>
        </label>
        {prefLang !== "off" && trackId === "off" && (
          <span className="sub-hint">{t("subPrefMissing", { lang: prefLang })}</span>
        )}
      </div>
    </div>
  );
}
