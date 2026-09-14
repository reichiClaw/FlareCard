/**
 * Profile signing: wraps .mobileconfig downloads in CMS SignedData so Apple
 * devices show "Verified". The certificate comes from one of two sources:
 *
 *  1. External (operator-managed): PEM key + chain from environment secrets or a
 *     Fetcher binding pointing at a directory (workerd `disk` service with the
 *     files Caddy/certbot maintain). Nothing to renew inside FlareCard.
 *  2. Managed (automatic): FlareCard acts as an ACME client, proves control of
 *     PUBLIC_HOST via http-01 on its own /.well-known/acme-challenge/ route and
 *     stores key, certificate and account in the Durable Object. Renewal is
 *     lazy: any admin request or profile download close to expiry kicks off a
 *     renewal in the background while the still-valid certificate keeps signing.
 *
 * All state lives in the settings table, so this works identically on
 * Cloudflare and workerd and needs no cron triggers or alarms.
 */

import type { Storage } from "../storage/types";
import {
  derToPem,
  importPrivateKey,
  parseCertificate,
  parsePrivateKeyPem,
  pemBlocks,
  type CertificateInfo,
  type SignatureAlgorithm,
} from "./asn1";
import { signCms, type CmsSigner } from "./cms";
import {
  AcmeClient,
  AcmeError,
  LETS_ENCRYPT_DIRECTORY,
  buildCsr,
  describeProblem,
  generateAccountKeys,
  keyAuthorization,
  providerName,
  type AcmeAccount,
  type AcmeAccountKeys,
  type ExternalAccountBinding,
  type FetchLike,
} from "./acme";

export interface SigningEnv {
  /** ACME directory; defaults to Let's Encrypt production. */
  ACME_DIRECTORY_URL?: string;
  /**
   * External Account Binding credentials (RFC 8555 §7.3.4). Required by ZeroSSL and
   * Google Trust Services; ignored by Let's Encrypt.
   */
  ACME_EAB_KID?: string;
  ACME_EAB_HMAC_KEY?: string;
  /** Operator-managed signing material (PEM). Takes precedence over the managed certificate. */
  PROFILE_SIGNING_KEY?: string;
  PROFILE_SIGNING_CERT?: string;
  /** Fetcher serving privkey.pem/fullchain.pem (or Caddy's <host>.key/<host>.crt). */
  SIGNING_CERTS?: Fetcher;
}

const KEYS = {
  enabled: "signing_enabled",
  email: "signing_email",
  domain: "signing_domain",
  account: "signing_acme_account",
  key: "signing_key_jwk",
  chain: "signing_cert_chain",
  state: "signing_state",
} as const;

type Phase = "idle" | "ordering" | "challenging" | "finalizing" | "issued" | "error";

interface AcmeState {
  phase: Phase;
  domain: string;
  orderUrl?: string;
  finalizeUrl?: string;
  authzUrl?: string;
  challengeUrl?: string;
  token?: string;
  keyAuth?: string;
  certificateUrl?: string;
  error?: string;
  startedAt: number;
  updatedAt: number;
  /** Consecutive failures; drives the retry backoff. */
  failures: number;
}

interface StoredAccount extends AcmeAccount {
  directory: string;
}

export interface CertificateSummary {
  subject: string | null;
  dnsNames: string[];
  notBefore: string;
  notAfter: string;
  daysLeft: number;
  algorithm: string;
}

export interface SigningStatus {
  /** Where the active certificate comes from. */
  source: "external" | "managed" | "none";
  /** Whether the admin switched automatic (ACME) signing on. */
  enabled: boolean;
  email: string | null;
  domain: string | null;
  /** Host FlareCard would use for a new order right now. */
  currentHost: string | null;
  certificate: CertificateSummary | null;
  phase: Phase;
  /** Human-readable progress or error line. */
  message: string;
  error: string | null;
  inProgress: boolean;
  renewalDue: boolean;
  acmeDirectory: string;
  /** Human-readable CA name derived from the directory URL. */
  acmeProvider: string;
  /** Whether ACME_EAB_KID/ACME_EAB_HMAC_KEY are set. */
  eabConfigured: boolean;
}

