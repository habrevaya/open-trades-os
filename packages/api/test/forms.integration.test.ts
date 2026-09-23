import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as forms from "../src/services/forms";
import * as marketing from "../src/services/marketing";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as jobs from "../src/services/jobs";
import * as billing from "../src/services/billing";
import { inTenant, ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, fixtureId, testDb } from "./helpers";

/**
 * THE FORM WHOSE LOSSES WERE INVISIBLE
 *
 * `checkForm` validates a definition and `checkSubmission` validates what
 * somebody sent against it, with a refusal per field written for the
 * homeowner. Both were complete, both exported, and neither had a caller,
 * because a form definition had nowhere to live.
 *
 * The decision that makes this different from every form builder a
 * contractor has used: a REFUSED submission is stored, with its refusals. A
 * form that silently drops what it cannot parse is a form whose owner
 * believes it works, and the first evidence is a customer ringing to ask why
 * nobody called back after they filled it in twice.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("forms:org");
const USER = fixtureId("forms:user");
const SLUG = "forms-co";

let raw: postgres.Sql;
let customerId = "";
let propertyId = "";

const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

const FIELDS = [
  { key: "name", label: "Your name", type: "text" as const, required: true },
  { key: "phone", label: "Phone", type: "phone" as const, required: true },
  { key: "email", label: "Email", type: "email" as const, required: false },
  {
    key: "problem", label: "What is wrong?", type: "choice" as const, required: true,
    options: [
      { value: "no_cooling", label: "Not cooling" },
      { value: "no_heat", label: "No heat" },
    ],
  },
  { key: "website", label: "Website", type: "honeypot" as const, required: false },
];

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Forms Co", slug: SLUG });

  const customer = await customers.create(owner(), {
    type: "residential", name: "Forms Customer", phone: "+15125550122",
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "3 Form St", city: "Austin", state: "TX", postalCode: "78701", country: "US" },
    hasDog: false, customFields: {}, customerId: customer.id, customerRole: "owner",
  });
  propertyId = property.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.form_submission where organization_id = ${ORG}`;
  await raw`delete from public.web_form where organization_id = ${ORG}`;
  await raw`delete from public.marketing_touch where organization_id = ${ORG}`;
});

const aForm = () => forms.save(owner(), {
  slug: "get-a-quote",
  title: "Get a quote",
  source: "organic_search",
  fields: FIELDS,
  minimumFillSeconds: 3,
});

run("publishing a form", () => {
  it("refuses a definition core says is unusable", async () => {
    await expect(forms.save(owner(), {
      slug: "broken", title: "Broken",
      fields: [
        { key: "a", label: "A", type: "text", required: true },
        { key: "a", label: "Also A", type: "text", required: true },
      ],
    })).rejects.toThrow(ConflictError);
  });

  it("refuses a form whose leads would land under no known source", async () => {
    /**
     * A VALID form with a bad source, because core's own check runs first
     * and would otherwise reject this for a different reason. The earlier
     * version of this test used a one field form and passed on core's
     * refusal that a lead nobody can ring back is not a lead, which proved
     * nothing about the source check at all.
     */
    await expect(forms.save(owner(), {
      slug: "x", title: "X", source: "spring-postcards", fields: FIELDS,
    })).rejects.toThrow(/not a lead source/);
  });

  it("replaces a form in place rather than publishing it twice", async () => {
    await aForm();
    await forms.save(owner(), {
      slug: "get-a-quote", title: "Request a visit", source: "organic_search", fields: FIELDS,
    });

    const all = await forms.list(owner());
    expect(all.filter((f) => f.slug === "get-a-quote")).toHaveLength(1);
    expect(all[0]!.title).toBe("Request a visit");
  });
});

