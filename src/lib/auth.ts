import type { Storage, User } from "../storage/types";
import {
  base64ToBytes,
  bytesToBase64,
  hashPassword,
  hmacSign,
  hmacVerify,
  randomBytes,
  sha256Hex,
  verifyPassword,
} from "./crypto";

export interface AuthEnv {
  ADMIN_BOOTSTRAP_PASSWORD?: string;
  ADMIN_BOOTSTRAP_USERNAME?: string;
  SESSION_SECRET?: string;
}

export const SESSION_COOKIE = "flarecard_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000;

export type AuthResult =
  | { ok: true; user: User }
  | { ok: false; reason: "missing" | "malformed" | "invalid" | "disabled" };

/**
 * Authentication for both the CardDAV surface (HTTP Basic) and the admin UI
 * (HMAC-signed session cookie). Verified Basic credentials are cached in memory
 * for a few minutes so PBKDF2 is not re-run on every PROPFIND.
 */
export class AuthService {
  private credentialCache = new Map<string, { userId: number; expires: number }>();
  private sessionSecret: string | null = null;

  constructor(
    private storage: Storage,
    private env: AuthEnv,
  ) {}

  /** Creates the first admin from ADMIN_BOOTSTRAP_PASSWORD when the user table is empty. */
  async ensureBootstrap(): Promise<void> {
    if ((await this.storage.countUsers()) > 0) return;
    const password = this.env.ADMIN_BOOTSTRAP_PASSWORD;
    if (!password) return;
    const username = (this.env.ADMIN_BOOTSTRAP_USERNAME || "admin").trim() || "admin";
    await this.storage.createUser({ username, role: "admin", passwordHash: await hashPassword(password) });
  }

  async isBootstrapped(): Promise<boolean> {
    return (await this.storage.countUsers()) > 0;
  }

  invalidateUser(userId: number): void {
    for (const [k, v] of this.credentialCache) if (v.userId === userId) this.credentialCache.delete(k);
  }

  parseBasic(header: string | null | undefined): { username: string; password: string } | null {
    if (!header) return null;
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
    if (!m) return null;
    let decoded: string;
    try {
      decoded = new TextDecoder().decode(base64ToBytes(m[1]));
    } catch {
      return null;
    }
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    return { username: decoded.slice(0, idx), password: decoded.slice(idx + 1) };
  }

  async authenticateBasic(header: string | null | undefined): Promise<AuthResult> {
    if (!header) return { ok: false, reason: "missing" };
    const creds = this.parseBasic(header);
    if (!creds) return { ok: false, reason: "malformed" };
    return this.authenticatePassword(creds.username, creds.password);
  }

  async authenticatePassword(username: string, password: string): Promise<AuthResult> {
    const user = await this.storage.getUserByUsername(username);
    if (!user) {
      // Burn comparable time so username enumeration via timing is harder.
      await verifyPassword(password, DUMMY_HASH);
      return { ok: false, reason: "invalid" };
    }
    if (user.disabled) return { ok: false, reason: "disabled" };

    const cacheKey = `${user.id}:${await sha256Hex(`${user.passwordHash}\n${password}`)}`;
    const cached = this.credentialCache.get(cacheKey);
    const now = Date.now();
    if (cached && cached.expires > now) return { ok: true, user };

    if (!(await verifyPassword(password, user.passwordHash))) return { ok: false, reason: "invalid" };
    this.credentialCache.set(cacheKey, { userId: user.id, expires: now + CREDENTIAL_CACHE_TTL_MS });
    if (this.credentialCache.size > 5000) this.credentialCache.clear();
    return { ok: true, user };
  }

  private async getSessionSecret(): Promise<string> {
    if (this.sessionSecret) return this.sessionSecret;
    if (this.env.SESSION_SECRET) {
      this.sessionSecret = this.env.SESSION_SECRET;
      return this.sessionSecret;
    }
    let stored = await this.storage.getSetting("session_secret");
    if (!stored) {
      stored = bytesToBase64(randomBytes(32));
      await this.storage.setSetting("session_secret", stored);
    }
    this.sessionSecret = stored;
    return stored;
  }

  /** Session token format: `<userId>.<expiresMs>.<passwordHashFingerprint>.<hmac>` */
  async createSessionToken(user: User): Promise<string> {
    const expires = Date.now() + SESSION_TTL_MS;
    const fp = (await sha256Hex(user.passwordHash)).slice(0, 16);
    const payload = `${user.id}.${expires}.${fp}`;
    const sig = await hmacSign(await this.getSessionSecret(), payload);
    return `${payload}.${sig}`;
  }

  async verifySessionToken(token: string | null | undefined): Promise<User | null> {
    if (!token) return null;
    const parts = token.split(".");
    if (parts.length !== 4) return null;
    const [idStr, expStr, fp, sig] = parts;
    const payload = `${idStr}.${expStr}.${fp}`;
    if (!(await hmacVerify(await this.getSessionSecret(), payload, sig))) return null;
    if (Number(expStr) < Date.now()) return null;
    const user = await this.storage.getUserById(Number(idStr));
    if (!user || user.disabled || user.role !== "admin") return null;
    // Password resets invalidate existing sessions.
    if ((await sha256Hex(user.passwordHash)).slice(0, 16) !== fp) return null;
    return user;
  }
}

// A valid-format hash of a random password, used only to equalise timing for unknown users.
const DUMMY_HASH = "pbkdf2-sha256$100000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";

export function parseCookies(header: string | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const idx = part.indexOf("=");
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