interface LoadedSigner {
  cms: CmsSigner;
  info: CertificateInfo;
  source: "external" | "managed";
  fingerprint: string;
}

const DAY = 86_400_000;
const RETRY_BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3_600_000, 6 * 3_600_000];

export class SigningError extends Error {}

export class ProfileSigner {
  private client: AcmeClient | null = null;
  private running: Promise<void> | null = null;
  private cache: { fingerprint: string; signer: LoadedSigner } | null = null;

  constructor(
    private readonly storage: Storage,
    private readonly env: SigningEnv,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
    private readonly now: () => number = () => Date.now(),
    /** Delay between polls while the CA validates or issues. */
    private readonly pollIntervalMs = 2000,
  ) {}

  get directoryUrl(): string {
    return this.env.ACME_DIRECTORY_URL?.trim() || LETS_ENCRYPT_DIRECTORY;
  }

  get provider(): string {
    return providerName(this.directoryUrl);
  }

  /** EAB credentials from the environment, or null when neither is set. */
  get externalAccountBinding(): ExternalAccountBinding | null {
    const kid = this.env.ACME_EAB_KID?.trim();
    const hmacKey = this.env.ACME_EAB_HMAC_KEY?.trim();
    if (!kid && !hmacKey) return null;
    if (!kid || !hmacKey) throw new SigningError("ACME_EAB_KID and ACME_EAB_HMAC_KEY must be set together");
    return { kid, hmacKey };
  }

  // -------------------------------------------------------------------------
  // Signing

  /** Signs a profile if a usable certificate exists, otherwise returns null. */
  async sign(profile: Uint8Array): Promise<Uint8Array | null> {
    const signer = await this.currentSigner();
    if (!signer) return null;
    return signCms(profile, signer.cms, new Date(this.now()));
  }

  async currentSigner(): Promise<LoadedSigner | null> {
    return (await this.externalSigner()) ?? (await this.managedSigner());
  }

  private async externalMaterial(): Promise<{ key: string; chain: string } | null> {
    if (this.env.PROFILE_SIGNING_KEY && this.env.PROFILE_SIGNING_CERT) {
      return { key: this.env.PROFILE_SIGNING_KEY, chain: this.env.PROFILE_SIGNING_CERT };
    }
    const fetcher = this.env.SIGNING_CERTS;
    if (!fetcher) return null;
    const read = async (name: string) => {
      const res = await fetcher.fetch(`http://signing-certs/${name}`);
      return res.ok ? res.text() : null;
    };
    const domain = (await this.storage.getSetting(KEYS.domain)) ?? "";
    const candidates: [string, string][] = [
      ["privkey.pem", "fullchain.pem"],
      ["key.pem", "cert.pem"],
      ...(domain ? ([[`${domain}.key`, `${domain}.crt`]] as [string, string][]) : []),
    ];
    for (const [k, c] of candidates) {
      const [key, chain] = await Promise.all([read(k), read(c)]);
      if (key && chain) return { key, chain };
    }
    return null;
  }

  private async externalSigner(): Promise<LoadedSigner | null> {
    const material = await this.externalMaterial();
    if (!material) return null;
    return this.loadSigner(material.key, material.chain, "external");
  }

  private async managedSigner(): Promise<LoadedSigner | null> {
    if (!(await this.isEnabled())) return null;
    return this.storedManagedSigner();
  }

  /** The stored Let's Encrypt certificate regardless of the enabled switch. */
  private async storedManagedSigner(): Promise<LoadedSigner | null> {
    const [jwk, chain] = await Promise.all([this.storage.getSetting(KEYS.key), this.storage.getSetting(KEYS.chain)]);
    if (!jwk || !chain) return null;
    const signer = await this.loadSigner(jwk, chain, "managed");
    return signer.info.notAfter.getTime() > this.now() ? signer : null;
  }

