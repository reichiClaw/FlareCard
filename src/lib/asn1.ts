/**
 * Minimal DER encoder/decoder plus the handful of X.509 / PKCS#8 / SEC1 parsing
 * helpers FlareCard needs for CMS profile signing and ACME certificate requests.
 * Web-standard only; no dependencies.
 */

import { base64ToBytes, bytesToBase64 } from "./crypto";

// ---------------------------------------------------------------------------
// Tags

export const TAG = {
  BOOLEAN: 0x01,
  INTEGER: 0x02,
  BIT_STRING: 0x03,
  OCTET_STRING: 0x04,
  NULL: 0x05,
  OID: 0x06,
  UTF8_STRING: 0x0c,
  PRINTABLE_STRING: 0x13,
  IA5_STRING: 0x16,
  UTC_TIME: 0x17,
  GENERALIZED_TIME: 0x18,
  SEQUENCE: 0x30,
  SET: 0x31,
} as const;

/** Context-specific tag; `constructed` selects [n] EXPLICIT-style wrapping. */
export function contextTag(n: number, constructed = true): number {
  return 0x80 | (constructed ? 0x20 : 0) | n;
}

// ---------------------------------------------------------------------------
// Encoding

function concat(parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function encodeLength(len: number): Uint8Array {
  if (len < 0x80) return new Uint8Array([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>>= 8;
  }
  return new Uint8Array([0x80 | bytes.length, ...bytes]);
}

/** Generic TLV. */
export function tlv(tag: number, content: Uint8Array): Uint8Array {
  return concat([new Uint8Array([tag]), encodeLength(content.length), content]);
}

export const seq = (...items: Uint8Array[]): Uint8Array => tlv(TAG.SEQUENCE, concat(items));
export const set = (...items: Uint8Array[]): Uint8Array => tlv(TAG.SET, concat(items));
export const explicit = (n: number, ...items: Uint8Array[]): Uint8Array => tlv(contextTag(n), concat(items));
export const implicit = (n: number, content: Uint8Array): Uint8Array => tlv(contextTag(n, false), content);
export const octetString = (b: Uint8Array): Uint8Array => tlv(TAG.OCTET_STRING, b);
export const nullValue = (): Uint8Array => tlv(TAG.NULL, new Uint8Array());
export const bitString = (b: Uint8Array): Uint8Array => tlv(TAG.BIT_STRING, concat([new Uint8Array([0]), b]));
export const utf8String = (s: string): Uint8Array => tlv(TAG.UTF8_STRING, new TextEncoder().encode(s));
export const ia5String = (s: string): Uint8Array => tlv(TAG.IA5_STRING, new TextEncoder().encode(s));
export const boolean = (v: boolean): Uint8Array => tlv(TAG.BOOLEAN, new Uint8Array([v ? 0xff : 0x00]));

/** Non-negative INTEGER from big-endian bytes (adds the leading zero when needed). */
export function integerFromBytes(b: Uint8Array): Uint8Array {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const trimmed = b.subarray(i);
  const needsPad = trimmed.length === 0 || trimmed[0] & 0x80;
  return tlv(TAG.INTEGER, needsPad ? concat([new Uint8Array([0]), trimmed]) : trimmed);
}

export function integer(n: number): Uint8Array {
  if (n < 0 || !Number.isInteger(n)) throw new Error("only non-negative integers supported");
  const bytes: number[] = [];
  let v = n;
  do {
    bytes.unshift(v & 0xff);
    v = Math.floor(v / 256);
  } while (v > 0);
  return integerFromBytes(new Uint8Array(bytes));
}

export function oid(dotted: string): Uint8Array {
  const parts = dotted.split(".").map(Number);
  if (parts.length < 2) throw new Error(`bad OID ${dotted}`);
  const out: number[] = [parts[0] * 40 + parts[1]];
  for (const p of parts.slice(2)) {
    const stack: number[] = [];
    let v = p;
    do {
      stack.unshift(v & 0x7f);
      v = Math.floor(v / 128);
    } while (v > 0);
    for (let i = 0; i < stack.length - 1; i++) stack[i] |= 0x80;
    out.push(...stack);
  }
  return tlv(TAG.OID, new Uint8Array(out));
}

const pad2 = (n: number) => String(n).padStart(2, "0");

/** UTCTime (YYMMDDhhmmssZ) as CMS/X.509 require for dates before 2050. */
export function utcTime(d: Date): Uint8Array {
  const s =
    pad2(d.getUTCFullYear() % 100) +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    "Z";
  return tlv(TAG.UTC_TIME, new TextEncoder().encode(s));
}

export function generalizedTime(d: Date): Uint8Array {
  const s =
    String(d.getUTCFullYear()).padStart(4, "0") +
    pad2(d.getUTCMonth() + 1) +
    pad2(d.getUTCDate()) +
    pad2(d.getUTCHours()) +
    pad2(d.getUTCMinutes()) +
    pad2(d.getUTCSeconds()) +
    "Z";
  return tlv(TAG.GENERALIZED_TIME, new TextEncoder().encode(s));
}

/** X.509 time: UTCTime before 2050, GeneralizedTime after (RFC 5280 §4.1.2.5). */
export const x509Time = (d: Date): Uint8Array => (d.getUTCFullYear() < 2050 ? utcTime(d) : generalizedTime(d));

// ---------------------------------------------------------------------------
// Decoding

export interface DerNode {
  tag: number;
  /** Content bytes (without header). */
  value: Uint8Array;
  /** Complete TLV bytes. */
  raw: Uint8Array;
  /** Child nodes for constructed types (SEQUENCE/SET/explicit tags). */
  children: DerNode[];
}

export class DerError extends Error {}

function readNode(buf: Uint8Array, offset: number): { node: DerNode; end: number } {
  if (offset + 2 > buf.length) throw new DerError("truncated DER");
  const tag = buf[offset];
  if ((tag & 0x1f) === 0x1f) throw new DerError("multi-byte tags unsupported");
  let len = buf[offset + 1];
  let pos = offset + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4) throw new DerError("unsupported length encoding");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[pos++];
  }
  const end = pos + len;
  if (end > buf.length) throw new DerError("truncated DER value");
  const value = buf.subarray(pos, end);
  const constructed = (tag & 0x20) !== 0;
  const children: DerNode[] = [];
  if (constructed) {
    let p = 0;
    while (p < value.length) {
      const child = readNode(value, p);
      children.push(child.node);
      p = child.end;
    }
  }
  return { node: { tag, value, raw: buf.subarray(offset, end), children }, end };
}

