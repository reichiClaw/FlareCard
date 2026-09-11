import type { Hono } from "hono";
import { createApp, type AppEnv } from "../src/app";
import type { FetchLike } from "../src/lib/acme";
import { MemoryStorage } from "../src/storage/memory";
import { hashPassword } from "../src/lib/crypto";
import { findChild, findChildren, parseXml, type XmlNode, NS_DAV } from "../src/lib/xml";

export const ADMIN_PASSWORD = "admin-secret-pw";
export const USER_PASSWORD = "user-secret-pw";

export interface TestApp {
  app: Hono;
  storage: MemoryStorage;
  fetch(path: string, init?: RequestInit & { auth?: string | null; body?: string | null }): Promise<Response>;
}

export function basic(username: string, password: string): string {
  return `Basic ${btoa(`${username}:${password}`)}`;
}

export async function makeApp(
  opts: { bootstrapPassword?: string | null; env?: Partial<AppEnv>; fetch?: FetchLike; now?: () => Date } = {},
): Promise<TestApp> {
  const storage = new MemoryStorage();
  const bootstrapPassword = opts.bootstrapPassword === undefined ? ADMIN_PASSWORD : opts.bootstrapPassword;
  const app = createApp({
    storage,
    fetch: opts.fetch,
    now: opts.now,
    acmePollIntervalMs: 10,
    env: {
      ADMIN_BOOTSTRAP_PASSWORD: bootstrapPassword ?? undefined,
      ADMIN_BOOTSTRAP_USERNAME: "admin",
      SESSION_SECRET: "test-session-secret",
      ...opts.env,
    },
  });
  if (bootstrapPassword) {
    // Trigger first-run bootstrap (creates "admin") before adding the regular user.
    await app.request("https://contacts.example.com/api/status");
    await storage.createUser({ username: "alice", role: "user", passwordHash: await hashPassword(USER_PASSWORD) });
  }
  return {
    app,
    storage,
    fetch(path, init = {}) {
      const { auth, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (auth === undefined) headers.set("Authorization", basic("alice", USER_PASSWORD));
      else if (auth) headers.set("Authorization", auth);
      return Promise.resolve(app.request(`https://contacts.example.com${path}`, { ...rest, headers }));
    },
  };
}

export const adminAuth = basic("admin", ADMIN_PASSWORD);

export function xml(text: string): XmlNode {
  const node = parseXml(text);
  if (!node) throw new Error("empty XML");
  return node;
}

export function responses(ms: XmlNode): XmlNode[] {
  return findChildren(ms, NS_DAV, "response");
}

export function hrefOf(response: XmlNode): string {
  return findChild(response, NS_DAV, "href")?.text ?? "";
}

/** Returns the 200 propstat <D:prop> of a response. */
export function okProps(response: XmlNode): XmlNode | undefined {
  for (const ps of findChildren(response, NS_DAV, "propstat")) {
    if (findChild(ps, NS_DAV, "status")?.text.includes("200")) return findChild(ps, NS_DAV, "prop");
  }
  return undefined;
}

export function notFoundProps(response: XmlNode): XmlNode | undefined {
  for (const ps of findChildren(response, NS_DAV, "propstat")) {
    if (findChild(ps, NS_DAV, "status")?.text.includes("404")) return findChild(ps, NS_DAV, "prop");
  }
  return undefined;
}

export function statusOf(response: XmlNode): string {
  return findChild(response, NS_DAV, "status")?.text ?? "";
}
