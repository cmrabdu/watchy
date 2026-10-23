import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import {
  addToWatchlist,
  fetchWatchlist,
  removeFromWatchlist,
  searchTmdb,
  type TmdbSearchHit,
  type WatchlistItem,
} from "./api";
import { useI18n } from "./i18n";
import { PosterImage } from "./PosterImage";

/**
 * L'envie partagee : elle deplace le « on regarde quoi ? » de 21h05 vers
 * toute la semaine, et c'est le seul endroit ou elle agit au lieu de subir.
 * Aucun fichier video n'est requis — une envie, c'est un titre TMDB.
 */
export function Watchlist({ username }: { username: string }) {
  const { t, lang } = useI18n();
  const [items, setItems] = useState<WatchlistItem[]>([]);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<TmdbSearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | string | null>(null);
  const seq = useRef(0);

  const load = useCallback(() => {
    return fetchWatchlist()
      .then((r) => setItems(r.items))
      .catch((e: Error) => setError(e.message));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const runSearch = useCallback(
    async (q: string) => {
      const gen = ++seq.current;
      if (q.trim().length < 2) {
        setHits([]);
        return;
      }
      setSearching(true);
      setError(null);
      try {
        const r = await searchTmdb(q.trim());
        if (seq.current === gen) setHits(r.results);
      } catch (e) {
        if (seq.current === gen) {
          setHits([]);
          setError(e instanceof Error ? e.message : t("searchFailed"));
        }
      } finally {
        if (seq.current === gen) setSearching(false);
      }
    },
    [t],
  );

  // Recherche a la frappe, mais sans marteler TMDB a chaque lettre.
  useEffect(() => {
    const id = window.setTimeout(() => void runSearch(query), 420);
    return () => window.clearTimeout(id);
  }, [query, runSearch]);

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void runSearch(query);
  };

  const add = async (hit: TmdbSearchHit) => {
    setBusyId(hit.id);
    setNotice(null);
    try {
      const r = await addToWatchlist({
        tmdbId: hit.id,
        title: hit.title,
        year: hit.year,
        overview: hit.overview,
        posterUrl: hit.posterUrl,
      });
      setNotice(
        r.already
          ? t("wishAlready", { title: r.item.title })
          : t("wishAdded", { title: r.item.title }),
      );
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : t("wishFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: WatchlistItem) => {
    setBusyId(item.id);
    try {
      await removeFromWatchlist(item.id);
      setItems((prev) => prev.filter((i) => i.id !== item.id));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("wishFailed"));
    } finally {
      setBusyId(null);
    }
  };

  const dateFmt = new Intl.DateTimeFormat(lang === "fr" ? "fr-FR" : "en-GB", {
    day: "numeric",
    month: "short",
  });

  return (
    <section className="wish-page">
      <div className="lobby-head">
        <div>
          <h1>{t("wishTitle")}</h1>
          <p>{t("wishHint")}</p>
        </div>
      </div>

      <form className="wish-search" onSubmit={onSubmit}>
        <input
          type="search"
          value={query}
          placeholder={t("wishSearchPh")}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("wishSearchPh")}
        />
        <button type="submit" className="primary-btn" disabled={searching}>
          {searching ? t("searching") : t("search")}
        </button>
      </form>

      {error && <p className="error">{error}</p>}
      {notice && <p className="muted-hint">{notice}</p>}

      {hits.length > 0 && (
        <div className="wish-hits">
          {hits.map((h) => (
            <article key={h.id} className="wish-hit">
              <div className="wish-hit-poster">
                <PosterImage src={h.posterUrl} title={h.title} />
              </div>
              <div className="wish-hit-body">
                <h3>
                  {h.title}
                  {h.year ? <span className="wish-year"> · {h.year}</span> : null}
                </h3>
                <p>{h.overview || t("noSynopsis")}</p>
              </div>
              <button
                type="button"
                className="primary-btn"
                disabled={busyId === h.id}
                onClick={() => void add(h)}
              >
                {t("wishAdd")}
              </button>
            </article>
          ))}
        </div>
      )}

      <h2 className="wish-sub">{t("wishListTitle")}</h2>
      {items.length === 0 ? (
        <div className="empty">{t("wishEmpty")}</div>
      ) : (
        <div className="wish-grid">
          {items.map((it) => (
            <article key={it.id} className="wish-card">
              <div className="poster-frame">
                <PosterImage src={it.posterUrl} title={it.title} />
                <span
                  className="wish-owner"
                  data-mine={
                    it.addedBy.toLowerCase() === username.toLowerCase()
                      ? "yes"
                      : "no"
                  }
                >
                  {it.addedBy}
                </span>
              </div>
              <div className="wish-card-meta">
                <h3>
                  {it.title}
                  {it.year ? <span className="wish-year"> · {it.year}</span> : null}
                </h3>
                <p className="wish-when">
                  {t("wishAddedOn", { date: dateFmt.format(it.addedAt) })}
                </p>
                <button
                  type="button"
                  className="ghost-btn"
                  disabled={busyId === it.id}
                  onClick={() => void remove(it)}
                >
                  {t("wishRemove")}
                </button>
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}
