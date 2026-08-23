import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type FormEvent,
} from "react";
import {
  deleteMovie,
  fetchMovies,
  formatBytes,
  login,
  logout,
  me,
  type Movie,
  type User,
} from "./api";
import { EditMovie } from "./EditMovie";
import { LangToggle, SiteCredit, useI18n } from "./i18n";
import { Player } from "./Player";
import { PosterImage } from "./PosterImage";
import { UploadDropzone } from "./UploadDropzone";
import { useSync, type PeerInfo } from "./useSync";

/** Routage minimal : #/movie/:id, pour survivre a un F5. */
function movieIdFromHash(): string | null {
  const m = /^#\/movie\/(.+)$/.exec(location.hash);
  return m ? decodeURIComponent(m[1]) : null;
}

function goToMovie(id: string) {
  location.hash = `#/movie/${encodeURIComponent(id)}`;
}

function goToCatalog() {
  location.hash = "#/";
}

export function App() {
  const { t } = useI18n();
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [movies, setMovies] = useState<Movie[]>([]);
  const [restPeers, setRestPeers] = useState<string[]>([]);
  const [routeId, setRouteId] = useState<string | null>(() => movieIdFromHash());
  const [resumeAt, setResumeAt] = useState<number | null>(null);
  const [editing, setEditing] = useState<Movie | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [roomBlurbOpen, setRoomBlurbOpen] = useState(false);

  useEffect(() => {
    const onHash = () => setRouteId(movieIdFromHash());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  const active = useMemo(
    () => (routeId ? (movies.find((m) => m.id === routeId) ?? null) : null),
    [routeId, movies],
  );

  const sync = useSync(user?.username ?? null, active?.id ?? null);
  const isAdmin = user?.role === "admin";
  const liveMovieId = sync.state?.movieId ?? null;

  const refreshMovies = useCallback(() => {
    return fetchMovies()
      .then((r) => {
        // Le sondage ne doit pas provoquer de rendu s'il n'apporte rien :
        // chaque rendu de App traverse le lecteur pendant le film.
        setMovies((prev) =>
          JSON.stringify(prev) === JSON.stringify(r.movies) ? prev : r.movies,
        );
        const names = (r.peers as (string | { name?: string })[]).map((p) =>
          typeof p === "string" ? p : (p?.name ?? ""),
        );
        setRestPeers((prev) =>
          prev.join("|") === names.join("|") ? prev : names,
        );
      })
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    me()
      .then((r) => setUser(r.user))
      .catch(() => setUser(null))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    const load = () => {
      void refreshMovies().catch(() => undefined);
      if (cancelled) return;
    };
    load();
    const id = window.setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [user, refreshMovies]);

  const peers: PeerInfo[] = useMemo(() => {
    if (sync.peers.length) return sync.peers;
    return restPeers.map((name) => ({
      name,
      watching: null,
      stalled: false,
      ready: false,
      away: false,
    }));
  }, [sync.peers, restPeers]);

  const others = useMemo(
    () =>
      peers.filter(
        (p) => p.name.toLowerCase() !== (user?.username ?? "").toLowerCase(),
      ),
    [peers, user?.username],
  );

  const peerLabel = useMemo(() => {
    if (!others.length) return t("nobodyElse");
    return others
      .map((p) => {
        if (p.away) {
          const base = t("peerAway", { name: p.name });
          return p.awayReason ? `${base} (${p.awayReason})` : base;
        }
        if (p.watching) return t("peerInRoom", { name: p.name });
        return t("peerInCatalog", { name: p.name });
      })
      .join(" · ");
  }, [others, t]);

  if (loading) {
    return (
      <div className="app-shell">
        <div className="login-page">
          <p style={{ color: "var(--muted)" }}>{t("loading")}</p>
        </div>
        <SiteCredit />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="app-shell">
        <Login
          onSuccess={(u) => {
            setUser(u);
            setError(null);
          }}
        />
        <SiteCredit />
      </div>
    );
  }

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">Watchy</div>
        <div className="topbar-meta">
          <LangToggle />
          <span>
            {user.username}
            {isAdmin ? " · admin" : ""}
          </span>
          <button
            className="ghost-btn"
            type="button"
            onClick={() => {
              void logout().then(() => {
                setUser(null);
                goToCatalog();
              });
            }}
          >
            {t("logout")}
          </button>
        </div>
      </header>

      {active ? (
        <section className="room">
          <div className="room-bar">
            <div>
              <button
                className="ghost-btn"
                type="button"
                onClick={() => goToCatalog()}
              >
                {t("backCatalog")}
              </button>
              <h1>{active.title}</h1>
              {active.description?.trim() && (
                <button
                  type="button"
                  className={`room-blurb${roomBlurbOpen ? " is-open" : ""}`}
                  onClick={() => setRoomBlurbOpen((v) => !v)}
                  aria-expanded={roomBlurbOpen}
                >
                  {roomBlurbOpen ? (
                    <>
                      <span className="room-blurb-body">{active.description}</span>
                      <em>{t("readLess")}</em>
                    </>
                  ) : (
                    <em className="room-blurb-peek">{t("readMore")}</em>
                  )}
                </button>
              )}
            </div>
            <div className="topbar-meta">
              <span className="pill">
                <span className="dot" />
                {peerLabel}
              </span>
              <span className="sync-badge" data-state={sync.status}>
                {sync.status === "synced"
                  ? t("synced")
                  : sync.status === "resync"
                    ? t("resync")
                    : sync.status === "connecting"
                      ? t("connecting")
                      : t("offline")}
              </span>
            </div>
          </div>
          {sync.lastError && <p className="error">{sync.lastError}</p>}
          <Player
            key={active.id}
            movie={active}
            sync={sync}
            username={user.username}
            startAt={resumeAt}
          />
        </section>
      ) : (
        <section className="lobby">
          <div className="lobby-head">
            <div>
              <h1>{t("catalog")}</h1>
              <p>{t("catalogHint")}</p>
            </div>
            <span className="pill">
              <span className="dot" />
              {peerLabel}
            </span>
          </div>

          {isAdmin && <UploadDropzone onUploaded={() => void refreshMovies()} />}

          {error && <p className="error">{error}</p>}

          {movies.length === 0 ? (
            <div className="empty">
              {isAdmin ? t("emptyAdmin") : t("emptyUser")}
            </div>
          ) : (
            <div className="catalog-grid">
              {movies.map((m) => (
                <CatalogCard
                  key={m.id}
                  movie={m}
                  watching={liveMovieId === m.id}
                  isAdmin={isAdmin}
                  onOpen={(resume) => {
                    setResumeAt(resume ? m.progressTime : null);
                    setRoomBlurbOpen(false);
                    goToMovie(m.id);
                  }}
                  onEdit={() => setEditing(m)}
                  onDelete={() => {
                    if (!confirm(t("deleteConfirm", { title: m.title }))) return;
                    void deleteMovie(m.id)
                      .then(() => refreshMovies())
                      .catch((e: Error) => setError(e.message));
                  }}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {editing && (
        <EditMovie
          movie={editing}
          onClose={() => setEditing(null)}
          onSaved={() => void refreshMovies()}
        />
      )}

      <SiteCredit />
    </div>
  );
}

function CatalogCard({
  movie: m,
  watching,
  isAdmin,
  onOpen,
  onEdit,
  onDelete,
}: {
  movie: Movie;
  watching: boolean;
  isAdmin: boolean;
  onOpen: (resume: boolean) => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t } = useI18n();
  const [openBlurb, setOpenBlurb] = useState(false);
  const canResume = !watching && m.progressTime != null && m.progressTime > 30;
  const blurb =
    m.description?.trim() ||
    `${formatBytes(m.size)}${
      m.audioTracks.length ? ` · ${m.audioTracks.length} audio` : ""
    }${m.subtitles.length ? ` · ${m.subtitles.length} ST` : ""}`;
  const hasStory = Boolean(m.description?.trim());

  return (
    <article className="poster-card">
      <button
        type="button"
        className="poster-hit"
        onClick={() => onOpen(false)}
        aria-label={t("openMovie", { title: m.title })}
      >
        <div className="poster-frame">
          <PosterImage src={m.posterUrl} title={m.title} />
          {watching && <span className="poster-badge live">{t("watching")}</span>}
          {!watching && canResume && (
            <span className="poster-badge progress">
              {formatClock(m.progressTime!)}
            </span>
          )}
        </div>
      </button>

      <div className="poster-meta">
        <h2>{m.title}</h2>
        {hasStory ? (
          <button
            type="button"
            className={`poster-blurb${openBlurb ? " is-open" : ""}`}
            onClick={() => setOpenBlurb((v) => !v)}
            aria-expanded={openBlurb}
          >
            {openBlurb ? (
              <>
                <span className="poster-blurb-body">{blurb}</span>
                <em>{t("readLess")}</em>
              </>
            ) : (
              <em className="poster-blurb-peek">{t("readMore")}</em>
            )}
          </button>
        ) : (
          <p className="poster-tech">{blurb}</p>
        )}
      </div>

      <div className="poster-admin">
        {canResume && (
          <button type="button" className="ghost-btn" onClick={() => onOpen(true)}>
            {t("resume")}
          </button>
        )}
        {isAdmin && (
          <>
            <button type="button" className="ghost-btn" onClick={onEdit}>
              {t("edit")}
            </button>
            <button
              type="button"
              className="ghost-btn danger-btn"
              onClick={onDelete}
            >
              {t("delete")}
            </button>
          </>
        )}
      </div>
    </article>
  );
}

function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, "0")}`;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function Login({ onSuccess }: { onSuccess: (u: User) => void }) {
  const { t } = useI18n();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await login(username, password);
      onSuccess(res.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("loginError"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login-page">
      <form className="login-panel" onSubmit={onSubmit}>
        <div className="login-lang">
          <LangToggle />
        </div>
        <h1>{t("loginTitle")}</h1>
        <p>{t("loginTagline")}</p>
        {error && <p className="error">{error}</p>}
        <div className="field">
          <label htmlFor="username">{t("username")}</label>
          <input
            id="username"
            autoComplete="username"
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            required
          />
        </div>
        <div className="field">
          <label htmlFor="password">{t("password")}</label>
          <input
            id="password"
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </div>
        <button className="primary-btn" type="submit" disabled={busy}>
          {busy ? t("signingIn") : t("enterRoom")}
        </button>
      </form>
    </div>
  );
}
