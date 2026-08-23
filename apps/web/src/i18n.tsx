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
    play: "Play",
    dropTitleSubs: "Drop subtitles",
    dropHintSubs: ".srt / .vtt / .ass — they attach to the film with the same name (e.g. movie.ar.srt).",
    uploadVideoAdminOnly: "Video files are admin-only. Subtitles are open to you.",
    uploadCancel: "Cancel",
    uploadCancelled: "Upload cancelled",
    uploadResume: "Resume upload",
    subOffset: "Timing",
    subOffsetHint: "Move the subtitles if they run ahead or behind.",
    subEarlier: "Subtitles earlier",
    subLater: "Subtitles later",
    subSize: "Size",
    subSmaller: "Smaller subtitles",
    subBigger: "Bigger subtitles",
    subBoxOn: "Box background: on",
    subBoxOff: "Box background: off",
    wishTab: "Wishlist",
    nightsTab: "Our evenings",
    wishTitle: "Our wishlist",
    wishHint: "Search a title and add it. No file needed — this is what we want to watch.",
    wishSearchPh: "A title, an idea…",
    searching: "Searching…",
    searchFailed: "Search failed",
    noSynopsis: "No synopsis",
    wishAdd: "Add",
    wishAdded: "“{title}” added to the list",
    wishAlready: "“{title}” was already on the list",
    wishFailed: "Could not update the list",
    wishListTitle: "What we want to watch",
    wishEmpty: "Nothing yet — search a title above.",
    wishRemove: "Remove",
    wishAddedOn: "added {date}",
    nightsTitle: "Our evenings",
    nightsHint: "Every film watched together lands here.",
    nightsCount: "{n} evenings · {time} together",
    nightsEmpty: "No evening yet. The first one is waiting.",
    nightNoteAdd: "Add a word about this evening",
    nightNotePh: "What we will remember…",
    durationHm: "{h} h {m}",
    durationM: "{m} min",
    readyPrompt: "{name} is here. Start together?",
    readyBtn: "Ready",
    waitingPeer: "Waiting for {name}…",
    startAnyway: "Start anyway",
    countdownSub: "Together in…",
    brb: "Pause, I'll be back",
    brb2: "2 min",
    brb5: "5 min",
    brb10: "10 min",
    brbBack: "I'm back",
    peerAwayCard: "{name} will be back — {reason}",
    pause: "Pause",
    progress: "Progress",
    back10: "Back 10 seconds",
    fwd10: "Forward 10 seconds",
    mute: "Mute",
    unmute: "Unmute",
    volume: "Volume",
    sendReaction: "Send {emoji}",
    quality: "Quality",
    qualityAuto: "Auto",
    qualityAutoShort: "Auto",
    fullscreen: "Fullscreen",
    exitFullscreen: "Exit fullscreen",
    peerWatchingWith: "{name} is watching with you",
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
    play: "Lecture",
    dropTitleSubs: "Déposer des sous-titres",
    dropHintSubs: ".srt / .vtt / .ass — ils se rattachent au film du même nom (ex. film.ar.srt).",
    uploadVideoAdminOnly: "Les fichiers vidéo sont réservés à l'administrateur. Les sous-titres te sont ouverts.",
    uploadCancel: "Annuler",
    uploadCancelled: "Envoi annulé",
    uploadResume: "Reprendre l'envoi",
    subOffset: "Décalage",
    subOffsetHint: "Décale les sous-titres s'ils sont en avance ou en retard.",
    subEarlier: "Sous-titres plus tôt",
    subLater: "Sous-titres plus tard",
    subSize: "Taille",
    subSmaller: "Sous-titres plus petits",
    subBigger: "Sous-titres plus grands",
    subBoxOn: "Fond noir : activé",
    subBoxOff: "Fond noir : désactivé",
    wishTab: "Envies",
    nightsTab: "Nos soirées",
    wishTitle: "Nos envies",
    wishHint: "Cherche un titre et ajoute-le. Aucun fichier nécessaire — c'est ce qu'on a envie de voir.",
    wishSearchPh: "Un titre, une idée…",
    searching: "Recherche…",
    searchFailed: "Recherche impossible",
    noSynopsis: "Pas de synopsis",
    wishAdd: "Ajouter",
    wishAdded: "« {title} » ajouté à la liste",
    wishAlready: "« {title} » était déjà dans la liste",
    wishFailed: "Impossible de mettre la liste à jour",
    wishListTitle: "Ce qu'on veut voir",
    wishEmpty: "Rien encore — cherche un titre ci-dessus.",
    wishRemove: "Retirer",
    wishAddedOn: "ajouté le {date}",
    nightsTitle: "Nos soirées",
    nightsHint: "Chaque film regardé ensemble atterrit ici.",
    nightsCount: "{n} soirées · {time} ensemble",
    nightsEmpty: "Aucune soirée encore. La première vous attend.",
    nightNoteAdd: "Ajouter un mot sur cette soirée",
    nightNotePh: "Ce qu'on en retiendra…",
    durationHm: "{h} h {m}",
    durationM: "{m} min",
    readyPrompt: "{name} est là. On lance ensemble ?",
    readyBtn: "Prêt ?",
    waitingPeer: "On attend {name}…",
    startAnyway: "Lancer quand même",
    countdownSub: "Ensemble dans…",
    brb: "Pause, je reviens",
    brb2: "2 min",
    brb5: "5 min",
    brb10: "10 min",
    brbBack: "Je suis de retour",
    peerAwayCard: "{name} revient — {reason}",
    pause: "Pause",
    progress: "Progression",
    back10: "Reculer de 10 secondes",
    fwd10: "Avancer de 10 secondes",
    mute: "Couper le son",
    unmute: "Remettre le son",
    volume: "Volume",
    sendReaction: "Envoyer {emoji}",
    quality: "Qualité",
    qualityAuto: "Automatique",
    qualityAutoShort: "Auto",
    fullscreen: "Plein écran",
    exitFullscreen: "Quitter le plein écran",
    peerWatchingWith: "{name} regarde avec toi",
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
