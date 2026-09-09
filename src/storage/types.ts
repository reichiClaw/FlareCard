export type Role = "admin" | "user";

export interface User {
  id: number;
  username: string;
  role: Role;
  disabled: boolean;
  passwordHash: string;
  createdAt: number;
}

export interface Contact {
  uid: string;
  vcard: string;
  etag: string;
  /** Global monotonically increasing change sequence; drives getctag and sync-token. */
  seq: number;
  updatedAt: number;
  displayName: string;
  searchText: string;
}

export interface Tombstone {
  uid: string;
  seq: number;
  deletedAt: number;
}

export interface ContactPage {
  items: Contact[];
  total: number;
}

export interface ContactInput {
  uid: string;
  vcard: string;
  etag: string;
  displayName: string;
  searchText: string;
}

/**
 * The only persistence boundary in FlareCard. The production implementation is a
 * SQLite-backed Durable Object; tests use an in-memory implementation.
 *
 * All methods are async so an implementation may be backed by anything, even though
 * the Durable Object SQLite API happens to be synchronous.
 */
export interface Storage {
  // users
  countUsers(): Promise<number>;
  listUsers(): Promise<User[]>;
  getUserById(id: number): Promise<User | null>;
  getUserByUsername(username: string): Promise<User | null>;
  createUser(input: { username: string; role: Role; passwordHash: string }): Promise<User>;
  updateUser(
    id: number,
    patch: Partial<Pick<User, "role" | "disabled" | "passwordHash">>,
  ): Promise<User | null>;
  deleteUser(id: number): Promise<boolean>;

  // contacts
  countContacts(): Promise<number>;
  listContacts(opts?: { q?: string; limit?: number; offset?: number }): Promise<ContactPage>;
  allContacts(): Promise<Contact[]>;
  getContact(uid: string): Promise<Contact | null>;
  getContacts(uids: string[]): Promise<Contact[]>;
  /** Insert or replace a contact, assigning a fresh seq. Clears any tombstone for the uid. */
  upsertContact(input: ContactInput): Promise<Contact>;
  /** Delete a contact and record a tombstone with a fresh seq. */
  deleteContact(uid: string): Promise<boolean>;
  /** Current highest seq (0 when nothing has ever changed). */
  currentSeq(): Promise<number>;
  /** All contacts changed and all tombstones recorded strictly after `seq`. */
  changesSince(seq: number): Promise<{ changed: Contact[]; deleted: Tombstone[] }>;

  // settings
  getSetting(key: string): Promise<string | null>;
  setSetting(key: string, value: string): Promise<void>;
}
