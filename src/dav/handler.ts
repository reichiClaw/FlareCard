import type { Contact } from "../storage/types";
import { NS_DAV, dav, davError, escapeXml, multistatus, parseXml, XmlParseError, type XmlNode } from "../lib/xml";
import { present, presentAll, type DavContext } from "./context";
import { ADDRESSBOOK_PATH, HOME_PATH, PRINCIPALS_PATH, principalHref, resolvePath, type Resource, vcardHref } from "./paths";
import { ALLPROP, parsePropRequest, propResponse } from "./props";
import { handleReport } from "./report";

export const DAV_HEADER = "1, 3, addressbook";
export const ALLOW_HEADER = "OPTIONS, GET, HEAD, PROPFIND, REPORT";
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const WRITE_METHODS = new Set([
  "PUT",
  "DELETE",
  "PROPPATCH",
  "MKCOL",
  "MKCALENDAR",
  "MOVE",
  "COPY",
  "LOCK",
  "UNLOCK",
  "POST",
  "PATCH",
  "ACL",
  "BIND",
  "UNBIND",
  "REBIND",
]);

const baseHeaders = (extra: Record<string, string> = {}) => ({
  DAV: DAV_HEADER,
  ...extra,
});

function xml(status: number, body: string, extra: Record<string, string> = {}): Response {
  return new Response(body, {
    status,
    headers: baseHeaders({ "Content-Type": "application/xml; charset=utf-8", ...extra }),
  });
}

