import { describe, expect, it } from "vitest";
import { LOCK_MARK, markLocked } from "../src/lib/lockmark";
import { emptyFields, fieldsToVCard, parseVCards, unfoldLines } from "../src/lib/vcard";
import { ContactService } from "../src/lib/contacts";
import { adminAuth, basic, makeApp, okProps, responses, USER_PASSWORD, xml, type TestApp } from "./helpers";
import { findChild, NS_CARDDAV, NS_CS, NS_DAV } from "../src/lib/xml";

const propOf = (vcard: string, name: string) =>
  parseVCards(vcard)[0].filter((p) => p.name === name).map((p) => p.value);

describe("markLocked", () => {
  it("appends the marker to FN and to the family name in N", () => {
    const f = { ...emptyFields(), uid: "x", fn: "Ada Lovelace", n: { ...emptyFields().n, given: "Ada", family: "Lovelace" } };
    const out = markLocked(fieldsToVCard(f));
    expect(propOf(out, "FN")).toEqual([`Ada Lovelace ${LOCK_MARK}`]);
    expect(propOf(out, "N")).toEqual([`Lovelace ${LOCK_MARK};Ada;;;`]);
    expect(propOf(out, "UID")).toEqual(["x"]);
    expect(out.endsWith("\r\n")).toBe(true);
    expect(unfoldLines(out).every((l) => new TextEncoder().encode(l).length > 0)).toBe(true);
  });

  it("uses the given name when there is no family name", () => {
    const f = { ...emptyFields(), uid: "x", fn: "Cher", n: { ...emptyFields().n, given: "Cher" } };
    const out = markLocked(fieldsToVCard(f));
    expect(propOf(out, "N")).toEqual([`;Cher ${LOCK_MARK};;;`]);
    expect(propOf(out, "ORG")).toEqual([]);
  });

  it("marks ORG for company cards without a personal name", () => {
    const f = { ...emptyFields(), uid: "x", fn: "", org: "Acme, Inc.", department: "Sales" };
    const out = markLocked(fieldsToVCard(f));
    expect(propOf(out, "FN")).toEqual([`Acme\\, Inc. ${LOCK_MARK}`]);
    expect(propOf(out, "ORG")).toEqual([`Acme\\, Inc. ${LOCK_MARK};Sales`]);
    expect(propOf(out, "N")).toEqual([";;;;"]);
  });

  it("is idempotent and keeps lines folded at 75 octets", () => {
    const long = "Maximilian Alexander Konstantin von Hohenberg-Zollern zu Wittelsbach";
    const f = { ...emptyFields(), uid: "x", fn: long, n: { ...emptyFields().n, given: "Maximilian", family: long } };
    const once = markLocked(fieldsToVCard(f));
    expect(markLocked(once)).toBe(once);
    for (const raw of once.split("\r\n")) expect(new TextEncoder().encode(raw).length).toBeLessThanOrEqual(75);
    expect(propOf(once, "FN")).toEqual([`${long} ${LOCK_MARK}`]);
  });

  it("leaves cards without any name untouched", () => {
    const bare = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\nEND:VCARD\r\n";
    expect(markLocked(bare)).toBe(bare);
  });
});

async function seedAda(t: TestApp) {
  const svc = new ContactService(t.storage);
  return svc.save({ ...emptyFields(), uid: "c1", fn: "Ada Lovelace", n: { ...emptyFields().n, given: "Ada", family: "Lovelace" } });
}

const multiget = `<?xml version="1.0" encoding="utf-8"?>
<B:addressbook-multiget xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:carddav"><A:prop><A:getetag/><B:address-data/></A:prop><A:href>/dav/addressbooks/shared/c1.vcf</A:href></B:addressbook-multiget>`;

describe("lock marker on the CardDAV surface", () => {
  it("serves marked vCards with a matching ETag while storage and admin API stay clean", async () => {
    const t = await makeApp();
    const stored = await seedAda(t);

    const get = await t.fetch("/dav/addressbooks/shared/c1.vcf");
    expect(get.status).toBe(200);
    const body = await get.text();
    expect(propOf(body, "FN")).toEqual([`Ada Lovelace ${LOCK_MARK}`]);
    const etag = get.headers.get("etag")!;
    expect(etag).not.toBe(stored.etag);

    // Conditional GET works with the served ETag.
    const cond = await t.fetch("/dav/addressbooks/shared/c1.vcf", { headers: { "If-None-Match": etag } });
    expect(cond.status).toBe(304);

    // PROPFIND getetag and REPORT address-data agree with GET.
    const pf = await t.fetch("/dav/addressbooks/shared/c1.vcf", {
      method: "PROPFIND",
      body: `<?xml version="1.0"?><A:propfind xmlns:A="DAV:"><A:prop><A:getetag/></A:prop></A:propfind>`,
    });
    expect(findChild(okProps(responses(xml(await pf.text()))[0]), NS_DAV, "getetag")?.text).toBe(etag);

    const rep = await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: multiget });
    const props = okProps(responses(xml(await rep.text()))[0]);
    expect(findChild(props, NS_DAV, "getetag")?.text).toBe(etag);
    expect(findChild(props, NS_CARDDAV, "address-data")?.text).toContain(`FN:Ada Lovelace ${LOCK_MARK}`);

    // Storage and the admin API are untouched.
    expect((await t.storage.getContact("c1"))!.vcard).not.toContain(LOCK_MARK);
    const admin = await t.fetch("/api/contacts/c1", { auth: adminAuth });
    const detail = (await admin.json()) as { fields: { fn: string }; vcard: string };
    expect(detail.fields.fn).toBe("Ada Lovelace");
    expect(detail.vcard).not.toContain(LOCK_MARK);
    const exported = await t.fetch("/api/contacts/export.vcf", { auth: adminAuth });
    expect(await exported.text()).not.toContain(LOCK_MARK);
  });

  it("can be switched off, which bumps the ctag so devices resync", async () => {
    const t = await makeApp();
    await seedAda(t);
    const ctag = async () => {
      const r = await t.fetch("/dav/addressbooks/shared/", {
        method: "PROPFIND",
        headers: { Depth: "0" },
        body: `<?xml version="1.0"?><A:propfind xmlns:A="DAV:" xmlns:C="http://calendarserver.org/ns/"><A:prop><C:getctag/></A:prop></A:propfind>`,
      });
      return findChild(okProps(responses(xml(await r.text()))[0]), NS_CS, "getctag")?.text;
    };
    const before = await ctag();

    const settings = await t.fetch("/api/settings", { auth: adminAuth });
    expect(((await settings.json()) as { lockMarker: boolean }).lockMarker).toBe(true);

    const off = await t.fetch("/api/settings", {
      method: "PUT",
      auth: adminAuth,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lockMarker: false }),
    });
    expect(((await off.json()) as { touched: number }).touched).toBe(1);
    expect(await ctag()).not.toBe(before);

    const get = await t.fetch("/dav/addressbooks/shared/c1.vcf", { auth: basic("alice", USER_PASSWORD) });
    expect(propOf(await get.text(), "FN")).toEqual(["Ada Lovelace"]);

    // Saving the same value again is a no-op.
    const same = await t.fetch("/api/settings", {
      method: "PUT",
      auth: adminAuth,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ lockMarker: false }),
    });
    expect(((await same.json()) as { touched: number }).touched).toBe(0);
  });
});