run("somebody fills it in", () => {
  it("accepts a good submission and records the touch", async () => {
    await aForm();
    const result = await forms.submit(db(), {
      organizationSlug: SLUG,
      formSlug: "get-a-quote",
      values: { name: "Ida Brennan", phone: "5125550101", problem: "no_cooling" },
      startedAt: new Date(Date.now() - 30_000),
      landingQuery: "?utm_source=google&utm_medium=cpc",
      visitorId: "v-form",
    });

    expect(result.accepted).toBe(true);
    expect(result.refusals).toEqual([]);

    const touches = await marketing.touchesFor(owner(), { visitorId: "v-form" });
    expect(touches).toHaveLength(1);
    expect(touches[0]!.source).toBe("google_ads");
  });

  it("returns EVERY refusal at once, not the first", async () => {
    /**
     * Returning one makes somebody fix their phone number, submit, and be
     * told about the problem field. That is the point at which a homeowner
     * with a leak rings the next company on the list.
     */
    await aForm();
    const result = await forms.submit(db(), {
      organizationSlug: SLUG,
      formSlug: "get-a-quote",
      values: { name: "", phone: "nonsense", problem: "exploded" },
      startedAt: new Date(Date.now() - 30_000),
    });

    expect(result.accepted).toBe(false);
    expect(result.refusals.length).toBeGreaterThan(1);
    expect(result.refusals.map((r) => r.field).sort()).toContain("phone");
    /** Written for the homeowner, not for a developer. */
    for (const refusal of result.refusals) {
      expect(refusal.message.length).toBeGreaterThan(10);
      expect(refusal.message).not.toContain("undefined");
    }
  });

  it("STORES a refused submission, which is the whole point", async () => {
    await aForm();
    await forms.submit(db(), {
      organizationSlug: SLUG,
      formSlug: "get-a-quote",
      values: { name: "Ida Brennan", phone: "nope", problem: "no_heat" },
      startedAt: new Date(Date.now() - 30_000),
    });

    const stored = await forms.submissions(owner(), {});
    expect(stored).toHaveLength(1);
    expect(stored[0]!.state).toBe("rejected");
    /** With what arrived, so somebody can read back what people actually typed. */
    const [row] = await raw<{ raw: Record<string, unknown> }[]>`
      select raw from public.form_submission where organization_id = ${ORG}`;
    expect(row!.raw["phone"]).toBe("nope");
  });

  it("records the touch even when the submission was refused", async () => {
    /**
     * Somebody who arrived from an ad and then could not submit is still a
     * click that channel was paid for. Dropping the touch on a refusal makes
     * a form with a broken field look like a channel that stopped working.
     */
    await aForm();
    await forms.submit(db(), {
      organizationSlug: SLUG,
      formSlug: "get-a-quote",
      values: { name: "", phone: "" },
      landingQuery: "?utm_source=bing&utm_medium=cpc",
      visitorId: "v-refused",
    });

    const touches = await marketing.touchesFor(owner(), { visitorId: "v-refused" });
    expect(touches).toHaveLength(1);
    expect(touches[0]!.source).toBe("bing_ads");
  });

  it("marks a robot as spam rather than refusing it", async () => {
    await aForm();
    const result = await forms.submit(db(), {
      organizationSlug: SLUG,
      formSlug: "get-a-quote",
      values: {
        name: "Bot", phone: "5125550101", problem: "no_heat",
        /** The honeypot: a field a person never sees and never fills in. */
        website: "http://example.com",
      },
      startedAt: new Date(Date.now() - 30_000),
    });

    expect(result.accepted).toBe(false);
    const stored = await forms.submissions(owner(), {});
    /**
     * Stored as spam rather than dropped, so a form that suddenly gets a
     * hundred of these is visible rather than merely quiet.
     */
    expect(stored[0]!.state).toBe("spam");
  });

  it("treats an impossibly fast submission as a robot", async () => {
    await aForm();
    const result = await forms.submit(db(), {
      organizationSlug: SLUG,
      formSlug: "get-a-quote",
      values: { name: "Fast", phone: "5125550101", problem: "no_heat" },
      startedAt: new Date(Date.now() - 500),
    });
    expect(result.accepted).toBe(false);
  });

  it("does not refuse a submission whose page could not report a start time", async () => {
    /**
     * Refusing on a missing timestamp throws away real leads from browsers
     * that blocked the script, and a lost lead costs far more than a spam
     * row somebody deletes.
     */
    await aForm();
    const result = await forms.submit(db(), {
      organizationSlug: SLUG,
      formSlug: "get-a-quote",
      values: { name: "No Script", phone: "5125550101", problem: "no_heat" },
    });
    expect(result.accepted).toBe(true);
  });

  it("counts which fields are losing people", async () => {
    await aForm();
    const [form] = await forms.list(owner());

    for (let i = 0; i < 3; i += 1) {
      await forms.submit(db(), {
        organizationSlug: SLUG, formSlug: "get-a-quote",
        values: { name: "Someone", phone: "1 512 555 0101 ext 4", problem: "no_heat" },
        startedAt: new Date(Date.now() - 30_000),
      });
    }

    const counts = await forms.refusalCounts(owner(), form!.id);
    /**
     * Not "the form gets some submissions" but "three people could not get
     * past the phone field". One of those is a fact somebody can act on.
     */
    expect(counts[0]).toMatchObject({ field: "phone", count: 3 });
  });
});

