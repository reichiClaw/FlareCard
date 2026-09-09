import type {
  Contact,
  ContactInput,
  ContactPage,
  Role,
  Storage,
  Tombstone,
  User,
} from "./types";

/**
 * Minimal subset of the Durable Object SQLite API this module depends on. Declared
 * locally so the module type-checks without pulling in runtime-specific globals.
 */
export type SqlValue = ArrayBuffer | string | number | null;

export interface SqlLike {
  exec<T extends Record<string, SqlValue>>(
    query: string,
    ...bindings: unknown[]
  ): { toArray(): T[]; one(): T; rowsWritten: number };
}

interface UserRow extends Record<string, SqlValue> {
  id: number;
  username: string;
  role: string;
  disabled: number;
  password_hash: string;
  created_at: number;
}

interface ContactRow extends Record<string, SqlValue> {
  uid: string;
  vcard: string;
  etag: string;
  seq: number;
  updated_at: number;
  display_name: string;
  search_text: string;
}

interface TombstoneRow extends Record<string, SqlValue> {
  uid: string;
  seq: number;
  deleted_at: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role TEXT NOT NULL CHECK (role IN ('admin','user')),
  disabled INTEGER NOT NULL DEFAULT 0,
  password_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS contacts (
  uid TEXT PRIMARY KEY,
  vcard TEXT NOT NULL,
  etag TEXT NOT NULL,
  seq INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  display_name TEXT NOT NULL DEFAULT '',
  search_text TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS contacts_seq ON contacts(seq);
CREATE INDEX IF NOT EXISTS contacts_display_name ON contacts(display_name);
CREATE TABLE IF NOT EXISTS tombstones (
  uid TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  deleted_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS tombstones_seq ON tombstones(seq);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT OR IGNORE INTO settings(key, value) VALUES ('seq', '0');
`;

function rowToUser(r: UserRow): User {
  return {
    id: Number(r.id),
    username: r.username,
    role: r.role as Role,
    disabled: Number(r.disabled) === 1,
    passwordHash: r.password_hash,
    createdAt: Number(r.created_at),
  };
}

function rowToContact(r: ContactRow): Contact {
  return {
    uid: r.uid,
    vcard: r.vcard,
    etag: r.etag,
    seq: Number(r.seq),
    updatedAt: Number(r.updated_at),
    displayName: r.display_name,
    searchText: r.search_text,
  };
}

/** Storage backed by the SQLite database of a single Durable Object. */
export class SqliteStorage implements Storage {
  constructor(private sql: SqlLike) {}

  migrate(): void {
    this.sql.exec(SCHEMA);
  }

  private nextSeq(): number {
    const row = this.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = 'seq'`).one();
    const next = Number(row.value) + 1;
    this.sql.exec(`UPDATE settings SET value = ? WHERE key = 'seq'`, String(next));
    return next;
  }

