# FlareCard

A self-hosted, **read-only CardDAV server** for a shared company address book. It syncs
natively to iOS/macOS Contacts and to Android via [DAVx5](https://www.davx5.com/), and ships
with an admin web UI for maintaining contacts and users.

- **One shared address book** at a fixed path, served to every user (~200 users, a few
  thousand contacts is the design target).
- **Read-only for devices.** Contacts are edited only in the admin UI; every write method on the
  CardDAV surface returns `403`.
- **Runtime-neutral.** A TypeScript Worker (Hono) that runs unchanged on Cloudflare Workers
  (`wrangler dev` / `wrangler deploy`) and on open-source [workerd](https://github.com/cloudflare/workerd).
- **One SQLite-backed Durable Object** holds all state. No D1, R2, KV, Queues or cron triggers,
  so nothing depends on Cloudflare-only services.
- **Web-standard APIs only** (`fetch`, Web Crypto, `TextEncoder`, …). No Node built-ins.

---

## Contents

- [Architecture](#architecture)
- [CardDAV surface](#carddav-surface)
- [Develop on Cloudflare](#develop-on-cloudflare)
- [Deploy to Cloudflare](#deploy-to-cloudflare) (full manual: [`docs/deploy-cloudflare.md`](docs/deploy-cloudflare.md))
- [Self-host on workerd](#self-host-on-workerd)
  - [Reverse proxy with TLS (Caddy / nginx)](#reverse-proxy-with-tls)
  - [Backups](#backups)
- [Admin UI](#admin-ui)
  - [Lock marker on devices](#lock-marker-on-devices)
  - [Forced re-sync (scheduled push)](#forced-re-sync-scheduled-push)
  - [Signed profiles](#signed-profiles)
- [Client setup](#client-setup)
- [Testing](#testing)
- [Known limitations](#known-limitations)

---

## Architecture

```
                     ┌──────────────────────────────────────────────────────┐
  iOS / macOS ─────▶ │  Worker entry (src/index.ts)                         │
  DAVx5       ─────▶ │   • /.well-known/carddav → 301 /dav/                 │
  Browser     ─────▶ │   • /admin/*  → static assets (ASSETS binding)       │
                     │   • everything else → Durable Object stub            │
                     └───────────────┬──────────────────────────────────────┘
                                     │ fetch()
                     ┌───────────────▼──────────────────────────────────────┐
                     │  FlareCardDO (src/do.ts) — ONE instance ("main")     │
                     │   Hono app (src/app.ts)                              │
                     │    ├─ /dav/**   CardDAV: PROPFIND/REPORT/GET/HEAD    │
                     │    └─ /api/**   Admin JSON API (session cookie)      │
                     │   Storage interface (src/storage/types.ts)           │
                     │    └─ SqliteStorage over ctx.storage.sql             │
                     │        users · contacts · tombstones · settings      │
                     └──────────────────────────────────────────────────────┘
```

| Area | Files |
| --- | --- |
| Worker entry, static assets, DO forwarding | `src/index.ts`, `src/do.ts`, `src/env.ts` |
| HTTP app (runtime-neutral, testable with in-memory storage) | `src/app.ts`, `src/api.ts` |
| CardDAV | `src/dav/paths.ts` (URL layout), `props.ts` (live properties), `handler.ts` (PROPFIND/GET/403s), `report.ts` (multiget, query, sync-collection) |
| Storage boundary | `src/storage/types.ts` (interface), `sqlite.ts` (Durable Object SQLite), `memory.ts` (tests) |
| Libraries | `src/lib/vcard.ts` (parse/serialize vCard 3.0), `xml.ts` (namespace-aware parser + writer), `crypto.ts` (PBKDF2, HMAC), `auth.ts` (Basic + sessions), `csv.ts`, `mobileconfig.ts`, `demo.ts` |
| Admin UI | `ui/` (React 19, Vite, Tailwind v4, shadcn/ui-style components, TanStack Query) |
| Runtime configs | `wrangler.jsonc` (Cloudflare), `workerd.capnp` (self-hosted) |
| External ACME runner | `scripts/acme-runner.ts` (CLI), `scripts/lib/renew.ts` (flow, tested), `.github/workflows/renew-signing-cert.yml` |

### Data model (inside the Durable Object)

| Table | Columns |
| --- | --- |
| `users` | `id`, `username` (unique, case-insensitive), `role` (`admin`/`user`), `disabled`, `password_hash` (PBKDF2-SHA256, 100k iterations, Web Crypto), `created_at` |
| `contacts` | `uid`, `vcard` (normalized vCard 3.0 text), `etag` (SHA-256 of the text), `seq` (global change sequence), `updated_at`, `display_name`, `search_text` |
| `tombstones` | `uid`, `seq`, `deleted_at` — feed `sync-collection` deletions |
| `settings` | key/value: `seq` counter, address book name/description, generated session secret |

`seq` is a single monotonically increasing counter. Every create/update/delete bumps it and it
drives both `getctag` (`flarecard-<seq>`) and the RFC 6578 `sync-token`
(`urn:x-flarecard:sync:<seq>`).

### Why a single Durable Object?

All CardDAV traffic for one address book funnels through one object, which gives strongly
consistent ETags, ctags and sync tokens with zero coordination. The SQLite backend handles a few
thousand contacts and a couple hundred users trivially, and the same `ctx.storage.sql` API exists
in workerd with `localDisk` storage. The `Storage` interface keeps the door open for another
backend later.

---

## CardDAV surface

Implements the parts of RFC 6352 (CardDAV), RFC 4918 (WebDAV), RFC 6578 (sync-collection) and
RFC 3744 (ACL properties) that Apple Contacts and DAVx5 use.

| Path | Resource |
| --- | --- |
| `/.well-known/carddav` | `301` → `/dav/` |
| `/dav/` | Root; `current-user-principal` |
| `/dav/principals/<username>/` | Principal: `principal-URL`, `addressbook-home-set`, `displayname`, `current-user-privilege-set` |
| `/dav/addressbooks/` | Address book home (identical for all users) |
| `/dav/addressbooks/shared/` | **The** shared address book: `resourcetype`, `displayname`, `getctag`, `sync-token`, `supported-report-set`, `supported-address-data`, `addressbook-description`, `max-resource-size`, `owner`, `current-user-privilege-set` |
| `/dav/addressbooks/shared/<uid>.vcf` | Contact: `getetag`, `getcontenttype`, `getcontentlength`, `getlastmodified`, `address-data` |

- `OPTIONS` → `DAV: 1, 3, addressbook`, `Allow: OPTIONS, GET, HEAD, PROPFIND, REPORT`
- `PROPFIND` with `Depth: 0` / `1` (`infinity` → `403 propfind-finite-depth`); `allprop`,
  `propname` and unknown properties (`404` propstat) handled.
- `REPORT`: `addressbook-multiget`, `addressbook-query` (prop-filter with `text-match`
  equals/contains/starts-with/ends-with, `negate-condition`, `is-not-defined`, `param-filter`,
  `anyof`/`allof`, `limit`), `sync-collection` (tombstones, `limit` with intermediate tokens,
  **`507` + `valid-sync-token` for unknown/foreign tokens**).
- `GET`/`HEAD` return `text/vcard; charset=utf-8`, `ETag`, `Last-Modified`; `If-None-Match` → `304`.
- `PUT`, `DELETE`, `PROPPATCH`, `MKCOL`, `MOVE`, `COPY`, `LOCK`, `UNLOCK`, `POST`, `ACL` → `403`
  with a `DAV:need-privileges` body, for every user including admins.
- Auth: HTTP Basic (`WWW-Authenticate: Basic realm="FlareCard"`); missing/invalid credentials and
  disabled users get `401`. Verified credentials are cached in memory for five minutes so PBKDF2
  is not re-run per request.
- Privileges: users get `read` + `read-current-user-privilege-set`; admins additionally
  advertise `write*`/`bind`/`unbind` (writes are still rejected — edits happen in the admin UI).
- Output is deliberately conservative for Apple clients: fixed `D:`/`C:`/`CS:` prefixes with
  exact namespace URIs, path-only `href`s, `HTTP/1.1 200 OK` status lines, vCard **3.0** with
  CRLF, 75-octet folding and `PHOTO;ENCODING=b;TYPE=JPEG` inline photos.

---

## Develop on Cloudflare

Requirements: Node 20+ and npm.

```bash
npm install
cp .dev.vars.example .dev.vars        # set ADMIN_BOOTSTRAP_PASSWORD
npm run dev                           # builds the UI, then wrangler dev on http://127.0.0.1:47321
```

- Admin UI: <http://127.0.0.1:47321/admin/> — sign in as `admin` with the bootstrap password.
- The first request creates the initial admin from `ADMIN_BOOTSTRAP_PASSWORD` if **no users
  exist** (username from `ADMIN_BOOTSTRAP_USERNAME`, default `admin`). Afterwards the secret is
  ignored; remove it if you like.
- Load demo contacts with the **Load demo contacts** button, or
  `npm run seed` (uses `BASE`, `ADMIN_USER`, `ADMIN_PASS` env vars).
- UI hot reload: run `npm run dev:ui` in a second terminal (Vite on `:47322`, proxies `/api` to
  wrangler).

Environment / secrets:

| Name | Purpose |
| --- | --- |
| `ADMIN_BOOTSTRAP_PASSWORD` | Secret. Creates the first admin when the user table is empty. |
| `ADMIN_BOOTSTRAP_USERNAME` | Var. Username for that admin (default `admin`). |
| `SESSION_SECRET` | Secret, optional. HMAC key for admin session cookies. If unset, a random key is generated once and stored in `settings`. |
| `PUBLIC_HOST` | Var, optional. Hostname (and port) placed into `.mobileconfig` profiles and the setup page. Defaults to the request `Host` header. |
| `AUTH_RATE_LIMIT_IP` | Var, optional (default `60`). Failed auth attempts allowed per client IP per window before `429`. `0` disables. |
| `AUTH_RATE_LIMIT_USER` | Var, optional (default `15`). Failed auth attempts allowed per username per window before `429`. `0` disables. |
| `AUTH_RATE_LIMIT_WINDOW_SECONDS` | Var, optional (default `600`). Rate-limit window; a successful login resets the counters. |
| `ACME_DIRECTORY_URL` | Var, optional. ACME directory for the in-Worker profile-signing client (workerd only; default: Let's Encrypt production; use the staging URL while testing). On Cloudflare the external ACME runner has its own `ACME_DIRECTORY_URL` environment variable. |
| `PROFILE_SIGNING_KEY` / `PROFILE_SIGNING_CERT` | Secrets, optional. Your own PEM key and certificate chain for signing profiles; takes precedence over the automatic certificate. |
| `SIGNING_CERTS` | Binding, optional (workerd). `disk` service with `privkey.pem`+`fullchain.pem` or `<host>.key`+`<host>.crt`, e.g. your Caddy/certbot directory. |

Rate limiting is built in and runtime-neutral: it lives in memory inside the single Durable
Object, counts only failed Basic-auth and admin-login attempts (so correctly configured devices are
never throttled), and answers `429 Too Many Requests` with `Retry-After`. Behind a reverse proxy
the client IP is taken from `CF-Connecting-IP`, then `X-Forwarded-For`, then `X-Real-IP`.

## Deploy to Cloudflare

```bash
npx wrangler login
npx wrangler secret put ADMIN_BOOTSTRAP_PASSWORD
npm run deploy                        # builds the UI and runs wrangler deploy
```

The `migrations` block in `wrangler.jsonc` declares `FlareCardDO` as a SQLite-backed class.
Attach a custom domain (Workers → Settings → Domains) so devices talk to something like
`contacts.example.com`.

**No terminal?** Fork this repository and deploy it entirely from the Cloudflare dashboard
(Workers & Pages → Create → Import a repository, build command `npm run build:ui`, deploy command
`npx wrangler deploy`, then add the `ADMIN_BOOTSTRAP_PASSWORD` secret). Every push to `main`
redeploys automatically. Step-by-step: [section 8 of the manual](docs/deploy-cloudflare.md#8-deploying-from-the-cloudflare-dashboard-no-cli).

**Full step-by-step manual** — account setup, secrets, custom domain, first login, user
onboarding, CI/CD, monitoring, backups, hardening, costs and troubleshooting:
[`docs/deploy-cloudflare.md`](docs/deploy-cloudflare.md).

---

## Self-host on workerd

The exact same bundle runs on open-source workerd. `workerd.capnp` configures:

- the Worker module (`dist/worker/index.js`), compatibility date matching `wrangler.jsonc`;
- a SQLite-enabled Durable Object namespace with **`localDisk`** storage under `./data`;
- a read-only `disk` service for the built admin UI bound as `ASSETS`;
- config/secrets pulled from the process environment (`fromEnvironment`);
- an `internet` network service so the Worker can talk to Let's Encrypt when automatic profile
  signing is enabled (remove it if you never use that feature), and a commented-out
  `signing-certs` disk service for reusing the proxy's certificate (see [Signed profiles](#signed-profiles)).

```bash
npm install
npm run build                 # ui/dist + dist/worker/index.js (wrangler deploy --dry-run --outdir)

export ADMIN_BOOTSTRAP_PASSWORD='choose-a-strong-password'
export ADMIN_BOOTSTRAP_USERNAME=admin
export SESSION_SECRET="$(openssl rand -base64 32)"   # optional but recommended
export PUBLIC_HOST=contacts.example.com              # what devices will connect to
mkdir -p data
workerd serve workerd.capnp   # listens on 127.0.0.1:8080 (plain HTTP)
```

`workerd` binaries: `npm i -g workerd`, the `workerd` npm package already in `node_modules/.bin`,
or the GitHub releases. Run it under systemd or in a container; a minimal unit:

```ini
[Unit]
Description=FlareCard CardDAV
After=network.target

[Service]
WorkingDirectory=/opt/flarecard
EnvironmentFile=/etc/flarecard.env
ExecStart=/usr/local/bin/workerd serve workerd.capnp
Restart=always
User=flarecard

[Install]
WantedBy=multi-user.target
```

### Reverse proxy with TLS

Basic auth must only ever cross the wire inside TLS, and Apple devices refuse plain-HTTP CardDAV
in practice. Terminate TLS in front of workerd and forward `Host` so profiles and discovery use
the public name.

**Caddy** (`Caddyfile`, automatic Let's Encrypt):

```caddyfile
contacts.example.com {
    reverse_proxy 127.0.0.1:8080 {
        header_up X-Forwarded-Proto https
    }
    # Optional hardening
    header {
        Strict-Transport-Security "max-age=31536000"
        -Server
    }
}
```

**nginx**:

```nginx
server {
    listen 443 ssl http2;
    server_name contacts.example.com;

    ssl_certificate     /etc/letsencrypt/live/contacts.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/contacts.example.com/privkey.pem;

    client_max_body_size 32m;   # admin imports (.vcf / CSV)

    location / {
        proxy_pass         http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-Proto https;
        proxy_set_header   X-Forwarded-For $remote_addr;
        # WebDAV verbs (PROPFIND/REPORT) pass through nginx untouched.
    }
}
server {
    listen 80;
    server_name contacts.example.com;
    return 301 https://$host$request_uri;
}
```

Set `PUBLIC_HOST=contacts.example.com` so the generated `.mobileconfig` profiles use the public
hostname and port 443 regardless of how the proxy forwards.

If you enable **automatic profile signing**, Let's Encrypt fetches
`http://contacts.example.com/.well-known/acme-challenge/<token>` and FlareCard must answer it.
Both configurations above already work: the port-80 redirect to HTTPS is followed by Let's Encrypt
and the HTTPS server proxies the path to workerd. Only if something else owns
`/.well-known/acme-challenge/` on port 80 (certbot `--webroot`, Caddy's own challenge handler is
fine) do you need to forward that path explicitly, or skip ACME in FlareCard and reuse the proxy's
certificate through the `SIGNING_CERTS` binding instead.

### Backups

All state lives in the Durable Object storage directory configured in `workerd.capnp`
(`./data` by default). Inside it workerd keeps one subdirectory per DO namespace
(`data/flarecard-main-v1/`) containing `metadata.sqlite` plus one `<id>.sqlite` file per object —
FlareCard has exactly one object, so you will see one data file (with `-wal`/`-shm` companions
while running).

Two safe approaches:

1. **Stop, copy, start** — simplest and always consistent:

   ```bash
   systemctl stop flarecard
   tar -C /opt/flarecard -czf /backups/flarecard-$(date +%F).tar.gz data
   systemctl start flarecard
   ```

2. **Online snapshot with the SQLite CLI** (no downtime; uses the backup API so WAL contents are
   included):

   ```bash
   for db in /opt/flarecard/data/flarecard-main-v1/*.sqlite; do
     sqlite3 "$db" ".backup '/backups/$(basename "$db" .sqlite)-$(date +%F).sqlite'"
   done
   ```

   Restore by stopping workerd, replacing the files (delete stale `-wal`/`-shm`), and starting it
   again. Keep the directory name (`flarecard-main-v1`) — it is derived from the `uniqueKey` in
   `workerd.capnp`, and changing that key would point workerd at an empty database.

Also keep a copy of the export produced by **Contacts → Export .vcf** in the admin UI; it is a
plain vCard file you can re-import anywhere.

On Cloudflare, Durable Object storage is replicated by the platform; use the `.vcf` export for
logical backups.

---

## Admin UI

Served at `/admin/` by the same Worker; only users with the `admin` role can sign in (HTTP-only,
`SameSite=Lax` session cookie, CSRF checks on mutations). Regular users never see it — they only
have CardDAV credentials.

- **Contacts** — search (name, organization, email, phone), paginated list, create/edit/delete
  with the common vCard fields (name parts, nickname, organization/department, title, phones,
  emails, postal addresses, websites, birthday, notes, photo). Photos are downscaled to 512px
  JPEG in the browser and capped at 512 KB server-side. Bulk **import** from `.vcf` (2.1/3.0/4.0)
  or CSV (Google/Outlook/generic headers), **export** everything as one `.vcf`, and a
  **Load demo contacts** button.
- **Users** — create (an app password is generated and shown **once**), enable/disable, change
  role, reset app password, delete, and **Download iOS/macOS profile** (`.mobileconfig` with a
  `com.apple.carddav.account` payload prefilled with host, username and principal URL).
- **Device setup** — server URLs to copy, step-by-step instructions for iOS/macOS and DAVx5, the
  address book display name/description, the **lock marker** switch, the **forced re-sync**
  schedule and the **profile signing** card (see below).
- Empty, loading and error states are covered; the layout collapses to a single column with a
  menu on phones.

Scripts and other tooling can use the same `/api/*` endpoints with **Basic auth as an admin**.

### Lock marker on devices

Phones and Macs have no way to show that a contact is read-only. FlareCard therefore appends
**🔒** to the displayed name of every card it serves over CardDAV: `FN:Ada Lovelace 🔒` and the
family name in `N` (or the given name if there is no family name; company cards without a personal
name get it on `ORG`). The marker exists **only in the sync output**: stored vCards, the admin UI,
search and `.vcf` export are unchanged. The ETag of a served card is the hash of what is actually
sent, so conditional requests keep working.

The switch lives under **Device setup → Lock marker on devices** (default on). Toggling it re-stamps
every contact with a fresh change sequence, so ctag and sync-token move and every device
re-downloads the address book on its next sync.

### Forced re-sync (scheduled push)

CardDAV is pull-only: a device downloads only the cards whose ETag changed since its last
sync-token. If someone deletes or edits a contact on their phone, the server rejects the change
(`403`), but the local copy is only repaired once the client decides to re-fetch that card. A
**forced re-sync** removes the waiting: it gives **every** contact a new revision — `REV` is set to
the run time, which changes the vCard body and therefore its ETag, and each card gets a fresh
change sequence. On their next sync all devices see every contact as modified and download the
whole address book again, restoring anything that was changed locally.

**Device setup → Forced re-sync** offers:

- **Force re-sync now** — one click, runs immediately and shows how many contacts were re-stamped.
- A **schedule**: *Off*, *Every N hours* (1–168, counted from the previous run), *Daily at HH:MM*
  or *Weekly on a weekday at HH:MM*, each in an IANA time zone (`Europe/Berlin`, `America/New_York`,
  …). Daylight-saving transitions are handled; the card shows the last and the next run.

FlareCard deliberately uses no cron triggers or alarms (see [Architecture](#architecture)), so the
schedule is evaluated **lazily**: every incoming request — a phone syncing, DAVx5 polling, an admin
opening the UI — first checks whether a run is due and performs it before the request is served.
With 200 devices syncing, the first sync after the scheduled time triggers the run and already
receives the new revisions. Missed occurrences (no traffic for days) collapse into a single run
and the schedule continues from the actual run time. The same endpoints are available to scripts:

```bash
curl -u admin:… https://contacts.example.com/api/resync                       # status
curl -u admin:… -X POST https://contacts.example.com/api/resync/run           # run now
curl -u admin:… -X PUT -H 'Content-Type: application/json' \
  -d '{"mode":"daily","time":"03:00","timeZone":"Europe/Berlin"}' \
  https://contacts.example.com/api/resync                                     # schedule
```

A run rewrites `REV` in the stored vCards (and moves `updatedAt`); names, numbers and every other
property are untouched. Pick a quiet time: each run makes every device download the full address
book once (a few thousand small cards per device).

### Signed profiles

An unsigned `.mobileconfig` installs fine but iOS/macOS label it **"Not Signed"** in red. FlareCard
can wrap every downloaded profile in a CMS/PKCS#7 `SignedData` envelope (what
`openssl smime -sign -nodetach` produces) so devices show **"Verified"** and the signer's name.
Three ways to get a certificate, in order of precedence:

1. **Your own PEM material** — `PROFILE_SIGNING_KEY` + `PROFILE_SIGNING_CERT` secrets (leaf first,
   then intermediates). RSA and ECDSA (P-256/P-384) keys in PKCS#8, PKCS#1 or SEC1 PEM are accepted.
2. **The reverse proxy's certificate** (workerd only) — bind a `disk` service as `SIGNING_CERTS`
   pointing at the directory Caddy or certbot maintains; FlareCard reads the current key and chain on
   each download, so renewals are picked up automatically.
3. **Automatic (self-hosted workerd)** — **Device setup → Profile signing → Sign profiles
   automatically**. FlareCard is its own ACME client: it generates an RSA key, orders a certificate
   for `PUBLIC_HOST` from Let's Encrypt, answers the `http-01` challenge on
   `/.well-known/acme-challenge/` itself, stores key, chain and account in the Durable Object and
   signs with the result. Renewal is lazy: whenever an admin request or profile download finds the
   certificate within 30 days (or a third of its lifetime) of expiry, a renewal runs in the
   background while the still-valid certificate keeps signing. No cron triggers, alarms, DNS API
   tokens or extra Cloudflare products are involved.
4. **Automatic via the external ACME runner (Cloudflare Workers)** — see below. Same key handling
   and the same challenge route, but the conversation with Let's Encrypt happens in a scheduled
   GitHub Actions job (or any cron host) instead of inside the Worker.

Requirements for the automatic modes: `PUBLIC_HOST` (or the host you open the admin UI with) must be a
public DNS name that reaches FlareCard over HTTP/HTTPS. Any publicly trusted certificate works for
profile signing; iOS shows the certificate's common name under "Signed by". Failures (host not
reachable, rate limits) are shown on the card and retried with backoff; profiles fall back to
unsigned until a certificate exists. Set `ACME_DIRECTORY_URL` to the Let's Encrypt staging directory
to rehearse without hitting production rate limits (staging certificates are not trusted by devices).

#### Cloudflare Workers and the 525 problem

Let's Encrypt's API is itself served through Cloudflare. A Worker that `fetch()`es another
Cloudflare-fronted hostname ("orange-to-orange") cannot complete the TLS handshake and gets
**HTTP 525** — a long-standing platform limitation that no DNS or SSL setting fixes (`wrangler dev`
is unaffected, which is why it only shows up after deploying). FlareCard recognises the 525 and
explains it on the signing card. The in-Worker client therefore only works on self-hosted workerd;
on Cloudflare use the **external ACME runner**:

- FlareCard keeps the certificate key inside the Durable Object and hands out a **CSR**
  (`POST /api/signing/csr`).
- The runner (`npm run acme:renew`, `scripts/acme-runner.ts`) talks to Let's Encrypt, registers the
  http-01 answer with FlareCard (`PUT /api/signing/challenge`) — FlareCard serves it on
  `/.well-known/acme-challenge/`, which Let's Encrypt reaches without any 525 issue — and uploads the
  issued chain (`PUT /api/signing/certificate`). FlareCard verifies that the chain matches its key and
  hostname, installs it and marks the certificate as *managed by the runner*, which switches the
  in-Worker client off.
- The runner renews only when fewer than 30 days remain (`RENEW_BEFORE_DAYS`), so it can run daily.
  `--force` renews regardless; `--staging` uses the Let's Encrypt staging directory.

The repository ships the workflow [`.github/workflows/renew-signing-cert.yml`](.github/workflows/renew-signing-cert.yml).
In your fork set the Actions **variable** `FLARECARD_URL` (e.g. `https://contacts.example.com`,
optionally `ACME_EMAIL`) and the **secrets** `FLARECARD_ADMIN_USER` / `FLARECARD_ADMIN_PASSWORD`
(a FlareCard admin — create a dedicated one). The job is skipped until `FLARECARD_URL` exists, runs
daily and can be started by hand under *Actions → Renew profile-signing certificate → Run workflow*.
No Cloudflare API token is involved, and the private key never leaves FlareCard. Optional secret
`ACME_ACCOUNT_KEY` (JSON `{privateJwk, publicJwk}`) pins one ACME account; otherwise each renewal
registers a fresh one, which is fine at Let's Encrypt's rate limits for a run every ~60 days.

The same command works from any machine with Node 22 and network access:

```bash
FLARECARD_URL=https://contacts.example.com FLARECARD_ADMIN_USER=admin FLARECARD_ADMIN_PASSWORD=… \
ACME_EMAIL=it@example.com npm run acme:renew            # add -- --force to renew now
```

Verify a downloaded profile yourself:

```bash
openssl cms -verify -inform DER -in flarecard-jane.mobileconfig -purpose any \
  -CAfile <(curl -s https://letsencrypt.org/certs/isrgrootx1.pem)     # prints the plist on success
```

---

## Client setup

Every person needs their own **username + app password** (Users page). Replace
`contacts.example.com` with your host.

### iOS / iPadOS

- **Profile (recommended):** download the user's `.mobileconfig` from the Users page and send it
  to them. Open it on the device → *Settings → Profile Downloaded → Install* → enter the app
  password when prompted.
- **Manual:** *Settings → Apps → Contacts → Contacts Accounts → Add Account → Other → Add CardDAV
  Account*. Server `contacts.example.com`, username, app password. iOS discovers the address book
  via `/.well-known/carddav`.

### macOS

- **Profile:** double-click the `.mobileconfig`, then *System Settings → Privacy & Security →
  Profiles → Install*.
- **Manual:** *Contacts → Settings → Accounts → + → Other Contacts Account… → CardDAV*, account
  type *Manual*, server `contacts.example.com`, username, app password.

### Android (DAVx5)

1. Install DAVx5 (Play Store or F-Droid) and tap **+**.
2. Choose **Login with URL and user name**; base URL `https://contacts.example.com/dav/`,
   username and app password.
3. **Create account**, then enable the address book under **CardDAV** and pick a sync interval.
4. Grant the Contacts permission. Contacts appear in the stock Contacts app under the DAVx5
   account. Exclude DAVx5 from battery optimisation if syncs lag.

---

## Testing

```bash
npm test          # Vitest: auth, vCard, ETag/ctag/sync-token, PROPFIND/REPORT XML, 403s, re-sync schedule, signing
npm run typecheck # worker + UI
npm run dav:smoke # curl walkthrough against a running server (BASE, USER_NAME, PASS env vars; SEED=1 to seed)
```

Tests run the Hono app directly against the in-memory `Storage` implementation, so they need no
Cloudflare tooling and finish in a few seconds. The signing tests include an in-process ACME server
and, when `openssl` is on the `PATH`, verify every produced CMS blob with `openssl cms -verify`.

An end-to-end run against [Pebble](https://github.com/letsencrypt/pebble), Let's Encrypt's test CA,
is skipped unless you point it at a running instance:

```bash
go install github.com/letsencrypt/pebble/v2/cmd/{pebble,pebble-challtestsrv}@latest
pebble-challtestsrv -dnsserver 127.0.0.1:8053 -doh "" -http01 "" -https01 "" -tlsalpn01 "" -defaultIPv4 127.0.0.1 -defaultIPv6 "" &
PEBBLE_VA_NOSLEEP=1 pebble -config pebble.json -dnsserver 127.0.0.1:8053 -strict &   # httpPort 5002
PEBBLE_DIRECTORY=https://127.0.0.1:14000/dir PEBBLE_HTTP_PORT=5002 npx vitest run test/pebble.test.ts
```

---

## Known limitations

- **Read-only is enforced server-side.** iOS/macOS Contacts and DAVx5 do not reliably honour
  `current-user-privilege-set`, so a user *can* edit or delete a contact locally. The device's
  `PUT`/`DELETE` is rejected with `403`; the change shows a sync error and is **reverted on the
  next sync**. There is no way to grey out the edit button on the device; the 🔒 lock marker in
  names is the visible hint that a contact is managed centrally, and a
  [forced re-sync](#forced-re-sync-scheduled-push) (manual or scheduled) repairs all devices
  without waiting for them.
- Unknown or foreign `sync-token`s return **`507`** (with a `DAV:valid-sync-token` error body).
  Clients handle this by starting a fresh sync with an empty token.
- Contacts are normalized to a fixed set of vCard 3.0 properties on import; exotic or `X-`
  properties from other systems are not preserved.
- Group support (`X-ADDRESSBOOKSERVER-KIND:group`) is not implemented.
- Partial `address-data` retrieval (`C:prop` inside `address-data`) returns the full card.
- Auth rate-limit counters are kept in memory inside the Durable Object: they reset on deploy or
  when the object is evicted after idling. That is adequate for brute-force protection but is not
  a persistent lockout; add an edge/WAF rule if you need one.
