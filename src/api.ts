import { Hono } from "hono";
import type { Services } from "./app";
import type { Contact, User } from "./storage/types";
import { SESSION_COOKIE, parseCookies } from "./lib/auth";
import { generateAppPassword, hashPassword } from "./lib/crypto";
import { clientIp, tooManyRequests } from "./lib/ratelimit";
import { ContactValidationError } from "./lib/contacts";
import { DEMO_CONTACTS } from "./lib/demo";
import { buildMobileConfig } from "./lib/mobileconfig";
import { type ContactFields, type PhotoField, emptyFields, exportVCards } from "./lib/vcard";
import { ADDRESSBOOK_PATH, principalHref } from "./dav/paths";
import {
  DEFAULT_ADDRESSBOOK_DESCRIPTION,
  DEFAULT_ADDRESSBOOK_NAME,
  LOCK_MARKER_SETTING,
  loadLockMarkerSetting,
} from "./dav/context";
import { LOCK_MARK } from "./lib/lockmark";
import { SigningError } from "./lib/signing";
import { ResyncError } from "./lib/resync";

type Variables = { user: User };

const MAX_IMPORT_BYTES = 25 * 1024 * 1024;

function publicUser(u: User) {
  return { id: u.id, username: u.username, role: u.role, disabled: u.disabled, createdAt: u.createdAt };
}