  private async loadSigner(keyText: string, chainPem: string, source: "external" | "managed"): Promise<LoadedSigner> {
    const fingerprint = `${source}:${keyText.length}:${chainPem.length}:${chainPem.slice(0, 200)}`;
    if (this.cache?.fingerprint === fingerprint) return this.cache.signer;

    const chain = pemBlocks(chainPem)
      .filter((b) => b.label === "CERTIFICATE")
      .map((b) => b.der);
    if (!chain.length) throw new SigningError("certificate chain contains no CERTIFICATE block");
    const info = parseCertificate(chain[0]);

    let key: CryptoKey;
    let algorithm: SignatureAlgorithm;
    if (keyText.trim().startsWith("{")) {
      // Managed key: stored as a private JWK (RSA).
      const jwk = JSON.parse(keyText) as JsonWebKey;
      algorithm = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
      key = await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
    } else {
      const parsed = parsePrivateKeyPem(keyText);
      algorithm = parsed.algorithm;
      key = await importPrivateKey(parsed);
    }
    const signer: LoadedSigner = { cms: { key, algorithm, chain }, info, source, fingerprint };
    this.cache = { fingerprint, signer };
    return signer;
  }

  // -------------------------------------------------------------------------
  // Status and control

  async isEnabled(): Promise<boolean> {
    return (await this.storage.getSetting(KEYS.enabled)) === "1";
  }

  private async state(): Promise<AcmeState | null> {
    const raw = await this.storage.getSetting(KEYS.state);
    return raw ? (JSON.parse(raw) as AcmeState) : null;
  }

  private async saveState(state: AcmeState): Promise<void> {
    state.updatedAt = this.now();
    await this.storage.setSetting(KEYS.state, JSON.stringify(state));
  }

  private summarize(info: CertificateInfo, algorithm: SignatureAlgorithm): CertificateSummary {
    return {
      subject: info.commonName ?? info.dnsNames[0] ?? null,
      dnsNames: info.dnsNames,
      notBefore: info.notBefore.toISOString(),
      notAfter: info.notAfter.toISOString(),
      daysLeft: Math.floor((info.notAfter.getTime() - this.now()) / DAY),
      algorithm: algorithm.name === "ECDSA" ? `ECDSA ${algorithm.namedCurve}` : "RSA",
    };
  }

  async status(currentHost: string | null): Promise<SigningStatus> {
    const enabled = await this.isEnabled();
    const email = await this.storage.getSetting(KEYS.email);
    const domain = await this.storage.getSetting(KEYS.domain);
    const state = await this.state();
    const external = await this.externalSigner().catch(() => null);
    const managed = external ? null : await this.managedSigner().catch(() => null);
    const active = external ?? managed;
    const phase: Phase = state?.phase ?? (managed ? "issued" : "idle");
    const inProgress = enabled && (phase === "ordering" || phase === "challenging" || phase === "finalizing");
    const renewalDue = enabled && !!managed && this.renewalDue(managed.info);

    let message: string;
    if (external) message = `Signing with the operator-provided certificate for ${external.info.commonName ?? external.info.dnsNames[0] ?? "unknown host"}.`;
    else if (!enabled) message = "Profiles are downloaded unsigned. iOS shows them as “Not Signed”.";
    else if (inProgress) message = phaseMessage(phase, state?.domain ?? domain ?? "", this.provider);
    else if (phase === "error") message = `Last attempt failed: ${state?.error ?? "unknown error"}. FlareCard retries automatically; profiles are unsigned until it succeeds.`;
    else if (managed) message = `Signing with a ${this.provider} certificate for ${managed.info.commonName ?? domain}; renews automatically.`;
    else message = "Enabled, waiting to request a certificate.";

    return {
      source: external ? "external" : managed ? "managed" : "none",
      enabled,
      email,
      domain,
      currentHost,
      certificate: active ? this.summarize(active.info, active.cms.algorithm) : null,
      phase,
      message,
      error: state?.phase === "error" ? (state.error ?? "unknown error") : null,
      inProgress,
      renewalDue,
      acmeDirectory: this.directoryUrl,
      acmeProvider: this.provider,
      eabConfigured: !!(this.env.ACME_EAB_KID?.trim() && this.env.ACME_EAB_HMAC_KEY?.trim()),
    };
  }

