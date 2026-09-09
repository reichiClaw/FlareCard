import { type ContactFields, emptyFields } from "./vcard";

/** RFC 4180-ish CSV parser (quotes, escaped quotes, CRLF/LF). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  const src = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          cell += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cell += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(cell);
      cell = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((c) => c.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += ch;
    }
  }
  row.push(cell);
  if (row.some((c) => c.trim() !== "")) rows.push(row);
  return rows;
}

type Setter = (f: ContactFields, value: string) => void;

const norm = (h: string) => h.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

function phone(type: string): Setter {
  return (f, v) => f.phones.push({ type, value: v });
}
function email(type: string): Setter {
  return (f, v) => f.emails.push({ type, value: v });
}
function addr(type: string, key: "street" | "city" | "region" | "postalCode" | "country"): Setter {
  return (f, v) => {
    let a = f.addresses.find((x) => x.type === type);
    if (!a) {
      a = { type, street: "", city: "", region: "", postalCode: "", country: "" };
      f.addresses.push(a);
    }
    a[key] = v;
  };
}

/**
 * Header aliases covering Google Contacts, Outlook and generic exports. Each
 * normalized header maps to a setter on the structured contact model.
 */
const HEADER_MAP: Record<string, Setter> = {
  uid: (f, v) => (f.uid = v),
  id: (f, v) => (f.uid = v),
  "full name": (f, v) => (f.fn = v),
  name: (f, v) => (f.fn = v),
  "display name": (f, v) => (f.fn = v),
  "first name": (f, v) => (f.n.given = v),
  "given name": (f, v) => (f.n.given = v),
  "middle name": (f, v) => (f.n.additional = v),
  "additional name": (f, v) => (f.n.additional = v),
  "last name": (f, v) => (f.n.family = v),
  "family name": (f, v) => (f.n.family = v),
  surname: (f, v) => (f.n.family = v),
  "name prefix": (f, v) => (f.n.prefix = v),
  prefix: (f, v) => (f.n.prefix = v),
  "name suffix": (f, v) => (f.n.suffix = v),
  suffix: (f, v) => (f.n.suffix = v),
  nickname: (f, v) => (f.nickname = v),
  organization: (f, v) => (f.org = v),
  "organization name": (f, v) => (f.org = v),
  "organization 1 name": (f, v) => (f.org = v),
  company: (f, v) => (f.org = v),
  org: (f, v) => (f.org = v),
  department: (f, v) => (f.department = v),
  "organization 1 department": (f, v) => (f.department = v),
  title: (f, v) => (f.title = v),
  "job title": (f, v) => (f.title = v),
  "organization 1 title": (f, v) => (f.title = v),
  role: (f, v) => (f.role = v),
  email: email("WORK"),
  "e mail": email("WORK"),
  "e mail address": email("WORK"),
  "email address": email("WORK"),
  "work email": email("WORK"),
  "e mail 1 value": email("WORK"),
  "home email": email("HOME"),
  "e mail 2 value": email("HOME"),
  phone: phone("WORK"),
  "phone number": phone("WORK"),
  "work phone": phone("WORK"),
  "business phone": phone("WORK"),
  "phone 1 value": phone("WORK"),
  mobile: phone("CELL"),
  "mobile phone": phone("CELL"),
  cell: phone("CELL"),
  "cell phone": phone("CELL"),
  "phone 2 value": phone("CELL"),
  "home phone": phone("HOME"),
  fax: phone("WORK,FAX"),
  "business fax": phone("WORK,FAX"),
  "work fax": phone("WORK,FAX"),
  pager: phone("PAGER"),
  street: addr("WORK", "street"),
  address: addr("WORK", "street"),
  "street address": addr("WORK", "street"),
  "business street": addr("WORK", "street"),
  "address 1 street": addr("WORK", "street"),
  city: addr("WORK", "city"),
  "business city": addr("WORK", "city"),
  "address 1 city": addr("WORK", "city"),
  state: addr("WORK", "region"),
  region: addr("WORK", "region"),
  "business state": addr("WORK", "region"),
  "address 1 region": addr("WORK", "region"),
  zip: addr("WORK", "postalCode"),
  "zip code": addr("WORK", "postalCode"),
  "postal code": addr("WORK", "postalCode"),
  "business postal code": addr("WORK", "postalCode"),
  "address 1 postal code": addr("WORK", "postalCode"),
  country: addr("WORK", "country"),
  "business country region": addr("WORK", "country"),
  "address 1 country": addr("WORK", "country"),
  website: (f, v) => f.urls.push({ type: "WORK", value: v }),
  url: (f, v) => f.urls.push({ type: "WORK", value: v }),
  "web page": (f, v) => f.urls.push({ type: "WORK", value: v }),
  "website 1 value": (f, v) => f.urls.push({ type: "WORK", value: v }),
  birthday: (f, v) => (f.birthday = v),
  notes: (f, v) => (f.note = v),
  note: (f, v) => (f.note = v),
};

export interface CsvImportResult {
  contacts: ContactFields[];
  unmappedHeaders: string[];
}

export function csvToFields(text: string): CsvImportResult {
  const rows = parseCsv(text);
  if (rows.length < 2) return { contacts: [], unmappedHeaders: [] };
  const headers = rows[0].map(norm);
  const setters = headers.map((h) => HEADER_MAP[h]);
  const unmappedHeaders = rows[0].filter((_, i) => !setters[i]);
  const contacts: ContactFields[] = [];
  for (const row of rows.slice(1)) {
    const f = emptyFields();
    row.forEach((cell, i) => {
      const value = cell.trim();
      const setter = setters[i];
      if (setter && value) setter(f, value);
    });
    contacts.push(f);
  }
  return { contacts, unmappedHeaders };
}