export function parseDer(buf: Uint8Array): DerNode {
  const { node, end } = readNode(buf, 0);
  if (end !== buf.length) throw new DerError("trailing bytes after DER value");
  return node;
}

export function decodeOid(node: DerNode): string {
  if (node.tag !== TAG.OID) throw new DerError("not an OID");
  const b = node.value;
  const first = b[0];
  const parts = [Math.floor(first / 40), first % 40];
  if (parts[0] > 2) {
    parts[1] += (parts[0] - 2) * 40;
    parts[0] = 2;
  }
  let v = 0;
  for (let i = 1; i < b.length; i++) {
    v = v * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      parts.push(v);
      v = 0;
    }
  }
  return parts.join(".");
}

export function decodeTime(node: DerNode): Date {
  const s = new TextDecoder().decode(node.value);
  let m: RegExpExecArray | null;
  if (node.tag === TAG.UTC_TIME && (m = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z$/.exec(s))) {
    const yy = Number(m[1]);
    const year = yy >= 50 ? 1900 + yy : 2000 + yy;
    return new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
  }
  if (node.tag === TAG.GENERALIZED_TIME && (m = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?(?:\.\d+)?Z$/.exec(s))) {
    return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)));
  }
  throw new DerError(`unsupported time value ${s}`);
}

// ---------------------------------------------------------------------------
// PEM

export function pemToDer(pem: string, label?: string): Uint8Array {
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem))) {
    if (!label || m[1] === label) return base64ToBytes(m[2].replace(/\s+/g, ""));
  }
  throw new DerError(label ? `no ${label} block in PEM input` : "no PEM block found");
}

export function pemBlocks(pem: string): { label: string; der: Uint8Array }[] {
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/g;
  const out: { label: string; der: Uint8Array }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem))) out.push({ label: m[1], der: base64ToBytes(m[2].replace(/\s+/g, "")) });
  return out;
}

