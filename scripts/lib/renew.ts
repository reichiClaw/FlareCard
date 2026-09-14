/**
 * External ACME runner: obtains a profile-signing certificate for a FlareCard
 * instance from a place that can reach the CA (Cloudflare Workers cannot reach
 * Let's Encrypt directly). The private key stays inside FlareCard:
 *
 *   1. GET  /api/signing              — skip when the certificate is still fresh
 *   2. POST /api/signing/csr          — CSR for the key kept in the Durable Object
 *   3. ACME order + http-01           — answer registered via PUT /api/signing/challenge,
 *                                       served by FlareCard itself
 *   4. PUT  /api/signing/certificate  — install the issued chain
 *
 * Web-standard APIs only (fetch, WebCrypto); runs on Node 22+ via tsx and is
 * exercised in tests against an in-process fake CA.
 */

import { AcmeClient, AcmeError, generateAccountKeys, keyAuthorization, type AcmeAccountKeys, type FetchLike } from "../../src/lib/acme";
import { pemToDer } from "../../src/lib/asn1";
import type { SigningStatus } from "../../src/lib/signing";

export interface RenewOptions {
  flarecard: {
    /** Base URL of the FlareCard instance, e.g. https://contacts.example.com */
    url: string;
    username: string;
    password: string;
    fetch?: FetchLike;
  };
  acme: {
    directoryUrl: string;
    fetch?: FetchLike;
    /** Persisted account keys; a fresh account is created when omitted. */
    accountKeys?: AcmeAccountKeys;
  };
  email: string | null;
  /** Renew when fewer than this many days remain (default 30). */
  renewBeforeDays?: number;
  /** Renew even if the current certificate is still fresh. */
  force?: boolean;
  /** Verify that the challenge answer is reachable before telling the CA (default true). */
  selfCheck?: boolean;
  pollIntervalMs?: number;
  /** Give up waiting for the CA after this many polls (default 60). */
  maxPolls?: number;
  log?: (line: string) => void;
}

export interface RenewResult {
  action: "skipped" | "renewed";
  status: SigningStatus;
}

export class RunnerError extends Error {}

