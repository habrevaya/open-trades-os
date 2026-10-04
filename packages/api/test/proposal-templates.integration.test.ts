import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { inflateSync } from "node:zlib";
import { PermissionError, pdf, type Actor } from "@opentradesos/core";
import * as estimates from "../src/services/estimates";
import * as proposals from "../src/services/proposals";
import * as templates from "../src/services/proposal-templates";
import * as documents from "../src/services/documents";
import * as jobs from "../src/services/jobs";
import { UnprocessableError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE COMPANY'S OWN PROPOSAL LAYOUT, ON THE PAGE AND IN THE FILE
 *
 * A template is designed once and every estimate for its job type starts in
 * it. What matters to a contractor is that the page the customer reads and
 * the PDF they print say the same thing in the same order, that the layout
 * on an estimate is the one it was sent with whatever happens to the
 * template later, and that a layout which would print badly is refused while
 * somebody is still looking at the editor.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("ptpl:org");
const USER = fixtureId("ptpl:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";
let installType = "";

/** A one pixel JPEG, which is all the PDF needs to embed a photograph. */
const JPEG = Uint8Array.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00,
  0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01, 0x00, 0x01, 0x01, 0x01, 0x11, 0x00,
  0xff, 0xda, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3f, 0x00, 0xd2, 0xcf, 0x20, 0xff, 0xd9,
]);
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");

const layout = (over: Record<string, unknown> = {}) => ({
  cover: { headline: "Your new system", intro: "Prepared after our visit." },
  sections: [
    { kind: "about", title: "Who we are", body: "Family owned since 1998." },
    { kind: "options" },
    { kind: "reviews", title: "What neighbours say", minRating: 5, count: 2 },
    { kind: "warranty", body: "Ten years parts and labour." },
    { kind: "terms", title: "The small print" },
  ],
  ...over,
});

