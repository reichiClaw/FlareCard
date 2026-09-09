import { describe, expect, it } from "vitest";
import {
  emptyFields,
  fieldsToVCard,
  foldLine,
  importVCards,
  parseVCards,
  propsToFields,
  unfoldLines,
} from "../src/lib/vcard";
import { csvToFields } from "../src/lib/csv";

const REV = new Date("2026-01-02T03:04:05Z");

describe("vCard 3.0 serialization", () => {
  it("produces a strict vCard 3.0 with CRLF, N/FN, typed TEL/EMAIL/ADR and REV", () => {
    const f = emptyFields();
    f.uid = "abc-123";
    f.n = { family: "Lovelace", given: "Ada", additional: "", prefix: "", suffix: "" };
    f.fn = "Ada Lovelace";
    f.org = "FlareCard, Inc.";
    f.department = "Engineering";
    f.title = "CTO";
    f.phones = [{ type: "CELL", value: "+1 415 555 0101", pref: true }, { type: "WORK,FAX", value: "+1 415 555 0102" }];
    f.emails = [{ type: "WORK", value: "ada@example.com" }];
    f.addresses = [{ type: "WORK", street: "1 Main St", city: "SF", region: "CA", postalCode: "94105", country: "USA" }];
    f.note = "Line one\nLine two; with semicolon";
    const vcard = fieldsToVCard(f, REV);
    expect(vcard).toContain("BEGIN:VCARD\r\nVERSION:3.0\r\n");
    expect(vcard).toContain("UID:abc-123\r\n");
    expect(vcard).toContain("N:Lovelace;Ada;;;\r\n");
    expect(vcard).toContain("FN:Ada Lovelace\r\n");
    expect(vcard).toContain("ORG:FlareCard\\, Inc.;Engineering\r\n");
    expect(vcard).toContain("TEL;TYPE=CELL,VOICE,PREF:+1 415 555 0101\r\n");
    expect(vcard).toContain("TEL;TYPE=WORK,FAX:+1 415 555 0102\r\n");
    expect(vcard).toContain("EMAIL;TYPE=INTERNET,WORK:ada@example.com\r\n");
    expect(vcard).toContain("ADR;TYPE=WORK:;;1 Main St;SF;CA;94105;USA\r\n");
    expect(vcard).toContain("NOTE:Line one\\nLine two\\; with semicolon\r\n");
    expect(vcard).toContain("REV:2026-01-02T03:04:05Z\r\n");
    expect(vcard.endsWith("END:VCARD\r\n")).toBe(true);
    expect(vcard).not.toMatch(/[^\r]\n/);
  });

  it("embeds photos as base64 with ENCODING=b and folds long lines at 75 octets", () => {
    const f = emptyFields();
    f.uid = "p1";
    f.fn = "Photo Person";
    f.photo = { mediaType: "image/jpeg", base64: "A".repeat(300) };
    const vcard = fieldsToVCard(f, REV);
    expect(vcard).toContain("PHOTO;ENCODING=b;TYPE=JPEG:");
    for (const line of vcard.split("\r\n")) {
      expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    }
    // Round trip through the parser restores the full base64 payload.
    const parsed = propsToFields(parseVCards(vcard)[0]);
    expect(parsed.photo?.base64).toBe("A".repeat(300));
    expect(parsed.photo?.mediaType).toBe("image/jpeg");
  });

  it("does not split multi-byte characters when folding", () => {
    const line = "NOTE:" + "é".repeat(100);
    const folded = foldLine(line);
    expect(unfoldLines(folded)[0]).toBe(line);
    for (const part of folded.split("\r\n")) expect(new TextEncoder().encode(part).length).toBeLessThanOrEqual(75);
  });

  it("is deterministic for the same input and REV (stable ETags)", () => {
    const f = emptyFields();
    f.uid = "d1";
    f.fn = "Determinism";
    expect(fieldsToVCard(f, REV)).toBe(fieldsToVCard(f, REV));
  });
});