run("closing the loop back to the ad account", () => {
  const today = () => new Date().toISOString().slice(0, 10);

  const aBookedJob = async (clickIds: { source: string; clickId: string }[], total: string) => {
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Won job", tags: [], customFields: {},
    });
    for (const { source, clickId } of clickIds) {
      await raw`insert into public.marketing_touch
        (organization_id, customer_id, job_id, source, basis, click_id, occurred_at)
        values (${ORG}, ${customerId}, ${job.id}, ${source}, 'click_id', ${clickId}, now())`;
    }
    await billing.create(owner(), {
      customerId, jobId: job.id,
      lines: [{ name: "Work", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
    });
    return job.id;
  };

  it("reports the job against the click id that produced it", async () => {
    await aBookedJob([{ source: "google_ads", clickId: "gclid-1" }], "1000.00");

    const rows = await marketing.conversions(owner(), { from: today(), to: today() });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.clickId).toBe("gclid-1");
    expect(rows[0]!.source).toBe("google_ads");
    expect(Number(rows[0]!.value)).toBe(1000);
  });

  it("splits the value so two platforms are not each told they won the whole job", async () => {
    /**
     * Sending the full amount to both, which is what most setups do because
     * it is easier, tells each platform it produced twice the revenue it
     * did, and both then bid as though the work were worth double.
     */
    await aBookedJob([
      { source: "google_ads", clickId: "gclid-2" },
      { source: "meta_ads", clickId: "fbclid-2" },
    ], "1000.00");

    const rows = await marketing.conversions(owner(), { from: today(), to: today(), model: "linear" });
    const total = rows.reduce((sum, row) => sum + Number(row.value), 0);
    expect(rows).toHaveLength(2);
    expect(total, "the parts sum to the invoice exactly").toBe(1000);
  });

  it("skips a job with no invoice rather than reporting it at zero", async () => {
    /**
     * A zero conversion teaches the account this click produced nothing,
     * which is the opposite of true and is a lesson it acts on. The job is
     * picked up by a later export once it is invoiced.
     */
    const job = await jobs.create(owner(), {
      customerId, propertyId, summary: "Not invoiced", tags: [], customFields: {},
    });
    await raw`insert into public.marketing_touch
      (organization_id, customer_id, job_id, source, basis, click_id, occurred_at)
      values (${ORG}, ${customerId}, ${job.id}, 'google_ads', 'click_id', 'gclid-3', now())`;

    const rows = await marketing.conversions(owner(), { from: today(), to: today() });
    expect(rows.filter((r) => r.clickId === "gclid-3")).toEqual([]);
  });

  it("writes the file each platform's importer actually takes", async () => {
    await aBookedJob([
      { source: "google_ads", clickId: "gclid-4" },
      { source: "meta_ads", clickId: "fbclid-4" },
    ], "500.00");

    const rows = await marketing.conversions(owner(), { from: today(), to: today() });

    const google = marketing.conversionsCsv(rows, "google");
    expect(google.split("\n")[0]).toBe(
      "Google Click ID,Conversion Name,Conversion Time,Conversion Value,Conversion Currency",
    );
    /**
     * An explicit offset, not the `Z` an ISO string ends with. Google's
     * parser rejects `Z` and says only "invalid date".
     */
    expect(google).toContain("+0000");
    expect(google).toContain("gclid-4");
    expect(google, "a google file carries no meta clicks").not.toContain("fbclid-4");

    const meta = marketing.conversionsCsv(rows, "meta");
    expect(meta.split("\n")[0]).toBe("fbclid,event_name,event_time,value,currency");
    expect(meta).toContain("fbclid-4");
    expect(meta).not.toContain("gclid-4");
  });
});
