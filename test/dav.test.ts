import { describe, expect, it } from "vitest";
import { adminAuth, hrefOf, makeApp, notFoundProps, okProps, responses, statusOf, xml, type TestApp } from "./helpers";
import { findChild, findChildren, NS_CARDDAV, NS_CS, NS_DAV } from "../src/lib/xml";
import { emptyFields } from "../src/lib/vcard";
import { ContactService } from "../src/lib/contacts";

const propfind = (props: string) =>
  `<?xml version="1.0" encoding="utf-8"?>
<A:propfind xmlns:A="DAV:" xmlns:B="urn:ietf:params:xml:ns:carddav" xmlns:C="http://calendarserver.org/ns/"><A:prop>${props}</A:prop></A:propfind>`;

async function seed(t: TestApp, uid: string, name: string, extra: Partial<ReturnType<typeof emptyFields>> = {}) {
  const svc = new ContactService(t.storage);
  const f = { ...emptyFields(), ...extra, uid };
  const [given, family] = name.split(" ");
  f.n = { ...f.n, given, family: family ?? "" };
  f.fn = name;
  return svc.save(f);
}

async function seeded() {
  const t = await makeApp();
  await seed(t, "c1", "Ada Lovelace", { org: "FlareCard", emails: [{ type: "WORK", value: "ada@example.com" }] });
  await seed(t, "c2", "Grace Hopper", { org: "Navy", phones: [{ type: "CELL", value: "+1 555 0102" }] });
  await seed(t, "c3", "Alan Turing", { org: "FlareCard", emails: [{ type: "WORK", value: "alan@example.com" }] });
  return t;
}

describe("discovery", () => {
  it("redirects /.well-known/carddav to the DAV root", async () => {
    const t = await makeApp();
    const res = await t.fetch("/.well-known/carddav", { auth: null, redirect: "manual" });
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/dav/");
  });

  it("answers PROPFIND on the root with current-user-principal", async () => {
    const t = await makeApp();
    const res = await t.fetch("/dav/", {
      method: "PROPFIND",
      headers: { Depth: "0" },
      body: propfind("<A:current-user-principal/><A:resourcetype/><A:principal-collection-set/><A:foo/>"),
    });
    expect(res.status).toBe(207);
    expect(res.headers.get("content-type")).toContain("application/xml");
    const ms = xml(await res.text());
    expect(ms.ns).toBe(NS_DAV);
    expect(ms.name).toBe("multistatus");
    const [r] = responses(ms);
    expect(hrefOf(r)).toBe("/dav/");
    const ok = okProps(r)!;
    const cup = findChild(ok, NS_DAV, "current-user-principal");
    expect(findChild(cup, NS_DAV, "href")?.text).toBe("/dav/principals/alice/");
    expect(findChild(findChild(ok, NS_DAV, "resourcetype"), NS_DAV, "collection")).toBeDefined();
    expect(findChild(notFoundProps(r), NS_DAV, "foo")).toBeDefined();
  });

  it("serves the principal with principal-URL, addressbook-home-set and displayname", async () => {
    const t = await makeApp();
    const res = await t.fetch("/dav/principals/alice/", {
      method: "PROPFIND",
      headers: { Depth: "0" },
      body: propfind(
        "<A:principal-URL/><B:addressbook-home-set/><A:displayname/><A:resourcetype/><A:current-user-privilege-set/><C:email-address-set/>",
      ),
    });
    expect(res.status).toBe(207);
    const [r] = responses(xml(await res.text()));
    const ok = okProps(r)!;
    expect(findChild(findChild(ok, NS_DAV, "principal-URL"), NS_DAV, "href")?.text).toBe("/dav/principals/alice/");
    expect(findChild(findChild(ok, NS_CARDDAV, "addressbook-home-set"), NS_DAV, "href")?.text).toBe("/dav/addressbooks/");
    expect(findChild(ok, NS_DAV, "displayname")?.text).toBe("alice");
    expect(findChild(findChild(ok, NS_DAV, "resourcetype"), NS_DAV, "principal")).toBeDefined();
    const privs = findChildren(findChild(ok, NS_DAV, "current-user-privilege-set"), NS_DAV, "privilege");
    expect(privs.some((p) => findChild(p, NS_DAV, "read"))).toBe(true);
    expect(privs.some((p) => findChild(p, NS_DAV, "write"))).toBe(false);
    expect(findChild(notFoundProps(r), NS_CS, "email-address-set")).toBeDefined();
  });

  it("hides other users' principals from regular users", async () => {
    const t = await makeApp();
    const res = await t.fetch("/dav/principals/admin/", { method: "PROPFIND", body: propfind("<A:displayname/>") });
    expect(res.status).toBe(404);
  });

  it("lists the shared address book under the home set (Depth: 1)", async () => {
    const t = await makeApp();
    const res = await t.fetch("/dav/addressbooks/", {
      method: "PROPFIND",
      headers: { Depth: "1" },
      body: propfind("<A:resourcetype/><A:displayname/><C:getctag/>"),
    });
    const rs = responses(xml(await res.text()));
    expect(rs.map(hrefOf)).toEqual(["/dav/addressbooks/", "/dav/addressbooks/shared/"]);
    const ab = okProps(rs[1])!;
    const rt = findChild(ab, NS_DAV, "resourcetype");
    expect(findChild(rt, NS_DAV, "collection")).toBeDefined();
    expect(findChild(rt, NS_CARDDAV, "addressbook")).toBeDefined();
    expect(findChild(ab, NS_CS, "getctag")?.text).toMatch(/^flarecard-\d+$/);
  });

  it("rejects Depth: infinity", async () => {
    const t = await makeApp();
    const res = await t.fetch("/dav/", { method: "PROPFIND", headers: { Depth: "infinity" }, body: propfind("<A:displayname/>") });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("propfind-finite-depth");
  });
});

