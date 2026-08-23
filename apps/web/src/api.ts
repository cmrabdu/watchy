export type Role = "admin" | "user";

export type User = { username: string; role: Role };

export type SubtitleTrack = {
  id: string;
  label: string;
  lang: string;
  filename: string;
  format: "vtt" | "srt";
};

export type AudioTrack = {
  index: number;
  lang: string;
  label: string;
  codec?: string;
  channels?: number;
};

export type Movie = {
  id: string;
  title: string;
  description: string;
  filename: string;
  size: number;
  hasHls: boolean;
  hlsPath?: string;
  posterUrl: string | null;
  subtitles: SubtitleTrack[];
  audioTracks: AudioTrack[];
  preferredAudio: number | null;
  indexedAt: number | null;
  tmdbId: number | null;
  metadataSource: "tmdb" | "manual" | "frame" | null;
  progressTime: number | null;
  progressAt: number | null;
  /** Film livre en echelle HLS seule, sans fichier source sur le disque. */
  hlsOnly?: boolean;
  /** Hauteurs de l'echelle, ex. [1080, 720, 480]. Vide pour un fichier simple. */
  variants?: number[];
  /** Duree en secondes, quand l'encodeur l'a notee. */
  duration?: number | null;
};

export type SyncState = {
  movieId: string | null;
  playing: boolean;
  mediaTime: number;
  updatedAt: number;
  updatedBy: string | null;
  host: string | null;
};

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (init?.body && !(init.body instanceof FormData) && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(url, {
    credentials: "include",
    ...init,
    headers,
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      /* ignore */
    }
    throw new Error(message);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function me() {
  return request<{ user: User | null }>("/api/me");
}

export function login(username: string, password: string) {
  return request<{ user: User }>("/api/login", {
    method: "POST",
    body: JSON.stringify({ username, password }),
  });
}

export function logout() {
  return request<{ ok: boolean }>("/api/logout", { method: "POST" });
}

export function fetchMovies() {
  return request<{
    movies: Movie[];
    peers: string[];
    peerCount: number;
    sync: SyncState;
  }>("/api/movies");
}

export function updateMovie(
  id: string,
  patch: { title?: string; description?: string; preferredAudio?: number | null },
) {
  return request<{ ok: boolean }>(`/api/movies/${id}`, {
    method: "PATCH",
    body: JSON.stringify(patch),
  });
}

export function reindexMovie(id: string) {
  return request<{ ok: boolean; tmdb?: boolean }>(`/api/movies/${id}/index`, {
    method: "POST",
  });
}

export function prepareMovie(id: string) {
  return request<{ ok: boolean }>(`/api/movies/${id}/prepare`, { method: "POST" });
}

export type TmdbSearchHit = {
  id: number;
  title: string;
  year: string | null;
  overview: string;
  posterUrl: string | null;
};

export function tmdbStatus() {
  return request<{ configured: boolean }>("/api/tmdb/status");
}

export function searchTmdb(q: string, year?: string) {
  const params = new URLSearchParams({ q });
  if (year) params.set("year", year);
  return request<{ results: TmdbSearchHit[] }>(`/api/tmdb/search?${params}`);
}

export function applyTmdb(id: string, tmdbId: number) {
  return request<{ ok: boolean }>(`/api/movies/${id}/tmdb`, {
    method: "POST",
    body: JSON.stringify({ tmdbId }),
  });
}

export function uploadPoster(id: string, file: File) {
  return new Promise<{ ok: boolean }>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", `/api/movies/${id}/poster`);
    xhr.withCredentials = true;
    xhr.setRequestHeader("Content-Type", file.type || "image/jpeg");
    xhr.onload = () => {
      try {
        const body = JSON.parse(xhr.responseText) as { ok?: boolean; error?: string };
        if (xhr.status >= 200 && xhr.status < 300 && body.ok) resolve({ ok: true });
        else reject(new Error(body.error || xhr.statusText));
      } catch {
        reject(new Error("Upload affiche échoué"));
      }
    };
    xhr.onerror = () => reject(new Error("Réseau"));
    xhr.send(file);
  });
}


/* --- Watchlist partagee (serveur : GET/POST /api/watchlist, DELETE /:id) --- */

export type WatchlistItem = {
  id: string;
  tmdbId: number | null;
  title: string;
  year: string | null;
  overview: string;
  posterUrl: string | null;
  addedBy: string;
  addedAt: number;
  removedAt?: number;
  removedBy?: string;
};

export function fetchWatchlist() {
  return request<{ items: WatchlistItem[] }>("/api/watchlist");
}

export function addToWatchlist(input: {
  tmdbId?: number | null;
  title: string;
  year?: string | null;
  overview?: string;
  posterUrl?: string | null;
}) {
  return request<{ ok: boolean; item: WatchlistItem; already: boolean }>(
    "/api/watchlist",
    { method: "POST", body: JSON.stringify(input) },
  );
}

export function removeFromWatchlist(id: string) {
  return request<{ ok: boolean }>(`/api/watchlist/${id}`, { method: "DELETE" });
}

/* --- Nos soirees (serveur : GET /api/history, PATCH /api/history/:id) --- */

