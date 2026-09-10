import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { signCms } from "../src/lib/cms";
import {
  OIDS,
  contextTag,
  decodeOid,
  derToPem,
  ecdsaRawToDer,
  importPrivateKey,
  integer,
  oid,
  parseCertificate,
  parseDer,
  parsePrivateKeyPem,
  pemToDer,
  seq,
  set,
  TAG,
  utcTime,
  decodeTime,
} from "../src/lib/asn1";
import { selfSigned } from "./certs";

const hasOpenssl = (() => {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
})();

describe("DER encoder/decoder", () => {
  it("round-trips OIDs, integers and times", () => {
    for (const o of ["1.2.840.113549.1.7.2", "2.16.840.1.101.3.4.2.1", "2.5.29.17", "1.3.132.0.34"]) {
      expect(decodeOid(parseDer(oid(o)))).toBe(o);
    }
    expect([...integer(0)]).toEqual([0x02, 0x01, 0x00]);
    expect([...integer(128)]).toEqual([0x02, 0x02, 0x00, 0x80]);
    expect([...integer(65536)]).toEqual([0x02, 0x03, 0x01, 0x00, 0x00]);
    const d = new Date("2026-09-10T12:34:56Z");
    expect(decodeTime(parseDer(utcTime(d))).toISOString()).toBe(d.toISOString());
  });

  it("uses long-form lengths and parses nested structures", () => {
    const big = new Uint8Array(300).fill(0xab);
    const node = parseDer(seq(set(integer(1)), seq(...Array.from({ length: 10 }, () => integer(7))), seq(big.length ? seq() : seq())));
    expect(node.tag).toBe(TAG.SEQUENCE);
    expect(node.children).toHaveLength(3);
    expect(node.children[1].children).toHaveLength(10);
    const wrapped = parseDer(seq(new Uint8Array([0x04, 0x82, 0x01, 0x2c, ...big])));
    expect(wrapped.children[0].value.length).toBe(300);
  });

  it("converts raw ECDSA signatures to DER", () => {
    const raw = new Uint8Array(64);
    raw[0] = 0x80; // r needs a leading zero
    raw[63] = 0x01;
    const node = parseDer(ecdsaRawToDer(raw));
    expect(node.children[0].value[0]).toBe(0);
    expect(node.children[0].value.length).toBe(33);
    expect(node.children[1].value.length).toBe(1);
  });
});