describe("vCard parsing and import", () => {
  it("parses 3.0 cards with folded lines, groups and quoted params", () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:3.0",
      "UID:x1",
      "N:Hopper;Grace;Brewster;Rear Admiral;",
      "FN:Grace Hopper",
      "item1.TEL;type=CELL;type=VOICE;type=pref:+1 555 0102",
      "item1.X-ABLabel:Mobile",
      'EMAIL;TYPE="INTERNET,WORK":grace@example.com',
      "NOTE:A very long note that will be folded across multiple",
      "  lines by the exporter",
      "END:VCARD",
    ].join("\r\n");
    const f = propsToFields(parseVCards(text)[0]);
    expect(f.uid).toBe("x1");
    expect(f.n.given).toBe("Grace");
    expect(f.n.prefix).toBe("Rear Admiral");
    expect(f.phones).toEqual([{ type: "CELL", value: "+1 555 0102", pref: true }]);
    expect(f.emails[0]).toMatchObject({ type: "WORK", value: "grace@example.com" });
    expect(f.note).toBe("A very long note that will be folded across multiple lines by the exporter");
  });

  it("normalizes vCard 4.0 input (tel: URIs, data: photos, compact BDAY) to 3.0", async () => {
    const text = [
      "BEGIN:VCARD",
      "VERSION:4.0",
      "UID:urn:uuid:4f2c7a8e-1111-2222-3333-444455556666",
      "FN:Alan Turing",
      "N:Turing;Alan;;;",
      "TEL;TYPE=cell;VALUE=uri:tel:+44-20-7946-0958",
      "EMAIL;TYPE=work:alan@example.com",
      "BDAY:19120623",
      "PHOTO:data:image/png;base64,iVBORw0KGgo=",
      "END:VCARD",
    ].join("\n");
    const [card] = await importVCards(text, REV);
    expect(card.fields.uid).toBe("urn:uuid:4f2c7a8e-1111-2222-3333-444455556666");
    expect(card.vcard).toContain("VERSION:3.0");
    expect(card.vcard).toContain("TEL;TYPE=CELL,VOICE:+44-20-7946-0958");
    expect(card.vcard).toContain("BDAY:1912-06-23");
    expect(card.vcard).toContain("PHOTO;ENCODING=b;TYPE=PNG:iVBORw0KGgo=");
  });

  it("derives a stable safe UID for unsafe UIDs and generates one when missing", async () => {
    const weird = "BEGIN:VCARD\nVERSION:3.0\nUID:has spaces/and slashes\nFN:Weird\nEND:VCARD\n";
    const [a] = await importVCards(weird, REV);
    const [b] = await importVCards(weird, REV);
    expect(a.fields.uid).toBe(b.fields.uid);
    expect(a.fields.uid).toMatch(/^u-[0-9a-f]{32}$/);
    const missing = "BEGIN:VCARD\nVERSION:3.0\nFN:No UID\nEND:VCARD\n";
    const [c] = await importVCards(missing, REV);
    expect(c.fields.uid).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("imports multiple cards from one file and skips empty ones", async () => {
    const text = [
      "BEGIN:VCARD\nVERSION:3.0\nUID:a\nFN:A\nEND:VCARD",
      "BEGIN:VCARD\nVERSION:3.0\nUID:b\nEND:VCARD",
      "BEGIN:VCARD\nVERSION:3.0\nUID:c\nFN:C\nEND:VCARD",
    ].join("\n");
    const cards = await importVCards(text, REV);
    expect(cards.map((c) => c.fields.uid)).toEqual(["a", "c"]);
  });
});

describe("CSV import", () => {
  it("maps common headers and handles quoted fields", () => {
    const csv = [
      "First Name,Last Name,Company,Job Title,Email,Mobile,Work Phone,City,Notes",
      'Ada,Lovelace,"FlareCard, Inc.",CTO,ada@example.com,+1 555 0101,+1 555 0100,"San Francisco","Likes ""engines"""',
      "Grace,Hopper,,,grace@example.com,,,,",
    ].join("\r\n");
    const { contacts, unmappedHeaders } = csvToFields(csv);
    expect(unmappedHeaders).toEqual([]);
    expect(contacts).toHaveLength(2);
    expect(contacts[0].n).toMatchObject({ given: "Ada", family: "Lovelace" });
    expect(contacts[0].org).toBe("FlareCard, Inc.");
    expect(contacts[0].phones).toEqual([
      { type: "CELL", value: "+1 555 0101" },
      { type: "WORK", value: "+1 555 0100" },
    ]);
    expect(contacts[0].addresses[0].city).toBe("San Francisco");
    expect(contacts[0].note).toBe('Likes "engines"');
  });
});
