import { describe, expect, it } from "vitest";
import { AuthRateLimiter, RateLimiter, clientIp } from "../src/lib/ratelimit";
import { ADMIN_PASSWORD, basic, makeApp, USER_PASSWORD } from "./helpers";

const PROPFIND_BODY = `<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>`;

describe("RateLimiter", () => {
  it("blocks after max failures within the window and recovers when it expires", () => {
    let now = 1_000_000;
    const rl = new RateLimiter(3, 60_000, () => now);
    expect(rl.check("k").allowed).toBe(true);
    rl.recordFailure("k");
    rl.recordFailure("k");
    expect(rl.check("k")).toMatchObject({ allowed: true, remaining: 1 });
    rl.recordFailure("k");
    const blocked = rl.check("k");
    expect(blocked.allowed).toBe(false);
    expect(blocked.retryAfterSeconds).toBe(60);
    now += 30_000;
    expect(rl.check("k").retryAfterSeconds).toBe(30);
    now += 30_001;
    expect(rl.check("k").allowed).toBe(true);
  });

  it("keeps keys independent and resets on success", () => {
    const rl = new RateLimiter(1, 60_000);
    rl.recordFailure("a");
    expect(rl.check("a").allowed).toBe(false);
    expect(rl.check("b").allowed).toBe(true);
    rl.reset("a");
    expect(rl.check("a").allowed).toBe(true);
  });

  it("applies per-IP and per-user budgets independently", () => {
    const rl = new AuthRateLimiter({ AUTH_RATE_LIMIT_IP: "5", AUTH_RATE_LIMIT_USER: "2", AUTH_RATE_LIMIT_WINDOW_SECONDS: "60" });
    rl.recordFailure("1.1.1.1", "alice");
    rl.recordFailure("2.2.2.2", "alice");
    expect(rl.check("3.3.3.3", "Alice").allowed).toBe(false); // username budget, case-insensitive
    expect(rl.check("3.3.3.3", "bob").allowed).toBe(true);
    for (let i = 0; i < 5; i++) rl.recordFailure("9.9.9.9", `user${i}`);
    expect(rl.check("9.9.9.9", "someone-else").allowed).toBe(false); // IP budget
  });

  it("treats 0 as 'disabled' and falls back to defaults for garbage values", () => {
    const off = new AuthRateLimiter({ AUTH_RATE_LIMIT_IP: "0", AUTH_RATE_LIMIT_USER: "0" });
    for (let i = 0; i < 500; i++) off.recordFailure("1.1.1.1", "alice");
    expect(off.check("1.1.1.1", "alice").allowed).toBe(true);

    const bad = new AuthRateLimiter({ AUTH_RATE_LIMIT_USER: "lots", AUTH_RATE_LIMIT_WINDOW_SECONDS: "-5" });
    for (let i = 0; i < 15; i++) bad.recordFailure("1.1.1.1", "alice");
    expect(bad.check("1.1.1.1", "alice").allowed).toBe(false);
    expect(bad.check("1.1.1.1", "alice").retryAfterSeconds).toBeGreaterThan(500);
  });

  it("derives the client IP from proxy headers", () => {
    expect(clientIp(new Request("https://x/", { headers: { "cf-connecting-ip": "203.0.113.5" } }))).toBe("203.0.113.5");
    expect(clientIp(new Request("https://x/", { headers: { "x-forwarded-for": "198.51.100.7, 10.0.0.1" } }))).toBe("198.51.100.7");
    expect(clientIp(new Request("https://x/"))).toBe("unknown");
  });
});

describe("auth rate limiting on the CardDAV surface", () => {
  const env = { AUTH_RATE_LIMIT_IP: "100", AUTH_RATE_LIMIT_USER: "3", AUTH_RATE_LIMIT_WINDOW_SECONDS: "600" };

  it("returns 429 with Retry-After after repeated wrong passwords, even for the right password", async () => {
    const t = await makeApp({ env });
    for (let i = 0; i < 3; i++) {
      const res = await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: basic("alice", "wrong") });
      expect(res.status).toBe(401);
    }
    const blocked = await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: basic("alice", USER_PASSWORD) });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(blocked.headers.get("dav")).toBe("1, 3, addressbook");
    // Other accounts from the same IP are unaffected (IP budget is generous).
    const admin = await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: basic("admin", ADMIN_PASSWORD) });
    expect(admin.status).toBe(207);
  });

  it("does not count unauthenticated probes and resets on success", async () => {
    const t = await makeApp({ env });
    for (let i = 0; i < 10; i++) {
      expect((await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: null })).status).toBe(401);
    }
    await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: basic("alice", "wrong") });
    await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: basic("alice", "wrong") });
    expect((await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY })).status).toBe(207);
    // Success cleared the counter: two more failures are still allowed before blocking.
    await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: basic("alice", "wrong") });
    await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth: basic("alice", "wrong") });
    expect((await t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY })).status).toBe(207);
  });

  it("separates clients by IP", async () => {
    const t = await makeApp({ env: { ...env, AUTH_RATE_LIMIT_IP: "2" } });
    const from = (ip: string, auth: string) =>
      t.fetch("/dav/", { method: "PROPFIND", body: PROPFIND_BODY, auth, headers: { "CF-Connecting-IP": ip } });
    await from("198.51.100.1", basic("nobody", "x"));
    await from("198.51.100.1", basic("nobody2", "x"));
    expect((await from("198.51.100.1", basic("alice", USER_PASSWORD))).status).toBe(429);
    expect((await from("198.51.100.2", basic("alice", USER_PASSWORD))).status).toBe(207);
  });
});

describe("auth rate limiting on the admin login", () => {
  it("throttles the login endpoint and shares the budget with Basic auth", async () => {
    const t = await makeApp({ env: { AUTH_RATE_LIMIT_USER: "2", AUTH_RATE_LIMIT_WINDOW_SECONDS: "600" } });
    const login = (password: string) =>
      t.fetch("/api/auth/login", {
        method: "POST",
        auth: null,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: "admin", password }),
      });
    expect((await login("bad")).status).toBe(401);
    // Second failure arrives via Basic auth on the API.
    expect((await t.fetch("/api/contacts", { auth: basic("admin", "bad") })).status).toBe(401);
    const blocked = await login(ADMIN_PASSWORD);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBeTruthy();
    expect(((await blocked.json()) as { error: string }).error).toMatch(/Too many failed attempts/);
  });
});
