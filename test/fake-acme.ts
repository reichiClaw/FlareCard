/**
 * In-process ACME server (RFC 8555 subset) for tests: directory, nonces, account,
 * order, http-01 authorization, finalize and certificate download. Validation is
 * delegated to a callback so tests can route it through the FlareCard app.
 */
import { base64UrlDecode } from "../src/lib/crypto";
import { jwkThumbprint } from "../src/lib/acme";
import { derToPem, parseDer } from "../src/lib/asn1";
import type { FetchLike } from "../src/lib/acme";
import { issueCertificate, type TestCert } from "./certs";

export interface FakeAcmeOptions {
  ca: TestCert;
  /** Fetches http://<domain>/.well-known/acme-challenge/<token>; returns body or null. */
  validate: (domain: string, token: string) => Promise<string | null>;
  base?: string;
  /** Number of "pending" polls before the authorization turns valid. */
  pendingPolls?: number;
  /** Number of "processing" polls before the order turns valid. */
  processingPolls?: number;
  /** Lifetime of issued certificates in days. */
  lifetimeDays?: number;
  now?: () => number;
}

interface Order {
  id: number;
  domain: string;
  status: "pending" | "ready" | "processing" | "valid" | "invalid";
  authzStatus: "pending" | "valid" | "invalid";
  token: string;
  jwk: JsonWebKey;
  pendingPolls: number;
  processingPolls: number;
  validated?: boolean;
  certificate?: string;
  error?: { type: string; detail: string };
}