describe("address book properties", () => {
  it("exposes getctag, sync-token, supported-report-set, supported-address-data and privileges", async () => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/shared/", {
      method: "PROPFIND",
      headers: { Depth: "0" },
      body: propfind(
        "<A:resourcetype/><A:displayname/><C:getctag/><A:sync-token/><A:supported-report-set/><B:supported-address-data/><B:addressbook-description/><A:current-user-privilege-set/><B:max-resource-size/><A:owner/>",
      ),
    });
    const [r] = responses(xml(await res.text()));
    const ok = okProps(r)!;
    expect(findChild(ok, NS_DAV, "displayname")?.text).toBe("Company Directory");
    expect(findChild(ok, NS_CS, "getctag")?.text).toBe("flarecard-3");
    expect(findChild(ok, NS_DAV, "sync-token")?.text).toBe("urn:x-flarecard:sync:3");
    const reports = findChildren(findChild(ok, NS_DAV, "supported-report-set"), NS_DAV, "supported-report").map(
      (sr) => findChild(sr, NS_DAV, "report")!.children[0],
    );
    expect(reports.map((r) => `${r.ns}|${r.name}`).sort()).toEqual(
      [`${NS_CARDDAV}|addressbook-multiget`, `${NS_CARDDAV}|addressbook-query`, `${NS_DAV}|sync-collection`].sort(),
    );
    const adt = findChild(findChild(ok, NS_CARDDAV, "supported-address-data"), NS_CARDDAV, "address-data-type");
    expect(adt?.attrs["content-type"]).toBe("text/vcard");
    expect(adt?.attrs.version).toBe("3.0");
    expect(findChild(ok, NS_CARDDAV, "addressbook-description")?.text).toContain("read-only");
    expect(findChild(ok, NS_CARDDAV, "max-resource-size")?.text).toBe("1048576");
    expect(findChild(findChild(ok, NS_DAV, "owner"), NS_DAV, "href")?.text).toBe("/dav/principals/alice/");
  });

  it("grants write privileges to admins only", async () => {
    const t = await makeApp();
    const body = propfind("<A:current-user-privilege-set/>");
    const asAdmin = await t.fetch("/dav/addressbooks/shared/", { method: "PROPFIND", body, auth: adminAuth });
    const [r] = responses(xml(await asAdmin.text()));
    const privs = findChildren(findChild(okProps(r), NS_DAV, "current-user-privilege-set"), NS_DAV, "privilege");
    expect(privs.some((p) => findChild(p, NS_DAV, "write"))).toBe(true);
  });

  it("lists .vcf children with getetag and getcontenttype at Depth: 1", async () => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/shared/", {
      method: "PROPFIND",
      headers: { Depth: "1" },
      body: propfind("<A:getetag/><A:getcontenttype/><A:resourcetype/>"),
    });
    const rs = responses(xml(await res.text()));
    expect(rs).toHaveLength(4);
    expect(hrefOf(rs[0])).toBe("/dav/addressbooks/shared/");
    const children = rs.slice(1);
    expect(children.map(hrefOf).sort()).toEqual([
      "/dav/addressbooks/shared/c1.vcf",
      "/dav/addressbooks/shared/c2.vcf",
      "/dav/addressbooks/shared/c3.vcf",
    ]);
    for (const c of children) {
      const ok = okProps(c)!;
      expect(findChild(ok, NS_DAV, "getetag")?.text).toMatch(/^"[0-9a-f]{32}"$/);
      expect(findChild(ok, NS_DAV, "getcontenttype")?.text).toBe("text/vcard; charset=utf-8");
      expect(findChild(ok, NS_DAV, "resourcetype")?.children).toHaveLength(0);
    }
  });
});

