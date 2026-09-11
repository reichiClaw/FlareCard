import { sha256Hex } from "./crypto";

/**
 * vCard parsing, a structured contact model, and strict vCard 3.0 serialization.
 * Input may be vCard 2.1, 3.0 or 4.0; output is always normalized 3.0 with CRLF
 * line endings, 75-octet folding and base64 (`ENCODING=b`) photos, which is what
 * Apple's Contacts clients are happiest with.
 */

export interface VProp {
  group?: string;
  name: string; // upper-case
  params: Record<string, string[]>; // upper-case keys
  value: string; // raw (still escaped) value
}

export interface PhoneField {
  type: string; // e.g. "CELL", "WORK", "HOME", "WORK,FAX", "MAIN", "PAGER", "OTHER"
  value: string;
  pref?: boolean;
}
export interface EmailField {
  type: string; // "WORK" | "HOME" | "OTHER"
  value: string;
  pref?: boolean;
}
export interface AddressField {
  type: string; // "WORK" | "HOME" | "OTHER"
  poBox?: string;
  extended?: string;
  street: string;
  city: string;
  region: string;
  postalCode: string;
  country: string;
}
export interface UrlField {
  type: string;
  value: string;
}
export interface PhotoField {
  mediaType: "image/jpeg" | "image/png" | "image/gif";
  base64: string;
}

export interface ContactFields {
  uid: string;
  fn: string;
  n: { family: string; given: string; additional: string; prefix: string; suffix: string };
  nickname: string;
  org: string;
  department: string;
  title: string;
  role: string;
  phones: PhoneField[];
  emails: EmailField[];
  addresses: AddressField[];
  urls: UrlField[];
  birthday: string; // YYYY-MM-DD or ""
  note: string;
  photo: PhotoField | null;
}

export const MAX_PHOTO_BYTES = 512 * 1024;
export const MAX_VCARD_BYTES = 1024 * 1024;

export class VCardError extends Error {}

export function emptyFields(): ContactFields {
  return {
    uid: "",
    fn: "",
    n: { family: "", given: "", additional: "", prefix: "", suffix: "" },
    nickname: "",
    org: "",
    department: "",
    title: "",
    role: "",
    phones: [],
    emails: [],
    addresses: [],
    urls: [],
    birthday: "",
    note: "",
    photo: null,
  };
}

// ---------------------------------------------------------------------------
// Low-level line handling

export function unfoldLines(text: string): string[] {
  const raw = text.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  for (const line of raw) {
    if ((line.startsWith(" ") || line.startsWith("\t")) && out.length) {
      out[out.length - 1] += line.slice(1);
    } else if (line.length) {
      out.push(line);
    }
  }
  return out;
}

export function parseContentLine(line: string): VProp | null {
  // Find the first ':' that is not inside a quoted parameter value.
  let colon = -1;
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === ":" && !inQuote) {
      colon = i;
      break;
    }
  }
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const parts = splitUnquoted(head, ";");
  let nameToken = parts.shift() ?? "";
  let group: string | undefined;
  const dot = nameToken.indexOf(".");
  if (dot >= 0) {
    group = nameToken.slice(0, dot);
    nameToken = nameToken.slice(dot + 1);
  }
  const params: Record<string, string[]> = {};
  for (const p of parts) {
    const eq = p.indexOf("=");
    let key: string;
    let vals: string[];
    if (eq < 0) {
      // vCard 2.1 style bare parameter, e.g. TEL;HOME;VOICE
      key = "TYPE";
      vals = [p];
    } else {
      key = p.slice(0, eq).toUpperCase();
      vals = splitUnquoted(p.slice(eq + 1), ",").map((v) => v.replace(/^"(.*)"$/, "$1"));
      // Some exporters write TYPE="INTERNET,WORK"; treat the quoted list as multiple values.
      if (key === "TYPE") vals = vals.flatMap((v) => v.split(","));
    }
    if (!key) continue;
    params[key] = [...(params[key] ?? []), ...vals.filter((v) => v.length)];
  }
  return { group, name: nameToken.toUpperCase(), params, value };
}

function splitUnquoted(s: string, sep: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') {
      inQuote = !inQuote;
      cur += ch;
    } else if (ch === sep && !inQuote) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out;
}

/** Splits a value on unescaped `sep`, then unescapes each component. */
export function splitValue(value: string, sep: ";" | ","): string[] {
  const out: string[] = [];
  let cur = "";
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "\\" && i + 1 < value.length) {
      cur += ch + value[i + 1];
      i++;
    } else if (ch === sep) {
      out.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  out.push(cur);
  return out.map(unescapeValue);
}

