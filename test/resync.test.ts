import { describe, expect, it } from "vitest";
import { ContactService } from "../src/lib/contacts";
import { describeSchedule, DEFAULT_SCHEDULE, nextOccurrence, parseSchedule, ResyncError, zonedTimeToUtc, type ResyncSchedule, type ResyncStatus } from "../src/lib/resync";
import { emptyFields, fieldsToVCard, parseVCards, withRev } from "../src/lib/vcard";
import { adminAuth, makeApp, okProps, responses, xml, type TestApp } from "./helpers";
import { findChild, NS_DAV } from "../src/lib/xml";

const propOf = (vcard: string, name: string) =>
  parseVCards(vcard)[0].filter((p) => p.name === name).map((p) => p.value);

const at = (iso: string) => new Date(iso);

describe("withRev", () => {
  it("replaces an existing REV and keeps everything else", () => {
    const card = fieldsToVCard({ ...emptyFields(), uid: "x", fn: "Ada" }, at("2026-01-01T00:00:00Z"));
    const out = withRev(card, at("2026-05-06T07:08:09.123Z"));
    expect(propOf(out, "REV")).toEqual(["2026-05-06T07:08:09Z"]);
    expect(propOf(out, "FN")).toEqual(["Ada"]);
    expect(out.endsWith("END:VCARD\r\n")).toBe(true);
  });

  it("adds REV before END:VCARD when the card has none", () => {
    const bare = "BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\nFN:Ada\r\nEND:VCARD\r\n";
    const out = withRev(bare, at("2026-05-06T07:08:09Z"));
    expect(out).toBe("BEGIN:VCARD\r\nVERSION:3.0\r\nUID:x\r\nFN:Ada\r\nREV:2026-05-06T07:08:09Z\r\nEND:VCARD\r\n");
  });
});

describe("schedule parsing and description", () => {
  it("accepts a full schedule and fills defaults", () => {
    const s = parseSchedule({ mode: "weekly", weekday: 5, time: "18:30", timeZone: "Europe/Berlin" });
    expect(s).toEqual({ mode: "weekly", everyHours: 24, time: "18:30", weekday: 5, timeZone: "Europe/Berlin" });
    expect(describeSchedule(s)).toBe("Every Friday at 18:30 (Europe/Berlin)");
    expect(describeSchedule({ ...DEFAULT_SCHEDULE, mode: "interval", everyHours: 1 })).toBe("Every hour");
    expect(describeSchedule({ ...DEFAULT_SCHEDULE, mode: "interval", everyHours: 6 })).toBe("Every 6 hours");
    expect(describeSchedule({ ...DEFAULT_SCHEDULE, mode: "interval", everyHours: 48 })).toBe("Every 2 days");
    expect(describeSchedule({ ...DEFAULT_SCHEDULE, mode: "daily" })).toBe("Daily at 03:00 (UTC)");
  });

  it("rejects bad input", () => {
    expect(() => parseSchedule(null)).toThrow(ResyncError);
    expect(() => parseSchedule({ mode: "hourly" })).toThrow(/mode/);
    expect(() => parseSchedule({ mode: "interval", everyHours: 0 })).toThrow(/everyHours/);
    expect(() => parseSchedule({ mode: "interval", everyHours: 1.5 })).toThrow(/everyHours/);
    expect(() => parseSchedule({ mode: "daily", time: "25:00" })).toThrow(/HH:MM/);
    expect(() => parseSchedule({ mode: "daily", time: "3:00" })).toThrow(/HH:MM/);
    expect(() => parseSchedule({ mode: "weekly", weekday: 7 })).toThrow(/weekday/);
    expect(() => parseSchedule({ mode: "daily", timeZone: "Mars/Olympus" })).toThrow(/time zone/);
  });
});

