import { DurableObject } from "cloudflare:workers";
import type { Hono } from "hono";
import { createApp } from "./app";
import { SqliteStorage } from "./storage/sqlite";
import type { Env } from "./env";

/**
 * The single Durable Object that owns all FlareCard state. The Worker forwards
 * every CardDAV and API request here; the Hono app runs inside the object so
 * SQLite access is local and strongly consistent.
 */
export class FlareCardDO extends DurableObject<Env> {
  private app: Hono;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    const storage = new SqliteStorage(ctx.storage.sql);
    storage.migrate();
    this.app = createApp({ storage, env, waitUntil: (p) => ctx.waitUntil(p) });
  }

  async fetch(request: Request): Promise<Response> {
    return this.app.fetch(request, this.env);
  }
}
