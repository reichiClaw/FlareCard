import type { Contact, Storage } from "../storage/types";
import { sha256Hex } from "./crypto";
import {
  type ContactFields,
  deriveDisplayName,
  fieldsToVCard,
  importVCards,
  normalizeUid,
  parseVCards,
  propsToFields,
  searchTextOf,
  validateFields,
} from "./vcard";
import { csvToFields } from "./csv";

export const SYNC_TOKEN_PREFIX = "urn:x-flarecard:sync:";

export function syncTokenFor(seq: number): string {
  return `${SYNC_TOKEN_PREFIX}${seq}`;
}

export function parseSyncToken(token: string): number | null {
  const t = token.trim();
  if (!t) return 0;
  if (!t.startsWith(SYNC_TOKEN_PREFIX)) return null;
  const n = Number(t.slice(SYNC_TOKEN_PREFIX.length));
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function ctagFor(seq: number): string {
  return `flarecard-${seq}`;
}

export async function etagFor(vcard: string): Promise<string> {
  return `"${(await sha256Hex(vcard)).slice(0, 32)}"`;
}

export interface ImportSummary {
  imported: number;
  skipped: number;
  unmappedHeaders?: string[];
}

/** Business logic around contacts: validation, vCard generation, import/export. */
export class ContactService {
  constructor(private storage: Storage) {}

  async save(fields: ContactFields, now: Date = new Date()): Promise<Contact> {
    const error = validateFields(fields);
    if (error) throw new ContactValidationError(error);
    const uid = await normalizeUid(fields.uid);
    const normalized = { ...fields, uid, fn: fields.fn.trim() || deriveDisplayName(fields) };
    const vcard = fieldsToVCard(normalized, now);
    return this.storage.upsertContact({
      uid,
      vcard,
      etag: await etagFor(vcard),
      displayName: normalized.fn,
      searchText: searchTextOf(normalized),
    });
  }

  async importVcf(text: string, now: Date = new Date()): Promise<ImportSummary> {
    const cards = await importVCards(text, now);
    let imported = 0;
    for (const { fields, vcard } of cards) {
      await this.storage.upsertContact({
        uid: fields.uid,
        vcard,
        etag: await etagFor(vcard),
        displayName: fields.fn,
        searchText: searchTextOf(fields),
      });
      imported++;
    }
    const total = parseVCards(text).length;
    return { imported, skipped: total - imported };
  }

  async importCsv(text: string, now: Date = new Date()): Promise<ImportSummary> {
    const { contacts, unmappedHeaders } = csvToFields(text);
    let imported = 0;
    let skipped = 0;
    for (const f of contacts) {
      if (!f.fn.trim() && !deriveDisplayName(f).trim()) {
        skipped++;
        continue;
      }
      if (validateFields(f)) {
        skipped++;
        continue;
      }
      await this.save(f, now);
      imported++;
    }
    return { imported, skipped, unmappedHeaders };
  }

  fieldsOf(contact: Contact): ContactFields {
    const cards = parseVCards(contact.vcard);
    const fields = cards.length ? propsToFields(cards[0]) : propsToFields([]);
    fields.uid = contact.uid;
    return fields;
  }
}

export class ContactValidationError extends Error {}
