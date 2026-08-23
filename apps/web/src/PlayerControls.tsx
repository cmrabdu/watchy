import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { useI18n } from "./i18n";

export type QualityLevel = { id: number; label: string; active: boolean };

type Props = {
  video: HTMLVideoElement | null;
  /** Duree connue du serveur, le temps que le manifeste HLS se charge. */
  fallbackDuration?: number;
  visible: boolean;
  onActivity: () => void;
  /** Hauteur reelle de la barre, pour poser les sous-titres juste au-dessus. */
  onHeight?: (px: number) => void;
  onTogglePlay: () => void;
  onSeekTo: (t: number) => void;
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  subtitles: { id: string; label: string }[];
  trackId: string;
  onTrack: (id: string) => void;
  /** Panneau reglages sous-titres (lot 4) rendu dans le menu. */
  subtitleExtras?: ReactNode;
  levels: QualityLevel[];
  levelId: number;
  onLevel: (id: number) => void;
  reactions: readonly string[];
  onReact: (emoji: string) => void;
  extraLeft?: ReactNode;
};

const VOLUME_KEY = "watchy.volume";

function useMediaQuery(query: string): boolean {
  const [match, setMatch] = useState(() =>
    typeof window !== "undefined" && typeof window.matchMedia === "function"
      ? window.matchMedia(query).matches
      : false,
  );
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(query);
    const on = () => setMatch(mq.matches);
    on();
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, [query]);
  return match;
}

export function formatClock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "0:00";
  const s = Math.floor(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const mm = h > 0 ? String(m).padStart(2, "0") : String(m);
  return h > 0
    ? `${h}:${mm}:${String(r).padStart(2, "0")}`
    : `${mm}:${String(r).padStart(2, "0")}`;
}

export function persistVolume(volume: number, muted: boolean) {
  try {
    localStorage.setItem(VOLUME_KEY, JSON.stringify({ volume, muted }));
  } catch {
    /* ignore */
  }
}

function readVolume(): { volume: number; muted: boolean } {
  try {
    const raw = localStorage.getItem(VOLUME_KEY);
    if (raw) {
      const p = JSON.parse(raw) as { volume?: number; muted?: boolean };
      return {
        volume: typeof p.volume === "number" ? Math.min(1, Math.max(0, p.volume)) : 1,
        muted: Boolean(p.muted),
      };
    }
  } catch {
    /* ignore */
  }
  return { volume: 1, muted: false };
}

