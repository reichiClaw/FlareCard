export interface PublicUser {
  id: number;
  username: string;
  role: "admin" | "user";
  disabled: boolean;
  createdAt: number;
}

export interface ContactSummary {
  uid: string;
  fn: string;
  org: string;
  title: string;
  email: string;
  phone: string;
  hasPhoto: boolean;
  etag: string;
  updatedAt: number;
}

export interface ContactPage {
  items: ContactSummary[];
  total: number;
  limit: number;
  offset: number;
  syncSeq: number;
}

export interface PhoneField {
  type: string;
  value: string;
  pref?: boolean;
}
export interface EmailField {
  type: string;
  value: string;
  pref?: boolean;
}
export interface AddressField {
  type: string;
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
  birthday: string;
  note: string;
  photo: PhotoField | null;
}

export interface ContactDetail {
  fields: ContactFields;
  vcard: string;
  etag: string;
  updatedAt: number;
}

export interface Settings {
  addressbookName: string;
  addressbookDescription: string;
  host: string;
  useSSL: boolean;
  addressbookPath: string;
  principalPath: string;
  contactCount: number;
  userCount: number;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  unmappedHeaders?: string[];
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

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

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { Accept: "application/json", ...(init.body ? { "Content-Type": "application/json" } : {}), ...init.headers },
    credentials: "same-origin",
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const message = (data as { error?: string } | null)?.error ?? `Request failed (${res.status})`;
    if (res.status === 401) window.dispatchEvent(new CustomEvent("flarecard:unauthorized"));
    throw new ApiError(res.status, message);
  }
  return data as T;
}

export const api = {
  status: () => request<{ bootstrapped: boolean; host: string }>("/status"),
  login: (username: string, password: string) =>
    request<{ user: PublicUser }>("/auth/login", { method: "POST", body: JSON.stringify({ username, password }) }),
  logout: () => request<{ ok: true }>("/auth/logout", { method: "POST" }),
  me: () => request<{ user: PublicUser }>("/auth/me"),

  settings: () => request<Settings>("/settings"),
  updateSettings: (patch: Partial<Pick<Settings, "addressbookName" | "addressbookDescription">>) =>
    request<{ ok: true }>("/settings", { method: "PUT", body: JSON.stringify(patch) }),

  contacts: (params: { q?: string; limit?: number; offset?: number }) => {
    const qs = new URLSearchParams();
    if (params.q) qs.set("q", params.q);
    if (params.limit) qs.set("limit", String(params.limit));
    if (params.offset) qs.set("offset", String(params.offset));
    return request<ContactPage>(`/contacts?${qs}`);
  },
  contact: (uid: string) => request<ContactDetail>(`/contacts/${encodeURIComponent(uid)}`),
  createContact: (fields: ContactFields) =>
    request<{ uid: string; etag: string }>("/contacts", { method: "POST", body: JSON.stringify(fields) }),
  updateContact: (uid: string, fields: ContactFields) =>
    request<{ uid: string; etag: string }>(`/contacts/${encodeURIComponent(uid)}`, { method: "PUT", body: JSON.stringify(fields) }),
  deleteContact: (uid: string) => request<void>(`/contacts/${encodeURIComponent(uid)}`, { method: "DELETE" }),
  importContacts: (format: "vcf" | "csv", text: string) =>
    request<ImportSummary>("/contacts/import", { method: "POST", body: JSON.stringify({ format, text }) }),
  seedDemo: () => request<{ imported: number }>("/contacts/seed", { method: "POST" }),
  exportUrl: "/api/contacts/export.vcf",

  users: () => request<{ items: PublicUser[] }>("/users"),
  createUser: (username: string, role: "admin" | "user") =>
    request<{ user: PublicUser; password: string }>("/users", { method: "POST", body: JSON.stringify({ username, role }) }),
  updateUser: (id: number, patch: { disabled?: boolean; role?: "admin" | "user" }) =>
    request<{ user: PublicUser }>(`/users/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  resetPassword: (id: number) => request<{ password: string }>(`/users/${id}/reset-password`, { method: "POST" }),
  deleteUser: (id: number) => request<void>(`/users/${id}`, { method: "DELETE" }),
  profileUrl: (id: number) => `/api/users/${id}/profile.mobileconfig`,
};
