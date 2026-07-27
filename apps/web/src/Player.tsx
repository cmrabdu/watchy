import { useEffect, useRef, useState } from "react";
import type { Movie } from "./api";
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

const SEEK_THRESHOLD = 2.8;
const DRIFT_IGNORE = 1.6;
const REACTIONS = ["❤️", "😂", "👀", "🔥", "👏", "😱"] as const;

type HlsLike = {
  destroy: () => void;
  loadSource: (src: string) => void;
  attachMedia: (video: HTMLMediaElement) => void;
  on: (event: string, cb: (...args: unknown[]) => void) => void;
};

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

export function Player({ movie, sync, username, startAt }: Props) {
  const { t } = useI18n();
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<HlsLike | null>(null);
  const applyingRef = useRef(false);
  const applyGen = useRef(0);
  const resumedRef = useRef(false);
  const [trackId, setTrackId] = useState<string>("off");
  const [readyHint, setReadyHint] = useState<string | null>(null);

  const mediaKey = `${movie.id}|${streamUrl(movie)}`;
  const lastBy = sync.state?.updatedBy;

  useEffect(() => {
    setTrackId("off");
    resumedRef.current = false;
  }, [movie.id]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const src = streamUrl(movie);
    let destroyed = false;
    hlsRef.current?.destroy();
    hlsRef.current = null;

    const setup = async () => {
      if (movie.hasHls) {
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
      video.removeAttribute("src");
      video.load();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mediaKey]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    for (const track of [...video.textTracks]) track.mode = "disabled";
    if (trackId === "off") return;
    const el = video.querySelector(
      `track[data-id="${CSS.escape(trackId)}"]`,
    ) as HTMLTrackElement | null;
    if (el?.track) el.track.mode = "showing";
  }, [trackId]);

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
  }, [startAt, mediaKey, sync]);

  useEffect(() => {
    const video = videoRef.current;
    const remote = sync.state;
    if (!video || !remote || remote.movieId !== movie.id) return;
    if (
      remote.updatedBy?.toLowerCase() === username.toLowerCase() &&
      Date.now() < sync.ignoreUntil.current
    ) {
      return;
    }

    const gen = ++applyGen.current;

    const apply = async () => {
      applyingRef.current = true;
      try {
        const end = maxSeekable(video);
        if (end != null && remote.mediaTime > end + 0.75) {
          setReadyHint(t("waitingEncode", { sec: Math.floor(end) }));
          return;
        }
        setReadyHint(null);

        const target = clampTime(video, remote.mediaTime);
        const drift = Math.abs(video.currentTime - target);

        if (drift > SEEK_THRESHOLD) {
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
          await video.play().catch(() => undefined);
        } else if (!remote.playing && !video.paused) {
          video.pause();
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
  }, [sync.state, movie.id, sync, username, t]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const id = window.setInterval(() => {
      if (!sync.state?.playing) return;
      if (applyingRef.current) return;
      if (video.paused) return;
      sync.heartbeat(video.currentTime, true);
    }, 4000);
    return () => clearInterval(id);
  }, [sync, sync.state?.playing]);

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
            emit(() => {
              const v = videoRef.current!;
              sync.play(clampTime(v, v.currentTime));
            });
          }}
          onPause={() => {
            emit(() => {
              const v = videoRef.current!;
              if (v.readyState < 3 && !v.seeking) return;
              const end = maxSeekable(v);
              if (end != null && v.currentTime >= end - 0.6) return;
              sync.pause(clampTime(v, v.currentTime));
            });
          }}
          onSeeked={() => {
            emit(() => {
              const v = videoRef.current!;
              const remote = sync.state?.mediaTime ?? v.currentTime;
              if (Math.abs(v.currentTime - remote) < DRIFT_IGNORE) return;
              sync.seek(clampTime(v, v.currentTime), !v.paused);
            });
          }}
          onWaiting={() => setReadyHint(t("buffering"))}
          onPlaying={() => setReadyHint(null)}
        >
          {movie.subtitles.map((tr) => (
            <track
              key={tr.id}
              data-id={tr.id}
              kind="subtitles"
              srcLang={tr.lang === "und" ? "fr" : tr.lang}
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

      <div className="player-tools">
        <span className="sync-badge" data-state="synced">
          {t("sharedControl")}
          {lastBy ? ` · ${t("lastBy")} : ${lastBy}` : ""}
        </span>
        {readyHint && <span className="sub-hint">{readyHint}</span>}

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
          <select value={trackId} onChange={(e) => setTrackId(e.target.value)}>
            <option value="off">{t("subsOff")}</option>
            {movie.subtitles.map((tr) => (
              <option key={tr.id} value={tr.id}>
                {tr.label}
              </option>
            ))}
          </select>
        </label>
      </div>
    </div>
  );
}
