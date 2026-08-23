import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";

export type Lang = "en" | "fr";

const messages = {
  en: {
    loading: "Loading…",
    logout: "Log out",
    catalog: "Catalog",
    catalogHint:
      "Pick a movie. Play / pause / seek stay in sync — shared control.",
    backCatalog: "← Catalog",
    nobodyElse: "Nobody else online",
    connected: "Online",
    synced: "Synced",
    resync: "Resync…",
    connecting: "Connecting…",
    offline: "Offline",
    emptyAdmin: "No movies yet — drop a file above.",
    emptyUser: "No movies yet.",
    deleteConfirm: "Delete “{title}”?",
    openMovie: "Open {title}",
    watching: "Live",
    readMore: "Read more",
    readLess: "Show less",
    resume: "Resume",
    edit: "Edit",
    delete: "Delete",
    loginTitle: "Watchy",
    loginTagline:
      "Private synced cinema — sign in, pick a movie, stay on the same frame.",
    username: "Username",
    password: "Password",
    enterRoom: "Enter the room",
    signingIn: "Signing in…",
    loginError: "Sign-in failed",
    sharedControl: "Shared control",
    lastBy: "last",
    refreshMe: "Refresh me",
    refreshAll: "Hard refresh (everyone)",
    subtitles: "Subtitles",
    subsOff: "Off",
    waitingEncode: "Waiting for encode (~{sec}s ready)",
    buffering: "Loading…",
    driftSynced: "In sync · {d}s",
    driftCatching: "Catching up · {d}s",
    driftOff: "Out of sync · {d}s",
    peerLoading: "{name} is loading…",
    playBlocked: "Your browser blocked playback.",
    tapToJoin: "Tap to join",
    sourceUpgraded: "Adaptive quality ready — reload",
    subPrefMissing: "No “{lang}” track on this movie",
    peerInRoom: "{name} · in the room",
    peerInCatalog: "{name} · browsing",
    peerAway: "{name} · away",
    sessionExpired: "Session expired — sign in again.",
    dropTitle: "Drop a movie or subtitles",
    dropHint:
      "MP4 / MKV / WebM · subtitles .vtt / .srt (e.g. movie.en.srt). Faster from your PC than via a middleman.",
    chooseFiles: "Choose files",
    maxUpload: "Up to ~{size}",
    uploadAdded: "{name} added",
    uploadAddedMany: "{n} files added",
    uploadFailed: "Upload failed",
    editSheet: "Movie sheet",
    title: "Title",
    description: "Description",
    descriptionPh: "Short synopsis for the catalog…",
    preferredAudio: "Preferred audio track",
    audioAuto: "Auto",
    poster: "Poster",
    uploadPoster: "Upload an image",
    sourceTmdb: "Source: TMDB",
    sourceManual: "Source: manual",
    sourceFrame: "Source: auto frame",
    tmdbSearch: "TMDB search (Jellyfin-style)",
    tmdbMissing:
      "Set TMDB_API_KEY on the server for auto sheets + search.",
    search: "Search",
    use: "Use",
    save: "Save",
    rescanning: "Re-scan (auto)",
    prepareBrowser: "Prepare for browser",
    readyBrowser: "Browser-ready",
    close: "Close",
    posterUpdated: "Poster updated",
    tmdbApplied: "TMDB sheet applied",
    rescanOkTmdb: "TMDB + tracks re-scan OK",
    rescanOkNoTmdb: "Tracks re-scan OK (no TMDB key)",
    prepareStarted: "Browser prepare started (HLS).",
    credit: "Made with ♥ by @cmrabdu",
    langEn: "EN",
    langFr: "FR",
  },
  fr: {
    loading: "Chargement…",
    logout: "Déconnexion",
    catalog: "Catalogue",
    catalogHint:
      "Choisissez un film. Play / pause / seek restent alignés — contrôle partagé.",
    backCatalog: "← Catalogue",
    nobodyElse: "Personne d’autre connecté",
    connected: "Connectés",
    synced: "Synchronisé",
    resync: "Resync…",
    connecting: "Connexion…",
    offline: "Hors ligne",
    emptyAdmin: "Aucun film — dépose un fichier ci-dessus.",
    emptyUser: "Aucun film pour l’instant.",
    deleteConfirm: "Supprimer « {title} » ?",
    openMovie: "Ouvrir {title}",
    watching: "En cours",
    readMore: "Lire plus",
    readLess: "Réduire",
    resume: "Reprendre",
    edit: "Éditer",
    delete: "Suppr.",
    loginTitle: "Watchy",
    loginTagline:
      "Cinéma privé synchronisé — entrez, choisissez un film, et restez sur la même image.",
    username: "Identifiant",
    password: "Mot de passe",
    enterRoom: "Entrer dans la salle",
    signingIn: "Connexion…",
    loginError: "Erreur de connexion",
    sharedControl: "Contrôle partagé",
    lastBy: "dernier",
    refreshMe: "Rafraîchir moi",
    refreshAll: "Hard refresh (tous)",
    subtitles: "Sous-titres",
    subsOff: "Désactivés",
    waitingEncode: "En attente d’encodage (~{sec}s prêts)",
    buffering: "Chargement…",
    driftSynced: "Synchronisé · {d} s",
    driftCatching: "Rattrapage · {d} s",
    driftOff: "Désynchronisé · {d} s",
    peerLoading: "{name} charge…",
    playBlocked: "Le navigateur a bloqué la lecture.",
    tapToJoin: "Appuie pour rejoindre",
    sourceUpgraded: "Qualité adaptative prête — recharger",
    subPrefMissing: "Pas de piste « {lang} » sur ce film",
    peerInRoom: "{name} · dans la salle",
    peerInCatalog: "{name} · dans le catalogue",
    peerAway: "{name} · absent",
    sessionExpired: "Session expirée — reconnecte-toi.",
    dropTitle: "Déposer un film ou des sous-titres",
    dropHint:
      "MP4 / MKV / WebM · sous-titres .vtt / .srt (ex. film.fr.srt). Plus rapide depuis ton PC que via un intermédiaire.",
    chooseFiles: "Choisir des fichiers",
    maxUpload: "Jusqu’à ~{size}",
    uploadAdded: "{name} ajouté",
    uploadAddedMany: "{n} fichiers ajoutés",
    uploadFailed: "Échec upload",
    editSheet: "Fiche film",
    title: "Titre",
    description: "Description",
    descriptionPh: "Petite synopse pour le catalogue…",
    preferredAudio: "Langue audio préférée",
    audioAuto: "Auto",
    poster: "Affiche",
    uploadPoster: "Uploader une image",
    sourceTmdb: "Source : TMDB",
    sourceManual: "Source : manuelle",
    sourceFrame: "Source : frame auto",
    tmdbSearch: "Recherche TMDB (comme Jellyfin)",
    tmdbMissing:
      "Configure TMDB_API_KEY sur le serveur pour l’auto-fiche + recherche.",
    search: "Chercher",
    use: "Utiliser",
    save: "Enregistrer",
    rescanning: "Re-scanner (auto)",
    prepareBrowser: "Préparer pour le navigateur",
    readyBrowser: "Prêt navigateur",
    close: "Fermer",
    posterUpdated: "Affiche mise à jour",
    tmdbApplied: "Fiche TMDB appliquée",
    rescanOkTmdb: "Re-scan TMDB + pistes OK",
    rescanOkNoTmdb: "Re-scan pistes OK (pas de clé TMDB)",
    prepareStarted: "Préparation navigateur lancée (HLS).",
    credit: "Made with ♥ by @cmrabdu",
    langEn: "EN",
    langFr: "FR",
  },
} as const;

