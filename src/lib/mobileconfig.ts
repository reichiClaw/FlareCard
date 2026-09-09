import { escapeXml } from "./xml";
import { principalHref } from "../dav/paths";

export interface MobileConfigOptions {
  host: string;
  port?: number;
  useSSL?: boolean;
  username: string;
  accountDescription?: string;
  organization?: string;
}

/**
 * Builds an unsigned Apple configuration profile with a com.apple.carddav.account
 * payload. Installing it on iOS/macOS creates the CardDAV account; the user is
 * prompted for the app password on install since we never embed secrets.
 */
export function buildMobileConfig(opts: MobileConfigOptions): string {
  const useSSL = opts.useSSL ?? true;
  const port = opts.port ?? (useSSL ? 443 : 80);
  const description = opts.accountDescription ?? "Company Directory";
  const org = opts.organization ?? "FlareCard";
  const payloadUUID = crypto.randomUUID().toUpperCase();
  const accountUUID = crypto.randomUUID().toUpperCase();
  const idSuffix = opts.host.replace(/[^a-zA-Z0-9.-]/g, "-");
  const x = escapeXml;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>CardDAVAccountDescription</key>
      <string>${x(description)}</string>
      <key>CardDAVHostName</key>
      <string>${x(opts.host)}</string>
      <key>CardDAVPort</key>
      <integer>${port}</integer>
      <key>CardDAVPrincipalURL</key>
      <string>${x(principalHref(opts.username))}</string>
      <key>CardDAVUseSSL</key>
      <${useSSL ? "true" : "false"}/>
      <key>CardDAVUsername</key>
      <string>${x(opts.username)}</string>
      <key>PayloadDescription</key>
      <string>Configures the ${x(description)} CardDAV account</string>
      <key>PayloadDisplayName</key>
      <string>${x(description)}</string>
      <key>PayloadIdentifier</key>
      <string>com.flarecard.${x(idSuffix)}.carddav.${x(opts.username.replace(/[^a-zA-Z0-9.-]/g, "-"))}</string>
      <key>PayloadType</key>
      <string>com.apple.carddav.account</string>
      <key>PayloadUUID</key>
      <string>${accountUUID}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Adds the ${x(description)} shared address book to Contacts.</string>
  <key>PayloadDisplayName</key>
  <string>${x(description)} (${x(opts.username)})</string>
  <key>PayloadIdentifier</key>
  <string>com.flarecard.${x(idSuffix)}.profile</string>
  <key>PayloadOrganization</key>
  <string>${x(org)}</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>${payloadUUID}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
`;
}
