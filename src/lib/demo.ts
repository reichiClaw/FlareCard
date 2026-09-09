import { type ContactFields, emptyFields } from "./vcard";

/** A tiny 1x1 PNG so demo data exercises the PHOTO path end to end. */
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function person(partial: Partial<ContactFields> & { given: string; family: string }): ContactFields {
  const f = emptyFields();
  const { given, family, ...rest } = partial;
  Object.assign(f, rest);
  f.n = { ...f.n, given, family };
  f.fn = `${given} ${family}`;
  return f;
}

export const DEMO_CONTACTS: ContactFields[] = [
  person({
    uid: "demo-ada-lovelace",
    given: "Ada",
    family: "Lovelace",
    org: "FlareCard Inc.",
    department: "Engineering",
    title: "Chief Technology Officer",
    phones: [
      { type: "CELL", value: "+1 415 555 0101", pref: true },
      { type: "WORK", value: "+1 415 555 0100" },
    ],
    emails: [{ type: "WORK", value: "ada@flarecard.example", pref: true }],
    addresses: [
      { type: "WORK", street: "1 Analytical Engine Way", city: "San Francisco", region: "CA", postalCode: "94105", country: "USA" },
    ],
    urls: [{ type: "WORK", value: "https://flarecard.example" }],
    note: "Founder. Prefers async communication.",
    photo: { mediaType: "image/png", base64: TINY_PNG },
  }),
  person({
    uid: "demo-grace-hopper",
    given: "Grace",
    family: "Hopper",
    org: "FlareCard Inc.",
    department: "Engineering",
    title: "Staff Engineer, Compilers",
    phones: [{ type: "CELL", value: "+1 415 555 0102" }],
    emails: [{ type: "WORK", value: "grace@flarecard.example" }],
    birthday: "1906-12-09",
  }),
  person({
    uid: "demo-alan-turing",
    given: "Alan",
    family: "Turing",
    org: "FlareCard Inc.",
    department: "Research",
    title: "Principal Scientist",
    phones: [{ type: "WORK", value: "+44 20 7946 0958" }, { type: "WORK,FAX", value: "+44 20 7946 0959" }],
    emails: [{ type: "WORK", value: "alan@flarecard.example" }],
    addresses: [
      { type: "WORK", street: "Hut 8, Bletchley Park", city: "Milton Keynes", region: "", postalCode: "MK3 6EB", country: "United Kingdom" },
    ],
  }),
  person({
    uid: "demo-katherine-johnson",
    given: "Katherine",
    family: "Johnson",
    org: "FlareCard Inc.",
    department: "Finance",
    title: "Head of Finance",
    phones: [{ type: "CELL", value: "+1 757 555 0104" }],
    emails: [{ type: "WORK", value: "katherine@flarecard.example" }, { type: "HOME", value: "kj@example.org" }],
  }),
  person({
    uid: "demo-linus-torvalds",
    given: "Linus",
    family: "Torvalds",
    org: "Kernel Partners Oy",
    title: "External Consultant",
    phones: [{ type: "CELL", value: "+358 40 555 0105" }],
    emails: [{ type: "WORK", value: "linus@kernel-partners.example" }],
    note: "Vendor contact – do not share externally.",
  }),
  person({
    uid: "demo-margaret-hamilton",
    given: "Margaret",
    family: "Hamilton",
    org: "FlareCard Inc.",
    department: "Engineering",
    title: "Director of Reliability",
    phones: [{ type: "WORK", value: "+1 617 555 0106" }, { type: "CELL", value: "+1 617 555 0107" }],
    emails: [{ type: "WORK", value: "margaret@flarecard.example" }],
    addresses: [
      { type: "WORK", street: "75 Cambridge Parkway", city: "Cambridge", region: "MA", postalCode: "02142", country: "USA" },
    ],
  }),
  person({
    uid: "demo-front-desk",
    given: "Front",
    family: "Desk",
    org: "FlareCard Inc.",
    department: "Operations",
    title: "Reception",
    phones: [{ type: "MAIN", value: "+1 415 555 0100", pref: true }],
    emails: [{ type: "WORK", value: "reception@flarecard.example" }],
    note: "Mon–Fri 08:00–18:00 PT",
  }),
];
