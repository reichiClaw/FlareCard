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
  ],
);
