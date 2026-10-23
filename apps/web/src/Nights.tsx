import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchHistory, setEveningNote, type HistoryEvening } from "./api";
import { useI18n } from "./i18n";
import { PosterImage } from "./PosterImage";

/**
 * Nos soirees : le mur de tout ce qu'ils ont vu ensemble. Le serveur tient
 * l'historique ; ici on ne fait que le rendre digne d'etre regarde.
 */
export function Nights() {
  const { t, lang } = useI18n();
  const [evenings, setEvenings] = useState<HistoryEvening[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const load = useCallback(() => {
    setLoading(true);
    return fetchHistory()
      .then((r) =>
        setEvenings([...r.evenings].sort((a, b) => b.startedAt - a.startedAt)),
      )
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const locale = lang === "fr" ? "fr-FR" : "en-GB";
  const dayFmt = useMemo(
    () =>
      new Intl.DateTimeFormat(locale, {
        weekday: "long",
        day: "numeric",
        month: "long",
      }),
    [locale],
  );
  const yearFmt = useMemo(
    () => new Intl.DateTimeFormat(locale, { year: "numeric" }),
    [locale],
  );

  const total = useMemo(
    () => evenings.reduce((acc, e) => acc + e.togetherSeconds, 0),
    [evenings],
  );

  const saveNote = async (id: string) => {
    setSaving(true);
    try {
      await setEveningNote(id, draft);
      setEvenings((prev) =>
        prev.map((e) => (e.id === id ? { ...e, note: draft || null } : e)),
      );
      setEditing(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Erreur");
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="nights-page">
      <div className="lobby-head">
        <div>
          <h1>{t("nightsTitle")}</h1>
          <p>
            {evenings.length > 0
              ? t("nightsCount", {
                  n: evenings.length,
                  time: humanDuration(total, t),
                })
              : t("nightsHint")}
          </p>
        </div>
      </div>

      {error && <p className="error">{error}</p>}

      {loading ? (
        <p className="muted-hint">{t("loading")}</p>
      ) : evenings.length === 0 ? (
        <div className="empty">{t("nightsEmpty")}</div>
      ) : (
        <div className="nights-grid">
          {evenings.map((e) => {
            const counts = countReactions(e.reactions);
            return (
              <article key={e.id} className="night-card">
                <div className="night-poster">
                  <PosterImage src={e.posterUrl} title={e.title} />
                  <div className="night-veil" />
                  <div className="night-stamp">
                    <span className="night-day">{dayFmt.format(e.startedAt)}</span>
                    <span className="night-year">{yearFmt.format(e.startedAt)}</span>
                  </div>
                </div>

                <div className="night-body">
                  <h2>{e.title}</h2>
                  <p className="night-meta">
                    {humanDuration(e.togetherSeconds, t)}
                    {e.peers.length ? ` · ${e.peers.join(" & ")}` : ""}
                  </p>

                  {counts.length > 0 && (
                    <div className="night-reactions">
                      {counts.map(([emoji, n]) => (
                        <span key={emoji} className="night-react">
                          <span className="night-react-emoji">{emoji}</span>
                          {n > 1 && <span className="night-react-n">{n}</span>}
                        </span>
                      ))}
                    </div>
                  )}

                  {editing === e.id ? (
                    <div className="night-note-edit">
                      <textarea
                        value={draft}
                        rows={3}
                        maxLength={500}
                        placeholder={t("nightNotePh")}
                        onChange={(ev) => setDraft(ev.target.value)}
                      />
                      <div className="night-note-actions">
                        <button
                          type="button"
                          className="primary-btn"
                          disabled={saving}
                          onClick={() => void saveNote(e.id)}
                        >
                          {t("save")}
                        </button>
                        <button
                          type="button"
                          className="ghost-btn"
                          onClick={() => setEditing(null)}
                        >
                          {t("close")}
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="night-note"
                      onClick={() => {
                        setDraft(e.note ?? "");
                        setEditing(e.id);
                      }}
                    >
                      {e.note ? (
                        <span className="night-note-text">« {e.note} »</span>
                      ) : (
                        <em>{t("nightNoteAdd")}</em>
                      )}
                    </button>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}

function countReactions(
  reactions: { emoji: string }[],
): [string, number][] {
  const map = new Map<string, number>();
  for (const r of reactions) map.set(r.emoji, (map.get(r.emoji) ?? 0) + 1);
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}

function humanDuration(
  seconds: number,
  t: (key: "durationHm" | "durationM", vars?: Record<string, string | number>) => string,
): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (h > 0) return t("durationHm", { h, m: String(m).padStart(2, "0") });
  return t("durationM", { m });
}