export type SessionReaction = {
  emoji: string;
  from: string;
  at: number;
  mediaTime: number;
};

export type HistoryEvening = {
  id: string;
  movieId: string;
  title: string;
  posterUrl: string | null;
  tmdbId: number | null;
  startedAt: number;
  endedAt: number;
  togetherSeconds: number;
  peers: string[];
  reactions: SessionReaction[];
  note: string | null;
};

export function fetchHistory() {
  return request<{ evenings: HistoryEvening[] }>("/api/history");
}

export function setEveningNote(id: string, note: string) {
  return request<{ ok: boolean }>(`/api/history/${id}`, {
    method: "PATCH",
    body: JSON.stringify({ note }),
  });
}

export function streamUrl(movie: Movie): string {
  if (movie.hasHls && movie.hlsPath) {
    return `/api/hls/${movie.hlsPath}`;
  }
  return `/api/stream/${movie.id}`;
}

export function subtitleUrl(track: SubtitleTrack): string {
  return `/api/subtitles/${track.id}`;
}

export function deleteMovie(id: string) {
  return request<{ ok: boolean }>(`/api/movies/${id}`, { method: "DELETE" });
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

/* --- Envoi de fichiers reprenable -------------------------------------------
 * Le serveur expose :
 *   GET    /api/upload?name=…                    -> { offset } : où reprendre
 *   PUT    /api/upload?name=…  Content-Range: …  -> ajoute un morceau
 *   DELETE /api/upload?name=…                    -> abandonne et libère les octets
 * Un 409 ne signifie pas l'échec : il porte l'offset réel du serveur, et on
 * repart de là. C'est ce qui permet à un envoi de 8 Go coupé à 95 % de
 * reprendre au lieu de tout recommencer.
 */

export type UploadProgress = {
  pct: number;
  sent: number;
  total: number;
  /** octets/s, mesuré depuis le début de CETTE tentative (0 tant que trop tôt) */
  rate: number;
  etaSeconds: number | null;
};

export type UploadHandle = {
  promise: Promise<{ filename: string }>;
  abort(): void;
};

/** 4 Mo : compromis entre le coût d'une requête et la finesse de la progression. */
const UPLOAD_CHUNK = 4 * 1024 * 1024;

export function abortUpload(name: string) {
  return request<{ ok: boolean }>(
    `/api/upload?name=${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
}

export function uploadResumable(
  file: File,
  onProgress: (p: UploadProgress) => void,
): UploadHandle {
  const controller = new AbortController();
  let aborted = false;

  const run = async (): Promise<{ filename: string }> => {
    const query = `/api/upload?name=${encodeURIComponent(file.name)}`;

    // Où le serveur en est-il déjà ? Un envoi neuf répond simplement 0.
    let offset = 0;
    try {
      const status = await request<{ offset: number }>(query);
      offset = Math.min(Math.max(status.offset ?? 0, 0), file.size);
    } catch {
      offset = 0;
    }

    const startedAt = Date.now();
    const startOffset = offset;
    const emit = () => {
      const elapsed = (Date.now() - startedAt) / 1000;
      const moved = offset - startOffset;
      const rate = elapsed > 0.5 && moved > 0 ? moved / elapsed : 0;
      const remaining = file.size - offset;
      onProgress({
        pct: file.size ? Math.round((offset / file.size) * 100) : 100,
        sent: offset,
        total: file.size,
        rate,
        etaSeconds: rate > 0 ? Math.round(remaining / rate) : null,
      });
    };
    emit();

    while (offset < file.size) {
      if (aborted) throw new Error("aborted");
      const end = Math.min(offset + UPLOAD_CHUNK, file.size);

      let res: Response;
      try {
        res = await fetch(query, {
          method: "PUT",
          credentials: "include",
          signal: controller.signal,
          headers: {
            "Content-Range": `bytes ${offset}-${end - 1}/${file.size}`,
          },
          body: file.slice(offset, end),
        });
      } catch (err) {
        if (aborted || (err as Error)?.name === "AbortError") {
          throw new Error("aborted");
        }
        throw err;
      }

      // 409 : le serveur a un autre offset que le nôtre. Il le dit, on le suit.
      if (res.status === 409) {
        const body = (await res.json().catch(() => ({}))) as { offset?: number };
        const real = Number(
          body.offset ?? res.headers.get("Upload-Offset") ?? Number.NaN,
        );
        if (!Number.isFinite(real) || real === offset) {
          throw new Error("Reprise impossible : le serveur et le client ne s'accordent pas");
        }
        offset = Math.min(Math.max(real, 0), file.size);
        emit();
        continue;
      }

      if (!res.ok) {
        let message = res.statusText;
        try {
          const body = (await res.json()) as { error?: string };
          if (body.error) message = body.error;
        } catch {
          /* ignore */
        }
        throw new Error(message);
      }

      const body = (await res.json()) as {
        complete: boolean;
        offset?: number;
        filename?: string;
      };
      offset = body.complete ? file.size : Math.min(body.offset ?? end, file.size);
      emit();
      if (body.complete) return { filename: body.filename ?? file.name };
    }

    return { filename: file.name };
  };

  return {
    promise: run(),
    abort() {
      aborted = true;
      controller.abort();
    },
  };
}
