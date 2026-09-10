/**
 * Minimal ACME (RFC 8555) client for a single hostname with the http-01
 * challenge. Every step is one HTTP round trip so callers can drive the flow
 * incrementally and persist state between steps. Web-standard APIs only.
 */

import { base64UrlEncode } from "./crypto";
import {
  OIDS,
  bitString,
  explicit,
  implicit,
  integer,
  octetString,
  oid,
  seq,
  set,
  signDer,
  signatureAlgorithmIdentifier,
  utf8String,
  type SignatureAlgorithm,
} from "./asn1";

export const LETS_ENCRYPT_DIRECTORY = "https://acme-v02.api.letsencrypt.org/directory";
export const LETS_ENCRYPT_STAGING_DIRECTORY = "https://acme-staging-v02.api.letsencrypt.org/directory";

export interface AcmeDirectory {
  newNonce: string;
  newAccount: string;
  newOrder: string;
  meta?: { termsOfService?: string; externalAccountRequired?: boolean };
}

export interface AcmeAccountKeys {
  privateJwk: JsonWebKey;
  publicJwk: JsonWebKey;
}

export interface AcmeAccount extends AcmeAccountKeys {
  /** Account URL, used as JWS `kid`. */
  kid: string;
}

export interface AcmeChallenge {
  type: string;
  url: string;
  token: string;
  status: string;
  error?: AcmeProblem;
}

export interface AcmeAuthorization {
  status: "pending" | "valid" | "invalid" | "deactivated" | "expired" | "revoked";
  identifier: { type: string; value: string };
  challenges: AcmeChallenge[];
}

export interface AcmeOrder {
  url: string;
  status: "pending" | "ready" | "processing" | "valid" | "invalid";
  authorizations: string[];
  finalize: string;
  certificate?: string;
  error?: AcmeProblem;
}

export interface AcmeProblem {
  type?: string;
  detail?: string;
  status?: number;
}

export class AcmeError extends Error {
  constructor(
    message: string,
    readonly problem: AcmeProblem = {},
    readonly httpStatus = 0,
  ) {
    super(message);
  }
}

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

const enc = new TextEncoder();
const b64json = (v: unknown) => base64UrlEncode(enc.encode(JSON.stringify(v)));

/** RFC 7638 JWK thumbprint for an EC P-256 public key. */
export async function jwkThumbprint(jwk: JsonWebKey): Promise<string> {
  const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y });
  const digest = await crypto.subtle.digest("SHA-256", enc.encode(canonical));
  return base64UrlEncode(new Uint8Array(digest));
}

export async function keyAuthorization(token: string, publicJwk: JsonWebKey): Promise<string> {
  return `${token}.${await jwkThumbprint(publicJwk)}`;
}

export async function generateAccountKeys(): Promise<AcmeAccountKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const privateJwk = (await crypto.subtle.exportKey("jwk", pair.privateKey)) as JsonWebKey;
  const publicJwk = (await crypto.subtle.exportKey("jwk", pair.publicKey)) as JsonWebKey;
  return { privateJwk, publicJwk: { kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x, y: publicJwk.y } };
}

export class AcmeClient {
  private directoryPromise: Promise<AcmeDirectory> | null = null;
  private nonces: string[] = [];

  constructor(
    readonly directoryUrl: string,
    private readonly fetchImpl: FetchLike = (input, init) => fetch(input, init),
  ) {}

  directory(): Promise<AcmeDirectory> {
    if (!this.directoryPromise) {
      this.directoryPromise = this.fetchImpl(this.directoryUrl, { headers: { Accept: "application/json" } })
        .then(async (res) => {
          if (!res.ok) throw new AcmeError(`ACME directory ${this.directoryUrl} returned ${res.status}`, {}, res.status);
          return (await res.json()) as AcmeDirectory;
        })
        .catch((e) => {
          this.directoryPromise = null;
          throw e;
        });
    }
    return this.directoryPromise;
  }

  private async nonce(): Promise<string> {
    const cached = this.nonces.pop();
    if (cached) return cached;
    const dir = await this.directory();
    const res = await this.fetchImpl(dir.newNonce, { method: "HEAD" });
    const n = res.headers.get("replay-nonce");
    if (!n) throw new AcmeError("ACME server did not return a nonce");
    return n;
  }

  private rememberNonce(res: Response): void {
    const n = res.headers.get("replay-nonce");
    if (n) this.nonces.push(n);
  }