export function PlayerControls({
  video,
  fallbackDuration,
  visible,
  onActivity,
  onHeight,
  onTogglePlay,
  onSeekTo,
  fullscreen,
  onToggleFullscreen,
  subtitles,
  trackId,
  onTrack,
  subtitleExtras,
  levels,
  levelId,
  onLevel,
  reactions,
  onReact,
  extraLeft,
}: Props) {
  const { t } = useI18n();
  const [current, setCurrent] = useState(0);
  const [duration, setDuration] = useState(fallbackDuration ?? 0);
  const [buffered, setBuffered] = useState(0);
  const [paused, setPaused] = useState(true);
  const [volume, setVolume] = useState(() => readVolume().volume);
  const [muted, setMuted] = useState(() => readVolume().muted);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState<{ x: number; time: number } | null>(null);
  const [menu, setMenu] = useState<"none" | "subs" | "quality" | "react">(
    "none",
  );
  const barRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Sur telephone la rangee ne tient pas : les reactions passent dans un
  // menu, sinon les sous-titres et le plein ecran sortent de l'ecran.
  const compact = useMediaQuery("(max-width: 720px)");

  useEffect(() => {
    const el = rootRef.current;
    if (!el || !onHeight) return;
    onHeight(el.offsetHeight);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(() => onHeight(el.offsetHeight));
    ro.observe(el);
    return () => ro.disconnect();
  }, [onHeight, compact]);

  // Etat lu depuis l'element video : les controles se rafraichissent seuls,
  // sans re-rendre tout le lecteur ni la page.
  useEffect(() => {
    if (!video) return;
    const onTime = () => setCurrent(video.currentTime);
    const onMeta = () => {
      setDuration(
        Number.isFinite(video.duration) && video.duration > 0
          ? video.duration
          : (fallbackDuration ?? 0),
      );
      setCurrent(video.currentTime);
    };
    const onState = () => setPaused(video.paused);
    const onProgress = () => {
      const b = video.buffered;
      if (!b || b.length === 0) return;
      setBuffered(b.end(b.length - 1));
    };
    const onVol = () => {
      setVolume(video.volume);
      setMuted(video.muted);
    };
    onMeta();
    onState();
    onVol();
    video.addEventListener("timeupdate", onTime);
    video.addEventListener("durationchange", onMeta);
    video.addEventListener("loadedmetadata", onMeta);
    video.addEventListener("play", onState);
    video.addEventListener("pause", onState);
    video.addEventListener("progress", onProgress);
    video.addEventListener("volumechange", onVol);
    return () => {
      video.removeEventListener("timeupdate", onTime);
      video.removeEventListener("durationchange", onMeta);
      video.removeEventListener("loadedmetadata", onMeta);
      video.removeEventListener("play", onState);
      video.removeEventListener("pause", onState);
      video.removeEventListener("progress", onProgress);
      video.removeEventListener("volumechange", onVol);
    };
  }, [video, fallbackDuration]);

  // Volume memorise d'une soiree a l'autre.
  useEffect(() => {
    if (!video) return;
    const pref = readVolume();
    video.volume = pref.volume;
    video.muted = pref.muted;
  }, [video]);

  const applyVolume = useCallback(
    (v: number, m: boolean) => {
      if (video) {
        video.volume = v;
        video.muted = m;
      }
      setVolume(v);
      setMuted(m);
      persistVolume(v, m);
    },
    [video],
  );

  const timeFromEvent = useCallback(
    (clientX: number): { time: number; ratio: number } => {
      const el = barRef.current;
      if (!el || !duration) return { time: 0, ratio: 0 };
      const rect = el.getBoundingClientRect();
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
      return { time: ratio * duration, ratio };
    },
    [duration],
  );

  const onBarDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const { time } = timeFromEvent(e.clientX);
    setScrub(time);
    onActivity();
  };

  const onBarMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    const { time } = timeFromEvent(e.clientX);
    const rect = barRef.current!.getBoundingClientRect();
    setHover({ x: e.clientX - rect.left, time });
    if (scrub != null) setScrub(time);
  };

  const onBarUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (scrub == null) return;
    const { time } = timeFromEvent(e.clientX);
    setScrub(null);
    onSeekTo(time);
    onActivity();
  };

  const shown = scrub ?? current;
  const pct = duration ? (shown / duration) * 100 : 0;
  const bufPct = duration ? Math.min(100, (buffered / duration) * 100) : 0;
  const remaining = duration ? duration - shown : 0;

  const closeMenus = () => setMenu("none");

  return (
    <div
      className="v-controls"
      ref={rootRef}
      data-compact={compact ? "yes" : "no"}
      data-visible={visible ? "yes" : "no"}
      onPointerMove={onActivity}
      onPointerDown={onActivity}
    >
      <div
        className="v-scrub"
        ref={barRef}
        role="slider"
        tabIndex={-1}
        aria-label={t("progress")}
        aria-valuemin={0}
        aria-valuemax={Math.round(duration)}
        aria-valuenow={Math.round(shown)}
        aria-valuetext={formatClock(shown)}
        onPointerDown={onBarDown}
        onPointerMove={onBarMove}
        onPointerUp={onBarUp}
        onPointerCancel={onBarUp}
        onPointerLeave={() => setHover(null)}
      >
        <div className="v-scrub-track">
          <div className="v-scrub-buffer" style={{ width: `${bufPct}%` }} />
          <div className="v-scrub-play" style={{ width: `${pct}%` }} />
          <div className="v-scrub-thumb" style={{ left: `${pct}%` }} />
        </div>
        {hover && duration > 0 && (
          <span className="v-scrub-tip" style={{ left: `${hover.x}px` }}>
            {formatClock(hover.time)}
          </span>
        )}
      </div>

      <div className="v-row">
        <button
          type="button"
          className="v-btn v-btn-main"
          onClick={onTogglePlay}
          aria-label={paused ? t("play") : t("pause")}
          title={paused ? t("play") : t("pause")}
        >
          {paused ? <IconPlay /> : <IconPause />}
        </button>

        <button
          type="button"
          className="v-btn"
          onClick={() => onSeekTo(Math.max(0, current - 10))}
          aria-label={t("back10")}
          title={t("back10")}
        >
          <IconBack10 />
        </button>
        <button
          type="button"
          className="v-btn"
          onClick={() => onSeekTo(Math.min(duration || current, current + 10))}
          aria-label={t("fwd10")}
          title={t("fwd10")}
        >
          <IconFwd10 />
        </button>

        <span className="v-time">
          {formatClock(shown)}
          <span className="v-time-sep"> / </span>
          <span className="v-time-total">{formatClock(duration)}</span>
          {duration > 0 && (
            <span className="v-time-left"> · -{formatClock(remaining)}</span>
          )}
        </span>

        <span className="v-spacer">{extraLeft}</span>

        <div className="v-volume">
          <button
            type="button"
            className="v-btn"
            onClick={() => applyVolume(volume, !muted)}
            aria-label={muted ? t("unmute") : t("mute")}
            title={muted ? t("unmute") : t("mute")}
          >
            {muted || volume === 0 ? <IconMuted /> : <IconVolume />}
          </button>
          <input
            className="v-volume-slider"
            type="range"
            min={0}
            max={1}
            step={0.02}
            value={muted ? 0 : volume}
            aria-label={t("volume")}
            onChange={(e) => {
              const v = Number(e.target.value);
              applyVolume(v, v === 0);
            }}
          />
        </div>

        {compact ? (
          <div className="v-menu-holder">
            <button
              type="button"
              className="v-btn v-btn-emoji"
              onClick={() => setMenu((m) => (m === "react" ? "none" : "react"))}
              aria-label={t("reactions")}
              aria-expanded={menu === "react"}
            >
              {reactions[0]}
            </button>
            {menu === "react" && (
              <div className="v-menu v-menu-react" role="menu">
                {reactions.map((emoji) => (
                  <button
                    key={emoji}
                    type="button"
                    className="v-react"
                    onClick={() => {
                      onReact(emoji);
                      onActivity();
                      closeMenus();
                    }}
                    aria-label={t("sendReaction", { emoji })}
                  >
                    {emoji}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : (
          <div className="v-reactions">
            {reactions.map((emoji) => (
              <button
                key={emoji}
                type="button"
                className="v-react"
                onClick={() => {
                  onReact(emoji);
                  onActivity();
                }}
                aria-label={t("sendReaction", { emoji })}
              >
                {emoji}
              </button>
            ))}
          </div>
        )}

        <div className="v-menu-holder">
          <button
            type="button"
            className={`v-btn${trackId !== "off" ? " is-on" : ""}`}
            onClick={() => setMenu((m) => (m === "subs" ? "none" : "subs"))}
            aria-label={t("subtitles")}
            title={t("subtitles")}
            aria-expanded={menu === "subs"}
          >
            <IconCc />
          </button>
          {menu === "subs" && (
            <div className="v-menu" role="menu">
              <div className="v-menu-title">{t("subtitles")}</div>
              <button
                type="button"
                role="menuitemradio"
                aria-checked={trackId === "off"}
                className={trackId === "off" ? "is-active" : ""}
                onClick={() => {
                  onTrack("off");
                  closeMenus();
                }}
              >
                {t("subsOff")}
              </button>
              {subtitles.map((s) => (
                <button
                  key={s.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={trackId === s.id}
                  className={trackId === s.id ? "is-active" : ""}
                  onClick={() => {
                    onTrack(s.id);
                    closeMenus();
                  }}
                >
                  {s.label}
                </button>
              ))}
              {subtitleExtras}
            </div>
          )}
        </div>

        {levels.length > 0 && (
          <div className="v-menu-holder">
            <button
              type="button"
              className="v-btn v-btn-text"
              onClick={() =>
                setMenu((m) => (m === "quality" ? "none" : "quality"))
              }
              aria-label={t("quality")}
              title={t("quality")}
              aria-expanded={menu === "quality"}
            >
              {levelId === -1
                ? t("qualityAutoShort")
                : (levels.find((l) => l.id === levelId)?.label ?? "—")}
            </button>
            {menu === "quality" && (
              <div className="v-menu" role="menu">
                <div className="v-menu-title">{t("quality")}</div>
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={levelId === -1}
                  className={levelId === -1 ? "is-active" : ""}
                  onClick={() => {
                    onLevel(-1);
                    closeMenus();
                  }}
                >
                  {t("qualityAuto")}
                  {levels.find((l) => l.active) && levelId === -1
                    ? ` · ${levels.find((l) => l.active)!.label}`
                    : ""}
                </button>
                {levels.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    role="menuitemradio"
                    aria-checked={levelId === l.id}
                    className={levelId === l.id ? "is-active" : ""}
                    onClick={() => {
                      onLevel(l.id);
                      closeMenus();
                    }}
                  >
                    {l.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        <button
          type="button"
          className="v-btn"
          onClick={onToggleFullscreen}
          aria-label={fullscreen ? t("exitFullscreen") : t("fullscreen")}
          title={fullscreen ? t("exitFullscreen") : t("fullscreen")}
        >
          {fullscreen ? <IconExitFs /> : <IconFs />}
        </button>
      </div>
    </div>
  );
}

/* --- Icones inline : aucune dependance externe, lisibles sur fond noir. --- */

function IconPlay() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M8 5.5v13l11-6.5z" fill="currentColor" />
    </svg>
  );
}

function IconPause() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 5h3.4v14H7zM13.6 5H17v14h-3.4z" fill="currentColor" />
    </svg>
  );
}

function IconBack10() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 6V3L7 7l5 4V8a5.5 5.5 0 1 1-5.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="7"
        fill="currentColor"
        fontFamily="inherit"
      >
        10
      </text>
    </svg>
  );
}

function IconFwd10() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M12 6V3l5 4-5 4V8a5.5 5.5 0 1 0 5.5 5.5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
      <text
        x="12"
        y="17"
        textAnchor="middle"
        fontSize="7"
        fill="currentColor"
        fontFamily="inherit"
      >
        10
      </text>
    </svg>
  );
}

function IconVolume() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" fill="currentColor" />
      <path
        d="M15.5 9a4 4 0 0 1 0 6M18 6.5a7.5 7.5 0 0 1 0 11"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconMuted() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d="M4 9.5h3.5L12 5.5v13L7.5 14.5H4z" fill="currentColor" />
      <path
        d="M16 9.5l5 5M21 9.5l-5 5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconCc() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <rect
        x="3"
        y="5.5"
        width="18"
        height="13"
        rx="3"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
      />
      <path
        d="M10 10.4a2.4 2.4 0 1 0 0 3.2M17 10.4a2.4 2.4 0 1 0 0 3.2"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconFs() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

function IconExitFs() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}