const anEstimate = (jobId?: string) => estimates.create(owner(), {
  customerId, propertyId, taxRate: "0", ...(jobId ? { jobId } : {}), terms: "Payment due on completion.",
  options: [{ name: "New furnace", isRecommended: true, lines: [{
    name: "Furnace", quantity: "1", unitPrice: "4200.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false,
  }] }],
});

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Layout Heating", slug: "layout-heating" });
  const [c] = await raw`insert into public.customer (organization_id, name) values (${ORG}, 'Sam Layout') returning id`;
  customerId = c!["id"];
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Print St', 'Austin', 'TX', '78701') returning id`;
  propertyId = p!["id"];
  await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${customerId}, ${propertyId})`;
  const [t] = await raw`insert into public.job_type (organization_id, name) values (${ORG}, 'Install') returning id`;
  installType = t!["id"];
  await raw`insert into public.review (organization_id, platform, rating, author_name, body, posted_at) values
    (${ORG}, 'google', 5, 'Pat', 'On time and tidy.', now() - interval '2 days'),
    (${ORG}, 'google', 5, 'Lee', null, now() - interval '1 day'),
    (${ORG}, 'google', 3, 'Kim', 'Fine.', now())`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`update public.estimate set proposal_template_id = null where organization_id = ${ORG}`;
  await raw`delete from public.proposal_template where organization_id = ${ORG}`;
});

run("designing one", () => {
  it("is saved by name, one default and one per job type, by whoever may change settings", async () => {
    const first = await templates.save(owner(), { name: "Installs", jobTypeId: installType, layout: layout() });
    expect(first.layout.sections.map((s) => s.kind)).toEqual(["about", "options", "reviews", "warranty", "terms"]);
    const a = await templates.save(owner(), { name: "Plain", isDefault: true, layout: { sections: [{ kind: "options" }] } });
    const b = await templates.save(owner(), { name: "Plainer", isDefault: true, layout: { sections: [{ kind: "options" }] } });
    expect((await templates.get(owner(), { id: a.id })).isDefault).toBe(false);
    expect(b.isDefault).toBe(true);
    await expect(templates.save(owner(), { name: "Installs again", jobTypeId: installType, layout: layout() }))
      .rejects.toThrow("That job type already starts with another layout");
    await expect(templates.save(owner(), { name: "Installs", layout: layout() })).rejects.toThrow('already a layout called "Installs"');
    await expect(templates.save(as(["office_manager"]), { name: "Mine", layout: layout() })).rejects.toBeInstanceOf(PermissionError);
  });

  it("refuses a layout that would print badly, every problem at once", async () => {
    const error = await templates.save(owner(), {
      name: "Broken", layout: { cover: { headline: "" }, sections: [{ kind: "about" }, { kind: "video" }] },
    }).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(UnprocessableError);
    expect((error as UnprocessableError).issues.map((i) => i.message)).toEqual([
      "The cover needs a headline, or take the cover off.",
      "Section 1 (About us) needs some words under it.",
      expect.stringContaining('Section 2 is a "video"'),
      expect.stringContaining("The options have to be in the proposal"),
    ]);
  });
});

run("on an estimate", () => {
  it("starts with its job type's layout, or the default, copied on", async () => {
    await templates.save(owner(), { name: "Installs", jobTypeId: installType, layout: layout() });
    await templates.save(owner(), { name: "Default", isDefault: true, layout: { sections: [{ kind: "options" }, { kind: "terms" }] } });
    const job = await jobs.create(owner(), { customerId, propertyId, summary: "New furnace", jobTypeId: installType, tags: [], customFields: {} });

    const forInstall = await proposals.proposal(owner(), { id: (await anEstimate(job.id)).id });
    expect(forInstall.layout.templateName).toBe("Installs");
    expect(forInstall.layout.sections.map((s) => s.title)).toEqual([
      "Who we are", "Your options", "What neighbours say", "Our warranty", "The small print",
    ]);
    /** The reviews section reads the company's own five star reviews that say something. */
    expect(forInstall.layout.sections[2]!.reviews!.map((r) => r.author)).toEqual(["Pat"]);

    const plain = await proposals.proposal(owner(), { id: (await anEstimate()).id });
    expect(plain.layout.templateName).toBe("Default");
  });

  it("keeps the copy it was given when the template changes later", async () => {
    const template = await templates.save(owner(), { name: "Installs", isDefault: true, layout: layout() });
    const written = await anEstimate();
    await templates.save(owner(), { id: template.id, name: "Installs", layout: { sections: [{ kind: "options" }] } });
    const doc = await proposals.proposal(owner(), { id: written.id });
    expect(doc.layout.sections).toHaveLength(5);
  });

  it("is applied to a draft and refused once the estimate has been sent", async () => {
    const template = await templates.save(owner(), { name: "Installs", layout: layout() });
    const written = await anEstimate();
    expect((await proposals.proposal(owner(), { id: written.id })).layout.templateName).toBeNull();
    await templates.applyToEstimate(owner(), { estimateId: written.id, templateId: template.id });
    expect((await proposals.proposal(owner(), { id: written.id })).layout.templateName).toBe("Installs");
    await templates.applyToEstimate(owner(), { estimateId: written.id, templateId: null });
    expect((await proposals.proposal(owner(), { id: written.id })).layout.sections.map((s) => s.kind)).toEqual(["options", "terms"]);

    await estimates.send(owner(), { id: written.id, channel: "link", expiresInDays: 30 });
    await expect(templates.applyToEstimate(owner(), { estimateId: written.id, templateId: template.id }))
      .rejects.toThrow("sending froze what the customer reads");
  });

  it("puts a photograph on the cover and on an option, on the page and in the PDF", async () => {
    const template = await templates.save(owner(), { name: "Installs", isDefault: true, layout: layout() });
    const withCover = await templates.uploadCoverPhoto(owner(), { id: template.id, fileName: "install.jpg", bytes: base64(JPEG) });
    expect(withCover.layout.cover?.photoKey).toBeTruthy();
    const written = await anEstimate();
    const [option] = await raw<{ id: string }[]>`select id from public.estimate_option where estimate_id = ${written.id}`;
    const photo = await templates.addOptionPhoto(owner(), { optionId: option!.id, fileName: "furnace.jpg", bytes: base64(JPEG) });

    const doc = await proposals.proposal(owner(), { id: written.id });
    expect(doc.layout.cover?.photoKey).toBe(withCover.layout.cover?.photoKey);
    expect(doc.layout.optionPhotos[option!.id]!.map((p) => p.id)).toEqual([photo.id]);
    const served = await templates.proposalPhoto(owner(), { estimateId: written.id, photoId: photo.id });
    expect(served.contentType).toBe("image/jpeg");
    expect((await templates.proposalPhoto(owner(), { estimateId: written.id, photoId: "cover" })).bytes.length).toBe(JPEG.length);

    const file = await documents.proposalPdf(owner(), { id: written.id });
    const read = pdf.inspectPdf(file.bytes, (b) => new Uint8Array(inflateSync(b)));
    expect(read.problems).toEqual([]);
    expect(read.pages[0]).toContain("Your new system");
    const text = read.pages.slice(1).flat();
    expect(text.indexOf("Who we are")).toBeLessThan(text.indexOf("New furnace (recommended)"));
    expect(text.indexOf("New furnace (recommended)")).toBeLessThan(text.indexOf("Our warranty"));
    expect(text).toContain("On time and tidy.");
    expect(new TextDecoder("latin1").decode(file.bytes).match(/\/Subtype \/Image/g)).toHaveLength(1);
  });

  it("serves only the photographs its own proposal shows", async () => {
    await templates.save(owner(), { name: "Installs", isDefault: true, layout: layout() });
    const mine = await anEstimate();
    const theirs = await anEstimate();
    const [option] = await raw<{ id: string }[]>`select id from public.estimate_option where estimate_id = ${theirs.id}`;
    const photo = await templates.addOptionPhoto(owner(), { optionId: option!.id, fileName: "x.jpg", bytes: base64(JPEG) });
    await expect(templates.proposalPhoto(owner(), { estimateId: mine.id, photoId: photo.id })).rejects.toThrow("not found");
  });
});
