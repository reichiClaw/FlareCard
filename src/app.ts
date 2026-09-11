import { Hono } from "hono";
import type { Storage } from "./storage/types";
import { AuthService, type AuthEnv } from "./lib/auth";
import { ContactService } from "./lib/contacts";
import { DAV_ROOT } from "./dav/paths";
import { DAV_HEADER, handleDav, optionsResponse, unauthorized } from "./dav/handler";
import { loadDavSettings } from "./dav/context";
import { adminApi } from "./api";
import { AuthRateLimiter, type AuthRateLimitEnv, clientIp, tooManyRequests } from "./lib/ratelimit";
import { ProfileSigner, type SigningEnv } from "./lib/signing";
import type { FetchLike } from "./lib/acme";
import { ResyncScheduler } from "./lib/resync";

export interface AppEnv extends AuthEnv, AuthRateLimitEnv, SigningEnv {
  PUBLIC_HOST?: string;
}

export interface AppDeps {
  storage: Storage;
  env: AppEnv;
  /** Outbound fetch for the ACME client (injectable for tests). */
  fetch?: FetchLike;
  /** Keeps background work (certificate renewal) alive after the response is sent. */
  waitUntil?: (p: Promise<unknown>) => void;
  /** ACME poll interval override (tests). */
  acmePollIntervalMs?: number;
  /** Clock override for the re-sync schedule (tests). */
  now?: () => Date;
}

export interface Services {
  storage: Storage;
  auth: AuthService;
  contacts: ContactService;
  rateLimiter: AuthRateLimiter;
  signer: ProfileSigner;
  resync: ResyncScheduler;
  env: AppEnv;
  /** Schedules background work; falls back to fire-and-forget. */
  background: (p: Promise<unknown>) => void;
}

/**
 * Builds the runtime-neutral HTTP application: CardDAV surface + admin JSON API.
 * Static assets for the admin UI are served by the Worker entry, not here, so
 * this app can be exercised directly in tests with an in-memory Storage.
 */
export function createApp(deps: AppDeps): Hono {
  const contacts = new ContactService(deps.storage);
  const services: Services = {
    storage: deps.storage,
    env: deps.env,
    auth: new AuthService(deps.storage, deps.env),
    contacts,
    rateLimiter: new AuthRateLimiter(deps.env),
    signer: new ProfileSigner(deps.storage, deps.env, deps.fetch, undefined, deps.acmePollIntervalMs),
    resync: new ResyncScheduler(deps.storage, contacts, deps.now),
    background: (p) => {
      const guarded = p.catch((e) => console.error("Background task failed", e));
      if (deps.waitUntil) deps.waitUntil(guarded);
    },
  };
  const app = new Hono();
  let bootstrapped = false;

  app.use("*", async (_c, next) => {
    if (!bootstrapped) {
      await services.auth.ensureBootstrap();
      bootstrapped = await services.auth.isBootstrapped();
    }
    // Lazy scheduler: a due forced re-sync runs before the request is served so
    // the very client that triggered it already sees the new revisions.
    try {
      await services.resync.tick();
    } catch (e) {
      console.error("Scheduled re-sync failed", e);
    }
    await next();
  });

  app.all("/.well-known/carddav", (c) => {
    const target = new URL(DAV_ROOT, c.req.url);
    return new Response(null, { status: 301, headers: { Location: target.pathname } });
  });

  // ACME http-01 validation for the automatically managed profile-signing certificate.
  app.get("/.well-known/acme-challenge/:token", async (c) => {
    const answer = await services.signer.challengeResponse(c.req.param("token"));
    if (!answer) return c.text("Not Found", 404);
    return c.text(answer, 200, { "Content-Type": "text/plain", "Cache-Control": "no-store" });
  });

  const dav = async (c: { req: { raw: Request } }) => {
    const request = c.req.raw;
    if (request.method.toUpperCase() === "OPTIONS") return optionsResponse();
    const header = request.headers.get("authorization");
    const ip = clientIp(request);
    const username = services.auth.parseBasic(header)?.username ?? null;
    const limit = services.rateLimiter.check(ip, username);
    if (!limit.allowed) return tooManyRequests(limit, { DAV: DAV_HEADER });
    const result = await services.auth.authenticateBasic(header);
    if (!result.ok) {
      // Only attempts that carried credentials count; the initial unauthenticated probe does not.
      if (result.reason !== "missing") services.rateLimiter.recordFailure(ip, username);
      return unauthorized();
    }
    services.rateLimiter.recordSuccess(ip, result.user.username);
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
