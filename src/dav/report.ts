import type { Contact } from "../storage/types";
import { parseSyncToken, syncTokenFor } from "../lib/contacts";
import { parseVCards, splitValue, type VProp } from "../lib/vcard";
import { NS_CARDDAV, NS_DAV, dav, davError, findChild, findChildren, multistatus, type XmlNode } from "../lib/xml";
import { presentAll, type DavContext } from "./context";
import { ADDRESSBOOK_PATH, type Resource, uidFromHref, vcardHref } from "./paths";
import { ALLPROP, parsePropRequest, propResponse, statusResponse } from "./props";

const XML_HEADERS = { "Content-Type": "application/xml; charset=utf-8" };

function xmlResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { ...XML_HEADERS, ...headers } });
}

const vcardResource = (uid: string): Resource => ({ kind: "vcard", href: vcardHref(uid), uid });

export async function handleReport(ctx: DavContext, resource: Resource, body: XmlNode | null): Promise<Response> {
  if (!body) return xmlResponse(400, davError(dav("supported-report")));
  if (resource.kind !== "addressbook") {
    return xmlResponse(403, davError(dav("supported-report")));
  }
  if (body.ns === NS_CARDDAV && body.name === "addressbook-multiget") return multiget(ctx, body);
  if (body.ns === NS_CARDDAV && body.name === "addressbook-query") return query(ctx, body);
  if (body.ns === NS_DAV && body.name === "sync-collection") return syncCollection(ctx, body);
  return xmlResponse(403, davError(dav("supported-report")));
}

async function multiget(ctx: DavContext, body: XmlNode): Promise<Response> {
  const request = parsePropRequest(body, ALLPROP.vcard);
  const hrefs = findChildren(body, NS_DAV, "href").map((h) => h.text.trim());
  const uids = hrefs.map(uidFromHref);
  const contacts = await presentAll(ctx, await ctx.storage.getContacts(uids.filter((u): u is string => !!u)));
  const byUid = new Map(contacts.map((c) => [c.uid, c]));
  const responses: string[] = [];
  for (let i = 0; i < hrefs.length; i++) {
    const uid = uids[i];
    const contact = uid ? byUid.get(uid) : undefined;
    if (!contact) {
      responses.push(statusResponse(hrefs[i], "HTTP/1.1 404 Not Found"));
      continue;
    }
    responses.push(await propResponse(ctx, vcardResource(contact.uid), request, contact));
  }
  return xmlResponse(207, multistatus(responses));
}

// ---------------------------------------------------------------------------
// addressbook-query filters (RFC 6352 §10.5)

type MatchType = "equals" | "contains" | "starts-with" | "ends-with";

interface TextMatch {
  value: string;
  matchType: MatchType;
  negate: boolean;
}

function parseTextMatch(node: XmlNode): TextMatch {
  const mt = (node.attrs["match-type"] ?? "contains") as MatchType;
  return {
    value: node.text,
    matchType: ["equals", "contains", "starts-with", "ends-with"].includes(mt) ? mt : "contains",
    negate: (node.attrs["negate-condition"] ?? "no").toLowerCase() === "yes",
  };
}

function textMatches(candidate: string, m: TextMatch): boolean {
  // Only i;unicode-casemap / i;ascii-casemap are advertised; both are case-insensitive.
  const a = candidate.toLowerCase();
  const b = m.value.toLowerCase();
  let result: boolean;
  switch (m.matchType) {
    case "equals":
      result = a === b;
      break;
    case "starts-with":
      result = a.startsWith(b);
      break;
    case "ends-with":
      result = a.endsWith(b);
      break;
    default:
      result = a.includes(b);
  }
  return m.negate ? !result : result;
}

function propValueText(p: VProp): string {
  return splitValue(p.value, ";")
    .flatMap((c) => c.split(","))
    .join(" ")
    .trim();
}

function propFilterMatches(props: VProp[], filter: XmlNode): boolean {
  const name = (filter.attrs.name ?? "").toUpperCase();
  const matching = props.filter((p) => p.name === name);
  if (findChild(filter, NS_CARDDAV, "is-not-defined")) return matching.length === 0;
  const conditions = filter.children.filter(
    (c) => c.ns === NS_CARDDAV && (c.name === "text-match" || c.name === "param-filter"),
  );
  if (!conditions.length) return matching.length > 0;
  const anyOf = (filter.attrs.test ?? "anyof").toLowerCase() !== "allof";
  const results = conditions.map((cond) => {
    if (cond.name === "text-match") {
      const m = parseTextMatch(cond);
      const matched = matching.some((p) => textMatches(propValueText(p), m));
      // A negated match on a missing property is true (nothing contradicts it).
      return matching.length === 0 ? m.negate : matched;
    }
    return matching.some((p) => paramFilterMatches(p, cond));
  });
  return anyOf ? results.some(Boolean) : results.every(Boolean);
}

