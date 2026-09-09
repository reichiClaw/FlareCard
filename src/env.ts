import type { AppEnv } from "./app";

/** Bindings shared by wrangler.jsonc (Cloudflare) and workerd.capnp (self-hosted). */
export interface Env extends AppEnv {
  FLARECARD: DurableObjectNamespace;
  /**
   * Static admin UI files. On Cloudflare this is the Workers Static Assets binding;
   * on workerd it is a `disk` service. Both are plain Fetchers.
   */
  ASSETS: Fetcher;
}
