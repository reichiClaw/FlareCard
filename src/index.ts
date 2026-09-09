import type { Env } from "./env";
import { DAV_ROOT } from "./dav/paths";

export { FlareCardDO } from "./do";

const ADMIN_PREFIX = "/admin";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json",
};

function contentTypeFor(path: string): string | undefined {
  const idx = path.lastIndexOf(".");
  return idx >= 0 ? MIME[path.slice(idx).toLowerCase()] : undefined;
}

/**
 * Serves the Vite-built admin UI (base path /admin/). Works with both the
 * Cloudflare assets binding and a workerd `disk` service: we strip the /admin
 * prefix, try the exact file, and fall back to index.html for SPA routes.
 */
async function serveAdminAsset(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response("Method Not Allowed", { status: 405, headers: { Allow: "GET, HEAD" } });
  }
  if (url.pathname === ADMIN_PREFIX) return Response.redirect(new URL(`${ADMIN_PREFIX}/`, url).toString(), 301);

  let assetPath = url.pathname.slice(ADMIN_PREFIX.length) || "/";
  const looksLikeFile = /\.[a-zA-Z0-9]+$/.test(assetPath);
  if (!looksLikeFile) assetPath = "/index.html";

  const fetchAsset = async (path: string) => {
    const res = await env.ASSETS.fetch(new Request(new URL(path, url.origin).toString(), { method: "GET" }));
    return res;
  };

  let res = await fetchAsset(assetPath);
  if (res.status === 404 && looksLikeFile) {
    return new Response("Not Found", { status: 404 });
  }
  if (res.status === 404) res = await fetchAsset("/index.html");
  if (!res.ok) {
    return new Response("Admin UI is not built. Run `npm run build:ui`.", {
      status: 503,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }

  const headers = new Headers(res.headers);
  const servedPath = res.status === 404 ? "/index.html" : assetPath;
  const ct = contentTypeFor(servedPath);
  if (ct && (!headers.get("content-type") || headers.get("content-type")?.startsWith("application/octet-stream"))) {
    headers.set("Content-Type", ct);
  }
  headers.set(
    "Cache-Control",
    servedPath.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "no-cache",
  );
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("X-Frame-Options", "DENY");
  headers.set("Referrer-Policy", "same-origin");
  return new Response(request.method === "HEAD" ? null : res.body, { status: 200, headers });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/.well-known/carddav") {
      return new Response(null, { status: 301, headers: { Location: DAV_ROOT } });
    }
    if (path === ADMIN_PREFIX || path.startsWith(`${ADMIN_PREFIX}/`)) {
      return serveAdminAsset(request, env);
    }
    if (path === "/" && (request.method === "GET" || request.method === "HEAD")) {
      return Response.redirect(new URL(`${ADMIN_PREFIX}/`, url).toString(), 302);
    }

    // Everything else (CardDAV tree, admin API, root PROPFIND/OPTIONS) lives in the single DO.
    const stub = env.FLARECARD.get(env.FLARECARD.idFromName("main"));
    return stub.fetch(request);
  },
} satisfies ExportedHandler<Env>;