export function unescapeValue(v: string): string {
  return v.replace(/\\([\\;,nN])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

export function escapeValue(v: string): string {
  return v.replace(/\\/g, "\\\\").replace(/\n/g, "\\n").replace(/,/g, "\\,").replace(/;/g, "\\;");
}

function escapeComponent(v: string): string {
  return escapeValue(v);
}

/** Splits a text into individual vCard property lists (BEGIN..END blocks). */
export function parseVCards(text: string): VProp[][] {
  const cards: VProp[][] = [];
  let current: VProp[] | null = null;
  for (const line of unfoldLines(text)) {
    const prop = parseContentLine(line);
    if (!prop) continue;
    if (prop.name === "BEGIN" && prop.value.trim().toUpperCase() === "VCARD") {
      current = [];
      continue;
    }
    if (prop.name === "END" && prop.value.trim().toUpperCase() === "VCARD") {
      if (current) cards.push(current);
      current = null;
      continue;
    }
    if (current) current.push(prop);
  }
  return cards;
}

/** Folds at 75 octets per RFC 2426 §2.6 without splitting multi-byte characters. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  const out: string[] = [];
  let cur = "";
  let curBytes = 0;
  let limit = 75;
  for (const ch of line) {
    const b = enc.encode(ch).length;
    if (curBytes + b > limit) {
      out.push(cur);
      cur = " ";
      curBytes = 1;
      limit = 75;
    }
    cur += ch;
    curBytes += b;
  }
  out.push(cur);
  return out.join("\r\n");
}

// ---------------------------------------------------------------------------
// Structured model <-> properties

const PHONE_TYPE_PRIORITY = ["CELL", "IPHONE", "WORK", "HOME", "MAIN", "FAX", "PAGER", "OTHER"];

function typesOf(prop: VProp): string[] {
  return (prop.params.TYPE ?? []).map((t) => t.toUpperCase());
}

function isPref(prop: VProp): boolean {
  const types = typesOf(prop);
  return types.includes("PREF") || (prop.params.PREF ?? []).some((p) => p === "1");
}

function phoneType(prop: VProp): string {
  const types = typesOf(prop).filter((t) => t !== "PREF" && t !== "VOICE");
  const hasFax = types.includes("FAX");
  const context = types.find((t) => t === "WORK" || t === "HOME");
  if (hasFax) return context ? `${context},FAX` : "FAX";
  if (types.includes("CELL") || types.includes("IPHONE") || types.includes("MOBILE")) return "CELL";
  for (const p of PHONE_TYPE_PRIORITY) if (types.includes(p)) return p;
  return types.length ? types[0] : "OTHER";
}

function contextType(prop: VProp): string {
  const types = typesOf(prop).filter((t) => t !== "PREF" && t !== "INTERNET");
  if (types.includes("WORK")) return "WORK";
  if (types.includes("HOME")) return "HOME";
  return types[0] ?? "OTHER";
}

function stripUriScheme(value: string, scheme: string): string {
  return value.toLowerCase().startsWith(`${scheme}:`) ? value.slice(scheme.length + 1) : value;
}

function normalizeBirthday(v: string): string {
  const s = v.trim();
  let m = /^(\d{4})-?(\d{2})-?(\d{2})/.exec(s);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = /^--(\d{2})-?(\d{2})$/.exec(s); // year-less birthday (vCard 4.0)
  if (m) return `1604-${m[1]}-${m[2]}`;
  return "";
}

function parsePhoto(prop: VProp): PhotoField | null {
  const value = prop.value.trim();
  let mediaType = "";
  let base64 = "";
  const dataUri = /^data:(image\/[a-z+.-]+);base64,(.*)$/is.exec(value);
  if (dataUri) {
    mediaType = dataUri[1].toLowerCase();
    base64 = dataUri[2];
  } else {
    const enc = (prop.params.ENCODING ?? []).map((e) => e.toUpperCase());
    if (!(enc.includes("B") || enc.includes("BASE64"))) return null; // URI photos are dropped
    const type = (prop.params.TYPE?.[0] ?? prop.params.MEDIATYPE?.[0] ?? "JPEG").toLowerCase();
    mediaType = type.startsWith("image/") ? type : `image/${type}`;
    base64 = value;
  }
  base64 = base64.replace(/\s+/g, "");
  if (mediaType === "image/jpg") mediaType = "image/jpeg";
  if (mediaType !== "image/jpeg" && mediaType !== "image/png" && mediaType !== "image/gif") return null;
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64) || !base64.length) return null;
  return { mediaType, base64 };
}

export function propsToFields(props: VProp[]): ContactFields {
  const f = emptyFields();
  const first = (name: string) => props.find((p) => p.name === name);
  f.uid = unescapeValue(first("UID")?.value ?? "").trim();
  f.fn = unescapeValue(first("FN")?.value ?? "").trim();
  const n = first("N");
  if (n) {
    const [family = "", given = "", additional = "", prefix = "", suffix = ""] = splitValue(n.value, ";");
    f.n = { family, given, additional, prefix, suffix };
  }
  f.nickname = splitValue(first("NICKNAME")?.value ?? "", ",")[0] ?? "";
  const org = first("ORG");
  if (org) {
    const [company = "", department = ""] = splitValue(org.value, ";");
    f.org = company;
    f.department = department;
  }
  f.title = unescapeValue(first("TITLE")?.value ?? "").trim();
  f.role = unescapeValue(first("ROLE")?.value ?? "").trim();
  f.note = unescapeValue(first("NOTE")?.value ?? "");
  f.birthday = normalizeBirthday(first("BDAY")?.value ?? "");
  for (const p of props) {
    switch (p.name) {
      case "TEL": {
        const value = stripUriScheme(unescapeValue(p.value), "tel").trim();
        if (value) f.phones.push({ type: phoneType(p), value, pref: isPref(p) || undefined });
        break;
      }
      case "EMAIL": {
        const value = stripUriScheme(unescapeValue(p.value), "mailto").trim();
        if (value) f.emails.push({ type: contextType(p), value, pref: isPref(p) || undefined });
        break;
      }
      case "ADR": {
        const [poBox = "", extended = "", street = "", city = "", region = "", postalCode = "", country = ""] =
          splitValue(p.value, ";");
        if ([poBox, extended, street, city, region, postalCode, country].some((x) => x.trim())) {
          f.addresses.push({ type: contextType(p), poBox, extended, street, city, region, postalCode, country });
        }
        break;
      }
      case "URL": {
        const value = unescapeValue(p.value).trim();
        if (value) f.urls.push({ type: contextType(p), value });
        break;
      }
      case "PHOTO": {
        if (!f.photo) f.photo = parsePhoto(p);
        break;
      }
    }
  }
  if (!f.fn) f.fn = deriveDisplayName(f);
  return f;
}

export function deriveDisplayName(f: ContactFields): string {
  const name = [f.n.prefix, f.n.given, f.n.additional, f.n.family, f.n.suffix]
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" ");
  return name || f.fn.trim() || f.org.trim() || f.emails[0]?.value || f.phones[0]?.value || "";
}

export function searchTextOf(f: ContactFields): string {
  return [
    f.fn,
    f.n.given,
    f.n.family,
    f.nickname,
    f.org,
    f.department,
    f.title,
    ...f.emails.map((e) => e.value),
    ...f.phones.map((p) => p.value),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function phoneTypeParams(type: string): string {
  const parts = type
    .split(",")
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);
  const out = parts.length ? [...parts] : ["OTHER"];
  if (!out.includes("FAX") && !out.includes("PAGER")) out.push("VOICE");
  return out.join(",");
}

/**
 * Serializes structured fields into a canonical vCard 3.0 string.
 * The output is deterministic for a given input + `rev` so ETags are stable.
 */
export function fieldsToVCard(f: ContactFields, rev: Date = new Date()): string {
  const lines: string[] = ["BEGIN:VCARD", "VERSION:3.0", "PRODID:-//FlareCard//FlareCard 0.1//EN"];
  const uid = f.uid.trim();
  if (!uid) throw new VCardError("uid is required");
  lines.push(`UID:${escapeValue(uid)}`);
  const n = f.n;
  lines.push(
    `N:${[n.family, n.given, n.additional, n.prefix, n.suffix].map((s) => escapeComponent(s.trim())).join(";")}`,
  );
  const fn = (f.fn || deriveDisplayName(f)).trim();
  if (!fn) throw new VCardError("A name or organization is required");
  lines.push(`FN:${escapeValue(fn)}`);
  if (f.nickname.trim()) lines.push(`NICKNAME:${escapeValue(f.nickname.trim())}`);
  if (f.org.trim() || f.department.trim()) {
    lines.push(
      `ORG:${escapeComponent(f.org.trim())}${f.department.trim() ? `;${escapeComponent(f.department.trim())}` : ""}`,
    );
  }
  if (f.title.trim()) lines.push(`TITLE:${escapeValue(f.title.trim())}`);
  if (f.role.trim()) lines.push(`ROLE:${escapeValue(f.role.trim())}`);
  for (const p of f.phones) {
    if (!p.value.trim()) continue;
    const types = phoneTypeParams(p.type) + (p.pref ? ",PREF" : "");
    lines.push(`TEL;TYPE=${types}:${escapeValue(p.value.trim())}`);
  }
  for (const e of f.emails) {
    if (!e.value.trim()) continue;
    const type = (e.type || "OTHER").trim().toUpperCase();
    lines.push(`EMAIL;TYPE=INTERNET,${type}${e.pref ? ",PREF" : ""}:${escapeValue(e.value.trim())}`);
  }
  for (const a of f.addresses) {
    const comps = [a.poBox ?? "", a.extended ?? "", a.street, a.city, a.region, a.postalCode, a.country];
    if (!comps.some((c) => c.trim())) continue;
    const type = (a.type || "OTHER").trim().toUpperCase();
    lines.push(`ADR;TYPE=${type}:${comps.map((c) => escapeComponent(c.trim())).join(";")}`);
  }
  for (const u of f.urls) {
    if (!u.value.trim()) continue;
    const type = (u.type || "OTHER").trim().toUpperCase();
    lines.push(`URL;TYPE=${type}:${escapeValue(u.value.trim())}`);
  }
  if (f.birthday) {
    const bd = normalizeBirthday(f.birthday);
    if (bd) lines.push(`BDAY:${bd}`);
  }
  if (f.note.trim()) lines.push(`NOTE:${escapeValue(f.note.replace(/\r\n?/g, "\n").trim())}`);
  if (f.photo && f.photo.base64) {
    const typeName = f.photo.mediaType.split("/")[1].toUpperCase();
    lines.push(`PHOTO;ENCODING=b;TYPE=${typeName}:${f.photo.base64}`);
  }
  lines.push(`REV:${formatRev(rev)}`);
  lines.push("END:VCARD");
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

export function formatRev(rev: Date): string {
  return rev.toISOString().replace(/\.\d{3}Z$/, "Z");
}

/**
 * Returns a copy of `vcard` whose REV property is `rev` (added before END:VCARD
 * when missing). Everything else, including folding of other lines, is preserved.
 */
export function withRev(vcard: string, rev: Date): string {
  const lines = unfoldLines(vcard);
  const revLine = `REV:${formatRev(rev)}`;
  const idx = lines.findIndex((l) => /^REV[;:]/i.test(l));
  if (idx >= 0) {
    lines[idx] = revLine;
  } else {
    const end = lines.findIndex((l) => /^END:VCARD$/i.test(l));
    lines.splice(end >= 0 ? end : lines.length, 0, revLine);
  }
  return lines.map(foldLine).join("\r\n") + "\r\n";
}

const SAFE_UID = /^[A-Za-z0-9._:@+-]{1,128}$/;

/** Ensures a UID that is safe to use as a URL path segment; derives a stable one otherwise. */
export async function normalizeUid(uid: string): Promise<string> {
  const trimmed = uid.trim();
  if (!trimmed) return crypto.randomUUID();
  if (SAFE_UID.test(trimmed)) return trimmed;
  return `u-${(await sha256Hex(trimmed)).slice(0, 32)}`;
}

export function validateFields(f: ContactFields): string | null {
  if (!f.fn.trim() && !deriveDisplayName(f).trim()) return "A name or organization is required";
  if (f.photo) {
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(f.photo.base64)) return "Photo must be base64";
    const bytes = Math.floor((f.photo.base64.length * 3) / 4);
    if (bytes > MAX_PHOTO_BYTES) return `Photo exceeds ${Math.round(MAX_PHOTO_BYTES / 1024)} KB`;
    if (!["image/jpeg", "image/png", "image/gif"].includes(f.photo.mediaType)) return "Unsupported photo type";
  }
  if (f.birthday && !normalizeBirthday(f.birthday)) return "Birthday must be YYYY-MM-DD";
  for (const e of f.emails) if (e.value && !/^[^\s@]+@[^\s@]+$/.test(e.value.trim())) return `Invalid email: ${e.value}`;
  return null;
}

/** Parses arbitrary vCard input and returns normalized 3.0 cards. */
export async function importVCards(text: string, now: Date = new Date()): Promise<{ fields: ContactFields; vcard: string }[]> {
  const out: { fields: ContactFields; vcard: string }[] = [];
  for (const props of parseVCards(text)) {
    const fields = propsToFields(props);
    fields.uid = await normalizeUid(fields.uid);
    if (fields.photo && Math.floor((fields.photo.base64.length * 3) / 4) > MAX_PHOTO_BYTES) fields.photo = null;
    if (validateFields(fields)) continue;
    out.push({ fields, vcard: fieldsToVCard(fields, now) });
  }
  return out;
}

/** Concatenates raw vCards for export. */
export function exportVCards(vcards: string[]): string {
  return vcards.map((v) => (v.endsWith("\r\n") ? v : v + "\r\n")).join("");
}