export function derToPem(der: Uint8Array, label: string): string {
  const b64 = bytesToBase64(der).replace(/(.{64})/g, "$1\n").replace(/\n$/, "");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

// ---------------------------------------------------------------------------
// Well-known OIDs

export const OIDS = {
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSAEncryption: "1.2.840.113549.1.1.11",
  ecPublicKey: "1.2.840.10045.2.1",
  ecdsaWithSHA256: "1.2.840.10045.4.3.2",
  ecdsaWithSHA384: "1.2.840.10045.4.3.3",
  prime256v1: "1.2.840.10045.3.1.7",
  secp384r1: "1.3.132.0.34",
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  pkcs7Data: "1.2.840.113549.1.7.1",
  pkcs7SignedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingTime: "1.2.840.113549.1.9.5",
  extensionRequest: "1.2.840.113549.1.9.14",
  subjectAltName: "2.5.29.17",
  commonName: "2.5.4.3",
} as const;

// ---------------------------------------------------------------------------
// X.509 certificate essentials

export interface CertificateInfo {
  /** DER of the Name structure, needed verbatim for CMS issuerAndSerialNumber. */
  issuerDer: Uint8Array;
  /** DER of the serial INTEGER (full TLV). */
  serialDer: Uint8Array;
  subjectDer: Uint8Array;
  notBefore: Date;
  notAfter: Date;
  /** Subject common name, if present. */
  commonName: string | null;
  /** dNSName SANs. */
  dnsNames: string[];
  /** SubjectPublicKeyInfo algorithm OID. */
  publicKeyAlgorithm: string;
  /** DER of the complete SubjectPublicKeyInfo, for matching a certificate to a key. */
  spkiDer: Uint8Array;
}

function nameCommonName(name: DerNode): string | null {
  for (const rdn of name.children) {
    for (const atv of rdn.children) {
      if (atv.children.length === 2 && decodeOid(atv.children[0]) === OIDS.commonName) {
        return new TextDecoder().decode(atv.children[1].value);
      }
    }
  }
  return null;
}

export function parseCertificate(der: Uint8Array): CertificateInfo {
  const cert = parseDer(der);
  const tbs = cert.children[0];
  if (!tbs) throw new DerError("not a certificate");
  let i = 0;
  if (tbs.children[i].tag === contextTag(0)) i++; // version
  const serial = tbs.children[i++];
  i++; // signature algorithm
  const issuer = tbs.children[i++];
  const validity = tbs.children[i++];
  const subject = tbs.children[i++];
  const spki = tbs.children[i++];
  const dnsNames: string[] = [];
  const extensions = tbs.children.find((c) => c.tag === contextTag(3));
  if (extensions) {
    for (const ext of extensions.children[0]?.children ?? []) {
      if (decodeOid(ext.children[0]) !== OIDS.subjectAltName) continue;
      const octets = ext.children[ext.children.length - 1];
      const names = parseDer(octets.value);
      for (const gn of names.children) if (gn.tag === contextTag(2, false)) dnsNames.push(new TextDecoder().decode(gn.value));
    }
  }
  return {
    issuerDer: issuer.raw,
    serialDer: serial.raw,
    subjectDer: subject.raw,
    notBefore: decodeTime(validity.children[0]),
    notAfter: decodeTime(validity.children[1]),
    commonName: nameCommonName(subject),
    dnsNames,
    publicKeyAlgorithm: decodeOid(spki.children[0].children[0]),
    spkiDer: spki.raw,
  };
}

// ---------------------------------------------------------------------------
// Private keys: accept PKCS#8, PKCS#1 (RSA) and SEC1 (EC) PEM and produce PKCS#8 DER
// plus the Web Crypto algorithm needed to import it.

export type SignatureAlgorithm =
  | { name: "RSASSA-PKCS1-v1_5"; hash: "SHA-256" }
  | { name: "ECDSA"; namedCurve: "P-256" | "P-384"; hash: "SHA-256" | "SHA-384" };

export interface ParsedPrivateKey {
  pkcs8: Uint8Array;
  algorithm: SignatureAlgorithm;
}

function curveFromOid(o: string): { namedCurve: "P-256" | "P-384"; hash: "SHA-256" | "SHA-384" } {
  if (o === OIDS.prime256v1) return { namedCurve: "P-256", hash: "SHA-256" };
  if (o === OIDS.secp384r1) return { namedCurve: "P-384", hash: "SHA-384" };
  throw new DerError(`unsupported EC curve ${o}`);
}

export function parsePrivateKeyPem(pem: string): ParsedPrivateKey {
  const blocks = pemBlocks(pem);
  const block = blocks.find((b) => b.label.endsWith("PRIVATE KEY"));
  if (!block) throw new DerError("no private key block in PEM input");
  if (block.label === "ENCRYPTED PRIVATE KEY") throw new DerError("encrypted private keys are not supported");

  if (block.label === "PRIVATE KEY") {
    const node = parseDer(block.der);
    const algId = node.children[1];
    const algOid = decodeOid(algId.children[0]);
    if (algOid === OIDS.rsaEncryption) return { pkcs8: block.der, algorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } };
    if (algOid === OIDS.ecPublicKey) return { pkcs8: block.der, algorithm: { name: "ECDSA", ...curveFromOid(decodeOid(algId.children[1])) } };
    throw new DerError(`unsupported key algorithm ${algOid}`);
  }

  if (block.label === "RSA PRIVATE KEY") {
    const pkcs8 = seq(integer(0), seq(oid(OIDS.rsaEncryption), nullValue()), octetString(block.der));
    return { pkcs8, algorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" } };
  }

  if (block.label === "EC PRIVATE KEY") {
    // SEC1 ECPrivateKey: SEQUENCE { version, privateKey, [0] parameters (curve OID), [1] publicKey }
    const node = parseDer(block.der);
    const params = node.children.find((c) => c.tag === contextTag(0));
    if (!params?.children[0]) throw new DerError("EC key without curve parameters");
    const curveOid = decodeOid(params.children[0]);
    const pkcs8 = seq(integer(0), seq(oid(OIDS.ecPublicKey), oid(curveOid)), octetString(block.der));
    return { pkcs8, algorithm: { name: "ECDSA", ...curveFromOid(curveOid) } };
  }

  throw new DerError(`unsupported private key type ${block.label}`);
}

export async function importPrivateKey(parsed: ParsedPrivateKey): Promise<CryptoKey> {
  const importAlg =
    parsed.algorithm.name === "ECDSA"
      ? { name: "ECDSA", namedCurve: parsed.algorithm.namedCurve }
      : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" };
  return crypto.subtle.importKey("pkcs8", parsed.pkcs8 as BufferSource, importAlg, true, ["sign"]);
}

/** Converts a raw (r||s) ECDSA signature from Web Crypto into the DER SEQUENCE X.509/CMS expect. */
export function ecdsaRawToDer(raw: Uint8Array): Uint8Array {
  const half = raw.length / 2;
  return seq(integerFromBytes(raw.subarray(0, half)), integerFromBytes(raw.subarray(half)));
}

/** AlgorithmIdentifier for a signature made with `alg`. */
export function signatureAlgorithmIdentifier(alg: SignatureAlgorithm): Uint8Array {
  if (alg.name === "RSASSA-PKCS1-v1_5") return seq(oid(OIDS.sha256WithRSAEncryption), nullValue());
  return seq(oid(alg.hash === "SHA-384" ? OIDS.ecdsaWithSHA384 : OIDS.ecdsaWithSHA256));
}

export function digestAlgorithmIdentifier(alg: SignatureAlgorithm): Uint8Array {
  return seq(oid(alg.hash === "SHA-384" ? OIDS.sha384 : OIDS.sha256), nullValue());
}

/** Signs `data` with a Web Crypto key and returns the DER-ready signature bytes. */
export async function signDer(key: CryptoKey, alg: SignatureAlgorithm, data: Uint8Array): Promise<Uint8Array> {
  const params = alg.name === "ECDSA" ? { name: "ECDSA", hash: alg.hash } : { name: "RSASSA-PKCS1-v1_5" };
  const sig = new Uint8Array(await crypto.subtle.sign(params, key, data as BufferSource));
  return alg.name === "ECDSA" ? ecdsaRawToDer(sig) : sig;
}
