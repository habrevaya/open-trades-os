import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as forms from "../src/services/forms";
import * as files from "../src/services/files";
import { seedOrg, testDb, fixtureId } from "./helpers";
import type { ServiceContext } from "../src/services/context";

/**
 * A HOSTED FORM THAT TAKES PHOTOS, RUNS OVER PAGES AND SAYS THEIR NAME BACK
 *
 * The scope and the abuse first, because the form is on the open internet:
 * a file sent to one company never lands on another; the address's hourly
 * ceiling for files is counted before a byte is read; a program is refused by
 * its name before it is decoded and by its bytes after; the count and the
 * total hold; and a refused or spam submission keeps no bytes at all. Then
 * what an accepted one does: the files on the customer the lead is, under
 * their own kind, the pages checked whole at the end, and a confirmation that
 * repeats what they typed, made safe for a message that goes to whatever
 * number was typed.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("formfiles:org");
const USER = fixtureId("formfiles:user");
const OTHER = fixtureId("formfiles:other");
const OTHER_USER = fixtureId("formfiles:other-user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (organizationId: string, userId: string, roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId, organizationId, roles }, db: db(),
});
const owner = () => as(ORG, USER);
/** A fresh address per call, so one test's ceiling is not another's. */
const meta = () => ({ ip: `10.77.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}` });

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);
const pdf = (size: number, mark = "") => {
  const bytes = Buffer.alloc(size, 0x20);
  Buffer.from(`%PDF-1.4\n%${mark}\n`).copy(bytes);
  return bytes;
};
const b64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const photo = (fileName = "leak.png", bytes: Uint8Array = PNG) => ({ field: "photos", fileName, contentType: "image/png", bytes: b64(bytes) });

const FIELDS = [
  { key: "name", label: "Your name", type: "text" as const, required: true, page: 0 },
  { key: "phone", label: "Mobile number", type: "phone" as const, required: true, page: 0 },
  {
    key: "system", label: "What kind of system", type: "choice" as const, required: true, page: 1,
    options: [{ value: "combi", label: "Combi boiler" }, { value: "heat_pump", label: "Heat pump" }],
  },
  { key: "photos", label: "Photos of the problem", type: "file" as const, required: false, page: 1 },
  { key: "details", label: "Anything else", type: "long_text" as const, required: false, page: 1 },
  { key: "website", label: "Leave this empty", type: "honeypot" as const, required: false },
];
const PAGES = [{ title: "About you" }, { title: "The system" }];
const good = (phone: string) => ({ name: "Iris Inlet", phone, system: "combi" });

/** Every stored file the company holds, which a refused submission must not add to. */
const storedCount = async (organizationId = ORG) =>
  Number((await raw<{ n: string }[]>`select count(*) as n from public.stored_file where organization_id = ${organizationId}`)[0]!.n);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Form Files Co", slug: "form-files-co" });
  await seedOrg(raw, { organizationId: OTHER, userId: OTHER_USER, name: "Form Files Other", slug: "form-files-other" });
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125557000', 'main', true)`;
  await forms.save(owner(), {
    slug: "boiler", title: "Boiler trouble", source: "organic_search", fields: FIELDS, pages: PAGES,
    settings: {
      thankYou: "Thanks {{ name }}, we will look at your {{ system }}.",
      confirmationText: "Hi {{ name }}, Form Files Co here about your {{ system }}. We ring soon.",
    },
  });
});

afterAll(async () => { if (raw) await raw.end(); });

