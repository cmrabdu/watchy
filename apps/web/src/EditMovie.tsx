import { useEffect, useState, type FormEvent } from "react";
import {
  applyTmdb,
  prepareMovie,
  reindexMovie,
  searchTmdb,
  tmdbStatus,
  updateMovie,
  uploadPoster,
  type Movie,
  type TmdbSearchHit,
} from "./api";
import { useI18n } from "./i18n";

type Props = {
  movie: Movie;
  onClose: () => void;
  onSaved: () => void;
};

export function EditMovie({ movie, onClose, onSaved }: Props) {
  const { t } = useI18n();
  const [title, setTitle] = useState(movie.title);
  const [description, setDescription] = useState(movie.description || "");
  const [preferredAudio, setPreferredAudio] = useState<number | "">(
    movie.preferredAudio ?? "",
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tmdbOk, setTmdbOk] = useState(false);
  const [query, setQuery] = useState(movie.title.replace(/\s*\(\d{4}\)\s*$/, ""));
  const [hits, setHits] = useState<TmdbSearchHit[]>([]);

  useEffect(() => {
    void tmdbStatus()
      .then((r) => setTmdbOk(r.configured))
      .catch(() => setTmdbOk(false));
  }, []);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await updateMovie(movie.id, {
        title,
        description,
        preferredAudio: preferredAudio === "" ? null : Number(preferredAudio),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Error");
    } finally {
      setBusy(false);
    }
  };

  const sourceLabel =
    movie.metadataSource === "tmdb"
      ? t("sourceTmdb")
      : movie.metadataSource === "manual"
        ? t("sourceManual")
        : t("sourceFrame");

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <form
        className="modal-panel modal-wide"
        onClick={(e) => e.stopPropagation()}
        onSubmit={onSubmit}
      >
        <h2>{t("editSheet")}</h2>
        <p className="modal-file">{movie.filename}</p>

        <div className="field">
          <label htmlFor="title">{t("title")}</label>
          <input
            id="title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            required
          />
        </div>

        <div className="field">
          <label htmlFor="description">{t("description")}</label>
          <textarea
            id="description"
            rows={4}
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t("descriptionPh")}
          />
        </div>

        {movie.audioTracks.length > 0 && (
          <div className="field">
            <label htmlFor="audio">{t("preferredAudio")}</label>
            <select
              id="audio"
              value={preferredAudio}
              onChange={(e) =>
                setPreferredAudio(
                  e.target.value === "" ? "" : Number(e.target.value),
                )
              }
            >
              <option value="">{t("audioAuto")}</option>
              {movie.audioTracks.map((track) => (
                <option key={track.index} value={track.index}>
                  {track.label}
                  {track.codec ? ` (${track.codec})` : ""}
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label>{t("poster")}</label>
          <div className="poster-upload-row">
            <label className="ghost-btn dropzone-btn">
              {t("uploadPoster")}
              <input
                type="file"
                accept="image/jpeg,image/png,image/webp"
                hidden
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  e.target.value = "";
                  if (!file) return;
                  setBusy(true);
                  setError(null);
                  void uploadPoster(movie.id, file)
                    .then(() => {
                      setMsg(t("posterUpdated"));
                      onSaved();
                    })
                    .catch((err: Error) => setError(err.message))
                    .finally(() => setBusy(false));
                }}
              />
            </label>
            <span className="muted-hint">{sourceLabel}</span>
          </div>
        </div>

        <div className="field">
          <label htmlFor="tmdb-q">{t("tmdbSearch")}</label>
          {!tmdbOk ? (
            <p className="muted-hint">
              {t("tmdbMissing")} (<code>TMDB_API_KEY</code>)
            </p>
          ) : (
            <>
              <div className="tmdb-search-row">
                <input
                  id="tmdb-q"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Hotel Transylvania"
                />
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={busy || query.trim().length < 2}
                  onClick={() => {
                    setBusy(true);
                    setError(null);
                    void searchTmdb(query)
                      .then((r) => setHits(r.results))
                      .catch((err: Error) => setError(err.message))
                      .finally(() => setBusy(false));
                  }}
                >
                  {t("search")}
                </button>
              </div>
              {hits.length > 0 && (
                <ul className="tmdb-hits">
                  {hits.map((h) => (
                    <li key={h.id}>
                      {h.posterUrl ? (
                        <img src={h.posterUrl} alt="" width={40} height={60} />
                      ) : (
                        <span className="tmdb-hit-ph" />
                      )}
                      <div>
                        <strong>
                          {h.title}
                          {h.year ? ` (${h.year})` : ""}
                        </strong>
                        <p>{h.overview?.slice(0, 120)}</p>
                      </div>
                      <button
                        type="button"
                        className="primary-btn"
                        disabled={busy}
                        onClick={() => {
                          setBusy(true);
                          setError(null);
                          void applyTmdb(movie.id, h.id)
                            .then(() => {
                              setMsg(t("tmdbApplied"));
                              onSaved();
                              onClose();
                            })
                            .catch((err: Error) => setError(err.message))
                            .finally(() => setBusy(false));
                        }}
                      >
                        {t("use")}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>

        {error && <p className="error">{error}</p>}
        {msg && <p className="ok-msg">{msg}</p>}

        <div className="modal-actions">
          <button className="primary-btn" type="submit" disabled={busy}>
            {t("save")}
          </button>
          <button
            className="ghost-btn"
            type="button"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void reindexMovie(movie.id)
                .then((r) => {
                  setMsg(r.tmdb ? t("rescanOkTmdb") : t("rescanOkNoTmdb"));
                  onSaved();
                })
                .catch((e: Error) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            {t("rescanning")}
          </button>
          <button
            className="ghost-btn"
            type="button"
            disabled={busy || movie.hasHls}
            onClick={() => {
              setBusy(true);
              void prepareMovie(movie.id)
                .then(() => {
                  setMsg(t("prepareStarted"));
                  onSaved();
                })
                .catch((e: Error) => setError(e.message))
                .finally(() => setBusy(false));
            }}
          >
            {movie.hasHls ? t("readyBrowser") : t("prepareBrowser")}
          </button>
          <button className="ghost-btn" type="button" onClick={onClose}>
            {t("close")}
          </button>
        </div>
      </form>
    </div>
  );
}