export type MessageKey = keyof typeof messages.en;

type I18nValue = {
  lang: Lang;
  setLang: (lang: Lang) => void;
  t: (key: MessageKey, vars?: Record<string, string | number>) => string;
};

const I18nContext = createContext<I18nValue | null>(null);

const STORAGE_KEY = "watchy.lang";

function readLang(): Lang {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    if (v === "fr" || v === "en") return v;
  } catch {
    /* ignore */
  }
  return "en";
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(() => readLang());

  const setLang = useCallback((next: Lang) => {
    setLangState(next);
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      /* ignore */
    }
    document.documentElement.lang = next;
  }, []);

  const t = useCallback(
    (key: MessageKey, vars?: Record<string, string | number>) => {
      let out: string = messages[lang][key] ?? messages.en[key] ?? key;
      if (vars) {
        for (const [k, v] of Object.entries(vars)) {
          out = out.replaceAll(`{${k}}`, String(v));
        }
      }
      return out;
    },
    [lang],
  );

  const value = useMemo(() => ({ lang, setLang, t }), [lang, setLang, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useI18n outside provider");
  return ctx;
}

export function LangToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <div className="lang-toggle" role="group" aria-label="Language">
      <button
        type="button"
        className={lang === "en" ? "is-active" : ""}
        onClick={() => setLang("en")}
      >
        {t("langEn")}
      </button>
      <button
        type="button"
        className={lang === "fr" ? "is-active" : ""}
        onClick={() => setLang("fr")}
      >
        {t("langFr")}
      </button>
    </div>
  );
}

export function SiteCredit() {
  const { t } = useI18n();
  return (
    <p className="site-credit">
      <a
        href="https://github.com/cmrabdu"
        target="_blank"
        rel="noreferrer noopener"
      >
        {t("credit")}
      </a>
    </p>
  );
}