run("files sent with a lead form: scope and abuse", () => {
  it("never puts a file on another company, whatever slug the post names", async () => {
    await expect(forms.submit(db(), {
      organizationSlug: "form-files-other", formSlug: "boiler", values: good("5125557101"), files: [photo()],
    }, meta())).rejects.toThrow(/not found/i);
    expect(await storedCount(OTHER)).toBe(0);

    const accepted = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557102"), files: [photo("scope.png")],
    }, meta());
    expect(accepted.accepted).toBe(true);
    const mine = await files.attachmentsFor(owner(), { entityType: "customer", entityId: accepted.customerId! });
    expect(mine.map((f) => f.kind)).toEqual(["form_file"]);
    const theirs = await files.attachmentsFor(as(OTHER, OTHER_USER), { entityType: "customer", entityId: accepted.customerId! });
    expect(theirs).toEqual([]);
  });

  it("counts every file against the address's hourly ceiling before reading a byte of it", async () => {
    const address = { ip: `10.78.${Math.floor(Math.random() * 250)}.1` };
    const junk = Array.from({ length: 5 }, (_, i) => ({ field: "photos", fileName: `junk${i}.png`, bytes: "!!not base64!!" }));
    for (let i = 0; i < 4; i++) {
      const refused = await forms.submit(db(), {
        organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557103"), files: junk,
      }, address);
      expect(refused.accepted).toBe(false);
      expect(refused.refusals[0]!.message).toMatch(/did not arrive whole/);
    }
    /** The twenty first file is refused at the door, before the bytes are looked at. */
    await expect(forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557103"), files: [photo()],
    }, address)).rejects.toThrow(/too many/i);
    /** Another address is not held back by it. */
    expect((await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557103"), files: [photo("other.png")],
    }, meta())).accepted).toBe(true);
  });

  it("refuses a program by its name before it is decoded, and by its bytes when it is called a photo", async () => {
    const before = await storedCount();
    const named = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557104"),
      files: [{ field: "photos", fileName: "invoice.pdf.exe", bytes: "this is never decoded!!" }],
    }, meta());
    expect(named.accepted).toBe(false);
    expect(named.refusals).toEqual([{
      field: "photos", reason: "bad_file",
      message: "invoice.pdf.exe was not sent: it is a program or a script, and those are never kept. Send a photo or a PDF.",
    }]);

    const disguised = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557104"),
      files: [photo("leak.png", Buffer.from([0x4d, 0x5a, 0x90, 0x00, 0x03, 0x00, 0x00, 0x00]))],
    }, meta());
    expect(disguised.refusals[0]!.message).toBe("leak.png was not sent: it is a program or a script, and those are never kept. Send a photo or a PDF.");

    const svg = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557104"),
      files: [{ field: "photos", fileName: "logo.svg", contentType: "image/svg+xml", bytes: b64(Buffer.from("<svg onload=alert(1)>")) }],
    }, meta());
    expect(svg.refusals[0]!.reason).toBe("bad_file");

    const gif = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557104"),
      files: [{ field: "photos", fileName: "anim.gif", bytes: b64(Buffer.from("GIF89a\x01\x00\x01\x00")) }],
    }, meta());
    expect(gif.refusals[0]!.message).toMatch(/only a photo \(JPEG, PNG, HEIC or WebP\) or a PDF/);
    expect(await storedCount()).toBe(before);
  });

  it("holds the count and the total for one submission, and keeps nothing of a refused one", async () => {
    const before = await storedCount();
    const six = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557105"),
      files: Array.from({ length: 6 }, (_, i) => ({ field: "photos", fileName: `p${i}.pdf`, bytes: b64(pdf(64, `six${i}`)) })),
    }, meta());
    expect(six.accepted).toBe(false);
    expect(six.refusals.map((r) => r.message)).toContain("p5.pdf was not sent: you can send up to 5 files with this form.");

    const heavy = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557105"),
      files: [
        { field: "photos", fileName: "one.pdf", bytes: b64(pdf(3 * 1024 * 1024, "one")) },
        { field: "photos", fileName: "two.pdf", bytes: b64(pdf(3 * 1024 * 1024, "two")) },
      ],
    }, meta());
    expect(heavy.refusals.map((r) => r.message)).toEqual(["two.pdf was not sent: the files sent with this form can come to 4 MB in all."]);
    expect(await storedCount()).toBe(before);
    const [row] = await raw<{ raw: { photos: string[] } }[]>`select raw from public.form_submission where id = ${heavy.submissionId}`;
    expect(row!.raw.photos).toEqual(["one.pdf", "two.pdf"]);
  });

  it("keeps no bytes of spam, and never decodes them", async () => {
    const before = await storedCount();
    const spam = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler",
      values: { ...good("5125557106"), website: "http://spam.example" },
      files: [
        { field: "photos", fileName: "spam.pdf", bytes: b64(pdf(64, "spam only")) },
        { field: "photos", fileName: "broken.png", bytes: "!!never decoded!!" },
      ],
    }, meta());
    expect(spam.refusals).toEqual([expect.objectContaining({ reason: "spam" })]);
    expect(await storedCount()).toBe(before);
  });

  it("takes files only for a file field, and never a name typed into one", async () => {
    const elsewhere = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557107"),
      files: [{ ...photo(), field: "details" }],
    }, meta());
    expect(elsewhere.refusals[0]).toMatchObject({ field: "details", reason: "unknown_field" });

    const claimed = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: { ...good("5125557107"), photos: ["../../etc/passwd"] },
    }, meta());
    expect(claimed.accepted).toBe(true);
    const [row] = await raw<{ clean: Record<string, unknown> }[]>`select clean from public.form_submission where id = ${claimed.submissionId}`;
    expect(row!.clean["photos"]).toBeUndefined();
  });
});