export async function renewSigningCertificate(opts: RenewOptions): Promise<RenewResult> {
  const log = opts.log ?? (() => {});
  const renewBeforeDays = opts.renewBeforeDays ?? 30;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;
  const maxPolls = opts.maxPolls ?? 60;
  const fc = flarecardApi(opts.flarecard);

  const status = await fc.get<SigningStatus>("/api/signing");
  if (status.source === "external") {
    log(`FlareCard signs with an operator-provided certificate (${status.certificate?.subject ?? "?"}); nothing to do.`);
    return { action: "skipped", status };
  }
  const cert = status.certificate;
  if (cert && !opts.force) {
    const fits = !status.currentHost || cert.dnsNames.includes(status.currentHost);
    if (fits && cert.daysLeft > renewBeforeDays) {
      log(`Certificate for ${cert.dnsNames.join(", ")} is valid for ${cert.daysLeft} more days (threshold ${renewBeforeDays}); nothing to do.`);
      return { action: "skipped", status };
    }
    log(fits ? `Certificate expires in ${cert.daysLeft} days; renewing.` : `Certificate covers ${cert.dnsNames.join(", ")} but FlareCard is reached as ${status.currentHost}; renewing.`);
  } else {
    log(cert ? "Renewal forced." : "No certificate installed yet; requesting one.");
  }

  const { domain, csr } = await fc.post<{ domain: string; csr: string }>("/api/signing/csr", {});
  log(`CSR for ${domain} received from FlareCard (key stays there).`);

  const client = new AcmeClient(opts.acme.directoryUrl, opts.acme.fetch);
  const keys = opts.acme.accountKeys ?? (await generateAccountKeys());
  const account = await client.createAccount(keys, opts.email);
  log(`ACME account ready at ${account.kid}.`);

  const order = await client.newOrder(account, domain);
  log(`Order ${order.url} created.`);
  for (const authzUrl of order.authorizations) {
    let authz = await client.getAuthorization(account, authzUrl);
    if (authz.status === "valid") continue;
    const challenge = authz.challenges.find((c) => c.type === "http-01");
    if (!challenge) throw new RunnerError("The CA offered no http-01 challenge");
    const keyAuth = await keyAuthorization(challenge.token, account.publicJwk);
    const registered = await fc.put<{ ok: true; url: string }>("/api/signing/challenge", { token: challenge.token, keyAuthorization: keyAuth });
    log(`Challenge answer registered; CA will fetch ${registered.url}`);
    if (opts.selfCheck ?? true) await selfCheck(opts.flarecard.fetch ?? defaultFetch, `${opts.flarecard.url.replace(/\/+$/, "")}/.well-known/acme-challenge/${challenge.token}`, keyAuth, log);
    await client.respondToChallenge(account, challenge.url);
    for (let i = 0; authz.status === "pending"; i++) {
      if (i >= maxPolls) throw new RunnerError("Timed out waiting for the CA to validate the challenge");
      await sleep(pollIntervalMs);
      authz = await client.getAuthorization(account, authzUrl);
    }
    if (authz.status !== "valid") {
      const ch = authz.challenges.find((c) => c.type === "http-01");
      const detail = ch?.error?.detail ? `: ${ch.error.detail}` : "";
      throw new RunnerError(`Validation failed (${authz.status})${detail}. The CA must be able to fetch http://${domain}/.well-known/acme-challenge/ from the internet.`);
    }
    log("Challenge validated.");
  }

  let finalized = await client.finalize(account, order.finalize, pemToDer(csr));
  for (let i = 0; finalized.status === "processing" || finalized.status === "pending" || finalized.status === "ready"; i++) {
    if (i >= maxPolls) throw new RunnerError("Timed out waiting for the CA to issue the certificate");
    await sleep(pollIntervalMs);
    finalized = await client.getOrder(account, order.url);
  }
  if (finalized.status !== "valid" || !finalized.certificate) {
    throw new RunnerError(`Order ended in state ${finalized.status}${finalized.error?.detail ? `: ${finalized.error.detail}` : ""}`);
  }
  const chain = await client.downloadCertificate(account, finalized.certificate);
  log("Certificate issued; uploading to FlareCard.");

  const installed = await fc.put<SigningStatus>("/api/signing/certificate", { certificate: chain });
  log(`Installed: ${installed.message}`);
  return { action: "renewed", status: installed };
}

const defaultFetch: FetchLike = (input, init) => fetch(input, init);

function flarecardApi(cfg: RenewOptions["flarecard"]) {
  const base = cfg.url.replace(/\/+$/, "");
  const fetchImpl = cfg.fetch ?? defaultFetch;
  const auth = `Basic ${btoa(`${cfg.username}:${cfg.password}`)}`;
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetchImpl(`${base}${path}`, {
      method,
      headers: { Authorization: auth, Accept: "application/json", ...(body !== undefined ? { "Content-Type": "application/json" } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!res.ok) {
      const message = (data as { error?: string } | null)?.error ?? text.slice(0, 200);
      throw new RunnerError(`FlareCard ${method} ${path} failed (${res.status})${message ? `: ${message}` : ""}`);
    }
    return data as T;
  };
  return {
    get: <T>(path: string) => call<T>("GET", path),
    post: <T>(path: string, body: unknown) => call<T>("POST", path, body),
    put: <T>(path: string, body: unknown) => call<T>("PUT", path, body),
  };
}

/** Best-effort check that FlareCard serves the answer; a mismatch is fatal, unreachability only a warning. */
async function selfCheck(fetchImpl: FetchLike, url: string, expected: string, log: (l: string) => void): Promise<void> {
  try {
    const res = await fetchImpl(url, { redirect: "follow" });
    const body = (await res.text()).trim();
    if (res.status === 200 && body === expected) {
      log(`Self-check OK: ${url}`);
      return;
    }
    if (res.status === 200) throw new RunnerError(`Self-check failed: ${url} returned a different answer than registered`);
    throw new RunnerError(`Self-check failed: ${url} returned HTTP ${res.status}`);
  } catch (e) {
    if (e instanceof RunnerError) throw e;
    log(`Self-check skipped (${e instanceof Error ? e.message : String(e)}); continuing.`);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export { AcmeError };
