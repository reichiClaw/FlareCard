/**
 * CLI for the external ACME runner. Usage:
 *
 *   FLARECARD_URL=https://contacts.example.com \
 *   FLARECARD_ADMIN_USER=admin FLARECARD_ADMIN_PASSWORD=… \
 *   ACME_EMAIL=it@example.com npm run acme:renew [-- --force] [--staging]
 *
 * Optional: ACME_DIRECTORY_URL (any ACME CA without external account binding),
 * ACME_ACCOUNT_KEY (JSON {privateJwk, publicJwk} to reuse one ACME account),
 * RENEW_BEFORE_DAYS (default 30).
 *
 * Exit codes: 0 = certificate fresh or renewed, 1 = failure.
 */

import { LETS_ENCRYPT_DIRECTORY, LETS_ENCRYPT_STAGING_DIRECTORY, type AcmeAccountKeys } from "../src/lib/acme";
import { renewSigningCertificate } from "./lib/renew";

const args = new Set(process.argv.slice(2));
const env = process.env;

function required(name: string): string {
  const v = env[name]?.trim();
  if (!v) {
    console.error(`Missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

const url = required("FLARECARD_URL");
const username = required("FLARECARD_ADMIN_USER");
const password = required("FLARECARD_ADMIN_PASSWORD");
const directoryUrl = args.has("--staging") ? LETS_ENCRYPT_STAGING_DIRECTORY : env.ACME_DIRECTORY_URL?.trim() || LETS_ENCRYPT_DIRECTORY;
const accountKeys = env.ACME_ACCOUNT_KEY ? (JSON.parse(env.ACME_ACCOUNT_KEY) as AcmeAccountKeys) : undefined;
const renewBeforeDays = env.RENEW_BEFORE_DAYS ? Number(env.RENEW_BEFORE_DAYS) : undefined;

const stamp = () => new Date().toISOString().slice(11, 19);

renewSigningCertificate({
  flarecard: { url, username, password },
  acme: { directoryUrl, accountKeys },
  email: env.ACME_EMAIL?.trim() || null,
  renewBeforeDays,
  force: args.has("--force"),
  log: (line) => console.log(`${stamp()} ${line}`),
})
  .then((result) => {
    const c = result.status.certificate;
    console.log(`${stamp()} ${result.action === "renewed" ? "Renewed" : "Skipped"}${c ? ` — certificate for ${c.dnsNames.join(", ")} valid until ${c.notAfter} (${c.daysLeft} days)` : ""}.`);
  })
  .catch((e) => {
    console.error(`${stamp()} ${e instanceof Error ? e.message : String(e)}`);
    process.exit(1);
  });