  async countUsers(): Promise<number> {
    return Number(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM users`).one().n);
  }

  async listUsers(): Promise<User[]> {
    return this.sql.exec<UserRow>(`SELECT * FROM users ORDER BY username`).toArray().map(rowToUser);
  }

  async getUserById(id: number): Promise<User | null> {
    const rows = this.sql.exec<UserRow>(`SELECT * FROM users WHERE id = ?`, id).toArray();
    return rows.length ? rowToUser(rows[0]) : null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const rows = this.sql.exec<UserRow>(`SELECT * FROM users WHERE username = ? COLLATE NOCASE`, username).toArray();
    return rows.length ? rowToUser(rows[0]) : null;
  }

  async createUser(input: { username: string; role: Role; passwordHash: string }): Promise<User> {
    if (await this.getUserByUsername(input.username)) throw new Error("username already exists");
    const now = Date.now();
    this.sql.exec(
      `INSERT INTO users(username, role, disabled, password_hash, created_at) VALUES (?, ?, 0, ?, ?)`,
      input.username,
      input.role,
      input.passwordHash,
      now,
    );
    const row = this.sql.exec<UserRow>(`SELECT * FROM users WHERE username = ?`, input.username).one();
    return rowToUser(row);
  }

  async updateUser(
    id: number,
    patch: Partial<Pick<User, "role" | "disabled" | "passwordHash">>,
  ): Promise<User | null> {
    const existing = await this.getUserById(id);
    if (!existing) return null;
    const merged = { ...existing, ...patch };
    this.sql.exec(
      `UPDATE users SET role = ?, disabled = ?, password_hash = ? WHERE id = ?`,
      merged.role,
      merged.disabled ? 1 : 0,
      merged.passwordHash,
      id,
    );
    return merged;
  }

  async deleteUser(id: number): Promise<boolean> {
    return this.sql.exec(`DELETE FROM users WHERE id = ?`, id).rowsWritten > 0;
  }

  async countContacts(): Promise<number> {
    return Number(this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts`).one().n);
  }

  async listContacts(opts: { q?: string; limit?: number; offset?: number } = {}): Promise<ContactPage> {
    const q = (opts.q ?? "").trim().toLowerCase();
    const limit = Math.max(1, Math.min(opts.limit ?? 50, 500));
    const offset = Math.max(0, opts.offset ?? 0);
    const where = q ? `WHERE search_text LIKE ? ESCAPE '\\'` : "";
    const bindings: unknown[] = q ? [`%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`] : [];
    const total = Number(
      this.sql.exec<{ n: number }>(`SELECT COUNT(*) AS n FROM contacts ${where}`, ...bindings).one().n,
    );
    const items = this.sql
      .exec<ContactRow>(
        `SELECT * FROM contacts ${where} ORDER BY display_name COLLATE NOCASE, uid LIMIT ? OFFSET ?`,
        ...bindings,
        limit,
        offset,
      )
      .toArray()
      .map(rowToContact);
    return { items, total };
  }

  async allContacts(): Promise<Contact[]> {
    return this.sql.exec<ContactRow>(`SELECT * FROM contacts ORDER BY uid`).toArray().map(rowToContact);
  }

  async getContact(uid: string): Promise<Contact | null> {
    const rows = this.sql.exec<ContactRow>(`SELECT * FROM contacts WHERE uid = ?`, uid).toArray();
    return rows.length ? rowToContact(rows[0]) : null;
  }

  async getContacts(uids: string[]): Promise<Contact[]> {
    const out: Contact[] = [];
    // SQLite bound-parameter limits are generous but keep chunks modest.
    for (let i = 0; i < uids.length; i += 200) {
      const chunk = uids.slice(i, i + 200);
      const placeholders = chunk.map(() => "?").join(",");
      out.push(
        ...this.sql
          .exec<ContactRow>(`SELECT * FROM contacts WHERE uid IN (${placeholders})`, ...chunk)
          .toArray()
          .map(rowToContact),
      );
    }
    return out;
  }

  async upsertContact(input: ContactInput): Promise<Contact> {
    const seq = this.nextSeq();
    const now = Date.now();
    const searchText = input.searchText.toLowerCase();
    this.sql.exec(
      `INSERT INTO contacts(uid, vcard, etag, seq, updated_at, display_name, search_text)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET vcard = excluded.vcard, etag = excluded.etag, seq = excluded.seq,
         updated_at = excluded.updated_at, display_name = excluded.display_name, search_text = excluded.search_text`,
      input.uid,
      input.vcard,
      input.etag,
      seq,
      now,
      input.displayName,
      searchText,
    );
    this.sql.exec(`DELETE FROM tombstones WHERE uid = ?`, input.uid);
    return { ...input, searchText, seq, updatedAt: now };
  }

  async deleteContact(uid: string): Promise<boolean> {
    const deleted = this.sql.exec(`DELETE FROM contacts WHERE uid = ?`, uid).rowsWritten > 0;
    if (!deleted) return false;
    const seq = this.nextSeq();
    this.sql.exec(
      `INSERT INTO tombstones(uid, seq, deleted_at) VALUES (?, ?, ?)
       ON CONFLICT(uid) DO UPDATE SET seq = excluded.seq, deleted_at = excluded.deleted_at`,
      uid,
      seq,
      Date.now(),
    );
    return true;
  }

  async currentSeq(): Promise<number> {
    return Number(this.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = 'seq'`).one().value);
  }

  async changesSince(seq: number): Promise<{ changed: Contact[]; deleted: Tombstone[] }> {
    const changed = this.sql
      .exec<ContactRow>(`SELECT * FROM contacts WHERE seq > ? ORDER BY seq`, seq)
      .toArray()
      .map(rowToContact);
    const deleted = this.sql
      .exec<TombstoneRow>(`SELECT * FROM tombstones WHERE seq > ? ORDER BY seq`, seq)
      .toArray()
      .map((r) => ({ uid: r.uid, seq: Number(r.seq), deletedAt: Number(r.deleted_at) }));
    return { changed, deleted };
  }

  async getSetting(key: string): Promise<string | null> {
    const rows = this.sql.exec<{ value: string }>(`SELECT value FROM settings WHERE key = ?`, key).toArray();
    return rows.length ? rows[0].value : null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.sql.exec(
      `INSERT INTO settings(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      key,
      value,
    );
  }
}
