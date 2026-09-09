import type { Storage, User } from "../storage/types";
import type { AuthService } from "../lib/auth";
import type { ContactService } from "../lib/contacts";

export interface DavSettings {
  addressbookName: string;
  addressbookDescription: string;
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

export async function loadDavSettings(storage: Storage): Promise<DavSettings> {
  return {
    addressbookName: (await storage.getSetting("addressbook_name")) ?? DEFAULT_ADDRESSBOOK_NAME,
    addressbookDescription:
      (await storage.getSetting("addressbook_description")) ?? DEFAULT_ADDRESSBOOK_DESCRIPTION,
  };
}