  /**
   * POST with a JWS body. `payload === null` sends a POST-as-GET (empty payload).
   * Uses the account URL as kid when present, otherwise embeds the public JWK
   * (only valid for newAccount).
   */
  async post(url: string, payload: unknown | null, keys: AcmeAccountKeys & { kid?: string }): Promise<Response> {
    const privateKey = await crypto.subtle.importKey("jwk", keys.privateJwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
    for (let attempt = 0; attempt < 2; attempt++) {
      const header: Record<string, unknown> = { alg: "ES256", nonce: await this.nonce(), url };
      if (keys.kid) header.kid = keys.kid;
      else header.jwk = keys.publicJwk;
      const protectedB64 = b64json(header);
      const payloadB64 = payload === null ? "" : b64json(payload);
      const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, enc.encode(`${protectedB64}.${payloadB64}`));
      const body = JSON.stringify({ protected: protectedB64, payload: payloadB64, signature: base64UrlEncode(new Uint8Array(sig)) });
      const res = await this.fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/jose+json" }, body });
      this.rememberNonce(res);
      if (res.status === 400 && attempt === 0) {
        const problem = await res
          .clone()
          .json()
          .catch(() => ({}));
        if ((problem as AcmeProblem).type === "urn:ietf:params:acme:error:badNonce") continue;
      }
      return res;
    }
    throw new AcmeError("ACME request failed after nonce retry");
  }

  private async expect(res: Response, what: string, ok: number[]): Promise<Response> {
    if (ok.includes(res.status)) return res;
    const problem = ((await res.json().catch(() => ({}))) as AcmeProblem) ?? {};
    const detail = problem.detail ? `: ${problem.detail}` : "";
    throw new AcmeError(`${what} failed (${res.status})${detail}`, problem, res.status);
  }

  /** Creates or looks up the account for these keys. */
  async createAccount(keys: AcmeAccountKeys, email: string | null): Promise<AcmeAccount> {
    const dir = await this.directory();
    if (dir.meta?.externalAccountRequired) throw new AcmeError("This ACME server requires external account binding, which FlareCard does not support");
    const payload: Record<string, unknown> = { termsOfServiceAgreed: true };
    if (email) payload.contact = [`mailto:${email}`];
    const res = await this.expect(await this.post(dir.newAccount, payload, keys), "Creating ACME account", [200, 201]);
    const kid = res.headers.get("location");
    if (!kid) throw new AcmeError("ACME server did not return an account URL");
    return { ...keys, kid };
  }

  async newOrder(account: AcmeAccount, domain: string): Promise<AcmeOrder> {
    const dir = await this.directory();
    const res = await this.expect(
      await this.post(dir.newOrder, { identifiers: [{ type: "dns", value: domain }] }, account),
      "Creating ACME order",
      [201],
    );
    const url = res.headers.get("location");
    if (!url) throw new AcmeError("ACME server did not return an order URL");
    const body = (await res.json()) as Omit<AcmeOrder, "url">;
    return { ...body, url };
  }

  async getOrder(account: AcmeAccount, url: string): Promise<AcmeOrder> {
    const res = await this.expect(await this.post(url, null, account), "Fetching ACME order", [200]);
    return { ...((await res.json()) as Omit<AcmeOrder, "url">), url };
  }

  async getAuthorization(account: AcmeAccount, url: string): Promise<AcmeAuthorization> {
    const res = await this.expect(await this.post(url, null, account), "Fetching ACME authorization", [200]);
    return (await res.json()) as AcmeAuthorization;
  }

  async respondToChallenge(account: AcmeAccount, challengeUrl: string): Promise<AcmeChallenge> {
    const res = await this.expect(await this.post(challengeUrl, {}, account), "Answering ACME challenge", [200]);
    return (await res.json()) as AcmeChallenge;
  }

  async finalize(account: AcmeAccount, finalizeUrl: string, csrDer: Uint8Array): Promise<AcmeOrder> {
    const res = await this.expect(
      await this.post(finalizeUrl, { csr: base64UrlEncode(csrDer) }, account),
      "Finalizing ACME order",
      [200],
    );
    return { ...((await res.json()) as Omit<AcmeOrder, "url">), url: res.headers.get("location") ?? finalizeUrl };
  }

  /** Downloads the issued certificate chain as PEM. */
  async downloadCertificate(account: AcmeAccount, certificateUrl: string): Promise<string> {
    const res = await this.post(certificateUrl, null, account);
    await this.expect(res.clone(), "Downloading certificate", [200]);
    return res.text();
  }
}

/** Describes what the ACME server reported for a failed authorization/order. */
export function describeProblem(p: AcmeProblem | undefined, fallback: string): string {
  if (!p) return fallback;
  const type = p.type?.replace("urn:ietf:params:acme:error:", "");
  return [type, p.detail].filter(Boolean).join(": ") || fallback;
}

// ---------------------------------------------------------------------------
// PKCS#10 certificate signing request

export async function buildCsr(domain: string, key: CryptoKeyPair, algorithm: SignatureAlgorithm): Promise<Uint8Array> {
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", key.publicKey)) as ArrayBuffer);
  // CN is limited to 64 characters; Let's Encrypt only needs the SAN anyway.
  const subject = domain.length <= 64 ? seq(set(seq(oid(OIDS.commonName), utf8String(domain)))) : seq();
  const san = seq(oid(OIDS.subjectAltName), octetString(seq(implicit(2, enc.encode(domain)))));
  const attributes = explicit(0, seq(oid(OIDS.extensionRequest), set(seq(san))));
  const info = seq(integer(0), subject, spki, attributes);
  const signature = await signDer(key.privateKey, algorithm, info);
  return seq(info, signatureAlgorithmIdentifier(algorithm), bitString(signature));
}
