/**
 * CMS / PKCS#7 SignedData with attached content (RFC 5652), which is what a
 * signed Apple configuration profile is: the plist wrapped in a DER envelope
 * carrying the signer certificate chain. Equivalent to
 *   openssl smime -sign -nodetach -outform der
 */

import {
  OIDS,
  digestAlgorithmIdentifier,
  explicit,
  integer,
  octetString,
  oid,
  parseCertificate,
  seq,
  set,
  signDer,
  signatureAlgorithmIdentifier,
  tlv,
  TAG,
  type SignatureAlgorithm,
  utcTime,
} from "./asn1";

export interface CmsSigner {
  key: CryptoKey;
  algorithm: SignatureAlgorithm;
  /** Leaf certificate first, then intermediates (DER). */
  chain: Uint8Array[];
}

async function digest(alg: SignatureAlgorithm, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest(alg.hash, data as BufferSource));
}

function attribute(type: string, value: Uint8Array): Uint8Array {
  return seq(oid(type), set(value));
}

/**
 * Wraps `content` in a SignedData ContentInfo signed by `signer`.
 * Signed attributes: contentType, signingTime, messageDigest (RFC 5652 §11).
 */
export async function signCms(content: Uint8Array, signer: CmsSigner, now: Date = new Date()): Promise<Uint8Array> {
  if (!signer.chain.length) throw new Error("signer chain is empty");
  const leaf = parseCertificate(signer.chain[0]);
  const alg = signer.algorithm;

  // DER requires SET OF elements in ascending order of their encodings (X.690 §11.6).
  const signedAttrs = [
    attribute(OIDS.contentType, oid(OIDS.pkcs7Data)),
    attribute(OIDS.signingTime, utcTime(now)),
    attribute(OIDS.messageDigest, octetString(await digest(alg, content))),
  ].sort(compareDer);
  // The signature is computed over the attributes encoded as a SET (tag 0x31),
  // even though they appear in the structure as [0] IMPLICIT.
  const signature = await signDer(signer.key, alg, set(...signedAttrs));
  const attrsInStructure = tlv(0xa0, concatAll(signedAttrs));

  const signerInfo = seq(
    integer(1), // version 1: issuerAndSerialNumber
    seq(leaf.issuerDer, leaf.serialDer),
    digestAlgorithmIdentifier(alg),
    attrsInStructure,
    signatureAlgorithmIdentifier(alg),
    octetString(signature),
  );

  const signedData = seq(
    integer(1),
    set(digestAlgorithmIdentifier(alg)),
    seq(oid(OIDS.pkcs7Data), explicit(0, octetString(content))),
    tlv(0xa0, concatAll(signer.chain)), // certificates [0] IMPLICIT SET OF Certificate
    set(signerInfo),
  );

  return seq(oid(OIDS.pkcs7SignedData), explicit(0, signedData));
}

function concatAll(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function compareDer(a: Uint8Array, b: Uint8Array): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const x = i < a.length ? a[i] : 0;
    const y = i < b.length ? b[i] : 0;
    if (x !== y) return x - y;
  }
  return 0;
}

/** True when the bytes look like a CMS ContentInfo (SEQUENCE starting with the signedData OID). */
export function looksLikeCms(bytes: Uint8Array): boolean {
  return bytes[0] === TAG.SEQUENCE;
}
