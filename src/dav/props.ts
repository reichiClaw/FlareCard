import type { Contact } from "../storage/types";
import { NS_CARDDAV, NS_CS, NS_DAV, card, cs, dav, escapeXml, element, findChild, type XmlNode } from "../lib/xml";
import { ctagFor, syncTokenFor } from "../lib/contacts";
import { MAX_VCARD_BYTES } from "../lib/vcard";
import type { DavContext } from "./context";
import { ADDRESSBOOK_PATH, HOME_PATH, PRINCIPALS_PATH, principalHref, type Resource } from "./paths";

export interface PropName {
  ns: string;
  name: string;
}

export interface PropRequest {
  mode: "prop" | "allprop" | "propname";
  props: PropName[];
}

/** Parses the <D:prop> / <D:allprop> / <D:propname> selector of a PROPFIND or REPORT body. */
export function parsePropRequest(root: XmlNode | null, defaults: PropName[]): PropRequest {
  if (!root) return { mode: "allprop", props: defaults };
  if (findChild(root, NS_DAV, "allprop")) return { mode: "allprop", props: defaults };
  if (findChild(root, NS_DAV, "propname")) return { mode: "propname", props: defaults };
  const prop = findChild(root, NS_DAV, "prop");
  if (!prop) return { mode: "allprop", props: defaults };
  const seen = new Set<string>();
  const props: PropName[] = [];
  for (const c of prop.children) {
    const key = `{${c.ns}}${c.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    props.push({ ns: c.ns, name: c.name });
  }
  return { mode: "prop", props };
}

const D = (name: string): PropName => ({ ns: NS_DAV, name });
const C = (name: string): PropName => ({ ns: NS_CARDDAV, name });
const CS = (name: string): PropName => ({ ns: NS_CS, name });

export const ALLPROP: Record<Resource["kind"], PropName[]> = {
  root: [D("resourcetype"), D("displayname"), D("current-user-principal"), D("principal-collection-set")],
  principals: [D("resourcetype"), D("displayname"), D("current-user-principal")],
  principal: [
    D("resourcetype"),
    D("displayname"),
    D("principal-URL"),
    D("current-user-principal"),
    D("principal-collection-set"),
    C("addressbook-home-set"),
    D("current-user-privilege-set"),
  ],
  home: [D("resourcetype"), D("displayname"), D("owner"), D("current-user-principal"), D("current-user-privilege-set")],
  addressbook: [
    D("resourcetype"),
    D("displayname"),
    D("owner"),
    D("current-user-principal"),
    D("current-user-privilege-set"),
    D("supported-report-set"),
    D("sync-token"),
    CS("getctag"),
    C("addressbook-description"),
    C("supported-address-data"),
    C("max-resource-size"),
  ],
  vcard: [
    D("resourcetype"),
    D("displayname"),
    D("getetag"),
    D("getcontenttype"),
    D("getcontentlength"),
    D("getlastmodified"),
  ],
};

export function privilegeSet(role: "admin" | "user"): string {
  const privs = [dav("privilege", dav("read")), dav("privilege", dav("read-current-user-privilege-set"))];
  if (role === "admin") {
    privs.push(
      dav("privilege", dav("write")),
      dav("privilege", dav("write-properties")),
      dav("privilege", dav("write-content")),
      dav("privilege", dav("bind")),
      dav("privilege", dav("unbind")),
    );
  }
  return privs.join("");
}

function reportSet(reports: string[]): string {
  return reports.map((r) => dav("supported-report", dav("report", r))).join("");
}

/**
 * Resolves a single property for a resource. Returns the XML for the *inner*
 * content (may be empty string) or `undefined` when the property is not defined,
 * which produces a 404 propstat.
 */
export async function resolveProp(
  ctx: DavContext,
  resource: Resource,
  prop: PropName,
  contact?: Contact,
): Promise<string | undefined> {
  const me = principalHref(ctx.user.username);
  const { ns, name } = prop;

  if (ns === NS_DAV) {
    switch (name) {
      case "current-user-principal":
        return dav("href", escapeXml(me));
      case "principal-collection-set":
        return dav("href", PRINCIPALS_PATH);
      case "current-user-privilege-set":
        return privilegeSet(ctx.user.role);
      case "owner":
        if (resource.kind === "home" || resource.kind === "addressbook" || resource.kind === "vcard") {
          return dav("href", escapeXml(me));
        }
        return undefined;
      case "resourcetype":
        switch (resource.kind) {
          case "root":
          case "principals":
          case "home":
            return dav("collection");
          case "principal":
            return dav("collection") + dav("principal");
          case "addressbook":
            return dav("collection") + card("addressbook");
          case "vcard":
            return "";
        }
        break;
      case "displayname":
        switch (resource.kind) {
          case "root":
            return "FlareCard";
          case "principals":
            return "Principals";
          case "principal":
            return escapeXml(resource.username);
          case "home":
            return "Address Books";
          case "addressbook":
            return escapeXml(ctx.settings.addressbookName);
          case "vcard":
            return contact ? escapeXml(contact.displayName) : undefined;
        }
        break;
      case "principal-URL":
        return resource.kind === "principal" ? dav("href", escapeXml(resource.href)) : undefined;
      case "supported-report-set":
        if (resource.kind === "addressbook") {
          return reportSet([card("addressbook-multiget"), card("addressbook-query"), dav("sync-collection")]);
        }
        if (resource.kind === "vcard") return reportSet([card("addressbook-multiget")]);
        return "";
      case "sync-token":
        return resource.kind === "addressbook" ? escapeXml(syncTokenFor(await ctx.storage.currentSeq())) : undefined;
      case "getetag":
        return resource.kind === "vcard" && contact ? escapeXml(contact.etag) : undefined;
      case "getcontenttype":
        if (resource.kind === "vcard") return "text/vcard; charset=utf-8";
        return undefined;
      case "getcontentlength":
        return resource.kind === "vcard" && contact ? String(new TextEncoder().encode(contact.vcard).length) : undefined;
      case "getlastmodified":
        return resource.kind === "vcard" && contact ? new Date(contact.updatedAt).toUTCString() : undefined;
      case "creationdate":
        return resource.kind === "vcard" && contact ? new Date(contact.updatedAt).toISOString() : undefined;
      case "supported-privilege-set":
        return (
          dav(
            "supported-privilege",
            dav("privilege", dav("all")) +
              dav("description", "All privileges", ' xml:lang="en"') +
              dav("supported-privilege", dav("privilege", dav("read")) + dav("description", "Read", ' xml:lang="en"')) +
              dav("supported-privilege", dav("privilege", dav("write")) + dav("description", "Write", ' xml:lang="en"')),
          )
        );
      case "acl-restrictions":
        return dav("grant-only") + dav("no-invert");
      case "alternate-URI-set":
      case "group-membership":
      case "group-member-set":
        return resource.kind === "principal" ? "" : undefined;
      default:
        return undefined;
    }
  }

  if (ns === NS_CARDDAV) {
    switch (name) {
      case "addressbook-home-set":
        return resource.kind === "principal" ? dav("href", HOME_PATH) : undefined;
      case "addressbook-description":
        return resource.kind === "addressbook" ? escapeXml(ctx.settings.addressbookDescription) : undefined;
      case "supported-address-data":
        return resource.kind === "addressbook"
          ? card("address-data-type", "", ' content-type="text/vcard" version="3.0"')
          : undefined;
      case "max-resource-size":
        return resource.kind === "addressbook" ? String(MAX_VCARD_BYTES) : undefined;
      case "address-data":
        return resource.kind === "vcard" && contact ? escapeXml(contact.vcard) : undefined;
      case "principal-address":
        return undefined;
      default:
        return undefined;
    }
  }

  if (ns === NS_CS) {
    switch (name) {
      case "getctag":
        return resource.kind === "addressbook" ? escapeXml(ctagFor(await ctx.storage.currentSeq())) : undefined;
      default:
        return undefined;
    }
  }
  return undefined;
}

export const STATUS_OK = "HTTP/1.1 200 OK";
export const STATUS_NOT_FOUND = "HTTP/1.1 404 Not Found";

/** Builds a <D:response> for one resource with 200 / 404 propstats. */
export async function propResponse(
  ctx: DavContext,
  resource: Resource,
  request: PropRequest,
  contact?: Contact,
  href: string = resource.href,
): Promise<string> {
  const found: string[] = [];
  const missing: string[] = [];
  for (const p of request.props) {
    const value = await resolveProp(ctx, resource, p, contact);
    if (value === undefined) {
      missing.push(element(p.ns, p.name));
    } else {
      found.push(request.mode === "propname" ? element(p.ns, p.name) : element(p.ns, p.name, value));
    }
  }
  let body = dav("href", escapeXml(href));
  if (found.length || !missing.length) {
    body += dav("propstat", dav("prop", found.join("")) + dav("status", STATUS_OK));
  }
  if (missing.length) {
    body += dav("propstat", dav("prop", missing.join("")) + dav("status", STATUS_NOT_FOUND));
  }
  return dav("response", body);
}

export function statusResponse(href: string, status: string, extra = ""): string {
  return dav("response", dav("href", escapeXml(href)) + dav("status", status) + extra);
}

export { ADDRESSBOOK_PATH, cs };
