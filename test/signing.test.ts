import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adminAuth, makeApp, type TestApp } from "./helpers";
import { fakeAcme } from "./fake-acme";
import { selfSigned } from "./certs";
import { MemoryStorage } from "../src/storage/memory";
import { ProfileSigner, normalizeHost, type SigningStatus } from "../src/lib/signing";
import { OIDS, decodeOid, derToPem, parseCertificate, parseDer } from "../src/lib/asn1";
import { buildCsr, providerName } from "../src/lib/acme";
import { base64UrlEncode } from "../src/lib/crypto";

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

const HOST = "contacts.example.com";

function verifyWithOpenssl(cms: Uint8Array, caDer: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "flarecard-profile-"));
  try {
    writeFileSync(join(dir, "profile.mobileconfig"), cms);
    writeFileSync(join(dir, "ca.pem"), derToPem(caDer, "CERTIFICATE"));
    return execFileSync(
      "openssl",
      ["cms", "-verify", "-inform", "DER", "-in", join(dir, "profile.mobileconfig"), "-CAfile", join(dir, "ca.pem"), "-purpose", "any"],
      { stdio: ["ignore", "pipe", "pipe"] },
    ).toString();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

async function setup(overrides: Parameters<typeof fakeAcme>[0] extends infer O ? Partial<O> : never = {}) {
  const ca = await selfSigned("Fake ACME CA", "ec", { ca: true });
  let t: TestApp;
  const acme = fakeAcme({
    ca,
    validate: async (domain, token) => {
      const res = await t.fetch(`/.well-known/acme-challenge/${token}`, { auth: null, headers: { Host: domain } });
      return res.status === 200 ? res.text() : null;
    },
    ...overrides,
  });
  t = await makeApp({ fetch: acme.fetch, env: { PUBLIC_HOST: HOST, ACME_DIRECTORY_URL: acme.directory } });
  return { t, acme, ca };
}

const jsonOf = async <T>(res: Response) => (await res.json()) as T;
const putJson = (t: TestApp, path: string, body: unknown, method = "PUT") =>
  t.fetch(path, { method, auth: adminAuth, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function waitFor(t: TestApp, pred: (s: SigningStatus) => boolean, tries = 40): Promise<SigningStatus> {
  let last: SigningStatus | undefined;
  for (let i = 0; i < tries; i++) {
    last = await jsonOf<SigningStatus>(await t.fetch("/api/signing", { auth: adminAuth }));
    if (pred(last)) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`condition not met; last status: ${JSON.stringify(last)}`);
}

describe("automatic profile signing (ACME http-01)", () => {
  it("obtains a certificate through the challenge route and signs profiles with it", async () => {
    const { t, acme, ca } = await setup();

    const before = await jsonOf<SigningStatus>(await t.fetch("/api/signing", { auth: adminAuth }));
    expect(before).toMatchObject({ source: "none", enabled: false, phase: "idle", currentHost: HOST });

    const users = await jsonOf<{ items: { id: number; username: string }[] }>(await t.fetch("/api/users", { auth: adminAuth }));
    const alice = users.items.find((u) => u.username === "alice")!;
    const unsigned = await t.fetch(`/api/users/${alice.id}/profile.mobileconfig`, { auth: adminAuth });
    expect(unsigned.headers.get("x-flarecard-profile-signed")).toBe("no");
    expect(await unsigned.text()).toContain("<plist");

    const enabled = await putJson(t, "/api/signing", { enabled: true, email: "it@example.com" });
    expect(enabled.status).toBe(200);
    const status = await waitFor(t, (s) => s.phase === "issued" || s.phase === "error");
    expect(status.phase).toBe("issued");
    expect(status.source).toBe("managed");
    expect(status.enabled).toBe(true);
    expect(status.email).toBe("it@example.com");
    expect(status.certificate).toMatchObject({ subject: HOST, dnsNames: [HOST], algorithm: "RSA" });
    expect(status.certificate!.daysLeft).toBeGreaterThanOrEqual(89);
    expect(status.message).toContain("renews automatically");

    // The full protocol was exercised: account, order, authz poll(s), challenge, finalize, order poll(s), cert.
    expect(acme.calls).toEqual(
      expect.arrayContaining(["POST /new-acct", "POST /new-order", "POST /authz/2", "POST /chall/2", "POST /order/2/finalize", "POST /order/2", "POST /cert/2"]),
    );
    // The challenge is no longer answered once the order is done.
    const order = [...acme.orders.values()][0];
    expect((await t.fetch(`/.well-known/acme-challenge/${order.token}`, { auth: null })).status).toBe(404);

    const signed = await t.fetch(`/api/users/${alice.id}/profile.mobileconfig`, { auth: adminAuth });
    expect(signed.status).toBe(200);
    expect(signed.headers.get("x-flarecard-profile-signed")).toBe("yes");
    expect(signed.headers.get("content-type")).toBe("application/x-apple-aspen-config");
    const cms = new Uint8Array(await signed.arrayBuffer());
    const root = parseDer(cms);
    expect(decodeOid(root.children[0])).toBe(OIDS.pkcs7SignedData);
    const certs = root.children[1].children[0].children[3];
    expect(certs.children).toHaveLength(2); // leaf + CA from the ACME chain
    expect(parseCertificate(certs.children[0].raw).dnsNames).toEqual([HOST]);
    const embedded = new TextDecoder().decode(root.children[1].children[0].children[2].children[1].children[0].value);
    expect(embedded).toContain("com.apple.carddav.account");
    expect(embedded).toContain(`<string>alice</string>`);
    if (hasOpenssl) expect(verifyWithOpenssl(cms, ca.der)).toBe(embedded);

    // Switching automatic signing off stops signing, even though the certificate is kept for a later re-enable.
    await putJson(t, "/api/signing", { enabled: false });
    const off = await jsonOf<SigningStatus>(await t.fetch("/api/signing", { auth: adminAuth }));
    expect(off.enabled).toBe(false);
    expect(off.source).toBe("none");
    const again = await t.fetch(`/api/users/${alice.id}/profile.mobileconfig`, { auth: adminAuth });
    expect(again.headers.get("x-flarecard-profile-signed")).toBe("no");

    // Re-enabling reuses the stored certificate without a new order.
    const ordersBefore = acme.orders.size;
    await putJson(t, "/api/signing", { enabled: true });
    const back = await jsonOf<SigningStatus>(await t.fetch("/api/signing", { auth: adminAuth }));
    expect(back).toMatchObject({ enabled: true, source: "managed", phase: "issued" });
    expect(acme.orders.size).toBe(ordersBefore);
  });

  it("reports validation failures with the CA's explanation and retries after a backoff", async () => {
    const ca = await selfSigned("Fake ACME CA", "ec", { ca: true });
    let clock = Date.parse("2026-09-10T12:00:00Z");
    const now = () => clock;
    const acme = fakeAcme({ ca, validate: async () => null, now }); // nothing answers the challenge
    const storage = new MemoryStorage();
    const signer = new ProfileSigner(storage, { ACME_DIRECTORY_URL: acme.directory }, acme.fetch, now, 10);

    await signer.enable(HOST, "it@example.com");
    await signer.advance(5000);
    let status = await signer.status(HOST);
    expect(status.phase).toBe("error");
    expect(status.error).toMatch(/Validation failed: unauthorized: Invalid response from http:\/\/contacts\.example\.com/);
    expect(status.message).toContain("retries automatically");
    expect(await signer.sign(new Uint8Array([1, 2, 3]))).toBeNull();

    // Backoff: nothing happens for the first minute, then a new order is placed.
    expect(await signer.hasWork()).toBe(false);
    clock += 61_000;
    expect(await signer.hasWork()).toBe(true);
    const ordersBefore = acme.orders.size;
    await signer.advance(5000);
    expect(acme.orders.size).toBe(ordersBefore + 1);
    status = await signer.status(HOST);
    expect(status.phase).toBe("error");
  });

  describe("external account binding (ZeroSSL / Google Trust Services)", () => {
    const eab = { kid: "zerossl-kid-123", hmacKey: base64UrlEncode(crypto.getRandomValues(new Uint8Array(32))) };

    it("binds the new account with an HS256 JWS and obtains a certificate", async () => {
      const ca = await selfSigned("Fake ZeroSSL CA", "ec", { ca: true });
      let signer!: ProfileSigner;
      const acme = fakeAcme({ ca, eab, validate: (_d, token) => signer.challengeResponse(token) });
      signer = new ProfileSigner(
        new MemoryStorage(),
        { ACME_DIRECTORY_URL: acme.directory, ACME_EAB_KID: eab.kid, ACME_EAB_HMAC_KEY: eab.hmacKey },
        acme.fetch,
        undefined,
        10,
      );
      await signer.enable(HOST, null);
      await signer.advance(10_000);
      const status = await signer.status(HOST);
      expect(status.phase).toBe("issued");
      expect(status.eabConfigured).toBe(true);
      expect(status.acmeProvider).toBe("acme.test");
      expect(status.message).toContain("Signing with a acme.test certificate");
      expect(await signer.sign(new Uint8Array([1, 2, 3]))).not.toBeNull();
    });

    it("accepts a padded/base64 HMAC key as handed out by some CAs", async () => {
      const ca = await selfSigned("Fake ZeroSSL CA", "ec", { ca: true });
      let signer!: ProfileSigner;
      const acme = fakeAcme({ ca, eab, validate: (_d, token) => signer.challengeResponse(token) });
      const padded = eab.hmacKey + "=".repeat((4 - (eab.hmacKey.length % 4)) % 4);
      signer = new ProfileSigner(
        new MemoryStorage(),
        { ACME_DIRECTORY_URL: acme.directory, ACME_EAB_KID: ` ${eab.kid} `, ACME_EAB_HMAC_KEY: padded },
        acme.fetch,
        undefined,
        10,
      );
      await signer.enable(HOST, null);
      await signer.advance(10_000);
      expect((await signer.status(HOST)).phase).toBe("issued");
    });

    it("explains what to configure when the CA requires EAB and none is set", async () => {
      const ca = await selfSigned("Fake ZeroSSL CA", "ec", { ca: true });
      const acme = fakeAcme({ ca, eab, validate: async () => null });
      const signer = new ProfileSigner(new MemoryStorage(), { ACME_DIRECTORY_URL: acme.directory }, acme.fetch, undefined, 10);
      await signer.enable(HOST, null);
      await signer.advance(5000);
      const status = await signer.status(HOST);
      expect(status.phase).toBe("error");
      expect(status.error).toMatch(/requires External Account Binding.*ACME_EAB_KID and ACME_EAB_HMAC_KEY/);
      expect(acme.calls.filter((c) => c.endsWith("/new-acct"))).toHaveLength(0);
      expect(acme.orders.size).toBe(0);
    });

    it("reports the CA's rejection of wrong EAB credentials", async () => {
      const ca = await selfSigned("Fake ZeroSSL CA", "ec", { ca: true });
      const acme = fakeAcme({ ca, eab, validate: async () => null });
      const signer = new ProfileSigner(
        new MemoryStorage(),
        { ACME_DIRECTORY_URL: acme.directory, ACME_EAB_KID: eab.kid, ACME_EAB_HMAC_KEY: base64UrlEncode(new Uint8Array(32)) },
        acme.fetch,
        undefined,
        10,
      );
      await signer.enable(HOST, null);
      await signer.advance(5000);
      const status = await signer.status(HOST);
      expect(status.phase).toBe("error");
      expect(status.error).toMatch(/Creating ACME account failed \(403\): EAB signature invalid/);
    });

    it("rejects half-configured EAB credentials before contacting the CA", async () => {
      const ca = await selfSigned("Fake ZeroSSL CA", "ec", { ca: true });
      const acme = fakeAcme({ ca, eab, validate: async () => null });
      const signer = new ProfileSigner(new MemoryStorage(), { ACME_DIRECTORY_URL: acme.directory, ACME_EAB_KID: eab.kid }, acme.fetch, undefined, 10);
      await signer.enable(HOST, null);
      await signer.advance(5000);
      expect((await signer.status(HOST)).error).toBe("ACME_EAB_KID and ACME_EAB_HMAC_KEY must be set together");
      expect(acme.calls.filter((c) => c.endsWith("/new-acct"))).toHaveLength(0);
    });

    it("names well-known CAs from the directory URL", () => {
      expect(providerName("https://acme-v02.api.letsencrypt.org/directory")).toBe("Let's Encrypt");
      expect(providerName("https://acme-staging-v02.api.letsencrypt.org/directory")).toBe("Let's Encrypt (staging)");
      expect(providerName("https://acme.zerossl.com/v2/DV90")).toBe("ZeroSSL");
      expect(providerName("https://dv.acme-v02.api.pki.goog/directory")).toBe("Google Trust Services");
      expect(providerName("https://pebble:14000/dir")).toBe("pebble");
    });
  });

  it("renews lazily when the certificate approaches expiry and reuses the key", async () => {
    const ca = await selfSigned("Fake ACME CA", "ec", { ca: true });
    let clock = Date.parse("2026-09-10T12:00:00Z");
    const now = () => clock;
    const storage = new MemoryStorage();
    let signer: ProfileSigner;
    const acme = fakeAcme({
      ca,
      now,
      lifetimeDays: 90,
      validate: (_d, token) => signer.challengeResponse(token),
    });
    signer = new ProfileSigner(storage, { ACME_DIRECTORY_URL: acme.directory }, acme.fetch, now, 10);

    await signer.enable(HOST, null);
    await signer.advance(5000);
    const first = await signer.status(HOST);
    expect(first.phase).toBe("issued");
    expect(first.renewalDue).toBe(false);
    const firstKey = await storage.getSetting("signing_key_jwk");
    const firstChain = await storage.getSetting("signing_cert_chain");

    clock += 59 * 86_400_000; // 31 days left: not yet
    expect(await signer.hasWork()).toBe(false);
    clock += 2 * 86_400_000; // 29 days left: renew
    expect((await signer.status(HOST)).renewalDue).toBe(true);
    expect(await signer.hasWork()).toBe(true);
    await signer.advance(5000);
    const renewed = await signer.status(HOST);
    expect(renewed.phase).toBe("issued");
    expect(renewed.certificate!.daysLeft).toBeGreaterThanOrEqual(89);
    expect(await storage.getSetting("signing_key_jwk")).toBe(firstKey);
    expect(await storage.getSetting("signing_cert_chain")).not.toBe(firstChain);
    expect(acme.orders.size).toBe(2);
  });

  it("renews short-lived certificates at a third of their lifetime", async () => {
    const ca = await selfSigned("Fake ACME CA", "ec", { ca: true });
    let clock = Date.parse("2026-09-10T12:00:00Z");
    const now = () => clock;
    let signer: ProfileSigner;
    const acme = fakeAcme({ ca, now, lifetimeDays: 6, validate: (_d, token) => signer.challengeResponse(token) });
    signer = new ProfileSigner(new MemoryStorage(), { ACME_DIRECTORY_URL: acme.directory }, acme.fetch, now, 10);
    await signer.enable(HOST, null);
    await signer.advance(5000);
    expect((await signer.status(HOST)).phase).toBe("issued");
    clock += 3.5 * 86_400_000; // 2.5 days left of 6: fine
    expect(await signer.hasWork()).toBe(false);
    clock += 1 * 86_400_000; // 1.5 days left (< 2 = lifetime/3): renew
    expect(await signer.hasWork()).toBe(true);
  });

  it("prefers operator-provided PEM material and signs even when automatic signing is off", async () => {
    const own = await selfSigned(HOST, "ec");
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", own.key)) as ArrayBuffer);
    const t = await makeApp({
      env: {
        PUBLIC_HOST: HOST,
        PROFILE_SIGNING_KEY: derToPem(pkcs8, "PRIVATE KEY"),
        PROFILE_SIGNING_CERT: derToPem(own.der, "CERTIFICATE"),
      },
    });
    const status = await jsonOf<SigningStatus>(await t.fetch("/api/signing", { auth: adminAuth }));
    expect(status.source).toBe("external");
    expect(status.enabled).toBe(false);
    expect(status.certificate).toMatchObject({ subject: HOST, algorithm: "ECDSA P-256" });
    expect(status.message).toContain("operator-provided");

    const users = await jsonOf<{ items: { id: number; username: string }[] }>(await t.fetch("/api/users", { auth: adminAuth }));
    const res = await t.fetch(`/api/users/${users.items[0].id}/profile.mobileconfig`, { auth: adminAuth });
    expect(res.headers.get("x-flarecard-profile-signed")).toBe("yes");
    const cms = new Uint8Array(await res.arrayBuffer());
    if (hasOpenssl) expect(verifyWithOpenssl(cms, own.der)).toContain("com.apple.carddav.account");
  });

  it("reads certificate files through a Fetcher binding (workerd disk service)", async () => {
    const own = await selfSigned(HOST, "rsa");
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", own.key)) as ArrayBuffer);
    const files: Record<string, string> = {
      "/privkey.pem": derToPem(pkcs8, "PRIVATE KEY"),
      "/fullchain.pem": derToPem(own.der, "CERTIFICATE"),
    };
    const fetcher = {
      fetch: async (input: string | Request) => {
        const path = new URL(typeof input === "string" ? input : input.url).pathname;
        return path in files ? new Response(files[path]) : new Response("not found", { status: 404 });
      },
    } as unknown as Fetcher;
    const signer = new ProfileSigner(new MemoryStorage(), { SIGNING_CERTS: fetcher });
    const status = await signer.status(HOST);
    expect(status.source).toBe("external");
    expect(status.certificate?.algorithm).toBe("RSA");
    expect(await signer.sign(new TextEncoder().encode("hi"))).toBeInstanceOf(Uint8Array);
  });

  it("builds a CSR with the domain as SAN and rejects bad hostnames", async () => {
    const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
    const csr = parseDer(await buildCsr("cards.example.org", pair, { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" }));
    const info = csr.children[0];
    expect(info.children[0].value[0]).toBe(0);
    expect(new TextDecoder().decode(info.children[1].raw)).toContain("cards.example.org");
    expect(decodeOid(info.children[3].children[0].children[0])).toBe(OIDS.extensionRequest);
    expect(decodeOid(csr.children[1].children[0])).toBe(OIDS.ecdsaWithSHA256);

    expect(normalizeHost("https://Contacts.Example.com:443/admin/")).toBe("contacts.example.com");
    expect(normalizeHost("contacts.example.com:8443")).toBe("contacts.example.com");
    expect(() => normalizeHost("localhost")).toThrow(/public hostname/);
    expect(() => normalizeHost("127.0.0.1:47321")).toThrow(/public hostname/);
  });
});