function sessionCookie(token: string, secure: boolean, maxAge: number): string {
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure ? "; Secure" : ""}`;
}

/** Host used for profiles/setup pages: PUBLIC_HOST overrides the request Host. */
function publicHost(services: Services, request: Request): { host: string; hostname: string; port: number; useSSL: boolean } {
  const url = new URL(request.url);
  const forwardedProto = request.headers.get("x-forwarded-proto");
  const configured = (services.env.PUBLIC_HOST ?? "").trim();
  const host = configured || request.headers.get("host") || url.host;
  const useSSL = configured ? true : (forwardedProto ?? url.protocol.replace(":", "")) === "https";
  const [hostname, portStr] = host.includes(":") && !host.startsWith("[") ? host.split(":") : [host, ""];
  const port = portStr ? Number(portStr) : useSSL ? 443 : 80;
  return { host, hostname, port, useSSL };
}

function coerceFields(input: unknown): ContactFields {
  const f = emptyFields();
  if (!input || typeof input !== "object") return f;
  const src = input as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  f.uid = str(src.uid);
  f.fn = str(src.fn);
  const n = (src.n ?? {}) as Record<string, unknown>;
  f.n = {
    family: str(n.family),
    given: str(n.given),
    additional: str(n.additional),
    prefix: str(n.prefix),
    suffix: str(n.suffix),
  };
  f.nickname = str(src.nickname);
  f.org = str(src.org);
  f.department = str(src.department);
  f.title = str(src.title);
  f.role = str(src.role);
  f.birthday = str(src.birthday);
  f.note = str(src.note);
  const arr = (v: unknown) => (Array.isArray(v) ? (v as Record<string, unknown>[]) : []);
  f.phones = arr(src.phones)
    .map((p) => ({ type: str(p.type) || "OTHER", value: str(p.value), pref: p.pref === true || undefined }))
    .filter((p) => p.value.trim());
  f.emails = arr(src.emails)
    .map((e) => ({ type: str(e.type) || "OTHER", value: str(e.value), pref: e.pref === true || undefined }))
    .filter((e) => e.value.trim());
  f.addresses = arr(src.addresses).map((a) => ({
    type: str(a.type) || "OTHER",
    poBox: str(a.poBox),
    extended: str(a.extended),
    street: str(a.street),
    city: str(a.city),
    region: str(a.region),
    postalCode: str(a.postalCode),
    country: str(a.country),
  }));
  f.urls = arr(src.urls)
    .map((u) => ({ type: str(u.type) || "OTHER", value: str(u.value) }))
    .filter((u) => u.value.trim());
  if (src.photo && typeof src.photo === "object") {
    const p = src.photo as Record<string, unknown>;
    const mediaType = str(p.mediaType) as PhotoField["mediaType"];
    f.photo = { mediaType, base64: str(p.base64).replace(/\s+/g, "") };
  }
  return f;
}

function contactSummary(services: Services, c: Contact) {
  const f = services.contacts.fieldsOf(c);
  return {
    uid: c.uid,
    fn: f.fn,
    org: f.org,
    title: f.title,
    email: f.emails.find((e) => e.pref)?.value ?? f.emails[0]?.value ?? "",
    phone: f.phones.find((p) => p.pref)?.value ?? f.phones[0]?.value ?? "",
    hasPhoto: !!f.photo,
    etag: c.etag,
    updatedAt: c.updatedAt,
  };
}

function formatRetry(seconds: number): string {
  if (seconds < 90) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
}

export function adminApi(services: Services): Hono<{ Variables: Variables }> {
  const api = new Hono<{ Variables: Variables }>();
  const { storage, auth, contacts, rateLimiter, signer, resync } = services;

  /** Kicks the ACME state machine in the background when there is something to do. */
  const nudgeSigner = async () => {
    if (await signer.hasWork()) services.background(signer.advance());
  };

  api.get("/status", async (c) => {
    const { host } = publicHost(services, c.req.raw);
    return c.json({ bootstrapped: await auth.isBootstrapped(), host });
  });

  api.post("/auth/login", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const username = typeof body.username === "string" ? body.username : "";
    const password = typeof body.password === "string" ? body.password : "";
    if (!username || !password) return c.json({ error: "Username and password are required" }, 400);
    const ip = clientIp(c.req.raw);
    const limit = rateLimiter.check(ip, username);
    if (!limit.allowed) {
      c.header("Retry-After", String(limit.retryAfterSeconds));
      return c.json({ error: `Too many failed attempts. Try again in ${formatRetry(limit.retryAfterSeconds)}.` }, 429);
    }
    const result = await auth.authenticatePassword(username, password);
    if (!result.ok) {
      rateLimiter.recordFailure(ip, username);
      return c.json({ error: "Invalid username or password" }, 401);
    }
    if (result.user.role !== "admin") return c.json({ error: "Only administrators can sign in to the admin UI" }, 403);
    rateLimiter.recordSuccess(ip, result.user.username);
    const token = await auth.createSessionToken(result.user);
    const secure = new URL(c.req.url).protocol === "https:";
    c.header("Set-Cookie", sessionCookie(token, secure, 12 * 60 * 60));
    return c.json({ user: publicUser(result.user) });
  });

  api.post("/auth/logout", (c) => {
    c.header("Set-Cookie", sessionCookie("", false, 0));
    return c.json({ ok: true });
  });

  const resolveAdmin = async (
    request: Request,
  ): Promise<{ user: User; viaCookie: boolean } | { rateLimited: Response } | null> => {
    const cookies = parseCookies(request.headers.get("cookie"));
    const fromCookie = await auth.verifySessionToken(cookies[SESSION_COOKIE]);
    if (fromCookie) return { user: fromCookie, viaCookie: true };
    const header = request.headers.get("authorization");
    if (!header) return null;
    const ip = clientIp(request);
    const username = auth.parseBasic(header)?.username ?? null;
    const limit = rateLimiter.check(ip, username);
    if (!limit.allowed) return { rateLimited: tooManyRequests(limit) };
    const basic = await auth.authenticateBasic(header);
    if (basic.ok && basic.user.role === "admin") {
      rateLimiter.recordSuccess(ip, basic.user.username);
      return { user: basic.user, viaCookie: false };
    }
    if (!basic.ok && basic.reason !== "missing") rateLimiter.recordFailure(ip, username);
    return null;
  };

  // Session probe used by the UI on load; answers 200 either way to keep the console quiet.
  api.get("/auth/me", async (c) => {
    const resolved = await resolveAdmin(c.req.raw);
    if (resolved && "rateLimited" in resolved) return resolved.rateLimited;
    return c.json({ user: resolved ? publicUser(resolved.user) : null });
  });

  // Everything below requires an admin: session cookie (UI) or Basic auth (scripts).
  api.use("*", async (c, next) => {
    const request = c.req.raw;
    const resolved = await resolveAdmin(request);
    if (resolved && "rateLimited" in resolved) return resolved.rateLimited;
    if (!resolved) return c.json({ error: "Unauthorized" }, 401);
    const { user, viaCookie } = resolved;
    if (viaCookie && request.method !== "GET" && request.method !== "HEAD") {
      // CSRF: cookie-authenticated mutations must originate from our own origin.
      const site = request.headers.get("sec-fetch-site");
      const origin = request.headers.get("origin");
      const sameOrigin = origin ? new URL(origin).host === new URL(request.url).host : true;
      if ((site && site !== "same-origin" && site !== "none") || !sameOrigin) {
        return c.json({ error: "Cross-site request rejected" }, 403);
      }
    }
    c.set("user", user);
    await next();
  });

  // -------------------------------------------------------------------------
  // Settings

  api.get("/settings", async (c) => {
    const host = publicHost(services, c.req.raw);
    return c.json({
      addressbookName: (await storage.getSetting("addressbook_name")) ?? DEFAULT_ADDRESSBOOK_NAME,
      addressbookDescription: (await storage.getSetting("addressbook_description")) ?? DEFAULT_ADDRESSBOOK_DESCRIPTION,
      lockMarker: await loadLockMarkerSetting(storage),
      lockMark: LOCK_MARK,
      host: host.host,
      useSSL: host.useSSL,
      addressbookPath: ADDRESSBOOK_PATH,
      principalPath: principalHref(c.get("user").username),
      contactCount: await storage.countContacts(),
      userCount: await storage.countUsers(),
    });
  });

  api.put("/settings", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    if (typeof body.addressbookName === "string" && body.addressbookName.trim()) {
      await storage.setSetting("addressbook_name", body.addressbookName.trim().slice(0, 100));
    }
    if (typeof body.addressbookDescription === "string") {
      await storage.setSetting("addressbook_description", body.addressbookDescription.trim().slice(0, 500));
    }
    let touched = 0;
    if (typeof body.lockMarker === "boolean") {
      const current = await loadLockMarkerSetting(storage);
      if (current !== body.lockMarker) {
        await storage.setSetting(LOCK_MARKER_SETTING, body.lockMarker ? "1" : "0");
        // Every card devices hold is now stale; bump all seqs so they resync.
        touched = await contacts.touchAll();
      }
    }
    return c.json({ ok: true, touched });
  });

  // -------------------------------------------------------------------------
  // Contacts

  api.get("/contacts", async (c) => {
    const q = c.req.query("q") ?? "";
    const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 50) || 50, 1), 200);
    const offset = Math.max(Number(c.req.query("offset") ?? 0) || 0, 0);
    const page = await storage.listContacts({ q, limit, offset });
    return c.json({
      items: page.items.map((ct) => contactSummary(services, ct)),
      total: page.total,
      limit,
      offset,
      syncSeq: await storage.currentSeq(),
    });
  });

  api.get("/contacts/export.vcf", async (c) => {
    const all = await storage.allContacts();
    return new Response(exportVCards(all.map((ct) => ct.vcard)), {
      headers: {
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Disposition": `attachment; filename="flarecard-export.vcf"`,
      },
    });
  });

  api.post("/contacts/import", async (c) => {
    const len = Number(c.req.header("content-length") ?? "0");
    if (len > MAX_IMPORT_BYTES) return c.json({ error: "Import file too large (max 25 MB)" }, 413);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body.text !== "string") return c.json({ error: "Expected { format, text }" }, 400);
    const format = body.format === "csv" ? "csv" : "vcf";
    const summary = format === "csv" ? await contacts.importCsv(body.text) : await contacts.importVcf(body.text);
    return c.json(summary);
  });

  api.post("/contacts/seed", async (c) => {
    let imported = 0;
    for (const f of DEMO_CONTACTS) {
      await contacts.save(f);
      imported++;
    }
    return c.json({ imported });
  });

  api.get("/contacts/:uid", async (c) => {
    const ct = await storage.getContact(c.req.param("uid"));
    if (!ct) return c.json({ error: "Not found" }, 404);
    return c.json({ fields: contacts.fieldsOf(ct), vcard: ct.vcard, etag: ct.etag, updatedAt: ct.updatedAt });
  });

  const saveContact = async (fields: ContactFields) => {
    try {
      return { contact: await contacts.save(fields) };
    } catch (e) {
      if (e instanceof ContactValidationError) return { error: e.message };
      throw e;
    }
  };

  api.post("/contacts", async (c) => {
    const fields = coerceFields(await c.req.json().catch(() => ({})));
    fields.uid = fields.uid || crypto.randomUUID();
    const result = await saveContact(fields);
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json({ uid: result.contact.uid, etag: result.contact.etag }, 201);
  });

  api.put("/contacts/:uid", async (c) => {
    const uid = c.req.param("uid");
    if (!(await storage.getContact(uid))) return c.json({ error: "Not found" }, 404);
    const fields = coerceFields(await c.req.json().catch(() => ({})));
    fields.uid = uid;
    const result = await saveContact(fields);
    if ("error" in result) return c.json({ error: result.error }, 400);
    return c.json({ uid: result.contact.uid, etag: result.contact.etag });
  });

  api.delete("/contacts/:uid", async (c) => {
    const ok = await storage.deleteContact(c.req.param("uid"));
    return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  });

  // -------------------------------------------------------------------------
  // Users

  api.get("/users", async (c) => c.json({ items: (await storage.listUsers()).map(publicUser) }));

  api.post("/users", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const username = typeof body.username === "string" ? body.username.trim() : "";
    const role = body.role === "admin" ? "admin" : "user";
    if (!/^[a-zA-Z0-9._@+-]{2,64}$/.test(username)) {
      return c.json({ error: "Username must be 2-64 chars: letters, digits, . _ @ + -" }, 400);
    }
    if (await storage.getUserByUsername(username)) return c.json({ error: "Username already exists" }, 409);
    const password = generateAppPassword();
    const user = await storage.createUser({ username, role, passwordHash: await hashPassword(password) });
    return c.json({ user: publicUser(user), password }, 201);
  });

  api.patch("/users/:id", async (c) => {
    const id = Number(c.req.param("id"));
    const target = await storage.getUserById(id);
    if (!target) return c.json({ error: "Not found" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const patch: { disabled?: boolean; role?: "admin" | "user" } = {};
    if (typeof body.disabled === "boolean") patch.disabled = body.disabled;
    if (body.role === "admin" || body.role === "user") patch.role = body.role;
    const me = c.get("user");
    if (target.id === me.id && (patch.disabled === true || patch.role === "user")) {
      return c.json({ error: "You cannot disable or demote your own account" }, 400);
    }
    const updated = await storage.updateUser(id, patch);
    auth.invalidateUser(id);
    return c.json({ user: publicUser(updated!) });
  });

  api.post("/users/:id/reset-password", async (c) => {
    const id = Number(c.req.param("id"));
    const target = await storage.getUserById(id);
    if (!target) return c.json({ error: "Not found" }, 404);
    const password = generateAppPassword();
    await storage.updateUser(id, { passwordHash: await hashPassword(password) });
    auth.invalidateUser(id);
    return c.json({ password });
  });

  api.delete("/users/:id", async (c) => {
    const id = Number(c.req.param("id"));
    if (id === c.get("user").id) return c.json({ error: "You cannot delete your own account" }, 400);
    const ok = await storage.deleteUser(id);
    auth.invalidateUser(id);
    return ok ? c.body(null, 204) : c.json({ error: "Not found" }, 404);
  });

  api.get("/users/:id/profile.mobileconfig", async (c) => {
    const target = await storage.getUserById(Number(c.req.param("id")));
    if (!target) return c.json({ error: "Not found" }, 404);
    const host = publicHost(services, c.req.raw);
    const name = (await storage.getSetting("addressbook_name")) ?? DEFAULT_ADDRESSBOOK_NAME;
    const profile = buildMobileConfig({
      host: host.hostname,
      port: host.port,
      useSSL: host.useSSL,
      username: target.username,
      accountDescription: name,
    });
    const plist = new TextEncoder().encode(profile);
    let body: Uint8Array = plist;
    let signed = false;
    try {
      const cms = await signer.sign(plist);
      if (cms) {
        body = cms;
        signed = true;
      }
    } catch (e) {
      console.error("Profile signing failed; serving unsigned profile", e);
    }
    await nudgeSigner();
    return new Response(body as BodyInit, {
      headers: {
        "Content-Type": signed ? "application/x-apple-aspen-config" : "application/x-apple-aspen-config; charset=utf-8",
        "Content-Disposition": `attachment; filename="flarecard-${target.username}.mobileconfig"`,
        "X-FlareCard-Profile-Signed": signed ? "yes" : "no",
      },
    });
  });

  // -------------------------------------------------------------------------
  // Profile signing (CMS with an operator-provided or automatically managed certificate)

  api.get("/signing", async (c) => {
    const host = publicHost(services, c.req.raw);
    const status = await signer.status(host.hostname);
    if (status.inProgress || status.renewalDue) await nudgeSigner();
    return c.json(status);
  });

  api.put("/signing", async (c) => {
    const body = (await c.req.json().catch(() => ({}))) as { enabled?: unknown; email?: unknown };
    if (typeof body.enabled !== "boolean") return c.json({ error: "enabled must be a boolean" }, 400);
    const host = publicHost(services, c.req.raw);
    const email = typeof body.email === "string" ? body.email.trim() : null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return c.json({ error: "Invalid e-mail address" }, 400);
    try {
      if (body.enabled) {
        await signer.enable(host.hostname, email);
        // Give the first order a head start so the UI sees progress immediately,
        // then let it continue in the background.
        await Promise.race([signer.advance(), new Promise((r) => setTimeout(r, 4000))]);
        services.background(signer.advance());
      } else {
        await signer.disable();
      }
    } catch (e) {
      if (e instanceof SigningError) return c.json({ error: e.message }, 400);
      throw e;
    }
    return c.json(await signer.status(host.hostname));
  });

  api.post("/signing/renew", async (c) => {
    const host = publicHost(services, c.req.raw);
    try {
      await signer.renewNow(host.hostname);
    } catch (e) {
      if (e instanceof SigningError) return c.json({ error: e.message }, 400);
      throw e;
    }
    await Promise.race([signer.advance(), new Promise((r) => setTimeout(r, 4000))]);
    services.background(signer.advance());
    return c.json(await signer.status(host.hostname));
  });

  // -------------------------------------------------------------------------
  // Forced re-sync (scheduled "push" of the whole address book to every device)

  api.get("/resync", async (c) => c.json(await resync.status()));

  api.put("/resync", async (c) => {
    const body = await c.req.json().catch(() => null);
    try {
      return c.json(await resync.setSchedule(body));
    } catch (e) {
      if (e instanceof ResyncError) return c.json({ error: e.message }, 400);
      throw e;
    }
  });

  api.post("/resync/run", async (c) => {
    const run = await resync.runNow("manual");
    return c.json({ ...(await resync.status()), run });
  });

  return api;
}
