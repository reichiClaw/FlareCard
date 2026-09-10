import type { Contact } from "../storage/types";
import { etagFor } from "./contacts";
import { foldLine, parseContentLine, unfoldLines } from "./vcard";

/**
 * Devices cannot show that a contact is read-only, so FlareCard appends this
 * marker to the displayed name of every card it serves over CardDAV. The stored
 * vCard and the admin UI are untouched; the marker exists only in the sync output.
 */
export const LOCK_MARK = "\u{1F512}"; // 🔒

/** Splits a raw (still escaped) structured value on unescaped semicolons. */
function splitRawComponents(value: string): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      cur += ch + value[i + 1];
      i++;
    } else if (ch === ";") {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

function withSuffix(value: string, mark: string): string {
  const trimmed = value.replace(/\s+$/, "");
  if (!trimmed) return value;
  return trimmed.endsWith(mark) ? trimmed : `${trimmed} ${mark}`;
}

/**
 * Returns a copy of `vcard` whose displayed name ends with `mark`.
 *
 * - FN always gets the suffix (what most clients show when N is absent).
 * - N gets it on the family name, or on the given name if there is no family
 *   name, because Apple Contacts composes the displayed name from N.
 * - A card without any personal name (company card) gets it on ORG instead,
 *   which is what Apple Contacts and DAVx5 display in that case.
 */
export function markLocked(vcard: string, mark: string = LOCK_MARK): string {
  const lines = unfoldLines(vcard);
  let nHasName = false;
  let nIndex = -1;
  let orgIndex = -1;
  let hasFn = false;

  for (let i = 0; i < lines.length; i++) {
    const prop = parseContentLine(lines[i]);
    if (!prop) continue;
    if (prop.name === "FN") hasFn = true;
    else if (prop.name === "N" && nIndex < 0) nIndex = i;
    else if (prop.name === "ORG" && orgIndex < 0) orgIndex = i;
  }
  if (!hasFn && nIndex < 0 && orgIndex < 0) return vcard;

  const rewrite = (index: number, fn: (rawValue: string) => string) => {
    const line = lines[index];
    // The value is everything after the first colon outside quoted parameters,
    // which is exactly what parseContentLine returned; keep the head verbatim.
    const prop = parseContentLine(line)!;
    const head = line.slice(0, line.length - prop.value.length - 1);
    lines[index] = `${head}:${fn(prop.value)}`;
  };

  for (let i = 0; i < lines.length; i++) {
    const prop = parseContentLine(lines[i]);
    if (prop?.name === "FN") rewrite(i, (v) => withSuffix(v, mark));
  }

  if (nIndex >= 0) {
    rewrite(nIndex, (raw) => {
      const comps = splitRawComponents(raw);
      while (comps.length < 5) comps.push("");
      const target = comps[0].trim() ? 0 : comps[1].trim() ? 1 : -1;
      if (target >= 0) {
        nHasName = true;
        comps[target] = withSuffix(comps[target], mark);
      }
      return comps.join(";");
    });
  }

  if (!nHasName && orgIndex >= 0) {
    rewrite(orgIndex, (raw) => {
      const comps = splitRawComponents(raw);
      if (comps[0].trim()) comps[0] = withSuffix(comps[0], mark);
      return comps.join(";");
    });
  }

  return lines.map(foldLine).join("\r\n") + "\r\n";
}

/** The contact as devices see it: marked vCard and an ETag that matches that body. */
export async function presentForDevice(contact: Contact, enabled: boolean): Promise<Contact> {
  if (!enabled) return contact;
  const vcard = markLocked(contact.vcard);
  if (vcard === contact.vcard) return contact;
  return { ...contact, vcard, etag: await etagFor(vcard) };
}