describe("GET/HEAD and ETags", () => {
  it("serves vCards with ETag and text/vcard content type", async () => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/shared/c1.vcf");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/vcard; charset=utf-8");
    const etag = res.headers.get("etag")!;
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const body = await res.text();
    expect(body).toContain("BEGIN:VCARD\r\nVERSION:3.0");
    expect(body).toContain("FN:Ada Lovelace");

    // PROPFIND getetag matches the GET ETag.
    const pf = await t.fetch("/dav/addressbooks/shared/c1.vcf", { method: "PROPFIND", body: propfind("<A:getetag/>") });
    const [r] = responses(xml(await pf.text()));
    expect(findChild(okProps(r), NS_DAV, "getetag")?.text).toBe(etag);

    const head = await t.fetch("/dav/addressbooks/shared/c1.vcf", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(head.headers.get("etag")).toBe(etag);

    const cond = await t.fetch("/dav/addressbooks/shared/c1.vcf", { headers: { "If-None-Match": etag } });
    expect(cond.status).toBe(304);
  });

  it("changes the ETag, ctag and sync-token when a contact is edited", async () => {
    const t = await seeded();
    const before = await t.fetch("/dav/addressbooks/shared/c1.vcf");
    const etagBefore = before.headers.get("etag");
    const svc = new ContactService(t.storage);
    const f = svc.fieldsOf((await t.storage.getContact("c1"))!);
    f.title = "Countess of Computing";
    await svc.save(f);
    const after = await t.fetch("/dav/addressbooks/shared/c1.vcf");
    expect(after.headers.get("etag")).not.toBe(etagBefore);
    const pf = await t.fetch("/dav/addressbooks/shared/", { method: "PROPFIND", body: propfind("<C:getctag/><A:sync-token/>") });
    const [r] = responses(xml(await pf.text()));
    expect(findChild(okProps(r), NS_CS, "getctag")?.text).toBe("flarecard-4");
    expect(findChild(okProps(r), NS_DAV, "sync-token")?.text).toBe("urn:x-flarecard:sync:4");
  });

  it("returns 404 for unknown contacts", async () => {
    const t = await seeded();
    expect((await t.fetch("/dav/addressbooks/shared/nope.vcf")).status).toBe(404);
  });
});

describe("read-only enforcement", () => {
  it.each(["PUT", "DELETE", "PROPPATCH", "MKCOL", "MOVE", "COPY", "LOCK"])("rejects %s with 403 for users", async (method) => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/shared/c1.vcf", { method, body: "BEGIN:VCARD\r\nEND:VCARD\r\n" });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("need-privileges");
  });

  it("rejects PUT with 403 even for admins", async () => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/shared/new.vcf", { method: "PUT", body: "BEGIN:VCARD\r\nEND:VCARD\r\n", auth: adminAuth });
    expect(res.status).toBe(403);
    expect(await t.storage.getContact("new")).toBeNull();
  });
});