describe("next occurrence", () => {
  const daily = (time: string, timeZone: string): ResyncSchedule => ({ ...DEFAULT_SCHEDULE, mode: "daily", time, timeZone });

  it("converts wall-clock times to UTC across DST", () => {
    // Berlin is UTC+1 in winter, UTC+2 in summer.
    expect(zonedTimeToUtc(2026, 1, 15, 3, 0, "Europe/Berlin").toISOString()).toBe("2026-01-15T02:00:00.000Z");
    expect(zonedTimeToUtc(2026, 7, 15, 3, 0, "Europe/Berlin").toISOString()).toBe("2026-07-15T01:00:00.000Z");
    // New York is UTC-5 / UTC-4.
    expect(zonedTimeToUtc(2026, 1, 15, 22, 30, "America/New_York").toISOString()).toBe("2026-01-16T03:30:00.000Z");
    // 02:30 does not exist on 2026-03-29 in Berlin (clocks jump 02:00 → 03:00); resolves after the gap.
    expect(zonedTimeToUtc(2026, 3, 29, 2, 30, "Europe/Berlin").toISOString()).toBe("2026-03-29T01:30:00.000Z");
  });

  it("finds the next daily run today or tomorrow in the configured zone", () => {
    const s = daily("03:00", "Europe/Berlin");
    // 00:30 UTC = 01:30 Berlin → today 03:00 Berlin = 02:00 UTC.
    expect(nextOccurrence(s, at("2026-01-15T00:30:00Z"))!.toISOString()).toBe("2026-01-15T02:00:00.000Z");
    // Exactly at the run time → the next day (strictly after).
    expect(nextOccurrence(s, at("2026-01-15T02:00:00Z"))!.toISOString()).toBe("2026-01-16T02:00:00.000Z");
    // 23:30 UTC = 00:30 Berlin next day → that day's 03:00.
    expect(nextOccurrence(s, at("2026-01-15T23:30:00Z"))!.toISOString()).toBe("2026-01-16T02:00:00.000Z");
  });

  it("finds the next weekly run", () => {
    const s: ResyncSchedule = { ...DEFAULT_SCHEDULE, mode: "weekly", weekday: 1, time: "06:00", timeZone: "UTC" };
    // 2026-01-15 is a Thursday → Monday 2026-01-19.
    expect(nextOccurrence(s, at("2026-01-15T12:00:00Z"))!.toISOString()).toBe("2026-01-19T06:00:00.000Z");
    // Monday morning before 06:00 → same day; after → the following Monday.
    expect(nextOccurrence(s, at("2026-01-19T05:59:00Z"))!.toISOString()).toBe("2026-01-19T06:00:00.000Z");
    expect(nextOccurrence(s, at("2026-01-19T06:00:00Z"))!.toISOString()).toBe("2026-01-26T06:00:00.000Z");
  });

  it("spaces interval runs from the last run and returns null when off", () => {
    const s: ResyncSchedule = { ...DEFAULT_SCHEDULE, mode: "interval", everyHours: 6 };
    expect(nextOccurrence(s, at("2026-01-15T12:00:00Z"))!.toISOString()).toBe("2026-01-15T18:00:00.000Z");
    expect(nextOccurrence(s, at("2026-01-15T12:00:00Z"), at("2026-01-15T11:00:00Z"))!.toISOString()).toBe("2026-01-15T17:00:00.000Z");
    expect(nextOccurrence(DEFAULT_SCHEDULE, at("2026-01-15T12:00:00Z"))).toBeNull();
  });
});

// ---------------------------------------------------------------------------

const syncReport = (token: string) => `<?xml version="1.0" encoding="utf-8"?>
<D:sync-collection xmlns:D="DAV:"><D:sync-token>${token}</D:sync-token><D:sync-level>1</D:sync-level><D:prop><D:getetag/></D:prop></D:sync-collection>`;

async function seed(t: TestApp) {
  const svc = new ContactService(t.storage);
  const rev = at("2026-01-01T00:00:00Z");
  await svc.save({ ...emptyFields(), uid: "c1", fn: "Ada Lovelace" }, rev);
  await svc.save({ ...emptyFields(), uid: "c2", fn: "Grace Hopper" }, rev);
}

async function initialSync(t: TestApp) {
  const res = await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: syncReport("") });
  const ms = xml(await res.text());
  const etags = new Map<string, string>();
  for (const r of responses(ms)) {
    const href = findChild(r, NS_DAV, "href")!.text;
    etags.set(href, findChild(okProps(r), NS_DAV, "getetag")!.text);
  }
  return { token: findChild(ms, NS_DAV, "sync-token")!.text, etags };
}

const json = { "Content-Type": "application/json" };

