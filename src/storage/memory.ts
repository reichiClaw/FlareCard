import type {
  Contact,
  ContactInput,
  ContactPage,
  Role,
  Storage,
  Tombstone,
  User,
} from "./types";

/** In-memory Storage used by tests and for local experiments. */
export class MemoryStorage implements Storage {
  private users = new Map<number, User>();
  private contacts = new Map<string, Contact>();
  private tombstones = new Map<string, Tombstone>();
  private settings = new Map<string, string>();
  private nextUserId = 1;
  private seq = 0;

  async countUsers(): Promise<number> {
    return this.users.size;
  }

  async listUsers(): Promise<User[]> {
    return [...this.users.values()].sort((a, b) => a.username.localeCompare(b.username));
  }

  async getUserById(id: number): Promise<User | null> {
    return this.users.get(id) ?? null;
  }

  async getUserByUsername(username: string): Promise<User | null> {
    const lower = username.toLowerCase();
    for (const u of this.users.values()) if (u.username.toLowerCase() === lower) return u;
    return null;
  }

  async createUser(input: { username: string; role: Role; passwordHash: string }): Promise<User> {
    if (await this.getUserByUsername(input.username)) {
      throw new Error("username already exists");
    }
    const user: User = {
      id: this.nextUserId++,
      username: input.username,
      role: input.role,
      disabled: false,
      passwordHash: input.passwordHash,
      createdAt: Date.now(),
    };
    this.users.set(user.id, user);
    return user;
  }

  async updateUser(
    id: number,
    patch: Partial<Pick<User, "role" | "disabled" | "passwordHash">>,
  ): Promise<User | null> {
    const u = this.users.get(id);
    if (!u) return null;
    const updated = { ...u, ...patch };
    this.users.set(id, updated);
    return updated;
  }

  async deleteUser(id: number): Promise<boolean> {
    return this.users.delete(id);
  }

  async countContacts(): Promise<number> {
    return this.contacts.size;
  }

  async listContacts(opts: { q?: string; limit?: number; offset?: number } = {}): Promise<ContactPage> {
    const q = (opts.q ?? "").trim().toLowerCase();
    let items = [...this.contacts.values()];
    if (q) items = items.filter((c) => c.searchText.includes(q));
    items.sort((a, b) => a.displayName.localeCompare(b.displayName) || a.uid.localeCompare(b.uid));
    const total = items.length;
    const offset = opts.offset ?? 0;
    const limit = opts.limit ?? 50;
    return { items: items.slice(offset, offset + limit), total };
  }

  async allContacts(): Promise<Contact[]> {
    return [...this.contacts.values()].sort((a, b) => a.uid.localeCompare(b.uid));
  }

  async getContact(uid: string): Promise<Contact | null> {
    return this.contacts.get(uid) ?? null;
  }

  async getContacts(uids: string[]): Promise<Contact[]> {
    const out: Contact[] = [];
    for (const uid of uids) {
      const c = this.contacts.get(uid);
      if (c) out.push(c);
    }
    return out;
  }

  async upsertContact(input: ContactInput): Promise<Contact> {
    const seq = ++this.seq;
    const contact: Contact = {
      uid: input.uid,
      vcard: input.vcard,
      etag: input.etag,
      seq,
      updatedAt: Date.now(),
      displayName: input.displayName,
      searchText: input.searchText.toLowerCase(),
    };
    this.contacts.set(input.uid, contact);
    this.tombstones.delete(input.uid);
    return contact;
  }

  async deleteContact(uid: string): Promise<boolean> {
    if (!this.contacts.delete(uid)) return false;
    const seq = ++this.seq;
    this.tombstones.set(uid, { uid, seq, deletedAt: Date.now() });
    return true;
  }

  async currentSeq(): Promise<number> {
    return this.seq;
  }

  async changesSince(seq: number): Promise<{ changed: Contact[]; deleted: Tombstone[] }> {
    const changed = [...this.contacts.values()].filter((c) => c.seq > seq).sort((a, b) => a.seq - b.seq);
    const deleted = [...this.tombstones.values()].filter((t) => t.seq > seq).sort((a, b) => a.seq - b.seq);
    return { changed, deleted };
  }

  async getSetting(key: string): Promise<string | null> {
    return this.settings.get(key) ?? null;
  }

  async setSetting(key: string, value: string): Promise<void> {
    this.settings.set(key, value);
  }
}