export function fakeAcme(opts: FakeAcmeOptions) {
  const base = opts.base ?? "https://acme.test";
  const orders = new Map<number, Order>();
  const accounts = new Map<string, JsonWebKey>();
  const calls: string[] = [];
  let nextId = 1;
  let nonceCounter = 0;
  const issuedNonces = new Set<string>();
  const now = opts.now ?? (() => Date.now());

  const nonce = () => {
    const n = `nonce-${++nonceCounter}`;
    issuedNonces.add(n);
    return n;
  };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json", "Replay-Nonce": nonce(), ...headers },
    });
  const problem = (status: number, type: string, detail: string) =>
    new Response(JSON.stringify({ type: `urn:ietf:params:acme:error:${type}`, detail, status }), {
      status,
      headers: { "Content-Type": "application/problem+json", "Replay-Nonce": nonce() },
    });

  const decode = (init?: RequestInit) => {
    const body = JSON.parse(String(init?.body)) as { protected: string; payload: string; signature: string };
    const header = JSON.parse(new TextDecoder().decode(base64UrlDecode(body.protected))) as {
      alg: string;
      nonce: string;
      url: string;
      jwk?: JsonWebKey;
      kid?: string;
    };
    const payload = body.payload ? JSON.parse(new TextDecoder().decode(base64UrlDecode(body.payload))) : null;
    return { header, payload, signature: body.signature };
  };

  const fetchImpl: FetchLike = async (input, init) => {
    const url = new URL(input);
    const path = url.pathname;
    calls.push(`${init?.method ?? "GET"} ${path}`);

    if (path === "/dir") {
      return json(200, { newNonce: `${base}/nonce`, newAccount: `${base}/new-acct`, newOrder: `${base}/new-order`, meta: {} });
    }
    if (path === "/nonce") return new Response(null, { status: 200, headers: { "Replay-Nonce": nonce() } });

    if (init?.method !== "POST") return problem(405, "malformed", "POST required");
    const { header, payload } = decode(init);
    if (header.alg !== "ES256") return problem(400, "badSignatureAlgorithm", header.alg);
    if (header.url !== input) return problem(400, "malformed", "url mismatch");
    if (!issuedNonces.delete(header.nonce)) return problem(400, "badNonce", "nonce was not issued or already used");

    if (path === "/new-acct") {
      if (!header.jwk) return problem(400, "malformed", "jwk required");
      const kid = `${base}/acct/${nextId++}`;
      accounts.set(kid, header.jwk);
      return json(201, { status: "valid", contact: payload?.contact ?? [] }, { Location: kid });
    }
    const jwk = header.kid ? accounts.get(header.kid) : undefined;
    if (!jwk) return problem(401, "accountDoesNotExist", "unknown kid");

    if (path === "/new-order") {
      const id = nextId++;
      const domain = payload.identifiers[0].value as string;
      orders.set(id, {
        id,
        domain,
        status: "pending",
        authzStatus: "pending",
        token: `tok-${id}-${Math.random().toString(36).slice(2)}`,
        jwk,
        pendingPolls: opts.pendingPolls ?? 1,
        processingPolls: opts.processingPolls ?? 1,
      });
      return json(201, orderBody(orders.get(id)!), { Location: `${base}/order/${id}` });
    }

    let m: RegExpExecArray | null;
    if ((m = /^\/order\/(\d+)\/finalize$/.exec(path))) {
      const order = orders.get(Number(m[1]));
      if (!order) return problem(404, "malformed", "no such order");
      if (order.authzStatus !== "valid") return problem(403, "orderNotReady", "authorization not valid");
      const csr = parseDer(base64UrlDecode(payload.csr as string));
      const info = csr.children[0];
      const spki = info.children[2].raw;
      const sanText = new TextDecoder().decode(info.children[3].raw);
      if (!sanText.includes(order.domain)) return problem(400, "badCSR", "SAN does not include the ordered domain");
      const notBefore = new Date(now() - 60_000);
      const notAfter = new Date(now() + (opts.lifetimeDays ?? 90) * 86_400_000);
      const leaf = await issueCertificate(
        spki,
        { key: opts.ca.key, algorithm: opts.ca.algorithm },
        { cn: order.domain, notBefore, notAfter, issuer: { cn: "Fake ACME CA", key: opts.ca.key, algorithm: opts.ca.algorithm } },
      );
      order.certificate = derToPem(leaf, "CERTIFICATE") + derToPem(opts.ca.der, "CERTIFICATE");
      order.status = "processing";
      return json(200, orderBody(order), { Location: `${base}/order/${order.id}` });
    }
    if ((m = /^\/order\/(\d+)$/.exec(path))) {
      const order = orders.get(Number(m[1]));
      if (!order) return problem(404, "malformed", "no such order");
      if (order.status === "processing" && order.processingPolls-- <= 0) order.status = "valid";
      return json(200, orderBody(order));
    }
    if ((m = /^\/authz\/(\d+)$/.exec(path))) {
      const order = orders.get(Number(m[1]));
      if (!order) return problem(404, "malformed", "no such authz");
      if (order.authzStatus === "pending" && order.validated && order.pendingPolls-- <= 0) {
        order.authzStatus = "valid";
        order.status = "ready";
      }
      return json(200, authzBody(order));
    }
    if ((m = /^\/chall\/(\d+)$/.exec(path))) {
      const order = orders.get(Number(m[1]));
      if (!order) return problem(404, "malformed", "no such challenge");
      // Validate asynchronously-ish: the client must have stored the key authorization already.
      const expected = `${order.token}.${await jwkThumbprint(order.jwk)}`;
      const got = await opts.validate(order.domain, order.token);
      if (got === expected) {
        // Stays "pending" for a few polls so the client exercises its wait path.
        order.validated = true;
      } else {
        order.authzStatus = "invalid";
        order.status = "invalid";
        order.error = { type: "urn:ietf:params:acme:error:unauthorized", detail: `Invalid response from http://${order.domain}/.well-known/acme-challenge/${order.token}: ${got === null ? "404" : "wrong key authorization"}` };
      }
      return json(200, authzBody(order).challenges[0]);
    }
    if ((m = /^\/cert\/(\d+)$/.exec(path))) {
      const order = orders.get(Number(m[1]));
      if (!order?.certificate) return problem(404, "malformed", "no certificate");
      return new Response(order.certificate, { status: 200, headers: { "Content-Type": "application/pem-certificate-chain", "Replay-Nonce": nonce() } });
    }
    return problem(404, "malformed", `unknown path ${path}`);
  };

  function orderBody(o: Order) {
    return {
      status: o.status,
      identifiers: [{ type: "dns", value: o.domain }],
      authorizations: [`${base}/authz/${o.id}`],
      finalize: `${base}/order/${o.id}/finalize`,
      ...(o.status === "valid" ? { certificate: `${base}/cert/${o.id}` } : {}),
      ...(o.error ? { error: o.error } : {}),
    };
  }
  function authzBody(o: Order) {
    return {
      status: o.authzStatus,
      identifier: { type: "dns", value: o.domain },
      challenges: [
        {
          type: "http-01",
          url: `${base}/chall/${o.id}`,
          token: o.token,
          status: o.authzStatus === "pending" ? "pending" : o.authzStatus,
          ...(o.error ? { error: o.error } : {}),
        },
      ],
    };
  }

  return { fetch: fetchImpl, orders, calls, directory: `${base}/dir` };
}