describe("forced re-sync", () => {
  it("runs on demand: every contact gets a new REV, ETag and appears in the next sync-collection", async () => {
    const clock = { now: at("2026-01-15T10:00:00Z") };
    const t = await makeApp({ now: () => clock.now });
    await seed(t);
    const before = await initialSync(t);

    // Nothing changed: an incremental sync is empty.
    const idle = xml(await (await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: syncReport(before.token) })).text());
    expect(responses(idle)).toHaveLength(0);

    const run = await t.fetch("/api/resync/run", { method: "POST", auth: adminAuth });
    expect(run.status).toBe(200);
    const body = (await run.json()) as ResyncStatus & { run: { contacts: number; reason: string } };
    expect(body.run).toMatchObject({ contacts: 2, reason: "manual" });
    expect(body.lastRun).toMatchObject({ at: "2026-01-15T10:00:00.000Z", contacts: 2, reason: "manual" });
    expect(body.nextRun).toBeNull();

    // Every card is reported as changed with a different ETag; the stored REV moved.
    const delta = xml(await (await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: syncReport(before.token) })).text());
    const rs = responses(delta);
    expect(rs).toHaveLength(2);
    for (const r of rs) {
      const href = findChild(r, NS_DAV, "href")!.text;
      expect(findChild(okProps(r), NS_DAV, "getetag")!.text).not.toBe(before.etags.get(href));
    }
    expect(propOf((await t.storage.getContact("c1"))!.vcard, "REV")).toEqual(["2026-01-15T10:00:00Z"]);
    expect(propOf((await t.storage.getContact("c1"))!.vcard, "FN")).toEqual(["Ada Lovelace"]);
  });

  it("stores a schedule and fires lazily on the first request after the due time", async () => {
    const clock = { now: at("2026-01-15T10:00:00Z") }; // Thursday 11:00 in Berlin
    const t = await makeApp({ now: () => clock.now });
    await seed(t);
    const before = await initialSync(t);

    const put = await t.fetch("/api/resync", {
      method: "PUT",
      auth: adminAuth,
      headers: json,
      body: JSON.stringify({ mode: "daily", time: "03:00", timeZone: "Europe/Berlin" }),
    });
    expect(put.status).toBe(200);
    const status = (await put.json()) as ResyncStatus;
    expect(status.schedule).toMatchObject({ mode: "daily", time: "03:00", timeZone: "Europe/Berlin" });
    expect(status.description).toBe("Daily at 03:00 (Europe/Berlin)");
    expect(status.nextRun).toBe("2026-01-16T02:00:00.000Z");
    expect(status.lastRun).toBeNull();

    // Not due yet: incremental sync stays empty.
    clock.now = at("2026-01-16T01:59:00Z");
    let delta = xml(await (await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: syncReport(before.token) })).text());
    expect(responses(delta)).toHaveLength(0);

    // Due: the request that arrives after 03:00 Berlin already sees the new revisions.
    clock.now = at("2026-01-16T02:00:30Z");
    delta = xml(await (await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: syncReport(before.token) })).text());
    expect(responses(delta)).toHaveLength(2);
    const newToken = findChild(delta, NS_DAV, "sync-token")!.text;

    const after = (await (await t.fetch("/api/resync", { auth: adminAuth })).json()) as ResyncStatus;
    expect(after.lastRun).toMatchObject({ at: "2026-01-16T02:00:30.000Z", contacts: 2, reason: "schedule" });
    expect(after.nextRun).toBe("2026-01-17T02:00:00.000Z");

    // It does not fire again until the next occurrence.
    clock.now = at("2026-01-16T12:00:00Z");
    delta = xml(await (await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: syncReport(newToken) })).text());
    expect(responses(delta)).toHaveLength(0);

    // Several missed days collapse into one run, rescheduled from the actual run time.
    clock.now = at("2026-01-20T15:00:00Z");
    delta = xml(await (await t.fetch("/dav/addressbooks/shared/", { method: "REPORT", body: syncReport(newToken) })).text());
    expect(responses(delta)).toHaveLength(2);
    const later = (await (await t.fetch("/api/resync", { auth: adminAuth })).json()) as ResyncStatus;
    expect(later.lastRun?.at).toBe("2026-01-20T15:00:00.000Z");
    expect(later.nextRun).toBe("2026-01-21T02:00:00.000Z");
  });

  it("interval schedules run from the last run; switching off clears the next run", async () => {
    const clock = { now: at("2026-01-15T10:00:00Z") };
    const t = await makeApp({ now: () => clock.now });
    await seed(t);

    const put = await t.fetch("/api/resync", {
      method: "PUT",
      auth: adminAuth,
      headers: json,
      body: JSON.stringify({ mode: "interval", everyHours: 6 }),
    });
    expect(((await put.json()) as ResyncStatus).nextRun).toBe("2026-01-15T16:00:00.000Z");

    clock.now = at("2026-01-15T16:10:00Z");
    await t.fetch("/healthz");
    let s = (await (await t.fetch("/api/resync", { auth: adminAuth })).json()) as ResyncStatus;
    expect(s.lastRun?.at).toBe("2026-01-15T16:10:00.000Z");
    expect(s.nextRun).toBe("2026-01-15T22:10:00.000Z");

    const off = await t.fetch("/api/resync", { method: "PUT", auth: adminAuth, headers: json, body: JSON.stringify({ mode: "off" }) });
    s = (await off.json()) as ResyncStatus;
    expect(s.nextRun).toBeNull();
    expect(s.description).toBe("Off");

    clock.now = at("2026-02-01T00:00:00Z");
    const seqBefore = await t.storage.currentSeq();
    await t.fetch("/healthz");
    expect(await t.storage.currentSeq()).toBe(seqBefore);
  });

  it("validates schedules and requires an admin", async () => {
    const t = await makeApp();
    const bad = await t.fetch("/api/resync", { method: "PUT", auth: adminAuth, headers: json, body: JSON.stringify({ mode: "daily", time: "nope" }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/HH:MM/);

    const tz = await t.fetch("/api/resync", { method: "PUT", auth: adminAuth, headers: json, body: JSON.stringify({ mode: "daily", timeZone: "Nowhere/Land" }) });
    expect(tz.status).toBe(400);

    const asUser = await t.fetch("/api/resync/run", { method: "POST" });
    expect(asUser.status).toBe(401);
  });
});