function paramFilterMatches(prop: VProp, filter: XmlNode): boolean {
  const name = (filter.attrs.name ?? "").toUpperCase();
  const values = prop.params[name] ?? [];
  if (findChild(filter, NS_CARDDAV, "is-not-defined")) return values.length === 0;
  const tm = findChild(filter, NS_CARDDAV, "text-match");
  if (!tm) return values.length > 0;
  const m = parseTextMatch(tm);
  return values.length === 0 ? m.negate : values.some((v) => textMatches(v, m));
}

export function contactMatchesFilter(contact: Contact, filter: XmlNode | undefined): boolean {
  if (!filter) return true;
  const propFilters = findChildren(filter, NS_CARDDAV, "prop-filter");
  if (!propFilters.length) return true;
  const cards = parseVCards(contact.vcard);
  const props = cards[0] ?? [];
  const anyOf = (filter.attrs.test ?? "anyof").toLowerCase() !== "allof";
  const results = propFilters.map((pf) => propFilterMatches(props, pf));
  return anyOf ? results.some(Boolean) : results.every(Boolean);
}

function parseLimit(body: XmlNode, ns: string): number | null {
  const limit = findChild(body, ns, "limit");
  const n = Number(findChild(limit, NS_DAV, "nresults")?.text.trim() ?? "");
  return limit && Number.isInteger(n) && n > 0 ? n : null;
}

async function query(ctx: DavContext, body: XmlNode): Promise<Response> {
  const request = parsePropRequest(body, ALLPROP.vcard);
  const filter = findChild(body, NS_CARDDAV, "filter");
  const limit = parseLimit(body, NS_CARDDAV);
  const all = await presentAll(ctx, await ctx.storage.allContacts());
  let matched = all.filter((c) => contactMatchesFilter(c, filter));
  let truncated = false;
  if (limit !== null && matched.length > limit) {
    matched = matched.slice(0, limit);
    truncated = true;
  }
  const responses: string[] = [];
  for (const c of matched) responses.push(await propResponse(ctx, vcardResource(c.uid), request, c));
  if (truncated) {
    responses.push(
      statusResponse(ADDRESSBOOK_PATH, "HTTP/1.1 507 Insufficient Storage", dav("error", dav("number-of-matches-within-limits"))),
    );
  }
  return xmlResponse(207, multistatus(responses));
}

// ---------------------------------------------------------------------------
// sync-collection (RFC 6578)

async function syncCollection(ctx: DavContext, body: XmlNode): Promise<Response> {
  const tokenText = findChild(body, NS_DAV, "sync-token")?.text ?? "";
  const since = parseSyncToken(tokenText);
  const current = await ctx.storage.currentSeq();
  if (since === null || since > current) {
    // Unknown / foreign / future token: the client must start over with an empty token.
    return xmlResponse(507, davError(dav("valid-sync-token")));
  }
  const request = parsePropRequest(body, []);
  const limit = parseLimit(body, NS_DAV);

  let { changed, deleted } = await ctx.storage.changesSince(since);
  changed = await presentAll(ctx, changed);
  if (since === 0) deleted = []; // initial sync never reports tombstones

  // Merge and order by seq so a truncated response can hand out an intermediate token.
  type Item = { seq: number; contact?: Contact; uid: string };
  let items: Item[] = [
    ...changed.map((c) => ({ seq: c.seq, contact: c, uid: c.uid })),
    ...deleted.map((t) => ({ seq: t.seq, uid: t.uid })),
  ].sort((a, b) => a.seq - b.seq);

  let truncated = false;
  let newToken = current;
  if (limit !== null && items.length > limit) {
    items = items.slice(0, limit);
    truncated = true;
    newToken = items[items.length - 1].seq;
  }

  const responses: string[] = [];
  for (const item of items) {
    if (item.contact) {
      if (request.props.length) {
        responses.push(await propResponse(ctx, vcardResource(item.uid), request, item.contact));
      } else {
        responses.push(statusResponse(vcardHref(item.uid), "HTTP/1.1 200 OK"));
      }
    } else {
      responses.push(statusResponse(vcardHref(item.uid), "HTTP/1.1 404 Not Found"));
    }
  }
  if (truncated) {
    responses.push(
      statusResponse(ADDRESSBOOK_PATH, "HTTP/1.1 507 Insufficient Storage", dav("error", dav("number-of-matches-within-limits"))),
    );
  }
  return xmlResponse(207, multistatus(responses, dav("sync-token", syncTokenFor(newToken))));
}
