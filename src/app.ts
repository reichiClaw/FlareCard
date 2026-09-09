import { Hono } from "hono";
import type { Storage } from "./storage/types";
import { AuthService, type AuthEnv } from "./lib/auth";
import { ContactService } from "./lib/contacts";
import { DAV_ROOT } from "./dav/paths";
import { handleDav, optionsResponse, unauthorized } from "./dav/handler";
import { loadDavSettings } from "./dav/context";
import { adminApi } from "./api";

export interface AppEnv extends AuthEnv {
  PUBLIC_HOST?: string;
}

export interface AppDeps {
  storage: Storage;
  env: AppEnv;
}

export interface Services {
  storage: Storage;
  auth: AuthService;
  contacts: ContactService;
  env: AppEnv;
}

/**
 * Builds the runtime-neutral HTTP application: CardDAV surface + admin JSON API.
 * Static assets for the admin UI are served by the Worker entry, not here, so
 * this app can be exercised directly in tests with an in-memory Storage.
 */
export function createApp(deps: AppDeps): Hono {
  const services: Services = {
    storage: deps.storage,
    env: deps.env,
    auth: new AuthService(deps.storage, deps.env),
    contacts: new ContactService(deps.storage),
  };
  const app = new Hono();
  let bootstrapped = false;

  app.use("*", async (_c, next) => {
    if (!bootstrapped) {
      await services.auth.ensureBootstrap();
      bootstrapped = await services.auth.isBootstrapped();
    }
    await next();
  });

  app.all("/.well-known/carddav", (c) => {
    const target = new URL(DAV_ROOT, c.req.url);
    return new Response(null, { status: 301, headers: { Location: target.pathname } });
  });

  const dav = async (c: { req: { raw: Request } }) => {
    const request = c.req.raw;
    if (request.method.toUpperCase() === "OPTIONS") return optionsResponse();
    const result = await services.auth.authenticateBasic(request.headers.get("authorization"));
    if (!result.ok) return unauthorized();
    return handleDav(request, {
      storage: services.storage,
      auth: services.auth,
      contacts: services.contacts,
      user: result.user,
      settings: await loadDavSettings(services.storage),
    });
  };
  app.all("/dav", dav);
  app.all("/dav/*", dav);
  // Some clients probe the server root before following .well-known.
  app.on(["PROPFIND", "OPTIONS"], "/", dav);

  app.get("/", (c) => c.redirect("/admin/"));
  app.get("/healthz", (c) => c.json({ ok: true }));

  app.route("/api", adminApi(services));

  app.notFound((c) => c.text("Not Found", 404));
  app.onError((err, c) => {
    console.error("Unhandled error", err);
    return c.json({ error: "Internal Server Error" }, 500);
  });
  return app;
}
