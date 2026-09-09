/**
 * The CardDAV URL layout. There is exactly one shared address book at a fixed
 * path; every user's home set points at it.
 *
 *   /dav/                                   root (current-user-principal discovery)
 *   /dav/principals/                        principal collection
 *   /dav/principals/<username>/             a user's principal
 *   /dav/addressbooks/                      addressbook-home-set (same for all users)
 *   /dav/addressbooks/shared/               the shared address book
 *   /dav/addressbooks/shared/<uid>.vcf      a contact
 */

export const DAV_ROOT = "/dav/";
export const PRINCIPALS_PATH = "/dav/principals/";
export const HOME_PATH = "/dav/addressbooks/";
export const ADDRESSBOOK_PATH = "/dav/addressbooks/shared/";

export type Resource =
  | { kind: "root"; href: string }
  | { kind: "principals"; href: string }
  | { kind: "principal"; href: string; username: string }
  | { kind: "home"; href: string }
  | { kind: "addressbook"; href: string }
  | { kind: "vcard"; href: string; uid: string };

export function principalHref(username: string): string {
  return `${PRINCIPALS_PATH}${encodeURIComponent(username)}/`;
}

export function vcardHref(uid: string): string {
  return `${ADDRESSBOOK_PATH}${encodeURIComponent(uid)}.vcf`;
}

function safeDecode(segment: string): string | null {
  try {
    return decodeURIComponent(segment);
  } catch {
    return null;
  }
}

/** Maps a request path to a DAV resource, tolerating a missing trailing slash on collections. */
export function resolvePath(pathname: string): Resource | null {
  if (pathname === "/" || pathname === "/dav" || pathname === DAV_ROOT) {
    return { kind: "root", href: pathname === "/" ? "/" : DAV_ROOT };
  }
  const withSlash = pathname.endsWith("/") ? pathname : `${pathname}/`;
  if (withSlash === PRINCIPALS_PATH) return { kind: "principals", href: PRINCIPALS_PATH };
  if (withSlash === HOME_PATH) return { kind: "home", href: HOME_PATH };
  if (withSlash === ADDRESSBOOK_PATH) return { kind: "addressbook", href: ADDRESSBOOK_PATH };

  if (withSlash.startsWith(PRINCIPALS_PATH)) {
    const rest = withSlash.slice(PRINCIPALS_PATH.length).replace(/\/$/, "");
    if (!rest || rest.includes("/")) return null;
    const username = safeDecode(rest);
    if (!username) return null;
    return { kind: "principal", href: principalHref(username), username };
  }

  if (pathname.startsWith(ADDRESSBOOK_PATH)) {
    const rest = pathname.slice(ADDRESSBOOK_PATH.length);
    if (!rest || rest.includes("/") || !rest.toLowerCase().endsWith(".vcf")) return null;
    const uid = safeDecode(rest.slice(0, -4));
    if (!uid) return null;
    return { kind: "vcard", href: vcardHref(uid), uid };
  }
  return null;
}

/** Extracts the uid from an href that may be absolute or relative. */
export function uidFromHref(href: string): string | null {
  let path = href.trim();
  try {
    if (/^https?:\/\//i.test(path)) path = new URL(path).pathname;
  } catch {
    return null;
  }
  const res = resolvePath(path);
  return res && res.kind === "vcard" ? res.uid : null;
}
