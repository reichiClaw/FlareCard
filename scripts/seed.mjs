#!/usr/bin/env node
// Loads the demo contacts into a running FlareCard instance via the admin API.
//
//   BASE=http://127.0.0.1:47321 ADMIN_USER=admin ADMIN_PASS=flarecard-dev-admin node scripts/seed.mjs
//
// The same action is available as the "Load demo contacts" button in the admin UI.
const base = process.env.BASE ?? "http://127.0.0.1:47321";
const user = process.env.ADMIN_USER ?? "admin";
const pass = process.env.ADMIN_PASS ?? process.env.ADMIN_BOOTSTRAP_PASSWORD ?? "flarecard-dev-admin";

const res = await fetch(`${base}/api/contacts/seed`, {
  method: "POST",
  headers: { Authorization: `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}` },
});
const body = await res.text();
if (!res.ok) {
  console.error(`Seed failed: HTTP ${res.status} ${body}`);
  process.exit(1);
}
console.log(`Seeded demo contacts: ${body}`);
