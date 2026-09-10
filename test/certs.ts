/**
 * Test-only helper: builds self-signed X.509 certificates with FlareCard's own DER
 * encoder and Web Crypto, so CMS and ACME tests need no fixtures or openssl.
 */
import {
  OIDS,
  bitString,
  boolean,
  explicit,
  implicit,
  integer,
  integerFromBytes,
  octetString,
  oid,
  seq,
  set,
  signDer,
  signatureAlgorithmIdentifier,
  utf8String,
  x509Time,
  type SignatureAlgorithm,
} from "../src/lib/asn1";

export interface TestCert {
  key: CryptoKey;
  algorithm: SignatureAlgorithm;
  der: Uint8Array;
  spki: Uint8Array;
}

export async function generateKey(kind: "rsa" | "ec" = "ec"): Promise<{ pair: CryptoKeyPair; algorithm: SignatureAlgorithm }> {
  if (kind === "rsa") {
    const pair = (await crypto.subtle.generateKey(
      { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
      true,
      ["sign", "verify"],
    )) as CryptoKeyPair;
    return { pair, algorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } };
  }
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  return { pair, algorithm: { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } };
}

function rdnName(cn: string): Uint8Array {
  return seq(set(seq(oid(OIDS.commonName), utf8String(cn))));
}

export interface CertOptions {
  cn: string;
  dnsNames?: string[];
  notBefore?: Date;
  notAfter?: Date;
  /** Issuer to sign with; self-signed when omitted. */
  issuer?: { cn: string; key: CryptoKey; algorithm: SignatureAlgorithm };
  serial?: number;
  /** Adds basicConstraints CA:TRUE so the certificate can issue others. */
  ca?: boolean;
}

/** Issues a certificate for `subjectPublicKey` (SPKI DER). */
export async function issueCertificate(
  subjectSpki: Uint8Array,
  signer: { key: CryptoKey; algorithm: SignatureAlgorithm },
  opts: CertOptions,
): Promise<Uint8Array> {
  const now = opts.notBefore ?? new Date(Date.now() - 60_000);
  const until = opts.notAfter ?? new Date(now.getTime() + 90 * 86_400_000);
  const issuerCn = opts.issuer?.cn ?? opts.cn;
  const sans = (opts.dnsNames ?? [opts.cn]).map((d) => implicit(2, new TextEncoder().encode(d)));
  const extList = [seq(oid(OIDS.subjectAltName), octetString(seq(...sans)))];
  if (opts.ca) extList.push(seq(oid("2.5.29.19"), boolean(true), octetString(seq(boolean(true)))));
  const extensions = explicit(3, seq(...extList));
  const tbs = seq(
    explicit(0, integer(2)),
    integerFromBytes(new Uint8Array([opts.serial ?? Math.floor(Math.random() * 1_000_000) + 1])),
    signatureAlgorithmIdentifier(signer.algorithm),
    rdnName(issuerCn),
    seq(x509Time(now), x509Time(until)),
    rdnName(opts.cn),
    subjectSpki,
    extensions,
  );
  const sig = await signDer(signer.key, signer.algorithm, tbs);
  return seq(tbs, signatureAlgorithmIdentifier(signer.algorithm), bitString(sig));
}

export async function selfSigned(cn: string, kind: "rsa" | "ec" = "ec", opts: Partial<CertOptions> = {}): Promise<TestCert> {
  const { pair, algorithm } = await generateKey(kind);
  const spki = new Uint8Array((await crypto.subtle.exportKey("spki", pair.publicKey)) as ArrayBuffer);
  const der = await issueCertificate(spki, { key: pair.privateKey, algorithm }, { cn, ...opts });
  return { key: pair.privateKey, algorithm, der, spki };
}