  /** Switches automatic signing on for `domain` and starts the first order. */
  async enable(domain: string, email: string | null): Promise<void> {
    const host = normalizeHost(domain);
    await this.storage.setSetting(KEYS.enabled, "1");
    await this.storage.setSetting(KEYS.domain, host);
    if (email !== null) await this.storage.setSetting(KEYS.email, email);
    const managed = await this.storedManagedSigner().catch(() => null);
    if (managed && managed.info.dnsNames.includes(host) && !this.renewalDue(managed.info)) {
      await this.saveState({ phase: "issued", domain: host, startedAt: this.now(), updatedAt: this.now(), failures: 0 });
      return;
    }
    await this.startOrder(host);
  }

  async disable(): Promise<void> {
    await this.storage.setSetting(KEYS.enabled, "0");
    const state = await this.state();
    if (state && state.phase !== "issued") await this.saveState({ ...state, phase: "idle", error: undefined });
  }

  /** Forces a fresh order (renew now / host changed). */
  async renewNow(domain: string): Promise<void> {
    if (!(await this.isEnabled())) throw new SigningError("Automatic signing is switched off");
    const host = normalizeHost(domain);
    await this.storage.setSetting(KEYS.domain, host);
    await this.startOrder(host);
  }

  private async startOrder(domain: string): Promise<void> {
    await this.saveState({ phase: "ordering", domain, startedAt: this.now(), updatedAt: this.now(), failures: 0 });
  }

  /** Answers /.well-known/acme-challenge/<token> during a pending order. */
  async challengeResponse(token: string): Promise<string | null> {
    const state = await this.state();
    if (!state || state.phase !== "challenging" || state.token !== token || !state.keyAuth) return null;
    return state.keyAuth;
  }

  // -------------------------------------------------------------------------
  // Progress

  renewalDue(info: CertificateInfo): boolean {
    const lifetime = info.notAfter.getTime() - info.notBefore.getTime();
    const threshold = Math.min(30 * DAY, lifetime / 3);
    return info.notAfter.getTime() - this.now() < threshold;
  }

  /** True when a call to advance() would do something right now. */
  async hasWork(): Promise<boolean> {
    if (!(await this.isEnabled())) return false;
    if (await this.externalMaterial()) return false;
    const state = await this.state();
    if (!state) return true;
    switch (state.phase) {
      case "ordering":
      case "challenging":
      case "finalizing":
        return true;
      case "error": {
        const backoff = RETRY_BACKOFF_MS[Math.min(state.failures, RETRY_BACKOFF_MS.length) - 1] ?? RETRY_BACKOFF_MS[0];
        return this.now() - state.updatedAt >= backoff;
      }
      case "issued":
      case "idle": {
        const managed = await this.managedSigner().catch(() => null);
        return !managed || this.renewalDue(managed.info);
      }
    }
  }

