import type { Contact, Storage, User } from "../storage/types";
import type { AuthService } from "../lib/auth";
import type { ContactService } from "../lib/contacts";
import { presentForDevice } from "../lib/lockmark";

export interface DavSettings {
  addressbookName: string;
  addressbookDescription: string;
  /** Append the 🔒 marker to names in vCards served to devices. */
  lockMarker: boolean;
}

export interface DavContext {
  storage: Storage;
  auth: AuthService;
  contacts: ContactService;
  user: User;
  settings: DavSettings;
}

export const DEFAULT_ADDRESSBOOK_NAME = "Company Directory";
export const DEFAULT_ADDRESSBOOK_DESCRIPTION = "Shared company address book (read-only)";
export const LOCK_MARKER_SETTING = "lock_marker";

export async function loadLockMarkerSetting(storage: Storage): Promise<boolean> {
  return ((await storage.getSetting(LOCK_MARKER_SETTING)) ?? "1") !== "0";
}

export async function loadDavSettings(storage: Storage): Promise<DavSettings> {
  return {
    addressbookName: (await storage.getSetting("addressbook_name")) ?? DEFAULT_ADDRESSBOOK_NAME,
    addressbookDescription:
      (await storage.getSetting("addressbook_description")) ?? DEFAULT_ADDRESSBOOK_DESCRIPTION,
    lockMarker: await loadLockMarkerSetting(storage),
  };
}

/** Applies the device-facing presentation (lock marker + matching ETag) to stored contacts. */
export function present(ctx: DavContext, contact: Contact): Promise<Contact> {
  return presentForDevice(contact, ctx.settings.lockMarker);
}

export function presentAll(ctx: DavContext, contacts: Contact[]): Promise<Contact[]> {
  if (!ctx.settings.lockMarker) return Promise.resolve(contacts);
  return Promise.all(contacts.map((c) => present(ctx, c)));
}
