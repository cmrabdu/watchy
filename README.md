# Watchy

Private synced cinema for long-distance movie nights.

Pick a film, stay on the same frame — shared play / pause / seek, reactions, resume, and Jellyfin-style TMDB metadata.

## Stack

- **Web**: React + Vite + hls.js
- **Server**: Hono + WebSocket sync + cookie auth
- **Deploy**: Docker Compose + Caddy (HTTPS)

## Local dev

```bash
cp .env.example .env
# fill AUTH_USERS with: npm run hash-password -- 'your-password'
# optional: TMDB_API_KEY from https://www.themoviedb.org/settings/api
npm install
npm run gen-test-video
npm run dev:server   # :8787
npm run dev:web      # :5173
```

## Production

```bash
# Prepare .env (SESSION_SECRET, AUTH_USERS, PUBLIC_ORIGIN, TMDB_API_KEY)
./scripts/bootstrap-vps.sh root@your-vps
./scripts/upload-movie.sh ~/Movies/film.mkv
```

In `.env` consumed by Docker Compose, escape bcrypt `$` as `$$` (`bootstrap-vps.sh` does this).

## Env (never commit `.env`)

| Variable | Purpose |
| --- | --- |
| `AUTH_USERS` | `user:bcryptHash[:admin\|user],…` |
| `SESSION_SECRET` | HMAC cookie secret |
| `TMDB_API_KEY` | Auto posters / titles |
| `PUBLIC_ORIGIN` | Public HTTPS origin |
| `MEDIA_DIR` | Media volume path |

## License

Private project by [C.M.R.A.B.D.U.](https://github.com/cmrabdu) — made with hard.