  /**
   * Drives the ACME state machine for up to `budgetMs`. Safe to call from any
   * request; concurrent callers share one run.
   */
  advance(budgetMs = 20_000): Promise<void> {
    if (this.running) return this.running;
    this.running = this.run(budgetMs).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async run(budgetMs: number): Promise<void> {
    const deadline = this.now() + budgetMs;
    if (!(await this.hasWork())) return;
    let state = (await this.state()) ?? {
      phase: "ordering" as Phase,
      domain: (await this.storage.getSetting(KEYS.domain)) ?? "",
      startedAt: this.now(),
      updatedAt: this.now(),
      failures: 0,
    };
    if (state.phase === "error" || state.phase === "issued" || state.phase === "idle") {
      state = { phase: "ordering", domain: state.domain, startedAt: this.now(), updatedAt: this.now(), failures: state.failures };
      await this.saveState(state);
    }
    if (!state.domain) {
      await this.fail(state, "No public hostname configured. Set PUBLIC_HOST or open the admin UI via the public hostname.");
      return;
    }

    try {
      while (this.now() < deadline) {
        const next = await this.step(state);
        if (next === "wait") {
          // The CA is still validating/issuing; poll again if the budget allows,
          // otherwise a later request picks the order up where it stands.
          if (this.now() + this.pollIntervalMs >= deadline) break;
          await this.sleep(this.pollIntervalMs);
          continue;
        }
        state = next;
        await this.saveState(state);
        if (state.phase === "issued") break;
      }
    } catch (e) {
      await this.fail(state, this.explainError(e));
    }
  }

  /**
   * Turns low-level ACME/network failures into something an admin can act on.
   * The 525 case is Cloudflare-specific: a Worker cannot reach an origin that is
   * itself behind Cloudflare with a TLS handshake the edge accepts, and Let's
   * Encrypt's API is exactly that. ZeroSSL and Google Trust Services are not.
   */
  private explainError(e: unknown): string {
    const message = e instanceof Error ? e.message : String(e);
    const status = e instanceof AcmeError ? e.httpStatus : 0;
    if (status === 525 || status === 521 || status === 522) {
      return `${message}. ${this.provider} answered with a Cloudflare edge error (${status}); a Cloudflare Worker cannot reach this CA directly. Switch to ZeroSSL by setting ACME_DIRECTORY_URL plus the ACME_EAB_KID/ACME_EAB_HMAC_KEY secrets (see README "Profile signing").`;
    }
    return message;
  }

  private async fail(state: AcmeState, error: string): Promise<void> {
    await this.saveState({ ...state, phase: "error", error, failures: state.failures + 1 });
  }

  /** Executes one ACME step. Returns the next state, or "wait" while the CA is busy. */
  private async step(state: AcmeState): Promise<AcmeState | "wait"> {
    const client = this.acme();
    const account = await this.account(client);

    switch (state.phase) {
      case "ordering": {
        const order = await client.newOrder(account, state.domain);
        const authzUrl = order.authorizations[0];
        if (!authzUrl) throw new AcmeError("Order has no authorizations");
        const authz = await client.getAuthorization(account, authzUrl);
        if (authz.status === "valid") {
          return { ...state, phase: "finalizing", orderUrl: order.url, finalizeUrl: order.finalize, authzUrl, ...(await this.finalize(client, account, order.finalize, state.domain)) };
        }
        const challenge = authz.challenges.find((c) => c.type === "http-01");
        if (!challenge) throw new AcmeError("The CA offered no http-01 challenge");
        const keyAuth = await keyAuthorization(challenge.token, account.publicJwk);
        const next: AcmeState = {
          ...state,
          phase: "challenging",
          orderUrl: order.url,
          finalizeUrl: order.finalize,
          authzUrl,
          challengeUrl: challenge.url,
          token: challenge.token,
          keyAuth,
        };
        // Persist before telling the CA, so the validation request can be answered.
        await this.saveState(next);
        await client.respondToChallenge(account, challenge.url);
        return next;
      }

      case "challenging": {
        const authz = await client.getAuthorization(account, state.authzUrl!);
        if (authz.status === "pending") return "wait";
        if (authz.status !== "valid") {
          const ch = authz.challenges.find((c) => c.type === "http-01");
          throw new AcmeError(
            `Validation failed: ${describeProblem(ch?.error, authz.status)}. ${this.provider} must be able to reach http://${state.domain}/.well-known/acme-challenge/ from the internet.`,
          );
        }
        return { ...state, phase: "finalizing", ...(await this.finalize(client, account, state.finalizeUrl!, state.domain)) };
      }

      case "finalizing": {
        const order = await client.getOrder(account, state.orderUrl!);
        if (order.status === "processing" || order.status === "pending" || order.status === "ready") {
          if (order.status === "ready") {
            // Finalize was not accepted yet (rare); send it again.
            await this.finalize(client, account, state.finalizeUrl!, state.domain);
          }
          return "wait";
        }
        if (order.status !== "valid" || !order.certificate) {
          throw new AcmeError(`Order ended in state ${order.status}: ${describeProblem(order.error, "no details")}`);
        }
        const pem = await client.downloadCertificate(account, order.certificate);
        const chain = pemBlocks(pem).filter((b) => b.label === "CERTIFICATE");
        if (!chain.length) throw new AcmeError("CA returned no certificate");
        parseCertificate(chain[0].der); // validate before storing
        await this.storage.setSetting(KEYS.chain, chain.map((b) => derToPem(b.der, "CERTIFICATE")).join(""));
        this.cache = null;
        return { ...state, phase: "issued", error: undefined, failures: 0, token: undefined, keyAuth: undefined, certificateUrl: order.certificate };
      }

      default:
        return "wait";
    }
  }

  private async finalize(client: AcmeClient, account: AcmeAccount, finalizeUrl: string, domain: string): Promise<Partial<AcmeState>> {
    const key = await this.certificateKey();
    const csr = await buildCsr(domain, key, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" });
    const order = await client.finalize(account, finalizeUrl, csr);
    return { certificateUrl: order.certificate };
  }

  /** The RSA key the certificate is issued for; generated once and reused across renewals. */
  private async certificateKey(): Promise<CryptoKeyPair> {
    const stored = await this.storage.getSetting(KEYS.key);
    const alg = { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
    if (stored) {
      const jwk = JSON.parse(stored) as JsonWebKey;
      const privateKey = await crypto.subtle.importKey("jwk", jwk, alg, true, ["sign"]);
      const pub: JsonWebKey = { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: "RS256", ext: true };
      const publicKey = await crypto.subtle.importKey("jwk", pub, alg, true, ["verify"]);
      return { privateKey, publicKey };
    }
    const pair = (await crypto.subtle.generateKey(
      { ...alg, modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]) },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    const jwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
    await this.storage.setSetting(KEYS.key, JSON.stringify(jwk));
    return pair;
  }

  private acme(): AcmeClient {
    if (!this.client || this.client.directoryUrl !== this.directoryUrl) this.client = new AcmeClient(this.directoryUrl, this.fetchImpl);
    return this.client;
  }

  private async account(client: AcmeClient): Promise<AcmeAccount> {
    const raw = await this.storage.getSetting(KEYS.account);
    if (raw) {
      const stored = JSON.parse(raw) as StoredAccount;
      if (stored.directory === client.directoryUrl && stored.kid) return stored;
    }
    const keys: AcmeAccountKeys = await generateAccountKeys();
    const email = (await this.storage.getSetting(KEYS.email)) || null;
    const account = await client.createAccount(keys, email, this.externalAccountBinding);
    const stored: StoredAccount = { ...account, directory: client.directoryUrl };
    await this.storage.setSetting(KEYS.account, JSON.stringify(stored));
    return account;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}

function phaseMessage(phase: Phase, domain: string, provider: string): string {
  switch (phase) {
    case "ordering":
      return `Requesting a certificate for ${domain} from ${provider}…`;
    case "challenging":
      return `Waiting for ${provider} to verify http://${domain}/.well-known/acme-challenge/…`;
    case "finalizing":
      return "Certificate is being issued…";
    default:
      return "";
  }
}

/** Strips scheme, path and port; http-01 requires the standard ports anyway. */
export function normalizeHost(input: string): string {
  let host = input.trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").split("/")[0];
  if (host.includes(":") && !host.startsWith("[")) host = host.split(":")[0];
  const isIp = /^\d+(\.\d+){3}$/.test(host);
  if (isIp || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(host)) {
    throw new SigningError(`"${input}" is not a public hostname. Set PUBLIC_HOST to the name devices connect to.`);
  }
  return host;
}
