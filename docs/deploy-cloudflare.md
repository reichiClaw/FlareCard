# Deploying FlareCard on Cloudflare — the complete manual

This guide takes you from an empty Cloudflare account to a production FlareCard server that
your iPhones, Macs and Android phones sync against, including custom domain, secrets, first
login, user onboarding, monitoring, updates, hardening and troubleshooting.

Time required: about 20 minutes for a first deployment.

There are two ways to get FlareCard onto Cloudflare; pick one:

- **Path A — CLI (sections 4–7).** Clone the repository, run `npm run deploy` from your machine.
  Best if you are comfortable with a terminal and want full control.
- **Path B — Cloudflare dashboard only (section 8).** Fork the repository on GitHub, connect it in
  the dashboard and let Cloudflare build and deploy it on every push. No Node.js, no terminal,
  and future updates are one click. Everything from section 9 onwards applies to both paths.

---

## Contents

1. [What gets deployed](#1-what-gets-deployed)
2. [Prerequisites](#2-prerequisites)
3. [Cloudflare account setup](#3-cloudflare-account-setup)
4. [Get the code and install dependencies](#4-get-the-code-and-install-dependencies)
5. [Review `wrangler.jsonc`](#5-review-wranglerjsonc)
6. [Configure secrets and variables](#6-configure-secrets-and-variables)
7. [First deployment](#7-first-deployment)
8. [Deploying from the Cloudflare dashboard (no CLI)](#8-deploying-from-the-cloudflare-dashboard-no-cli)
9. [Attach a custom domain](#9-attach-a-custom-domain)
10. [First login and bootstrap](#10-first-login-and-bootstrap)
11. [Verify the CardDAV endpoint](#11-verify-the-carddav-endpoint)
12. [Load contacts](#12-load-contacts)
13. [Onboard users and devices](#13-onboard-users-and-devices)
14. [Updating FlareCard](#14-updating-flarecard)
15. [Continuous deployment with GitHub Actions](#15-continuous-deployment-with-github-actions)
16. [Monitoring and logs](#16-monitoring-and-logs)
17. [Backups and data export](#17-backups-and-data-export)
18. [Security hardening](#18-security-hardening)
19. [Costs and limits](#19-costs-and-limits)
20. [Multiple environments (staging/production)](#20-multiple-environments-stagingproduction)
21. [Troubleshooting](#21-troubleshooting)
22. [Uninstalling](#22-uninstalling)
23. [Command cheat sheet](#23-command-cheat-sheet)

---

## 1. What gets deployed

`npm run deploy` creates exactly these Cloudflare resources:

| Resource | Name | Purpose |
| --- | --- | --- |
| Worker | `flarecard` (from `name` in `wrangler.jsonc`) | Runs the CardDAV server, the admin API and serves the admin UI |
| Durable Object class | `FlareCardDO` (SQLite-backed) | **All** data: users, contacts, tombstones, settings. Exactly one instance is ever created (`idFromName("main")`). |
| Static assets | uploaded from `ui/dist` | The built admin UI, served under `/admin/` |
| Secrets | `ADMIN_BOOTSTRAP_PASSWORD`, optional `SESSION_SECRET` | See section 6 |

Nothing else is used: no D1, KV, R2, Queues or cron triggers. That is what allows the same code
to run on self-hosted workerd (see `README.md`).

Requests flow like this:

```
device ──HTTPS──▶ Cloudflare edge ──▶ Worker (src/index.ts)
                                        ├─ /admin/*            → static assets
                                        ├─ /.well-known/carddav → 301 /dav/
                                        └─ /dav/*, /api/*      → Durable Object "main" (Hono app + SQLite)
```

The Durable Object lives in one Cloudflare location (chosen near the first request). Every
CardDAV request is routed there, which is what gives FlareCard strongly consistent ETags and
sync tokens.

---

## 2. Prerequisites

On your workstation:

- **Node.js 20 or newer** and npm (`node -v`). Node 22 is what the project is developed on.
- **Git**.
- A terminal. Wrangler (the Cloudflare CLI) is installed by `npm install`; you do not need a
  global install.

On Cloudflare:

- A Cloudflare account (free plan is enough; see section 19).
- Optional but strongly recommended: a **domain whose DNS is hosted on Cloudflare** so you can
  serve FlareCard from something like `contacts.example.com`. Without it you get a
  `*.workers.dev` hostname, which also works.

---

## 3. Cloudflare account setup

1. Sign up or sign in at <https://dash.cloudflare.com>.
2. Enable Workers: in the left sidebar open **Compute (Workers)** → **Workers & Pages**. The first
   time, Cloudflare asks you to pick a `workers.dev` subdomain (e.g. `acme.workers.dev`). Choose
   one; your Worker will be reachable at `flarecard.<subdomain>.workers.dev`.
3. (Optional) Add your domain: **Add a site** → enter `example.com` → follow the nameserver
   change instructions. You need this only for the custom domain in section 9.

You will authenticate Wrangler in the next section via a browser OAuth flow, so no API token is
needed for a manual deployment. (API tokens are covered in section 15 for CI.)

---

## 4. Get the code and install dependencies

```bash
git clone https://github.com/reichiClaw/FlareCard.git
cd FlareCard
npm install
```

Run the test suite once to make sure the toolchain works:

```bash
npm test
```

Log Wrangler in to your Cloudflare account (opens a browser window):

```bash
npx wrangler login
npx wrangler whoami        # prints the account you are deploying to
```

If you have several Cloudflare accounts, `whoami` lists them all and `wrangler deploy` will
prompt; you can pin one by adding `"account_id": "<id>"` to `wrangler.jsonc` or exporting
`CLOUDFLARE_ACCOUNT_ID`.

---

## 5. Review `wrangler.jsonc`

The shipped configuration works as-is. The parts you may want to touch:

```jsonc
{
  "name": "flarecard",                 // Worker name → flarecard.<subdomain>.workers.dev
  "main": "src/index.ts",
  "compatibility_date": "2025-09-01",  // leave as is unless you know why
  "workers_dev": true,                 // keep the workers.dev URL enabled (handy for testing)
  "observability": { "enabled": true },// Workers Logs in the dashboard

  "assets": {
    "directory": "./ui/dist",          // built by `npm run build:ui`
    "binding": "ASSETS",
    "run_worker_first": true,          // Worker decides what is DAV vs. UI
    "html_handling": "none",
    "not_found_handling": "none"
  },

  "durable_objects": {
    "bindings": [{ "name": "FLARECARD", "class_name": "FlareCardDO" }]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["FlareCardDO"] }],

  "vars": {
    "PUBLIC_HOST": "",                 // set to your custom hostname, see section 9
    "ADMIN_BOOTSTRAP_USERNAME": "admin"
  }
}
```

- **`name`**: change if you want a different `workers.dev` hostname or run several instances in
  one account (e.g. `flarecard-staging`).
- **`migrations`**: declares that `FlareCardDO` uses SQLite storage. Never remove or rename an
  existing migration tag after deploying; that would orphan your data. New migrations, if a future
  version needs one, are appended.
- **`vars`**: plain-text configuration. Secrets go elsewhere (next section).

---

## 6. Configure secrets and variables

FlareCard needs one secret and accepts a handful of optional settings.

| Name | Type | Required | Purpose |
| --- | --- | --- | --- |
| `ADMIN_BOOTSTRAP_PASSWORD` | secret | **Yes, for the first deploy** | Password of the initial admin account, created automatically on the first request if the user table is empty. |
| `ADMIN_BOOTSTRAP_USERNAME` | var | no (default `admin`) | Username of that initial admin. |
| `SESSION_SECRET` | secret | no | HMAC key for admin session cookies. If absent, FlareCard generates a random key once and stores it in the Durable Object. Set it explicitly if you want sessions to survive a full data reset or want to rotate it deliberately. |
| `PUBLIC_HOST` | var | recommended | Public hostname (optionally `host:port`) written into `.mobileconfig` profiles and the Device setup page. Defaults to the incoming `Host` header, which is fine once you use a single hostname. |
| `AUTH_RATE_LIMIT_IP` | var | no (default `60`) | Failed login attempts allowed per client IP within the window before FlareCard answers `429 Too Many Requests`. |
| `AUTH_RATE_LIMIT_USER` | var | no (default `15`) | Failed attempts allowed per username within the window, regardless of IP. Protects an individual account against distributed guessing. |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | var | no (default `600`) | Length of the rate-limit window. Counters reset on a successful login and expire after the window. |

The three `AUTH_RATE_LIMIT_*` variables control FlareCard's **built-in** brute-force protection. It
covers Basic auth on `/dav/*` and `/api/*` as well as the admin login form, counts only *failed*
attempts (a phone that syncs correctly every minute is never throttled), and is enforced inside the
Durable Object, so it works identically on Cloudflare and on self-hosted workerd. Set a variable to
`0` to disable that particular limit. Counters are kept in memory and start fresh after a deploy or
when the Durable Object is evicted after a long idle period; that is acceptable for its purpose.

### Set the bootstrap password

Generate a strong password and store it as a Worker secret. Secrets are encrypted at rest and never
shown again in the dashboard.

```bash
openssl rand -base64 24         # copy the output
npx wrangler secret put ADMIN_BOOTSTRAP_PASSWORD
# paste the password when prompted
```

Wrangler needs the Worker to exist before it can attach a secret. If you get "Worker not found",
either run the first deploy (section 7) and then set the secret, or let Wrangler create a
placeholder when it offers to. Either order is fine: the admin is created on the **first request
after** both the code and the secret are present.

### Optional: session secret

```bash
openssl rand -base64 32 | npx wrangler secret put SESSION_SECRET
```

### Optional: public host

Edit `wrangler.jsonc`:

```jsonc
"vars": { "PUBLIC_HOST": "contacts.example.com", "ADMIN_BOOTSTRAP_USERNAME": "admin" }
```

You can also set vars in the dashboard (**Worker → Settings → Variables and Secrets**), but values
in `wrangler.jsonc` win on the next deploy, so keep them in the file.

Store the bootstrap password in your password manager. After the first login you can (and should)
delete the secret; see section 18.

---

## 7. First deployment

Build the admin UI and deploy the Worker, Durable Object migration and static assets in one go:

```bash
npm run deploy
```

Under the hood this runs `vite build` (→ `ui/dist`) and `wrangler deploy`. The output ends with
something like:

```
Uploaded flarecard (3.21 sec)
Deployed flarecard triggers (0.52 sec)
  https://flarecard.acme.workers.dev
Current Version ID: 4f1c…
```

Open `https://flarecard.<subdomain>.workers.dev/admin/`. You should see the FlareCard login page.
If the bootstrap secret is set, the first request has already created the admin account. If the
page shows a blue banner "No administrator yet", the secret is missing — set it (section 6) and
reload.

Common first-deploy hiccups:

- *"You need to register a workers.dev subdomain"* → do step 2 of section 3.
- *"Durable Objects are not available"* → your account is missing the Workers product; opening
  **Workers & Pages** once in the dashboard usually fixes it.
- *Assets directory not found* → `ui/dist` is missing because the UI build failed; run
  `npm run build:ui` and read the error.

---

## 8. Deploying from the Cloudflare dashboard (no CLI)

This path uses **Workers Builds**, Cloudflare's built-in CI: you connect a Git repository, Cloudflare
clones it, runs the build, deploys the Worker and redeploys automatically whenever the connected
branch changes. You never install Node.js or Wrangler locally. It is the equivalent of sections 4–7
and of the GitHub Actions setup in section 15, done entirely by clicking.

You need: a Cloudflare account (section 3, including the `workers.dev` subdomain) and a GitHub or
GitLab account.

### 8.1 Fork the repository

1. Open the FlareCard repository on GitHub and click **Fork** (top right). Keep the name
   `FlareCard` or choose your own; a **private** fork is fine and recommended.
2. Your fork is what Cloudflare deploys. Later updates come in by syncing the fork with upstream
   (GitHub shows a **Sync fork** button on the fork's main page).

Why a fork rather than the upstream repository directly? Because the only file you may want to
change — `wrangler.jsonc` (public hostname, rate limits) — lives in the repository, and because
Cloudflare needs permission to install its GitHub app on the repository it deploys.

### 8.2 Create the Worker from the repository

1. Dashboard → **Compute (Workers)** → **Workers & Pages** → **Create** (blue button).
2. On the **Workers** tab choose **Import a repository** (sometimes labelled *Connect to Git* /
   *Continue with GitHub*).
3. Authorize the **Cloudflare Workers and Pages** GitHub app when asked. Grant it access to your
   fork only ("Only select repositories" → pick `FlareCard`).
4. Select the fork from the list and click **Begin setup**.
5. Fill in the **Set up your application** form:

   | Field | Value |
   | --- | --- |
   | Project / Worker name | `flarecard` (must match `name` in `wrangler.jsonc`; if you pick another name the dashboard warns you and uses the name from the file) |
   | Production branch | `main` |
   | Root directory | `/` (leave empty) |
   | Build command | `npm run build:ui` |
   | Deploy command | `npx wrangler deploy` |
   | Build variables | none needed |

   Cloudflare detects `package.json`, runs `npm clean-install` automatically before the build
   command and uses the Node.js version from `.nvmrc` (22). Do **not** use `npm run deploy` as
   the build command; the build must not deploy, the *Deploy command* does that.

6. Click **Save and Deploy**. The first build takes one to two minutes; you can watch the log
   live under **Deployments → View build**. The log ends with `Deployed flarecard triggers` and
   the `https://flarecard.<subdomain>.workers.dev` URL.

If you do not see an *Import a repository* option, the Git integration may not be enabled for your
account yet: open **Workers & Pages → Create → Workers**, scroll to *Deploy from a Git repository*,
or make sure you are not inside a *Pages* creation flow (Pages and Workers look similar; FlareCard
needs a **Worker**, because it uses Durable Objects).

### 8.3 Add the secrets

The first deployment succeeds but shows "No administrator yet" on the login page until the
bootstrap password exists. Add it now:

1. **Workers & Pages → flarecard → Settings → Variables and Secrets → Add**.
2. Type: **Secret**. Variable name `ADMIN_BOOTSTRAP_PASSWORD`. Value: a long random password
   (a password manager's generator is fine; store it there too). **Save** — no redeploy is
   necessary for secrets, they are live within seconds.
3. Optional: add `SESSION_SECRET` the same way (type Secret, 32+ random characters).

Secrets added in the dashboard are **not** touched by Git deployments; `wrangler deploy` never
overwrites secrets. They are also never displayed again, only replaceable.

### 8.4 Set plain variables (hostname, rate limits)

`PUBLIC_HOST`, `ADMIN_BOOTSTRAP_USERNAME` and the `AUTH_RATE_LIMIT_*` variables are defined in the
`vars` block of `wrangler.jsonc`. On every Git deployment that file **replaces** whatever plain
variables are set in the dashboard, so edit them in the repository, not in the dashboard:

1. On GitHub, open your fork → `wrangler.jsonc` → pencil icon (**Edit this file**).
2. Change, for example, `"PUBLIC_HOST": ""` to `"PUBLIC_HOST": "contacts.example.com"` and, if you
   want stricter limits, `"AUTH_RATE_LIMIT_USER": "10"`.
3. **Commit changes** to `main`. Cloudflare picks up the push and redeploys automatically; watch it
   under **Deployments**.

(If you would rather manage variables in the dashboard, add `"keep_vars": true` to `wrangler.jsonc`
once and remove the `vars` block; then dashboard values survive deployments. Secrets are unaffected
either way.)

### 8.5 First login

Open `https://flarecard.<subdomain>.workers.dev/admin/`, sign in with `admin` and the bootstrap
password and continue with section 10 (create your personal admin account) and section 9 (custom
domain — this is also done in the dashboard). After the first login, delete
`ADMIN_BOOTSTRAP_PASSWORD` under **Settings → Variables and Secrets** as described in section 18.

### 8.6 Day-to-day with the dashboard path

- **Updating FlareCard**: on GitHub open your fork → **Sync fork → Update branch**. That single
  commit on `main` triggers a build and deployment. Check **Deployments** for the green tick.
- **Preview builds**: pushes to any other branch of the fork produce a *preview* version with its
  own URL (`<hash>-flarecard.<subdomain>.workers.dev`) that shares the **same** Durable Object
  data as production, because there is only one Worker. Treat previews as production for data
  purposes, or use a separate Worker for staging (section 20).
- **Rollback**: **Deployments** → previous version → **Rollback**. Data is never rolled back.
- **Logs and metrics**: **flarecard → Logs** (persistent, searchable) and **Metrics**, see
  section 16. The live tail is also available in the dashboard under **Logs → Live**.
- **Build failures**: open the failed build; the log shows the failing step. The two common causes
  are a `wrangler.jsonc` edit with a JSON syntax error (a missing comma) and a Node.js version
  override. Fix the file on GitHub and push; there is nothing to clean up on Cloudflare.
- **Disconnecting Git**: **Settings → Build → Disconnect**. The Worker and all data stay; you can
  continue with the CLI path.

Everything else in this manual — custom domain (9), verifying CardDAV (11), loading contacts (12),
onboarding users (13), backups (17), hardening (18), troubleshooting (21) — is identical for both
paths. Where a section mentions an `npx wrangler …` command, the dashboard equivalent is noted or
the same action is available under **Workers & Pages → flarecard**.

---

## 9. Attach a custom domain

Apple devices and DAVx5 work with the `workers.dev` hostname, but a stable company hostname is
nicer for users and lets you change hosting later without touching every device.

### Option A — dashboard (recommended)

1. Dashboard → **Workers & Pages** → **flarecard** → **Settings** → **Domains & Routes** → **Add**
   → **Custom Domain**.
2. Enter `contacts.example.com` and confirm. Cloudflare creates the DNS record and certificate
   automatically (the zone must be on Cloudflare).
3. Wait a minute for the certificate, then open `https://contacts.example.com/admin/`.

### Option B — `wrangler.jsonc`

```jsonc
"routes": [
  { "pattern": "contacts.example.com", "custom_domain": true }
]
```

Then `npm run deploy`.

### Afterwards

- Set `"PUBLIC_HOST": "contacts.example.com"` in `wrangler.jsonc` and redeploy so downloaded
  profiles point at the custom domain.
- Optionally disable the `workers.dev` URL (`"workers_dev": false`, redeploy) so there is exactly
  one hostname in circulation. Keep it enabled while testing.

### TLS notes

Cloudflare terminates TLS with its own certificate ("Universal SSL"). No configuration is needed.
Basic auth credentials never cross the wire unencrypted: the Worker only ever sees HTTPS traffic
on a custom domain. If your zone's SSL mode is "Flexible" that only affects origin traffic, which
does not exist for Workers, so any mode is fine.

---

## 10. First login and bootstrap

1. Open `https://contacts.example.com/admin/` (or the `workers.dev` URL).
2. Sign in with `admin` (or your `ADMIN_BOOTSTRAP_USERNAME`) and the bootstrap password.
3. You land on the empty **Contacts** page.

How bootstrap works, so you can reason about it later:

- On every request the Durable Object checks once whether any users exist. If none exist **and**
  `ADMIN_BOOTSTRAP_PASSWORD` is set, it creates an admin with that password (PBKDF2-SHA256 hashed).
- Once at least one user exists the secret is ignored forever, even if you change it. To recover a
  lost admin password, see section 21.

Recommended immediately after the first login:

1. **Users → New user** → create a personal admin account for yourself (e.g. `jane` with role
   *Admin*). Copy the one-time app password.
2. Sign out, sign in as the new admin, then either delete the `admin` account or reset its
   password to something only stored in your password manager.
3. **Device setup** → confirm the *Server details* card shows your public hostname and that the
   "Not served over HTTPS" warning is **not** shown.

---

## 11. Verify the CardDAV endpoint

From any machine with `curl`, using an admin or user account:

```bash
BASE=https://contacts.example.com USER_NAME=admin PASS='your-password' scripts/dav-smoke.sh
```

The script walks the exact request sequence Apple Contacts uses (OPTIONS, `.well-known`,
principal discovery, home set, address book, multiget, query, sync-collection) and confirms that
`PUT`/`DELETE` are rejected with 403 and unknown sync tokens with 507.

Manual spot checks:

```bash
# Capabilities
curl -si -X OPTIONS https://contacts.example.com/dav/ | grep -iE '^(DAV|Allow)'

# Discovery redirect
curl -si https://contacts.example.com/.well-known/carddav | grep -i '^location'

# Principal (replace credentials)
curl -s -u admin:PASSWORD -X PROPFIND -H 'Depth: 0' https://contacts.example.com/dav/ \
  --data '<D:propfind xmlns:D="DAV:"><D:prop><D:current-user-principal/></D:prop></D:propfind>'
```

Expected: `DAV: 1, 3, addressbook`, a `301` to `/dav/`, and a `207` multistatus containing
`/dav/principals/admin/`.

---

## 12. Load contacts

Three ways, all in the admin UI under **Contacts**:

- **Import** → upload a `.vcf` (Apple Contacts, Google Contacts, Outlook, another CardDAV server;
  vCard 2.1/3.0/4.0, many cards per file) or a **CSV** with a header row (Google/Outlook/generic
  column names are recognized; unknown columns are reported and ignored). Files up to 25 MB.
  Re-importing a file replaces contacts with the same UID, so periodic re-imports from an HR
  system are safe.
- **New contact** → manual entry with all common fields and a photo (downscaled to 512 px JPEG in
  the browser, capped at 512 KB).
- **Load demo contacts** → seven sample people to test device sync. Delete them afterwards or
  leave them; they are ordinary contacts.

Scripted import (e.g. from a nightly HR export) can use the same API with Basic auth as an admin:

```bash
curl -u admin:PASSWORD -H 'Content-Type: application/json' \
  --data "$(jq -Rs '{format:"vcf", text:.}' < export.vcf)" \
  https://contacts.example.com/api/contacts/import
```

Every change bumps the address book's `getctag`/`sync-token`, so devices pick it up on their next
sync (iOS typically polls every 15–60 minutes or on opening Contacts; DAVx5 at the interval you set).

---

## 13. Onboard users and devices

For each person:

1. **Users → New user** → username (this is their CardDAV login), role *User*. FlareCard generates
   an app password and shows it **once**. Copy it into your password manager or a secure message
   to the user.
2. Send them **one** of:
   - the **iOS/macOS profile** (button in the user row). It is a `.mobileconfig` with a
     `com.apple.carddav.account` payload prefilled with host, port, SSL, username and principal URL.
     They open it, install it in Settings, and enter the app password when asked; or
   - the manual instructions from the **Device setup** page (iOS/macOS and Android/DAVx5 tabs).
3. On the device the account appears in Contacts as the address book name ("Company Directory" by
   default; change it under **Device setup → Address book name**).

Operational tasks:

- **Lost password** → *Reset app password* in the user's menu; devices stop syncing until the new
  password is entered on them.
- **Offboarding** → *Disable* (keeps the row, all requests get 401) or *Delete*. Contacts already on
  the person's device stay there until they remove the account; FlareCard cannot wipe devices.
- **Promote to admin** → *Make admin* gives access to the admin UI. Admins still cannot edit
  contacts from their phone; edits are UI-only by design.

Distributing profiles at scale: the `.mobileconfig` is unsigned, so iOS shows a "Not Signed"
notice, which is normal. If you use an MDM, you can push the same payload from there; FlareCard's
profile is a convenience, not a requirement.

---

## 14. Updating FlareCard

```bash
git pull
npm install
npm test
npm run deploy
```

Deployments are atomic and take a few seconds; in-flight requests finish on the old version.
Durable Object data is untouched by deploys. If a release adds a Durable Object migration, it is
already declared in `wrangler.jsonc` and applied by `wrangler deploy`.

Rollback: **Workers & Pages → flarecard → Deployments** lists previous versions with a
**Rollback** action, or from the CLI:

```bash
npx wrangler deployments list
npx wrangler rollback <version-id>
```

Rolling back code never rolls back data.

---

## 15. Continuous deployment with GitHub Actions

Deploy from `main` automatically instead of from a laptop.

1. Create an API token: dashboard → **My Profile → API Tokens → Create Token → "Edit Cloudflare
   Workers"** template. Scope it to your account (and zone, if you use a custom domain). Copy the
   token.
2. Find your account ID: **Workers & Pages** overview, right-hand column, or `npx wrangler whoami`.
3. In the GitHub repository add two **Actions secrets**: `CLOUDFLARE_API_TOKEN` and
   `CLOUDFLARE_ACCOUNT_ID`.
4. Add `.github/workflows/deploy.yml`:

```yaml
name: Deploy FlareCard
on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: npm
      - run: npm ci
      - run: npm run typecheck
      - run: npm test
      - run: npm run build:ui
      - name: Deploy
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
```

Worker secrets (`ADMIN_BOOTSTRAP_PASSWORD`, `SESSION_SECRET`) are stored on Cloudflare, not in the
repository, so the workflow does not need them. If you prefer to manage them from CI too, add
`secrets: | ADMIN_BOOTSTRAP_PASSWORD` to the action inputs and expose them as job env vars.

---

## 16. Monitoring and logs

- **Live logs**: `npx wrangler tail` streams every request with method, path and status (the app
  logs one line per request plus any unhandled error). Filter: `npx wrangler tail --status error`.
- **Workers Logs** (persisted, searchable): enabled by `"observability": { "enabled": true }`.
  Dashboard → **flarecard → Logs**. Retention depends on plan (3 days free / 7 days paid at the
  time of writing).
- **Metrics**: **flarecard → Metrics** shows requests, errors, CPU time and Durable Object
  request/storage counts. A healthy deployment has near-zero 5xx; expect plenty of 401s (devices
  probing before sending credentials) and 403s (device edits being rejected — that is the read-only
  mechanism working).
- **Health check**: `GET https://contacts.example.com/healthz` returns `{"ok":true}` from inside the
  Durable Object, so it exercises the whole path. Point an external uptime monitor at it.
- **Alerts**: **Notifications** in the dashboard can email/page you on Worker error-rate spikes.

Debug logs never include passwords or vCard contents.

---

## 17. Backups and data export

On Cloudflare the Durable Object's SQLite database is replicated and durable, and SQLite-backed
Durable Objects support point-in-time recovery for the last 30 days
(`ctx.storage.getBookmarkForTime()` / `onNextSessionRestoreBookmark()`), but FlareCard exposes no UI
for it. For everyday operations use logical backups:

- **Contacts**: **Contacts → Export .vcf** downloads every contact as one vCard file. Automate it:

  ```bash
  curl -su admin:PASSWORD https://contacts.example.com/api/contacts/export.vcf \
    -o "flarecard-$(date +%F).vcf"
  ```

  Restoring is **Import** of that file (UIDs are preserved, so it is idempotent).
- **Users**: `GET /api/users` returns usernames, roles and status (never password hashes). There is
  no import; recreate users and hand out new app passwords if you ever rebuild from scratch.
- **Settings**: address book name/description — note them down; two fields.

A disaster-recovery rebuild is therefore: deploy → bootstrap admin → import `.vcf` → recreate
users. Devices will do a full resync because the sync token namespace restarts.

---

## 18. Security hardening

FlareCard's defaults are sane (HTTPS-only on Cloudflare, PBKDF2 passwords, HttpOnly/SameSite
cookies, CSRF checks, 403 on all writes). Additional measures, roughly in order of value:

1. **Remove the bootstrap secret after first login.** It is inert once users exist, but there is no
   reason to keep a plaintext-equivalent admin password around:

   ```bash
   npx wrangler secret delete ADMIN_BOOTSTRAP_PASSWORD
   ```

2. **Protect `/admin/*` and `/api/*` with Cloudflare Access** (Zero Trust, free for up to 50 users).
   Zero Trust dashboard → **Access → Applications → Add → Self-hosted**, domain
   `contacts.example.com`, path `admin` (add a second application or path for `api`), policy
   "Allow: emails in @example.com" or your IdP group. Users then need SSO **before** they see the
   FlareCard login. Do **not** put Access in front of `/dav/*` or `/.well-known/*`; CardDAV clients
   cannot complete an Access login.

   Note: `/api/*` is also used with Basic auth by scripts (section 12/17). Either exempt those with
   an Access *service token* or run scripts from a machine that can complete the Access flow.

3. **Rate limiting.** FlareCard ships with brute-force protection enabled: after 15 failed attempts
   against one username or 60 from one IP within 10 minutes, further attempts get
   `429 Too Many Requests` with a `Retry-After` header, on the CardDAV endpoints and the admin
   login alike. Tune it with the `AUTH_RATE_LIMIT_*` variables (section 6); the defaults are
   generous enough that a mistyped password on a phone never locks anyone out, yet make online
   guessing of a 16-character app password hopeless.

   For an additional edge-side layer that stops abusive traffic before it reaches the Worker
   (and before it counts against your request quota), add a Cloudflare **WAF rate limiting rule**:
   Dashboard → **Security → WAF → Rate limiting rules → Create**: "if URI path starts with
   `/api/auth/login` and rate > 10 requests / 1 minute per IP → block for 10 minutes", and a looser
   one for `/dav/*` responses with status 401 (e.g. 60 per minute per IP). Rate limiting rules are
   available on the free plan and are independent of FlareCard's built-in limiter.

4. **Disable the `workers.dev` hostname** once the custom domain works (`"workers_dev": false`)
   so there is a single well-known entry point.

5. **Use strong, unique app passwords** — FlareCard generates 16-character random ones; do not let
   users choose their own (there is deliberately no self-service password change).

6. **Review admins periodically** on the Users page; demote or disable stale accounts.

7. **Security headers** for the admin UI are set by the Worker (`X-Frame-Options: DENY`,
   `nosniff`, `Referrer-Policy`). You may add HSTS at the zone level: **SSL/TLS → Edge
   Certificates → HSTS**.

---

## 19. Costs and limits

FlareCard is tiny by Cloudflare standards. Rough sizing for the design target (200 users, a few
thousand contacts):

- Each device syncs a handful of requests every 15–60 minutes → on the order of **200k–1M Worker
  requests per month**, each also a Durable Object request.
- Storage: a few thousand vCards with small photos is **10–50 MB** of SQLite.

Plan implications (verify current numbers at <https://developers.cloudflare.com/workers/platform/pricing/>):

- **Workers Free**: 100,000 requests/day, 10 ms CPU per request. Small teams fit; a 200-user
  deployment on aggressive sync intervals can exceed the daily request cap during work hours, at
  which point requests fail until midnight UTC. SQLite-backed Durable Objects are included on the
  free plan with storage limits in the low-GB range.
- **Workers Paid** ($5/month): 10 M requests included, then $0.30/M; Durable Object requests
  1 M included then $0.15/M; DO storage 1 GB included. A 200-user FlareCard stays within or barely
  above the included amounts, so expect **about $5–7/month**.

Hard limits that matter:

- Request body 100 MB (imports are capped at 25 MB by FlareCard anyway).
- A single Durable Object handles requests serially; PBKDF2 verification is cached for five
  minutes per credential, so the object comfortably handles hundreds of devices. If you ever go far
  beyond the design target, the bottleneck is this single object, not Workers.
- Static assets: 20,000 files / 25 MB per file — the admin UI is three files.

---

## 20. Multiple environments (staging/production)

Wrangler environments let one config produce several Workers. Add to `wrangler.jsonc`:

```jsonc
"env": {
  "staging": {
    "name": "flarecard-staging",
    "vars": { "PUBLIC_HOST": "contacts-staging.example.com", "ADMIN_BOOTSTRAP_USERNAME": "admin" },
    "routes": [{ "pattern": "contacts-staging.example.com", "custom_domain": true }]
  }
}
```

Then:

```bash
npx wrangler secret put ADMIN_BOOTSTRAP_PASSWORD --env staging
npm run build:ui && npx wrangler deploy --env staging
```

Each environment has its own Worker, Durable Object namespace (and therefore its own data),
secrets and hostname. Top-level `durable_objects`/`migrations`/`assets` are inherited.

---

## 21. Troubleshooting

**Login page says "No administrator yet".**
The user table is empty and `ADMIN_BOOTSTRAP_PASSWORD` is not set (or was set after the Worker
cached "not bootstrapped"). Run `npx wrangler secret put ADMIN_BOOTSTRAP_PASSWORD`; setting a
secret redeploys the Worker, so the next request re-checks. Confirm with
`curl https://…/api/status` → `{"bootstrapped":true,…}`.

**I lost the only admin password.**
Options, least destructive first: (1) if another admin exists, ask them to reset yours; (2) if
`ADMIN_BOOTSTRAP_PASSWORD` was the only admin and you still have it, it does not help — bootstrap
only runs on an empty user table; (3) as a last resort, wipe the Durable Object by deploying a
new migration that renames/deletes the class, which discards **all** data — export contacts first
if you still can via a user account (users can `GET` vCards but not the export endpoint). Practical
prevention: create two admin accounts (section 10).

**iPhone says "Cannot verify account" / "Server does not support CardDAV".**
- Check `curl -si -X OPTIONS https://host/dav/` shows `DAV: 1, 3, addressbook`.
- Ensure the hostname resolves publicly and the certificate is valid (`workers.dev` and custom
  domains both are). Self-signed or Cloudflare Access in front of `/dav/` will break it.
- If the account was added manually with "Advanced settings", the account URL should be
  `https://host/dav/principals/<username>/` or simply the hostname.
- Wrong password gives the same generic error on iOS; reset the app password to be sure.

**DAVx5: "Couldn't find CardDAV service".**
Use base URL `https://host/dav/` (with trailing slash) or just `https://host`. DAVx5 follows
`/.well-known/carddav`. Make sure `PUBLIC_HOST`, if set, matches the host you typed; a mismatch
only affects profiles, not discovery, but is a common typo source.

**Contacts sync but edits on the phone "fail" or revert.**
Expected. The server returns 403 for `PUT`/`DELETE`; the device shows a sync error and re-fetches
the server copy. Edit in the admin UI. Users on iOS may see "Contacts couldn't be saved"; DAVx5
logs the 403.

**Changes in the admin UI do not show up on devices.**
Devices poll; iOS often only syncs when Contacts is opened. Force it: iOS Settings → Contacts
account → toggle off/on, or in DAVx5 pull-to-refresh. Verify server-side that the ctag changed:
`PROPFIND` with `CS:getctag` (see `scripts/dav-smoke.sh`).

**Devices do a full re-download frequently.**
Look for 507 responses in `wrangler tail`. A 507 means the device presented a sync token FlareCard
does not know, typically after a data reset/reimport with a fresh Durable Object. It self-heals
after one full sync.

**`wrangler deploy` fails with "Cannot apply new-sqlite-classes migration"** or similar.
The migration tag `v1` already exists in a different form (e.g. you edited it). Restore the
original `migrations` block; never edit past migrations.

**`wrangler deploy` fails with "Assets directory ./ui/dist not found".**
Run `npm run build:ui` (or use `npm run deploy`, which does it for you).

**429 "Too many failed authentication attempts" (from FlareCard).**
The built-in rate limiter tripped: more than `AUTH_RATE_LIMIT_USER` (default 15) wrong passwords for
that username, or more than `AUTH_RATE_LIMIT_IP` (default 60) from that IP, within the window. The
usual cause is a device still holding an old app password after a reset — fix the password on the
device; the block clears on the first correct login or after `Retry-After` seconds (default up to
10 minutes). If a whole office shares one public IP and hits the IP budget, raise
`AUTH_RATE_LIMIT_IP` in `wrangler.jsonc` and redeploy. To lift a block immediately, redeploy the
Worker (counters live in memory).

**429 / "daily request limit exceeded" on the free plan.**
Upgrade to Workers Paid or lengthen sync intervals in DAVx5. iOS intervals cannot be set below
"Fetch → Hourly"/"Manually" under Settings → Contacts → Accounts → Fetch New Data.

**HTTP 500 from the Worker.**
`npx wrangler tail --status error` shows the stack trace. Common culprits are malformed imports
(fixed by validation) — please file an issue with the trace; passwords and vCard bodies are not
logged.

**Profile download opens as text instead of installing.**
Send the `.mobileconfig` to the device via AirDrop, Mail or Files rather than opening it in a
third-party browser; Safari and Files hand it to Settings correctly.

---

## 22. Uninstalling

```bash
npx wrangler delete            # removes the Worker, its assets, secrets and routes
```

Deleting the Worker also deletes its Durable Object namespace and **all stored data** after a
grace period. Export contacts first (section 17). Remove the custom domain DNS record if Cloudflare
did not clean it up, and remove any Access applications or WAF rules you created.

---

## 23. Command cheat sheet

```bash
npm install                                   # dependencies (includes wrangler)
npx wrangler login                            # authenticate CLI
npx wrangler secret put ADMIN_BOOTSTRAP_PASSWORD
npx wrangler secret put SESSION_SECRET        # optional
npm run deploy                                # build UI + deploy Worker, DO, assets
npx wrangler tail                             # live request log
npx wrangler deployments list                 # version history
npx wrangler rollback <version-id>            # roll back code (not data)
npx wrangler secret delete ADMIN_BOOTSTRAP_PASSWORD   # after first login
BASE=https://contacts.example.com USER_NAME=admin PASS=… scripts/dav-smoke.sh   # verify CardDAV
curl -su admin:… https://contacts.example.com/api/contacts/export.vcf -o backup.vcf
npx wrangler delete                           # uninstall (destroys data)
```