describe("REPORT addressbook-multiget", () => {
  it("returns address-data and getetag for each href, 404 for missing ones", async () => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/shared/", {
      method: "REPORT",
      headers: { Depth: "1" },
      body: `<?xml version="1.0" encoding="utf-8"?>
<C:addressbook-multiget xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop><D:getetag/><C:address-data/></D:prop>
  <D:href>/dav/addressbooks/shared/c1.vcf</D:href>
  <D:href>https://contacts.example.com/dav/addressbooks/shared/c2.vcf</D:href>
  <D:href>/dav/addressbooks/shared/missing.vcf</D:href>
</C:addressbook-multiget>`,
    });
    expect(res.status).toBe(207);
    const rs = responses(xml(await res.text()));
    expect(rs).toHaveLength(3);
    const c1 = okProps(rs[0])!;
    expect(findChild(c1, NS_DAV, "getetag")?.text).toMatch(/^"/);
    expect(findChild(c1, NS_CARDDAV, "address-data")?.text).toContain("FN:Ada Lovelace");
    expect(hrefOf(rs[1])).toBe("/dav/addressbooks/shared/c2.vcf");
    expect(findChild(okProps(rs[1]), NS_CARDDAV, "address-data")?.text).toContain("FN:Grace Hopper");
    expect(hrefOf(rs[2])).toBe("/dav/addressbooks/shared/missing.vcf");
    expect(statusOf(rs[2])).toBe("HTTP/1.1 404 Not Found");
  });

  it("rejects unknown reports", async () => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/shared/", {
      method: "REPORT",
      body: `<D:principal-property-search xmlns:D="DAV:"/>`,
    });
    expect(res.status).toBe(403);
    expect(await res.text()).toContain("supported-report");
  });
});

describe("REPORT addressbook-query", () => {
  const query = (filter: string) => `<?xml version="1.0" encoding="utf-8"?>
<C:addressbook-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:prop><D:getetag/><C:address-data/></D:prop>
  ${filter}
</C:addressbook-query>`;

  it("filters by text-match on FN (contains, case-insensitive)", async () => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/shared/", {
      method: "REPORT",
      body: query(`<C:filter><C:prop-filter name="FN"><C:text-match collation="i;unicode-casemap" match-type="contains">grace</C:text-match></C:prop-filter></C:filter>`),
    });
    const rs = responses(xml(await res.text()));
    expect(rs.map(hrefOf)).toEqual(["/dav/addressbooks/shared/c2.vcf"]);
  });

  it("supports allof across properties, starts-with, and is-not-defined", async () => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/shared/", {
      method: "REPORT",
      body: query(`<C:filter test="allof">
        <C:prop-filter name="ORG"><C:text-match match-type="equals">flarecard</C:text-match></C:prop-filter>
        <C:prop-filter name="EMAIL"><C:text-match match-type="starts-with">alan</C:text-match></C:prop-filter>
        <C:prop-filter name="TEL"><C:is-not-defined/></C:prop-filter>
      </C:filter>`),
    });
    const rs = responses(xml(await res.text()));
    expect(rs.map(hrefOf)).toEqual(["/dav/addressbooks/shared/c3.vcf"]);
  });

  it("returns everything for an empty filter and honours limit", async () => {
    const t = await seeded();
    const all = await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: query("<C:filter/>") });
    expect(responses(xml(await all.text()))).toHaveLength(3);
    const limited = await t.fetch("/dav/addressbooks/shared/", {
      method: "REPORT",
      body: query("<C:filter/><C:limit><D:nresults>2</D:nresults></C:limit>"),
    });
    const rs = responses(xml(await limited.text()));
    expect(rs).toHaveLength(3); // 2 results + the 507 truncation marker
    expect(statusOf(rs[2])).toContain("507");
  });

  it("supports negate-condition", async () => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/shared/", {
      method: "REPORT",
      body: query(`<C:filter><C:prop-filter name="ORG"><C:text-match negate-condition="yes">flarecard</C:text-match></C:prop-filter></C:filter>`),
    });
    expect(responses(xml(await res.text())).map(hrefOf)).toEqual(["/dav/addressbooks/shared/c2.vcf"]);
  });
});

