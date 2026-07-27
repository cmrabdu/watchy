import { createHmac, timingSafeEqual } from "node:crypto";
import bcrypt from "bcryptjs";
import { config, type AuthUser, type Role } from "./config.js";

export type SessionPayload = {
  u: string;
  role: Role;
  exp: number;
};

function b64url(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function fromB64url(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const pad = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
  return Buffer.from(padded + pad, "base64");
}

export function findUser(username: string): AuthUser | undefined {
  const key = username.trim().toLowerCase();
  return config.users.find((u) => u.username.toLowerCase() === key);
}

export async function verifyPassword(
  user: AuthUser,
  password: string,
): Promise<boolean> {
  return bcrypt.compare(password, user.passwordHash);
}

export function signSession(user: AuthUser): string {
  const payload: SessionPayload = {
    u: user.username,
    role: user.role,
    exp: Date.now() + config.sessionTtlMs,
  };
  const body = b64url(JSON.stringify(payload));
  const sig = createHmac("sha256", config.sessionSecret)
    .update(body)
    .digest();
  return `${body}.${b64url(sig)}`;
}

export function verifySession(token: string | undefined): SessionPayload | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", config.sessionSecret)
    .update(body)
    .digest();
  const got = fromB64url(sig);
  if (got.length !== expected.length || !timingSafeEqual(got, expected)) {
    return null;
  }
  try {
    const payload = JSON.parse(fromB64url(body).toString("utf8")) as SessionPayload;
    if (!payload.u || typeof payload.exp !== "number" || payload.exp < Date.now()) {
      return null;
    }
    const user = findUser(payload.u);
    if (!user) return null;
    return { u: user.username, role: user.role, exp: payload.exp };
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = "watch_session";
