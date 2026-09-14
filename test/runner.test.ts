import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adminAuth, basic, makeApp, USER_PASSWORD, type TestApp } from "./helpers";
import { fakeAcme } from "./fake-acme";
import { generateKey, issueCertificate, selfSigned } from "./certs";
import { renewSigningCertificate, RunnerError } from "../scripts/lib/renew";
import { explainAcmeError, type SigningStatus } from "../src/lib/signing";
import { AcmeError, type FetchLike } from "../src/lib/acme";
import { OIDS, decodeOid, derToPem, parseCertificate, parseDer, pemToDer } from "../src/lib/asn1";

const HOST = "contacts.example.com";
const BASE = `https://${HOST}`;

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

function verifyWithOpenssl(cms: Uint8Array, caDer: Uint8Array): string {
  const dir = mkdtempSync(join(tmpdir(), "flarecard-runner-"));
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

/**
 * Builds a FlareCard whose *own* ACME client cannot reach the CA (as on Cloudflare
 * Workers: 525), plus a fake CA that the runner can reach and that validates
 * challenges by fetching FlareCard's challenge route.
 */
async function setup(opts: { lifetimeDays?: number; now?: () => number } = {}) {
  const ca = await selfSigned("Fake ACME CA", "ec", { ca: true });
  let t: TestApp;
  const acme = fakeAcme({
    ca,
    lifetimeDays: opts.lifetimeDays,
    now: opts.now,
    validate: async (domain, token) => {
      const res = await t.fetch(`/.well-known/acme-challenge/${token}`, { auth: null, headers: { Host: domain } });
      return res.status === 200 ? res.text() : null;
    },
  });
  const workerFetch: FetchLike = async () => new Response("<html>525 SSL handshake failed</html>", { status: 525 });
  t = await makeApp({ fetch: workerFetch, env: { PUBLIC_HOST: HOST, ACME_DIRECTORY_URL: acme.directory } });
  // The runner reaches FlareCard over HTTPS; in tests that is the Hono app itself.
  const flarecardFetch: FetchLike = (input, init) => Promise.resolve(t.app.request(input, init));
  const run = (extra: Partial<Parameters<typeof renewSigningCertificate>[0]> = {}) =>
    renewSigningCertificate({
      flarecard: { url: BASE, username: "admin", password: "admin-secret-pw", fetch: flarecardFetch },
      acme: { directoryUrl: acme.directory, fetch: acme.fetch },
      email: "it@example.com",
      pollIntervalMs: 5,
      ...extra,
    });
  return { t, acme, ca, run, flarecardFetch };
}

const jsonOf = async <T>(res: Response) => (await res.json()) as T;
const putJson = (t: TestApp, path: string, body: unknown, method = "PUT") =>
  t.fetch(path, { method, auth: adminAuth, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

describe("external ACME runner", () => {
  it("obtains a certificate for FlareCard's key, installs it and profiles get signed", async () => {
    const { t, acme, ca, run } = await setup();
    const log: string[] = [];

    const first = await run({ log: (l) => log.push(l) });
    expect(first.action).toBe("renewed");
    expect(first.status).toMatchObject({ source: "managed", managedBy: "runner", enabled: true, phase: "issued", domain: HOST });
    expect(first.status.certificate).toMatchObject({ dnsNames: [HOST], algorithm: "RSA" });
    expect(first.status.runnerInstalledAt).not.toBeNull();
    expect(first.status.message).toContain("external ACME runner");
    expect(log.some((l) => l.startsWith("Self-check OK"))).toBe(true);
    expect(acme.calls).toEqual(expect.arrayContaining(["POST /new-acct", "POST /new-order", "POST /chall/2", "POST /order/2/finalize", "POST /cert/2"]));

    // The challenge answer is gone after installation.
    const order = [...acme.orders.values()][0];
    expect((await t.fetch(`/.well-known/acme-challenge/${order.token}`, { auth: null })).status).toBe(404);

    // Profiles are signed with the uploaded chain and verify against the CA.
    const users = await jsonOf<{ items: { id: number; username: string }[] }>(await t.fetch("/api/users", { auth: adminAuth }));
    const alice = users.items.find((u) => u.username === "alice")!;
    const signed = await t.fetch(`/api/users/${alice.id}/profile.mobileconfig`, { auth: adminAuth });
    expect(signed.headers.get("x-flarecard-profile-signed")).toBe("yes");
    const cms = new Uint8Array(await signed.arrayBuffer());
    const root = parseDer(cms);
    expect(decodeOid(root.children[0])).toBe(OIDS.pkcs7SignedData);
    const certs = root.children[1].children[0].children[3];
    expect(parseCertificate(certs.children[0].raw).dnsNames).toEqual([HOST]);
    if (hasOpenssl) expect(verifyWithOpenssl(cms, ca.der)).toContain("com.apple.carddav.account");

    // The in-Worker client stays quiet even though it would fail with 525.
    const callsBefore = acme.calls.length;
    const status = await jsonOf<SigningStatus>(await t.fetch("/api/signing", { auth: adminAuth }));
    expect(status.error).toBeNull();
    expect(status.inProgress).toBe(false);
    await new Promise((r) => setTimeout(r, 30));
    expect(acme.calls.length).toBe(callsBefore);

    // A second run finds the certificate fresh and does nothing.
    const second = await run();
    expect(second.action).toBe("skipped");
    expect(acme.calls.length).toBe(callsBefore);

    // --force renews with the same key.
    const spkiBefore = parseCertificate(certs.children[0].raw).spkiDer;
    const third = await run({ force: true });
    expect(third.action).toBe("renewed");
    expect(acme.orders.size).toBe(2);
    const signedAgain = await t.fetch(`/api/users/${alice.id}/profile.mobileconfig`, { auth: adminAuth });
    const leaf = parseDer(new Uint8Array(await signedAgain.arrayBuffer())).children[1].children[0].children[3].children[0];
    expect(parseCertificate(leaf.raw).spkiDer).toEqual(spkiBefore);
    expect([...acme.orders.values()][1].certificate!.startsWith(derToPem(leaf.raw, "CERTIFICATE"))).toBe(true);
  });

  it("renews when fewer days than the threshold remain", async () => {
    const { run, acme } = await setup({ lifetimeDays: 90 });
    expect((await run()).action).toBe("renewed");
    expect((await run()).action).toBe("skipped");
    expect((await run({ renewBeforeDays: 95 })).action).toBe("renewed");
    expect(acme.orders.size).toBe(2);
  });

  it("rejects a certificate for another key or another host and requires an admin", async () => {
    const { t } = await setup();
    const csr = await jsonOf<{ domain: string; csr: string }>(await putJson(t, "/api/signing/csr", {}, "POST"));
    expect(csr.domain).toBe(HOST);
    expect(csr.csr).toMatch(/^-----BEGIN CERTIFICATE REQUEST-----/);
    const csrDer = parseDer(pemToDer(csr.csr));
    expect(new TextDecoder().decode(csrDer.children[0].children[3].raw)).toContain(HOST);
    const ourSpki = csrDer.children[0].children[2].raw;

    const ca = await selfSigned("Other CA", "ec", { ca: true });
    const other = await generateKey("rsa");
    const otherSpki = new Uint8Array((await crypto.subtle.exportKey("spki", other.pair.publicKey)) as ArrayBuffer);
    const forOtherKey = await issueCertificate(otherSpki, { key: ca.key, algorithm: ca.algorithm }, { cn: HOST, issuer: { cn: "Other CA", key: ca.key, algorithm: ca.algorithm } });
    const wrongKey = await putJson(t, "/api/signing/certificate", { certificate: derToPem(forOtherKey, "CERTIFICATE") });
    expect(wrongKey.status).toBe(400);
    expect((await jsonOf<{ error: string }>(wrongKey)).error).toContain("not issued for FlareCard's key");

    const forOtherHost = await issueCertificate(ourSpki, { key: ca.key, algorithm: ca.algorithm }, { cn: "other.example.com", issuer: { cn: "Other CA", key: ca.key, algorithm: ca.algorithm } });
    const wrongHost = await putJson(t, "/api/signing/certificate", { certificate: derToPem(forOtherHost, "CERTIFICATE") });
    expect(wrongHost.status).toBe(400);
    expect((await jsonOf<{ error: string }>(wrongHost)).error).toContain(HOST);

    const expired = await issueCertificate(ourSpki, { key: ca.key, algorithm: ca.algorithm }, {
      cn: HOST,
      notBefore: new Date(Date.now() - 2 * 86_400_000),
      notAfter: new Date(Date.now() - 86_400_000),
      issuer: { cn: "Other CA", key: ca.key, algorithm: ca.algorithm },
    });
    expect((await putJson(t, "/api/signing/certificate", { certificate: derToPem(expired, "CERTIFICATE") })).status).toBe(400);

    const good = await issueCertificate(ourSpki, { key: ca.key, algorithm: ca.algorithm }, { cn: HOST, issuer: { cn: "Other CA", key: ca.key, algorithm: ca.algorithm } });
    const ok = await putJson(t, "/api/signing/certificate", { certificate: derToPem(good, "CERTIFICATE") + derToPem(ca.der, "CERTIFICATE") });
    expect(ok.status).toBe(200);
    expect((await jsonOf<SigningStatus>(ok)).source).toBe("managed");

    expect((await putJson(t, "/api/signing/challenge", { token: "abc", keyAuthorization: "abc.x" })).status).toBe(400);
    expect((await putJson(t, "/api/signing/challenge", { token: "tokentoken1234", keyAuthorization: "other.thumb" })).status).toBe(400);

    for (const [path, method] of [["/api/signing/csr", "POST"], ["/api/signing/challenge", "PUT"], ["/api/signing/certificate", "PUT"]] as const) {
      const res = await t.fetch(path, { method, auth: basic("alice", USER_PASSWORD), headers: { "Content-Type": "application/json" }, body: "{}" });
      expect(res.status).toBe(401);
    }
  });

  it("serves runner-registered challenge answers and expires them", async () => {
    const { t } = await setup();
    const token = "runner-token_ABCDEFGH0123456789";
    const keyAuth = `${token}.thumbprintthumbprintthumbprint`;
    const reg = await putJson(t, "/api/signing/challenge", { token, keyAuthorization: keyAuth });
    expect(reg.status).toBe(200);
    expect((await jsonOf<{ url: string }>(reg)).url).toBe(`http://${HOST}/.well-known/acme-challenge/${token}`);
    const served = await t.fetch(`/.well-known/acme-challenge/${token}`, { auth: null });
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(keyAuth);
    expect(served.headers.get("content-type")).toContain("text/plain");
    expect((await t.fetch(`/.well-known/acme-challenge/unknown-token-xyz`, { auth: null })).status).toBe(404);
  });

  it("switching back to the in-Worker client works, and 'Renew now' is refused in runner mode", async () => {
    const { t, run } = await setup();
    await run();
    const renew = await t.fetch("/api/signing/renew", { method: "POST", auth: adminAuth });
    expect(renew.status).toBe(400);
    expect((await jsonOf<{ error: string }>(renew)).error).toContain("external ACME runner");

    const back = await putJson(t, "/api/signing", { enabled: true, managedBy: "worker" });
    expect(back.status).toBe(200);
    const s = await jsonOf<SigningStatus>(back);
    expect(s.managedBy).toBe("worker");
    // The runner's certificate is still valid for this host, so it is kept.
    expect(s.source).toBe("managed");
    expect(s.phase).toBe("issued");
  });

  it("explains a 525 from the CA as the Cloudflare Workers limitation", async () => {
    const { t } = await setup();
    await putJson(t, "/api/signing", { enabled: true });
    let status: SigningStatus | undefined;
    for (let i = 0; i < 40; i++) {
      status = await jsonOf<SigningStatus>(await t.fetch("/api/signing", { auth: adminAuth }));
      if (status.phase === "error") break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(status?.phase).toBe("error");
    expect(status?.error).toContain("returned 525");
    expect(status?.error).toContain("external ACME runner");
    expect(explainAcmeError(new AcmeError("x", {}, 525))).toContain("Cloudflare Workers");
    expect(explainAcmeError(new Error("plain"))).toBe("plain");
  });

  it("fails clearly when FlareCard rejects the runner's credentials", async () => {
    const { run, flarecardFetch } = await setup();
    await expect(run({ flarecard: { url: BASE, username: "admin", password: "wrong", fetch: flarecardFetch } })).rejects.toThrow(/GET \/api\/signing failed \(401\)/);
    await expect(run({ flarecard: { url: BASE, username: "admin", password: "wrong", fetch: flarecardFetch } })).rejects.toBeInstanceOf(RunnerError);
  });
});
