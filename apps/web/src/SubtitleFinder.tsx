import { useCallback, useEffect, useState } from "react";
import {
  downloadOpenSubtitle,
  openSubtitlesStatus,
  searchOpenSubtitles,
  type SubtitleCandidate,
} from "./api";
import { useI18n } from "./i18n";

type Props = {
  movieId: string;
  onClose: () => void;
  /** Appele apres un telechargement reussi : le catalogue doit se relire. */
  onAdded: (lang: string) => void;
};

const LANGS = ["ar", "fr", "en"] as const;

/**
 * Chercher des sous-titres sans quitter la salle. L'empreinte du fichier
 * passe avant le titre : un resultat trouve par empreinte est cale sur ce
 * rip precis, donc deja synchrone.
 */
export function SubtitleFinder({ movieId, onClose, onAdded }: Props) {
  const { t } = useI18n();
  const [langs, setLangs] = useState<string[]>(["ar", "fr"]);
  const [results, setResults] = useState<SubtitleCandidate[]>([]);
  const [matchedBy, setMatchedBy] = useState<"hash" | "title" | null>(null);
  const [busy, setBusy] = useState(false);
  const [downloading, setDownloading] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [configured, setConfigured] = useState<boolean | null>(null);

  useEffect(() => {
    openSubtitlesStatus()
      .then((r) => setConfigured(r.configured))
      .catch(() => setConfigured(false));
  }, []);

  const run = useCallback(async () => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const r = await searchOpenSubtitles(movieId, langs);
      setResults(r.results);
      setMatchedBy(r.matchedBy);
      if (r.results.length === 0) setNotice(t("osNoResult"));
    } catch (e) {
      setError(e instanceof Error ? e.message : t("osFailed"));
    } finally {
      setBusy(false);
    }
  }, [movieId, langs, t]);

  useEffect(() => {
    if (configured) void run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configured]);

  const grab = async (c: SubtitleCandidate) => {
    setDownloading(c.fileId);
    setError(null);
    try {
      const r = await downloadOpenSubtitle({
        movieId,
        fileId: c.fileId,
        lang: c.lang,
      });
      setNotice(
        t("osAdded", {
          lang: r.lang,
          left: r.remaining == null ? "?" : String(r.remaining),
        }),
      );
      onAdded(r.lang);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("osFailed"));
    } finally {
      setDownloading(null);
    }
  };

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-wide"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="modal-head">
          <h2>{t("osTitle")}</h2>
          <button type="button" className="ghost-btn" onClick={onClose}>
            {t("close")}
          </button>
        </header>

        {configured === false ? (
          <p className="muted-hint">{t("osMissingKey")}</p>
        ) : (
          <>
            <div className="os-langs">
              {LANGS.map((l) => (
                <button
                  key={l}
                  type="button"
                  className={`os-chip${langs.includes(l) ? " is-on" : ""}`}
                  onClick={() =>
                    setLangs((prev) =>
                      prev.includes(l)
                        ? prev.filter((x) => x !== l)
                        : [...prev, l],
                    )
                  }
                >
                  {t(`lang_${l}` as "lang_ar")}
                </button>
              ))}
              <button
                type="button"
                className="primary-btn"
                disabled={busy || langs.length === 0}
                onClick={() => void run()}
              >
                {busy ? t("searching") : t("search")}
              </button>
            </div>

            {matchedBy && (
              <p className="muted-hint">
                {matchedBy === "hash" ? t("osByHash") : t("osByTitle")}
              </p>
            )}
            {error && <p className="error">{error}</p>}
            {notice && <p className="ok-msg">{notice}</p>}

            <ul className="os-list">
              {results.map((c) => (
                <li key={c.fileId}>
                  <div className="os-item">
                    <span className="os-lang">{c.lang.toUpperCase()}</span>
                    <div className="os-body">
                      <strong>{c.release || c.title}</strong>
                      <p>
                        {c.hashMatch && (
                          <span className="os-badge">{t("osExactMatch")}</span>
                        )}
                        {c.fromTrusted && (
                          <span className="os-badge">{t("osTrusted")}</span>
                        )}
                        {c.hearingImpaired && (
                          <span className="os-badge">{t("osHi")}</span>
                        )}
                        {t("osDownloads", { n: c.downloads })}
                      </p>
                    </div>
                    <button
                      type="button"
                      className="ghost-btn"
                      disabled={downloading != null}
                      onClick={() => void grab(c)}
                    >
                      {downloading === c.fileId ? t("osGetting") : t("osGet")}
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}