export function unauthorized(): Response {
  return new Response("Authentication required", {
    status: 401,
    headers: baseHeaders({
      "WWW-Authenticate": 'Basic realm="FlareCard", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    }),
  });
}

export function optionsResponse(): Response {
  return new Response(null, {
    status: 200,
    headers: baseHeaders({ Allow: ALLOW_HEADER, "Content-Length": "0" }),
  });
}

function forbiddenWrite(href: string): Response {
  return xml(
    403,
    davError(
      dav(
        "need-privileges",
        dav("resource", dav("href", escapeXml(href)) + dav("privilege", dav("write"))),
      ),
    ),
    { Allow: ALLOW_HEADER },
  );
}

async function readXmlBody(request: Request): Promise<XmlNode | null | Response> {
  const len = Number(request.headers.get("content-length") ?? "0");
  if (len > MAX_BODY_BYTES) return new Response("Request body too large", { status: 413, headers: baseHeaders() });
  const text = await request.text();
  if (text.length > MAX_BODY_BYTES) return new Response("Request body too large", { status: 413, headers: baseHeaders() });
  if (!text.trim()) return null;
  try {
    return parseXml(text);
  } catch (e) {
    if (e instanceof XmlParseError) return new Response(`Malformed XML: ${e.message}`, { status: 400, headers: baseHeaders() });
    throw e;
  }
}

/** Dispatches an authenticated CardDAV request. `/.well-known` and auth are handled by the caller. */
export async function handleDav(request: Request, ctx: DavContext): Promise<Response> {
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const resource = resolvePath(url.pathname);

  if (method === "OPTIONS") return optionsResponse();
  if (!resource) return new Response("Not Found", { status: 404, headers: baseHeaders() });

  if (WRITE_METHODS.has(method)) {
    // Discard any body so the runtime does not complain about an unread request stream.
    if (request.body) await request.body.cancel().catch(() => undefined);
    return forbiddenWrite(resource.href);
  }

  // Principals are private: users may only inspect their own (admins see all).
  if (resource.kind === "principal" && resource.username.toLowerCase() !== ctx.user.username.toLowerCase()) {
    if (ctx.user.role !== "admin" || !(await ctx.storage.getUserByUsername(resource.username))) {
      return new Response("Not Found", { status: 404, headers: baseHeaders() });
    }
  }

  let contact: Contact | undefined;
  if (resource.kind === "vcard") {
    const stored = await ctx.storage.getContact(resource.uid);
    if (!stored) return new Response("Not Found", { status: 404, headers: baseHeaders() });
    contact = await present(ctx, stored);
  }

  switch (method) {
    case "GET":
    case "HEAD":
      return handleGet(request, resource, contact, ctx);
    case "PROPFIND":
      return handlePropfind(request, resource, contact, ctx);
    case "REPORT": {
      const body = await readXmlBody(request);
      if (body instanceof Response) return body;
      return handleReport(ctx, resource, body);
    }
    default:
      return new Response("Method Not Allowed", { status: 405, headers: baseHeaders({ Allow: ALLOW_HEADER }) });
  }
}

function handleGet(request: Request, resource: Resource, contact: Contact | undefined, ctx: DavContext): Response {
  const head = request.method.toUpperCase() === "HEAD";
  if (resource.kind === "vcard" && contact) {
    const ifNoneMatch = request.headers.get("if-none-match");
    if (ifNoneMatch && ifNoneMatch.split(",").some((t) => t.trim() === contact.etag || t.trim() === "*")) {
      return new Response(null, { status: 304, headers: baseHeaders({ ETag: contact.etag }) });
    }
    const bytes = new TextEncoder().encode(contact.vcard);
    return new Response(head ? null : bytes, {
      status: 200,
      headers: baseHeaders({
        ETag: contact.etag,
        "Content-Type": "text/vcard; charset=utf-8",
        "Content-Length": String(bytes.length),
        "Last-Modified": new Date(contact.updatedAt).toUTCString(),
        "Cache-Control": "private, no-cache",
      }),
    });
  }
  const label =
    resource.kind === "addressbook"
      ? `${ctx.settings.addressbookName} (CardDAV address book)`
      : `FlareCard CardDAV ${resource.kind} collection`;
  const body = `${label}\nUse a CardDAV client (iOS/macOS Contacts, DAVx5) to browse this collection.\n`;
  return new Response(head ? null : body, {
    status: 200,
    headers: baseHeaders({ "Content-Type": "text/plain; charset=utf-8", Allow: ALLOW_HEADER }),
  });
}

function parseDepth(request: Request): 0 | 1 | "infinity" {
  const raw = (request.headers.get("depth") ?? "0").trim().toLowerCase();
  if (raw === "1") return 1;
  if (raw === "infinity") return "infinity";
  return 0;
}

async function handlePropfind(
  request: Request,
  resource: Resource,
  contact: Contact | undefined,
  ctx: DavContext,
): Promise<Response> {
  const depth = parseDepth(request);
  if (depth === "infinity") {
    return xml(403, davError(dav("propfind-finite-depth")));
  }
  const body = await readXmlBody(request);
  if (body instanceof Response) return body;
  if (body && !(body.ns === NS_DAV && body.name === "propfind")) {
    return new Response("Expected DAV:propfind body", { status: 400, headers: baseHeaders() });
  }
  const propRequest = parsePropRequest(body, ALLPROP[resource.kind]);
  const responses: string[] = [await propResponse(ctx, resource, propRequest, contact)];

  if (depth === 1) {
    for (const child of await children(resource, ctx)) {
      const childRequest = propRequest.mode === "prop" ? propRequest : { ...propRequest, props: ALLPROP[child.resource.kind] };
      responses.push(await propResponse(ctx, child.resource, childRequest, child.contact));
    }
  }
  return xml(207, multistatus(responses));
}

async function children(resource: Resource, ctx: DavContext): Promise<{ resource: Resource; contact?: Contact }[]> {
  switch (resource.kind) {
    case "root":
      return [
        { resource: { kind: "principals", href: PRINCIPALS_PATH } },
        { resource: { kind: "home", href: HOME_PATH } },
      ];
    case "principals": {
      const users = ctx.user.role === "admin" ? await ctx.storage.listUsers() : [ctx.user];
      return users.map((u) => ({
        resource: { kind: "principal", href: principalHref(u.username), username: u.username },
      }));
    }
    case "home":
      return [{ resource: { kind: "addressbook", href: ADDRESSBOOK_PATH } }];
    case "addressbook": {
      const all = await presentAll(ctx, await ctx.storage.allContacts());
      return all.map((c) => ({ resource: { kind: "vcard", href: vcardHref(c.uid), uid: c.uid }, contact: c }));
    }
    default:
      return [];
  }
}