describe("certificate and key parsing", () => {
  it("extracts issuer, serial, validity and SANs from a certificate", async () => {
    const cert = await selfSigned("contacts.example.com", "ec", { dnsNames: ["contacts.example.com", "cards.example.com"] });
    const info = parseCertificate(cert.der);
    expect(info.commonName).toBe("contacts.example.com");
    expect(info.dnsNames).toEqual(["contacts.example.com", "cards.example.com"]);
    expect(info.notAfter.getTime()).toBeGreaterThan(Date.now() + 80 * 86_400_000);
    expect(info.publicKeyAlgorithm).toBe(OIDS.ecPublicKey);
    expect(parseDer(info.serialDer).tag).toBe(TAG.INTEGER);
    expect(parseDer(info.issuerDer).tag).toBe(TAG.SEQUENCE);
  });

  it("imports PKCS#8 RSA/EC keys and wraps SEC1 and PKCS#1 keys", async () => {
    const ec = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign"])) as CryptoKeyPair;
    const pkcs8 = new Uint8Array((await crypto.subtle.exportKey("pkcs8", ec.privateKey)) as ArrayBuffer);
    const pem = derToPem(pkcs8, "PRIVATE KEY");
    const parsed = parsePrivateKeyPem(pem);
    expect(parsed.algorithm).toEqual({ name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" });
    expect(await importPrivateKey(parsed)).toBeTruthy();

    if (hasOpenssl) {
      const dir = mkdtempSync(join(tmpdir(), "flarecard-keys-"));
      try {
        // PKCS#1 "RSA PRIVATE KEY" (legacy openssl / certbot with --key-type rsa on old versions).
        execFileSync("openssl", ["genrsa", "-traditional", "-out", join(dir, "rsa.pem"), "2048"], { stdio: "ignore" });
        const rsaPem = readFileSync(join(dir, "rsa.pem"), "utf8");
        expect(rsaPem).toContain("BEGIN RSA PRIVATE KEY");
        const rsa = parsePrivateKeyPem(rsaPem);
        expect(rsa.algorithm.name).toBe("RSASSA-PKCS1-v1_5");
        expect(await importPrivateKey(rsa)).toBeTruthy();

        // SEC1 "EC PRIVATE KEY" with embedded curve parameters, as written by Caddy.
        execFileSync("openssl", ["ecparam", "-name", "prime256v1", "-genkey", "-noout", "-out", join(dir, "ec.pem")], { stdio: "ignore" });
        const sec1Pem = readFileSync(join(dir, "ec.pem"), "utf8");
        expect(sec1Pem).toContain("BEGIN EC PRIVATE KEY");
        const fromSec1 = parsePrivateKeyPem(sec1Pem);
        expect(fromSec1.algorithm).toEqual({ name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" });
        expect(await importPrivateKey(fromSec1)).toBeTruthy();
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});

describe("CMS SignedData", () => {
  const content = new TextEncoder().encode('<?xml version="1.0"?><plist version="1.0"><dict/></plist>');

  for (const kind of ["ec", "rsa"] as const) {
    it(`produces a well-formed ${kind.toUpperCase()} signature that verifies`, async () => {
      const cert = await selfSigned("contacts.example.com", kind);
      const cms = await signCms(content, { key: cert.key, algorithm: cert.algorithm, chain: [cert.der] });

      const root = parseDer(cms);
      expect(decodeOid(root.children[0])).toBe(OIDS.pkcs7SignedData);
      const signedData = root.children[1].children[0];
      const [version, digestAlgs, encapContent, certs, signerInfos] = signedData.children;
      expect(version.value[0]).toBe(1);
      expect(decodeOid(digestAlgs.children[0].children[0])).toBe(OIDS.sha256);
      expect(decodeOid(encapContent.children[0])).toBe(OIDS.pkcs7Data);
      expect([...encapContent.children[1].children[0].value]).toEqual([...content]);
      expect(certs.tag).toBe(contextTag(0));
      expect([...certs.children[0].raw]).toEqual([...cert.der]);

      const signerInfo = signerInfos.children[0];
      const [, sid, , signedAttrs, sigAlg, signature] = signerInfo.children;
      const leaf = parseCertificate(cert.der);
      expect([...sid.children[0].raw]).toEqual([...leaf.issuerDer]);
      expect([...sid.children[1].raw]).toEqual([...leaf.serialDer]);
      expect(signedAttrs.tag).toBe(contextTag(0));
      const attrTypes = signedAttrs.children.map((a) => decodeOid(a.children[0]));
      expect(attrTypes).toEqual(expect.arrayContaining([OIDS.contentType, OIDS.signingTime, OIDS.messageDigest]));
      const digestAttr = signedAttrs.children.find((a) => decodeOid(a.children[0]) === OIDS.messageDigest)!;
      const expectedDigest = new Uint8Array(await crypto.subtle.digest("SHA-256", content));
      expect([...digestAttr.children[1].children[0].value]).toEqual([...expectedDigest]);
      expect(decodeOid(sigAlg.children[0])).toBe(kind === "ec" ? OIDS.ecdsaWithSHA256 : OIDS.sha256WithRSAEncryption);

      // Verify the signature over the attributes re-encoded as a SET.
      const setBytes = new Uint8Array(signedAttrs.raw);
      setBytes[0] = TAG.SET;
      const pub = await crypto.subtle.importKey(
        "spki",
        cert.spki as BufferSource,
        kind === "ec" ? { name: "ECDSA", namedCurve: "P-256" } : { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      );
      let sigBytes = signature.value;
      if (kind === "ec") {
        const [r, s] = parseDer(sigBytes).children.map((n) => n.value);
        const strip = (b: Uint8Array) => (b.length > 32 ? b.subarray(b.length - 32) : b);
        const raw = new Uint8Array(64);
        raw.set(strip(r), 32 - strip(r).length);
        raw.set(strip(s), 64 - strip(s).length);
        sigBytes = raw;
      }
      const ok = await crypto.subtle.verify(
        kind === "ec" ? { name: "ECDSA", hash: "SHA-256" } : { name: "RSASSA-PKCS1-v1_5" },
        pub,
        sigBytes as BufferSource,
        setBytes as BufferSource,
      );
      expect(ok).toBe(true);

      if (hasOpenssl) {
        const dir = mkdtempSync(join(tmpdir(), "flarecard-cms-"));
        try {
          writeFileSync(join(dir, "signed.der"), cms);
          writeFileSync(join(dir, "cert.pem"), derToPem(cert.der, "CERTIFICATE"));
          const out = execFileSync(
            "openssl",
            ["cms", "-verify", "-inform", "DER", "-in", join(dir, "signed.der"), "-CAfile", join(dir, "cert.pem"), "-purpose", "any"],
            { stdio: ["ignore", "pipe", "pipe"] },
          );
          expect(out.toString()).toBe(new TextDecoder().decode(content));
        } finally {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    });
  }

  it("includes intermediates in the certificate set", async () => {
    const ca = await selfSigned("FlareCard Test CA", "ec", { ca: true });
    const leafKeys = await selfSigned("contacts.example.com", "ec");
    const { issueCertificate } = await import("./certs");
    const leafDer = await issueCertificate(
      leafKeys.spki,
      { key: ca.key, algorithm: ca.algorithm },
      { cn: "contacts.example.com", issuer: { cn: "FlareCard Test CA", key: ca.key, algorithm: ca.algorithm } },
    );
    const cms = await signCms(content, { key: leafKeys.key, algorithm: leafKeys.algorithm, chain: [leafDer, ca.der] });
    const certs = parseDer(cms).children[1].children[0].children[3];
    expect(certs.children).toHaveLength(2);
    expect(pemToDer(derToPem(certs.children[1].raw, "CERTIFICATE"))).toEqual(ca.der);

    if (hasOpenssl) {
      const dir = mkdtempSync(join(tmpdir(), "flarecard-cms-"));
      try {
        writeFileSync(join(dir, "signed.der"), cms);
        writeFileSync(join(dir, "ca.pem"), derToPem(ca.der, "CERTIFICATE"));
        const out = execFileSync(
          "openssl",
          ["cms", "-verify", "-inform", "DER", "-in", join(dir, "signed.der"), "-CAfile", join(dir, "ca.pem"), "-purpose", "any"],
          { stdio: ["ignore", "pipe", "pipe"] },
        );
        expect(out.toString()).toBe(new TextDecoder().decode(content));
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  });
});
