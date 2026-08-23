import { useCallback, useEffect, useRef, useState } from "react";
import type { Movie, SyncState } from "./api";
import { streamUrl, subtitleUrl } from "./api";
import { useI18n } from "./i18n";
import { PlayerControls, persistVolume, type QualityLevel } from "./PlayerControls";
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
const UI_IDLE_MS = 3200;

type HlsLevel = { height?: number; bitrate?: number; name?: string };

type HlsLike = {
  destroy: () => void;
  loadSource: (src: string) => void;
  attachMedia: (video: HTMLMediaElement) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
  levels: HlsLevel[];
  currentLevel: number;
  autoLevelEnabled?: boolean;
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

function levelLabel(l: HlsLevel): string {
  if (l.height) return `${l.height}p`;
  if (l.name) return l.name;
  if (l.bitrate) return `${Math.round(l.bitrate / 1000)} kb/s`;
  return "?";
}

export function Player({ movie, sync, username, startAt }: Props) {
  const { t, lang } = useI18n();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
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
  const idleTimer = useRef<number | undefined>(undefined);

  const [prefLang, setPrefLang] = useState<string>(() => readPreferredSubLang());
  const [trackId, setTrackId] = useState<string>(() =>
    pickTrack(movie, readPreferredSubLang()),
  );
  const [readyHint, setReadyHint] = useState<string | null>(null);
  const [drift, setDrift] = useState<DriftInfo | null>(null);
  const [blocked, setBlocked] = useState(false);
  const [uiVisible, setUiVisible] = useState(true);
  const [fullscreen, setFullscreen] = useState(false);
  const [pseudoFs, setPseudoFs] = useState(false);
  const [levels, setLevels] = useState<QualityLevel[]>([]);
  const [levelId, setLevelId] = useState(-1);
  const [paused, setPaused] = useState(true);

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

  const others = sync.peers.filter(
    (p) => p.name.toLowerCase() !== username.toLowerCase(),
  );
  const peerStalled = others.find((p) => p.stalled && p.watching === movie.id);
  const peerAway = others.find((p) => p.away);
  const peerHere = others.find((p) => p.watching === movie.id);

  useEffect(() => {
    const pref = readPreferredSubLang();
    setPrefLang(pref);
    setTrackId(pickTrack(movie, pref));
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
    setLevels([]);
    setLevelId(-1);

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
          const publish = (activeIdx: number) => {
            setLevels(
              instance.levels.map((l, i) => ({
                id: i,
                label: levelLabel(l),
                active: i === activeIdx,
              })),
            );
          };
          instance.on("hlsManifestParsed", () => {
            publish(instance.currentLevel);
          });
          instance.on("hlsLevelSwitched", (...args: unknown[]) => {
            const data = args[1] as { level?: number } | undefined;
            publish(data?.level ?? instance.currentLevel);
          });
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
      const chosen =
        id === "off"
          ? "off"
          : (movie.subtitles.find((s) => s.id === id)?.lang ?? "off");
      setPrefLang(chosen);
      writePreferredSubLang(chosen);
    },
    [movie.subtitles],
  );

  const chooseLevel = useCallback((id: number) => {
    setLevelId(id);
    const hls = hlsRef.current;
    if (hls) hls.currentLevel = id;
  }, []);

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

  /* ----- Interface : visibilite, plein ecran, clavier ----- */

  const bumpUi = useCallback(() => {
    setUiVisible(true);
    window.clearTimeout(idleTimer.current);
    const video = videoRef.current;
    if (video && !video.paused) {
      idleTimer.current = window.setTimeout(
        () => setUiVisible(false),
        UI_IDLE_MS,
      );
    }
  }, []);

  useEffect(() => {
    if (paused) {
      window.clearTimeout(idleTimer.current);
      setUiVisible(true);
    } else {
      bumpUi();
    }
  }, [paused, bumpUi]);

  useEffect(() => () => window.clearTimeout(idleTimer.current), []);

  const togglePlay = useCallback(() => {
    const video = videoRef.current;
    if (!video) return;
    bumpUi();
    if (video.paused) void startPlayback();
    else video.pause();
  }, [bumpUi, startPlayback]);

  const seekTo = useCallback(
    (time: number) => {
      const video = videoRef.current;
      if (!video) return;
      bumpUi();
      video.playbackRate = 1;
      correctingRef.current = false;
      video.currentTime = clampTime(video, time);
    },
    [bumpUi],
  );

  const toggleFullscreen = useCallback(() => {
    const el = wrapRef.current;
    if (!el) return;
    bumpUi();
    if (document.fullscreenElement) {
      void document.exitFullscreen().catch(() => undefined);
      return;
    }
    if (pseudoFs) {
      setPseudoFs(false);
      return;
    }
    if (typeof el.requestFullscreen === "function") {
      el.requestFullscreen({ navigationUI: "hide" }).catch(() => {
        // iPhone : pas de plein ecran sur un div. On simule, sinon la
        // surimpression (reactions, presence) disparaitrait justement au
        // moment ou elle sert.
        setPseudoFs(true);
      });
      return;
    }
    setPseudoFs(true);
  }, [bumpUi, pseudoFs]);

  useEffect(() => {
    const onChange = () =>
      setFullscreen(document.fullscreenElement === wrapRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "SELECT" ||
          target.isContentEditable)
      ) {
        return;
      }
      const video = videoRef.current;
      if (!video) return;
      switch (e.key) {
        case " ":
        case "k":
          e.preventDefault();
          togglePlay();
          break;
        case "ArrowLeft":
          e.preventDefault();
          seekTo(video.currentTime - (e.shiftKey ? 60 : 10));
          break;
        case "ArrowRight":
          e.preventDefault();
          seekTo(video.currentTime + (e.shiftKey ? 60 : 10));
          break;
        case "ArrowUp":
          e.preventDefault();
          video.volume = Math.min(1, video.volume + 0.05);
          video.muted = false;
          persistVolume(video.volume, false);
          bumpUi();
          break;
        case "ArrowDown":
          e.preventDefault();
          video.volume = Math.max(0, video.volume - 0.05);
          persistVolume(video.volume, video.muted);
          bumpUi();
          break;
        case "f":
          e.preventDefault();
          toggleFullscreen();
          break;
        case "m":
          e.preventDefault();
          video.muted = !video.muted;
          persistVolume(video.volume, video.muted);
          bumpUi();
          break;
        default:
          break;
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [togglePlay, seekTo, toggleFullscreen, bumpUi]);

  const driftState =
    drift == null
      ? "idle"
      : drift.state === "synced"
        ? "synced"
        : drift.state === "catching"
          ? "resync"
          : "offline";

  const driftText =
    drift == null
      ? t("sharedControl")
      : drift.state === "synced"
        ? t("driftSynced", { d: fmtSeconds(drift.drift, lang) })
        : drift.state === "catching"
          ? t("driftCatching", { d: fmtSeconds(drift.drift, lang) })
          : t("driftOff", { d: fmtSeconds(drift.drift, lang) });

  const presenceText = peerStalled
    ? t("peerLoading", { name: peerStalled.name })
    : peerAway
      ? `${t("peerAway", { name: peerAway.name })}${
          peerAway.awayReason ? ` — ${peerAway.awayReason}` : ""
        }`
      : peerHere
        ? t("peerWatchingWith", { name: peerHere.name })
        : others.length
          ? t("peerInCatalog", { name: others[0].name })
          : t("nobodyElse");

  return (
    <div className="player-stack">
      <div
        className="player-wrap"
        ref={wrapRef}
        data-ui={uiVisible ? "on" : "off"}
        data-fs={fullscreen ? "real" : pseudoFs ? "pseudo" : "off"}
        onPointerMove={bumpUi}
        onPointerDown={bumpUi}
        onTouchStart={bumpUi}
      >
        <video
          ref={(el) => {
            videoRef.current = el;
            setVideoEl(el);
          }}
          playsInline
          preload="auto"
          crossOrigin="use-credentials"
          onClick={() => {
            // Sur telephone, la premiere touche revele les commandes ;
            // la seconde joue ou met en pause.
            if (!uiVisible) bumpUi();
            else togglePlay();
          }}
          onDoubleClick={toggleFullscreen}
          onPlay={() => {
            setPaused(false);
            setBlocked(false);
            emit(() => {
              const v = videoRef.current!;
              sync.play(clampTime(v, v.currentTime));
            });
          }}
          onPause={() => {
            setPaused(true);
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

        <div className="v-top" data-visible={uiVisible ? "yes" : "no"}>
          <span className="v-title">{movie.title}</span>
          <span className="v-presence" data-state={peerStalled ? "wait" : "ok"}>
            <span className="dot" />
            {presenceText}
          </span>
          <span className="v-sync" data-state={driftState}>
            {driftText}
          </span>
        </div>

        {readyHint && <div className="v-toast">{readyHint}</div>}

        {blocked && (
          <div className="v-blocked">
            <p>{t("playBlocked")}</p>
            <button
              type="button"
              className="primary-btn"
              onClick={() => void startPlayback()}
            >
              {t("tapToJoin")}
            </button>
          </div>
        )}

        {paused && !blocked && (
          <button
            type="button"
            className="v-bigplay"
            onClick={togglePlay}
            aria-label={t("play")}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
            </svg>
          </button>
        )}

        <PlayerControls
          video={videoEl}
          visible={uiVisible}
          onActivity={bumpUi}
          onTogglePlay={togglePlay}
          onSeekTo={seekTo}
          fullscreen={fullscreen || pseudoFs}
          onToggleFullscreen={toggleFullscreen}
          subtitles={movie.subtitles.map((s) => ({ id: s.id, label: s.label }))}
          trackId={trackId}
          onTrack={chooseTrack}
          levels={levels}
          levelId={levelId}
          onLevel={chooseLevel}
          reactions={REACTIONS}
          onReact={(emoji) => sync.react(emoji)}
        />
      </div>

      <div className="player-tools">
        <span className="sync-badge" data-state={driftState}>
          {driftText}
          {lastBy ? ` · ${t("lastBy")} : ${lastBy}` : ""}
        </span>
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
        {prefLang !== "off" && trackId === "off" && (
          <span className="sub-hint">
            {t("subPrefMissing", { lang: prefLang })}
          </span>
        )}
      </div>
    </div>
  );
}
