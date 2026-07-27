import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "../../..");

export type Role = "admin" | "user";

export type AuthUser = {
  username: string;
  passwordHash: string;
  role: Role;
};

function parseUsers(raw: string | undefined): AuthUser[] {
  if (!raw?.trim()) return [];
  return raw.split(",").map((entry) => {
    const trimmed = entry.trim();
    // username:bcryptHash[:role]
    // bcrypt has no ":", role is optional trailing :admin|:user
    let role: Role = "user";
    let rest = trimmed;
    if (rest.endsWith(":admin")) {
      role = "admin";
      rest = rest.slice(0, -":admin".length);
    } else if (rest.endsWith(":user")) {
      role = "user";
      rest = rest.slice(0, -":user".length);
    }
    const idx = rest.indexOf(":");
    if (idx <= 0) {
      throw new Error(`Invalid AUTH_USERS entry: ${entry}`);
    }
    return {
      username: rest.slice(0, idx).trim(),
      passwordHash: rest.slice(idx + 1).trim(),
      role,
    };
  });
}

const isProd = process.env.NODE_ENV === "production";

export const config = {
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "0.0.0.0",
  mediaDir: path.resolve(process.env.MEDIA_DIR ?? path.join(repoRoot, "media")),
  webDistDir: path.resolve(
    process.env.WEB_DIST_DIR ?? path.join(repoRoot, "apps/web/dist"),
  ),
  sessionSecret:
    process.env.SESSION_SECRET ??
    (isProd ? "" : "dev-only-session-secret-change-me"),
  cookieSecure:
    process.env.COOKIE_SECURE === "true" ||
    (process.env.COOKIE_SECURE !== "false" && isProd),
  publicOrigin: process.env.PUBLIC_ORIGIN ?? "http://localhost:5173",
  users: parseUsers(process.env.AUTH_USERS),
  sessionTtlMs: 1000 * 60 * 60 * 24 * 14,
  isProd,
  maxUploadBytes: Number(process.env.MAX_UPLOAD_BYTES ?? 20 * 1024 ** 3),
  /** Free key: https://www.themoviedb.org/settings/api */
  tmdbApiKey: process.env.TMDB_API_KEY?.trim() || "",
};

if (isProd && !process.env.SESSION_SECRET) {
  throw new Error("SESSION_SECRET is required in production");
}

if (!config.users.length) {
  console.warn(
    "AUTH_USERS is empty — set users via .env (npm run hash-password -- 'pass')",
  );
}
