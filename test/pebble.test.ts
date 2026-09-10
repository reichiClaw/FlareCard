/**
 * End-to-end check against Pebble, Let's Encrypt's test ACME server. Skipped
 * unless PEBBLE_DIRECTORY is set, e.g.
 *
 *   pebble-challtestsrv -dns01 127.0.0.1:8053 -http01 "" -https01 "" -tlsalpn01 "" -defaultIPv4 127.0.0.1 &
 *   PEBBLE_VA_NOSLEEP=1 pebble -config pebble.json -dnsserver 127.0.0.1:8053 &
 *   PEBBLE_DIRECTORY=https://127.0.0.1:14000/dir PEBBLE_HTTP_PORT=5002 npm test -- pebble
 */
import { describe, expect, it } from "vitest";
import { createServer } from "node:http";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { adminAuth, makeApp } from "./helpers";
import type { SigningStatus } from "../src/lib/signing";
import { parseCertificate, parseDer } from "../src/lib/asn1";

const directory = process.env.PEBBLE_DIRECTORY;
const httpPort = Number(process.env.PEBBLE_HTTP_PORT ?? "5002");
const HOST = "flarecard.test";

describe.skipIf(!directory)("ACME against Pebble", () => {
  it("issues a real certificate via http-01 and signs a profile that openssl verifies", { timeout: 60_000 }, async () => {
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0"; // Pebble uses a self-signed TLS certificate
    const t = await makeApp({ env: { PUBLIC_HOST: HOST, ACME_DIRECTORY_URL: directory! } });

    // Pebble validates by connecting to <host>:httpPort; forward that into the app.
    const server = createServer((req, res) => {
      t.fetch(req.url ?? "/", { auth: null, headers: { Host: HOST } })
        .then(async (r) => {
          res.writeHead(r.status, { "Content-Type": r.headers.get("content-type") ?? "text/plain" });
          res.end(new Uint8Array(await r.arrayBuffer()));
        })
        .catch(() => {
          res.writeHead(500);
          res.end();
        });
    });
    await new Promise<void>((resolve) => server.listen(httpPort, "127.0.0.1", resolve));

    try {
      const res = await t.fetch("/api/signing", {
        method: "PUT",
        auth: adminAuth,
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ enabled: true, email: "it@example.com" }),
      });
      expect(res.status).toBe(200);
      let status = (await res.json()) as SigningStatus;
      for (let i = 0; i < 200 && status.phase !== "issued" && status.phase !== "error"; i++) {
        await new Promise((r) => setTimeout(r, 250));
        status = (await (await t.fetch("/api/signing", { auth: adminAuth })).json()) as SigningStatus;
      }
      expect(status.error).toBeNull();
      expect(status.phase).toBe("issued");
      expect(status.certificate?.dnsNames).toEqual([HOST]);

      const users = (await (await t.fetch("/api/users", { auth: adminAuth })).json()) as { items: { id: number }[] };
      const profile = await t.fetch(`/api/users/${users.items[0].id}/profile.mobileconfig`, { auth: adminAuth });
      expect(profile.headers.get("x-flarecard-profile-signed")).toBe("yes");
      const cms = new Uint8Array(await profile.arrayBuffer());
      const certs = parseDer(cms).children[1].children[0].children[3].children;
      expect(certs.length).toBeGreaterThanOrEqual(2); // leaf + Pebble intermediate
      expect(parseCertificate(certs[0].raw).dnsNames).toEqual([HOST]);

      // Verify the CMS with Pebble's root (served by its management interface).
      const mgmt = directory!.replace(/:\d+\/dir$/, ":15000/roots/0");
      const root = await (await fetch(mgmt)).text();
      const dir = mkdtempSync(join(tmpdir(), "flarecard-pebble-"));
      try {
        writeFileSync(join(dir, "p.der"), cms);
        writeFileSync(join(dir, "root.pem"), root);
        const out = execFileSync(
          "openssl",
          ["cms", "-verify", "-inform", "DER", "-in", join(dir, "p.der"), "-CAfile", join(dir, "root.pem"), "-purpose", "any"],
          { stdio: ["ignore", "pipe", "pipe"] },
        ).toString();
        expect(out).toContain("com.apple.carddav.account");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