run("an accepted lead form with files, pages and a confirmation by name", () => {
  it("puts the files on the customer the lead is, apart from what a signed in customer adds, once on a retry", async () => {
    const replay = { ...meta(), idempotencyKey: randomBytes(8).toString("hex") };
    const post = () => forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: good("5125557110"),
      files: [photo("boiler front.png"), { field: "photos", fileName: "quote.pdf", contentType: "application/pdf", bytes: b64(pdf(200, "quote")) }],
    }, replay);
    const first = await post();
    expect(first.accepted).toBe(true);
    expect((await post()).submissionId).toBe(first.submissionId);

    const kept = await files.attachmentsFor(owner(), { entityType: "customer", entityId: first.customerId! });
    expect(kept.map((f) => ({ kind: f.kind, fileName: f.fileName, contentType: f.contentType, addedByCustomer: f.addedByCustomer })).sort((a, b) => a.fileName!.localeCompare(b.fileName!)))
      .toEqual([
        { kind: "form_file", fileName: "boiler front.png", contentType: "image/png", addedByCustomer: false },
        { kind: "form_file", fileName: "quote.pdf", contentType: "application/pdf", addedByCustomer: false },
      ]);
    /** Never something the office can show the customer: it is not theirs and not on a job. */
    await expect(files.shareWithCustomer(owner(), { attachmentId: kept[0]!.id, shared: true })).rejects.toThrow(/Only a photograph or a file on a job/);

    const [task] = await raw<{ body: string }[]>`
      select body from public.task where organization_id = ${ORG} and entity_id = ${first.customerId!} order by created_at desc limit 1`;
    expect(task!.body).toContain("Photos of the problem: boiler front.png, quote.pdf");
    expect(task!.body).toContain("The files they sent are on their customer page.");
    const [audit] = await raw<{ n: string }[]>`
      select count(*) as n from public.audit_log where organization_id = ${ORG} and action = 'attachment.form_added'
      and after->>'submissionId' = ${first.submissionId}`;
    expect(Number(audit!.n)).toBe(2);
  });

  it("serves the pages to the hosted page and checks every page when the form is posted", async () => {
    const definition = await forms.definitionOf(owner(), "boiler");
    expect(definition.pages).toEqual(PAGES);
    const hosted = await forms.hosted(db(), { key: definition.publicKey! });
    expect(hosted.pages).toEqual(PAGES);
    expect(hosted.fields.find((f) => f.key === "photos")).toMatchObject({ type: "file", page: 1 });
    expect(hosted.uploads).toMatchObject({ maxFiles: 5, maxTotalMegabytes: 4 });

    /** A page skipped in the browser is still a page: the whole form is checked at the end. */
    const skipped = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: { name: "Iris Inlet", phone: "5125557111" },
    }, meta());
    expect(skipped.accepted).toBe(false);
    expect(skipped.refusals.map((r) => r.field)).toEqual(["system"]);
  });

  it("refuses a form split badly, or a confirmation naming what it cannot repeat", async () => {
    await expect(forms.save(owner(), {
      slug: "split", title: "Split", fields: FIELDS.map((f) => ({ ...f, page: 2 })), pages: PAGES,
    })).rejects.toThrow(/is on page 3, and this form has 2 pages/);
    await expect(forms.save(owner(), {
      slug: "split", title: "Split", fields: FIELDS, pages: PAGES,
      settings: { confirmationText: "Thanks {{ name }}, about {{ details }} and {{ nmae }}" },
    })).rejects.toThrow(/"\{\{ details \}\}" is a long text field.*"\{\{ nmae \}\}" is not a question on this form/);
    /** Fields changed under a confirmation kept from before are checked against it too. */
    await expect(forms.save(owner(), {
      slug: "boiler", title: "Boiler trouble", fields: FIELDS.filter((f) => f.key !== "system"), pages: PAGES,
    })).rejects.toThrow(/"\{\{ system \}\}" is not a question on this form/);
    /** One page is no split, and its questions are kept without a page. */
    await forms.save(owner(), { slug: "flat", title: "Flat", fields: FIELDS.filter((f) => f.page === 0), pages: [PAGES[0]!] });
    const flat = await forms.definitionOf(owner(), "flat");
    expect(flat.pages).toEqual([]);
    expect(flat.fields.every((f) => f.page === undefined)).toBe(true);
  });

  it("says their answers back, as a choice's label, and leaves a stranger's link out of the text", async () => {
    const said = await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler", values: { ...good("5125557112"), name: "Iris {{ phone }}" },
    }, meta());
    expect(said.thankYou).toBe("Thanks Iris phone, we will look at your Combi boiler.");
    const [text] = await raw<{ body: string }[]>`
      select body from public.message where organization_id = ${ORG} and to_address = '+15125557112'`;
    expect(text!.body).toBe("Hi Iris phone, Form Files Co here about your Combi boiler. We ring soon.");

    await forms.submit(db(), {
      organizationSlug: "form-files-co", formSlug: "boiler",
      values: { ...good("5125557113"), name: "Your bank account is locked, sign in at bad.example" },
    }, meta());
    const [aimed] = await raw<{ body: string }[]>`
      select body from public.message where organization_id = ${ORG} and to_address = '+15125557113'`;
    expect(aimed!.body).toBe("Hi , Form Files Co here about your Combi boiler. We ring soon.");
  });
});
