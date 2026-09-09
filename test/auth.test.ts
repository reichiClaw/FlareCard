import { describe, expect, it } from "vitest";
import { ADMIN_PASSWORD, adminAuth, basic, makeApp, USER_PASSWORD } from "./helpers";
import { hashPassword, verifyPassword } from "../src/lib/crypto";

const PROPFIND_BODY = `<?xml version="1.0" encoding="utf-8"?>
<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`;

describe("password hashing", () => {
  it("hashes with PBKDF2 and verifies", async () => {
    const hash = await hashPassword("hunter2");
    expect(hash.startsWith("pbkdf2-sha256$100000$")).toBe(true);
    expect(await verifyPassword("hunter2", hash)).toBe(true);
    expect(await verifyPassword("hunter3", hash)).toBe(false);
    expect(await verifyPassword("hunter2", "garbage")).toBe(false);
  });

  it("uses a random salt", async () => {
    expect(await hashPassword("x")).not.toEqual(await hashPassword("x"));
  });
});

describe("bootstrap", () => {
  it("creates the initial admin from ADMIN_BOOTSTRAP_PASSWORD on first request", async () => {
    const t = await makeApp();
    const admin = await t.storage.getUserByUsername("admin");
    expect(admin?.role).toBe("admin");
    expect(admin?.passwordHash.startsWith("pbkdf2-sha256$")).toBe(true);
    const res = await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: adminAuth });
    expect(res.status).toBe(207);
  });

  it("does not create another admin once users exist", async () => {
    const t = await makeApp();
    expect(await t.storage.countUsers()).toBe(2);
    await t.fetch("/api/status", { auth: null });
    expect(await t.storage.countUsers()).toBe(2);
  });

  it("does nothing when no bootstrap password is configured", async () => {
    const t = await makeApp({ bootstrapPassword: null });
    const res = await t.fetch("/api/status", { auth: null });
    expect(await res.json()).toMatchObject({ bootstrapped: false });
  });
});

describe("HTTP Basic auth on the CardDAV tree", () => {
  it("returns 401 with a Basic challenge when credentials are missing", async () => {
    const t = await makeApp();
    const res = await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: null });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/^Basic realm="FlareCard"/);
  });

  it("returns 401 for a wrong password", async () => {
    const t = await makeApp();
    const res = await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: basic("alice", "nope") });
    expect(res.status).toBe(401);
  });

  it("returns 401 for an unknown user", async () => {
    const t = await makeApp();
    const res = await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: basic("ghost", "x") });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a disabled user even with the right password", async () => {
    const t = await makeApp();
    const alice = await t.storage.getUserByUsername("alice");
    await t.storage.updateUser(alice!.id, { disabled: true });
    const res = await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY });
    expect(res.status).toBe(401);
  });

  it("accepts valid credentials (case-insensitive username)", async () => {
    const t = await makeApp();
    const res = await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: basic("Alice", USER_PASSWORD) });
    expect(res.status).toBe(207);
  });

  it("allows OPTIONS without credentials and advertises addressbook support", async () => {
    const t = await makeApp();
    const res = await t.fetch("/dav/addressbooks/shared/", { method: "OPTIONS", auth: null });
    expect(res.status).toBe(200);
    expect(res.headers.get("dav")).toBe("1, 3, addressbook");
    expect(res.headers.get("allow")).toContain("PROPFIND");
    expect(res.headers.get("allow")).toContain("REPORT");
    expect(res.headers.get("allow")).not.toContain("PUT");
  });
});

describe("admin session auth", () => {
  it("rejects non-admins from the admin UI", async () => {
    const t = await makeApp();
    const res = await t.fetch("/api/auth/login", {
      method: "POST",
      auth: null,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "alice", password: USER_PASSWORD }),
    });
    expect(res.status).toBe(403);
  });

  it("issues a session cookie for admins and accepts it on later requests", async () => {
    const t = await makeApp();
    const login = await t.fetch("/api/auth/login", {
      method: "POST",
      auth: null,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
    });
    expect(login.status).toBe(200);
    const cookie = login.headers.get("set-cookie")!;
    expect(cookie).toContain("flarecard_session=");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    const me = await t.fetch("/api/auth/me", { auth: null, headers: { Cookie: cookie.split(";")[0] } });
    expect(me.status).toBe(200);
    expect(((await me.json()) as { user: { username: string } }).user.username).toBe("admin");
    // The probe answers 200 with a null user when there is no session.
    const anon = await t.fetch("/api/auth/me", { auth: null });
    expect(anon.status).toBe(200);
    expect(((await anon.json()) as { user: unknown }).user).toBeNull();
  });

  it("rejects requests without a session or Basic admin credentials", async () => {
    const t = await makeApp();
    expect((await t.fetch("/api/contacts", { auth: null })).status).toBe(401);
    // Regular users cannot use the API even with valid Basic credentials.
    expect((await t.fetch("/api/contacts")).status).toBe(401);
    // Admin Basic credentials are accepted (used by scripts).
    expect((await t.fetch("/api/contacts", { auth: adminAuth })).status).toBe(200);
  });

  it("invalidates sessions after a password reset", async () => {
    const t = await makeApp();
    const login = await t.fetch("/api/auth/login", {
      method: "POST",
      auth: null,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: "admin", password: ADMIN_PASSWORD }),
    });
    const cookie = login.headers.get("set-cookie")!.split(";")[0];
    const admin = await t.storage.getUserByUsername("admin");
    await t.storage.updateUser(admin!.id, { passwordHash: await hashPassword("new-pw") });
    const me = await t.fetch("/api/auth/me", { auth: null, headers: { Cookie: cookie } });
    expect(((await me.json()) as { user: unknown }).user).toBeNull();
    expect((await t.fetch("/api/contacts", { auth: null, headers: { Cookie: cookie } })).status).toBe(401);
  });
});