describe("REPORT sync-collection", () => {
  const sync = (token: string, extra = "") => `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:carddav">
  <D:sync-token>${token}</D:sync-token>
  <D:sync-level>1</D:sync-level>
  ${extra}
  <D:prop><D:getetag/></D:prop>
</D:sync-collection>`;

  it("performs an initial sync and then reports only changes and tombstones", async () => {
    const t = await seeded();
    const initial = await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: sync("") });
    expect(initial.status).toBe(207);
    const ms = xml(await initial.text());
    expect(responses(ms)).toHaveLength(3);
    const token = findChild(ms, NS_DAV, "sync-token")!.text;
    expect(token).toBe("urn:x-flarecard:sync:3");

    // No changes: empty response, same token.
    const idle = xml(await (await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: sync(token) })).text());
    expect(responses(idle)).toHaveLength(0);
    expect(findChild(idle, NS_DAV, "sync-token")!.text).toBe(token);

    // Edit c1, delete c2, add c4.
    const svc = new ContactService(t.storage);
    const f = svc.fieldsOf((await t.storage.getContact("c1"))!);
    f.note = "edited";
    await svc.save(f);
    await t.storage.deleteContact("c2");
    await seed(t, "c4", "Katherine Johnson");

    const delta = xml(await (await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: sync(token) })).text());
    const rs = responses(delta);
    const byHref = new Map(rs.map((r) => [hrefOf(r), r]));
    expect([...byHref.keys()].sort()).toEqual([
      "/dav/addressbooks/shared/c1.vcf",
      "/dav/addressbooks/shared/c2.vcf",
      "/dav/addressbooks/shared/c4.vcf",
    ]);
    expect(statusOf(byHref.get("/dav/addressbooks/shared/c2.vcf")!)).toBe("HTTP/1.1 404 Not Found");
    expect(findChild(okProps(byHref.get("/dav/addressbooks/shared/c1.vcf")!), NS_DAV, "getetag")?.text).toMatch(/^"/);
    expect(findChild(delta, NS_DAV, "sync-token")!.text).toBe("urn:x-flarecard:sync:6");
  });

  it("does not report tombstones on an initial sync", async () => {
    const t = await seeded();
    await t.storage.deleteContact("c2");
    const ms = xml(await (await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: sync("") })).text());
    expect(responses(ms).map(hrefOf).sort()).toEqual(["/dav/addressbooks/shared/c1.vcf", "/dav/addressbooks/shared/c3.vcf"]);
  });

  it("returns 507 for unknown or future sync tokens", async () => {
    const t = await seeded();
    for (const token of ["urn:x-flarecard:sync:999", "http://other-server/sync/1", "garbage"]) {
      const res = await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: sync(token) });
      expect(res.status).toBe(507);
      expect(await res.text()).toContain("valid-sync-token");
    }
  });

  it("truncates with D:limit and hands out an intermediate token", async () => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/shared/", {
      method: "REPORT",
      body: sync("", "<D:limit><D:nresults>2</D:nresults></D:limit>"),
    });
    const ms = xml(await res.text());
    const rs = responses(ms);
    expect(rs).toHaveLength(3);
    expect(statusOf(rs[2])).toContain("507");
    const token = findChild(ms, NS_DAV, "sync-token")!.text;
    expect(token).toBe("urn:x-flarecard:sync:2");
    const rest = xml(await (await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: sync(token) })).text());
    expect(responses(rest).map(hrefOf)).toEqual(["/dav/addressbooks/shared/c3.vcf"]);
  });

  it("only allows sync-collection on the address book collection", async () => {
    const t = await seeded();
    const res = await t.fetch("/dav/addressbooks/", { method: "REPORT", body: sync("") });
    expect(res.status).toBe(403);
  });
});
