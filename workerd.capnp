# workerd configuration for self-hosting FlareCard on open-source workerd.
#
#   npm run build            # bundles the Worker to dist/worker/index.js and the UI to ui/dist
#   workerd serve workerd.capnp
#
# Durable Object state (users, contacts, tombstones, settings) is persisted as SQLite
# files under ./data — back that directory up. Put a TLS-terminating reverse proxy
# (Caddy/nginx) in front of the plain-HTTP socket below; see README.md.

using Workerd = import "/workerd/workerd.capnp";

const config :Workerd.Config = (
  services = [
    (name = "flarecard", worker = .flarecard),
    # Built admin UI, served through the ASSETS binding (read-only).
    (name = "assets", disk = (path = "ui/dist")),
    # SQLite files for the Durable Object live here (writable).
    (name = "do-storage", disk = (path = "data", writable = true)),
    # Outbound internet access, needed only for automatic profile-signing certificates
    # (ACME requests to Let's Encrypt). Remove if you never enable that feature.
    (name = "internet", network = (allow = ["public"])),
    # Optional: reuse the certificate your reverse proxy already maintains for signing
    # profiles. Point this at the directory holding privkey.pem + fullchain.pem (certbot)
    # or <host>.key + <host>.crt (Caddy) and uncomment the SIGNING_CERTS binding below.
    # (name = "signing-certs", disk = (path = "/etc/letsencrypt/live/contacts.example.com")),
  ],

  sockets = [
    (name = "http", address = "127.0.0.1:8080", http = (), service = "flarecard"),
  ],
);

const flarecard :Workerd.Worker = (
  modules = [
    (name = "index.js", esModule = embed "dist/worker/index.js"),
  ],
  compatibilityDate = "2025-09-01",

  durableObjectNamespaces = [
    (className = "FlareCardDO", uniqueKey = "flarecard-main-v1", enableSql = true),
  ],
  durableObjectStorage = (localDisk = "do-storage"),

  bindings = [
    (name = "FLARECARD", durableObjectNamespace = "FlareCardDO"),
    (name = "ASSETS", service = "assets"),
    # Secrets / config come from the process environment.
    (name = "ADMIN_BOOTSTRAP_PASSWORD", fromEnvironment = "ADMIN_BOOTSTRAP_PASSWORD"),
    (name = "ADMIN_BOOTSTRAP_USERNAME", fromEnvironment = "ADMIN_BOOTSTRAP_USERNAME"),
    (name = "SESSION_SECRET", fromEnvironment = "SESSION_SECRET"),
    (name = "PUBLIC_HOST", fromEnvironment = "PUBLIC_HOST"),
    # Optional auth rate-limit tuning (defaults: 60 per IP, 15 per user, 600 s window).
    (name = "AUTH_RATE_LIMIT_IP", fromEnvironment = "AUTH_RATE_LIMIT_IP"),
    (name = "AUTH_RATE_LIMIT_USER", fromEnvironment = "AUTH_RATE_LIMIT_USER"),
    (name = "AUTH_RATE_LIMIT_WINDOW_SECONDS", fromEnvironment = "AUTH_RATE_LIMIT_WINDOW_SECONDS"),
    # Profile signing. Either let FlareCard obtain an ACME certificate itself (admin UI
    # switch; ACME_DIRECTORY_URL defaults to ZeroSSL, which needs the two EAB values; on
    # workerd you may instead export ACME_DIRECTORY_URL=https://acme-v02.api.letsencrypt.org/directory
    # for Let's Encrypt without EAB), provide PEM material through the environment, or mount
    # the proxy's certificate directory via the SIGNING_CERTS disk service above.
    (name = "ACME_DIRECTORY_URL", fromEnvironment = "ACME_DIRECTORY_URL"),
    (name = "ACME_EAB_KID", fromEnvironment = "ACME_EAB_KID"),
    (name = "ACME_EAB_HMAC_KEY", fromEnvironment = "ACME_EAB_HMAC_KEY"),
    (name = "PROFILE_SIGNING_KEY", fromEnvironment = "PROFILE_SIGNING_KEY"),
    (name = "PROFILE_SIGNING_CERT", fromEnvironment = "PROFILE_SIGNING_CERT"),
    # (name = "SIGNING_CERTS", service = "signing-certs"),
  ],
);
