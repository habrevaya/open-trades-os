import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as reports from "../src/services/service-reports";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M11, AND THE COLUMN NOTHING SET
 *
 * `services/field.ts` captures a service report from a technician's phone,
 * writes every field as its own row and submits it. That half is built and
 * tested. Three permissions were granted to roles and checked by nothing, and
 * the sharpest of the three is `servicereport:publish`: `published_at` is what
 * decides whether a customer sees the document, `field.ts` reads it to derive
 * a status, and NOTHING SET IT. Every report ever captured sat at submitted
 * forever and no customer received one.
 *
 * THE PROPERTIES THIS FILE IS ABOUT, in the order they would cost somebody:
 *
 *   Publishing is a decision taken separately from capture. A report is
 *   written in a basement by somebody holding a torch.
 *
 *   A customer facing read drops the technician's notes as well as the fields
 *   marked not visible. Those notes are where somebody writes what the
 *   customer did not want to hear.
 *
 *   A template's version moves when its FIELDS move and not when its name
 *   does, because a report records which version it answered.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("sr:org");
const USER = fixtureId("sr:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});
/**
 * Exactly these permissions and nothing else, which is the only actor that
 * can tell a pair apart.
 *
 * NO ROLE AT ALL, and that is the point. The first version of this used
 * `roles: ["technician"]`, and the technician preset already holds
 * `servicereport:read` AND `servicereport:write`, so every refusal test
 * resolved and proved nothing. A role that happens to hold one of the pair is
 * the recurring trap in this suite.
 */
const granted = (...permissions: string[]): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG,
    roles: [] as unknown as Actor["roles"],
    grants: permissions as NonNullable<Actor["grants"]>,
  },
  db: db(),
});

let customerId = "";
let propertyId = "";
let jobId = "";
let visitId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Report Co", slug: "service-report-co" });
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name)
    values (${ORG}, 'residential', 'Reported Ltd') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '7 Report Road', 'Austin', 'TX', '78703') returning id`;
  propertyId = property!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
            values (${ORG}, ${customerId}, ${propertyId})`;
  const [job] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, 1, ${customerId}, ${propertyId}, 'scheduled', 'Annual service') returning id`;
  jobId = job!.id;
  const [visit] = await raw<{ id: string }[]>`
    insert into public.visit (organization_id, job_id, sequence, status)
    values (${ORG}, ${jobId}, 1, 'completed') returning id`;
  visitId = visit!.id;
});

/**
 * A report as the field app would have left it: rows in both tables, nothing
 * published, because that is the state every report in this product has ever
 * been in.
 */
async function captured(opts: {
  submitted?: boolean; skipped?: boolean; skipReason?: string;
  notes?: string; summary?: string;
} = {}): Promise<string> {
  const [row] = await raw<{ id: string }[]>`
    insert into public.service_report
      (organization_id, visit_id, job_id, customer_id, property_id,
       summary, technician_notes, skipped, skip_reason, submitted_at)
    values (${ORG}, ${visitId}, ${jobId}, ${customerId}, ${propertyId},
            ${opts.summary ?? "Replaced the capacitor"},
            ${opts.notes ?? "Told them the unit is on its last legs"},
            ${opts.skipped ?? false}, ${opts.skipReason ?? null},
            ${opts.submitted === false ? null : new Date()})
    returning id`;
  const id = row!.id;

  await raw`
    insert into public.service_report_field
      (organization_id, report_id, property_id, key, label, kind,
       value_numeric, unit, customer_visible, out_of_range)
    values
      (${ORG}, ${id}, ${propertyId}, 'superheat', 'Superheat', 'numeric',
       '42.0000', 'F', false, true),
      (${ORG}, ${id}, ${propertyId}, 'return_temp', 'Return air', 'numeric',
       '72.0000', 'F', true, false)`;
  return id;
}

/* ------------------------------------------------------------- publishing */

run("sending the report to the customer", () => {
  it("publishes a submitted report, which nothing could do", async () => {
    /**
     * THE WRITE THE WHOLE MODULE WAS MISSING. `published_at` was read to
     * derive a status and set by nothing.
     */
    const id = await captured();
    expect((await reports.get(owner(), { id })).status).toBe("submitted");

    const published = await reports.publish(owner(), { id });
    expect(published.status).toBe("published");
    expect(published.publishedAt).toBeTruthy();
  });

  it("refuses to publish a draft, which is still syncing from the phone", async () => {
    /**
     * A draft is a report a technician has not finished: the phone has synced
     * some of it and may sync more, so publishing sends the customer a
     * document that then changes underneath them.
     */
    const id = await captured({ submitted: false });
    expect((await reports.get(owner(), { id })).status).toBe("draft");
    await expect(reports.publish(owner(), { id })).rejects.toThrow(/not been submitted/);
  });

  it("refuses to publish a skipped report, and says what the technician said", async () => {
    /**
     * The technician said there was nothing to report and gave a reason.
     * Publishing it would send a customer an empty form with a letterhead.
     */
    const id = await captured({ skipped: true, skipReason: "No access to the roof" });
    expect((await reports.get(owner(), { id })).status).toBe("skipped");
    await expect(reports.publish(owner(), { id })).rejects.toThrow(/No access to the roof/);
  });

  it("publishing twice is the same as publishing once", async () => {
    const id = await captured();
    const first = await reports.publish(owner(), { id });
    const second = await reports.publish(owner(), { id });
    expect(second.publishedAt).toBe(first.publishedAt);
  });

  it("withdraws it, and the reason travels with the document", async () => {
    /**
     * On the observations rather than only in the audit log, because somebody
     * asks about a withdrawn report a year later and they will be reading the
     * report rather than the log.
     */
    const id = await captured();
    await reports.publish(owner(), { id });
    const pulled = await reports.unpublish(owner(), { id, reason: "Wrong unit recorded" });
    expect(pulled.status).toBe("submitted");
    expect(pulled.publishedAt).toBeNull();
    expect(pulled.observations).toContain("Withdrawn: Wrong unit recorded");
  });

  it("refuses to withdraw without a reason, or one that is not published", async () => {
    const id = await captured();
    await expect(reports.unpublish(owner(), { id, reason: "x" })).rejects.toThrow(/not published/);
    await reports.publish(owner(), { id });
    await expect(reports.unpublish(owner(), { id, reason: "   " })).rejects.toThrow(/needs a reason/);
  });

  it("refuses somebody who may write a report but not publish one", async () => {
    /**
     * `servicereport:write` and `servicereport:publish` are different
     * authorities and this is the actor that tells them apart. A role holding
     * neither could not.
     */
    const id = await captured();
    await expect(reports.publish(granted("servicereport:write", "servicereport:read"), { id }))
      .rejects.toThrow();
    await expect(reports.publish(granted("servicereport:publish", "servicereport:read"), { id }))
      .resolves.toMatchObject({ status: "published" });
  });
});

/* --------------------------------------------------------------- reading */

run("reading a report back", () => {
  it("returns every captured field with its value out of the right column", async () => {
    /**
     * Four typed value columns and not one jsonb, which is the schema's
     * decision: a refrigerant weight is trended, range checked and exported
     * to a regulator, and none of those work against a string.
     */
    const id = await captured();
    const report = await reports.get(owner(), { id });
    const byKey = new Map(report.fields.map((f) => [f.key, f]));
    expect(byKey.get("superheat")).toMatchObject({
      label: "Superheat", unit: "F", value: "42.0000", outOfRange: true, customerVisible: false,
    });
    expect(byKey.get("return_temp")).toMatchObject({ customerVisible: true, outOfRange: false });
  });

  it("hides the technician's notes AND the private fields from a customer read", async () => {
    /**
     * BOTH, and the notes are the half that matters. They are where somebody
     * writes "told them the unit is on its last legs, they did not want to
     * hear it", and a portal that showed them would be a different product.
     *
     * Asserted together with the office read of the same report, so this is a
     * test of the switch rather than of the fixture.
     */
    const id = await captured();

    const office = await reports.get(owner(), { id });
    expect(office.technicianNotes).toContain("last legs");
    expect(office.fields).toHaveLength(2);

    const theirs = await reports.get(owner(), { id, customerFacing: true });
    expect(theirs.technicianNotes).toBeNull();
    expect(theirs.fields.map((f) => f.key)).toEqual(["return_temp"]);
  });

  it("counts the fields and the out of range ones in a list", async () => {
    /**
     * The tally is why the list is worth opening: "which of yesterday's jobs
     * recorded a reading outside its range" is the question that catches a
     * failing compressor before the customer rings.
     */
    const id = await captured();
    const { reports: found } = await reports.list(owner(), { jobId });
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ id, fieldCount: 2, outOfRangeCount: 1 });
  });

  it("narrows to the ones with a reading out of range", async () => {
    const withBad = await captured();
    const [clean] = await raw<{ id: string }[]>`
      insert into public.service_report
        (organization_id, visit_id, job_id, customer_id, property_id, submitted_at)
      values (${ORG}, ${visitId}, ${jobId}, ${customerId}, ${propertyId}, now())
      returning id`;
    await raw`
      insert into public.service_report_field
        (organization_id, report_id, property_id, key, label, kind, value_numeric, out_of_range)
      values (${ORG}, ${clean!.id}, ${propertyId}, 'ok', 'Fine', 'numeric', '1.0000', false)`;

    const all = await reports.list(owner(), {});
    expect(all.reports).toHaveLength(2);

    const bad = await reports.list(owner(), { outOfRangeOnly: true });
    expect(bad.reports.map((r) => r.id)).toEqual([withBad]);
  });

  it("narrows by status, and each status means one thing", async () => {
    const draft = await captured({ submitted: false });
    const submitted = await captured();
    const published = await captured();
    await reports.publish(owner(), { id: published });
    const skipped = await captured({ skipped: true });
    /**
     * A SKIPPED REPORT THAT WAS NEVER SUBMITTED, which is the case that tells
     * the draft filter from a filter on `submitted_at` alone.
     *
     * A deliberate breakage found the gap: dropping `skipped = false` from
     * the draft arm stayed green, because the only skipped report in the
     * fixture carried a submitted timestamp and so failed the other half of
     * the condition anyway. A technician who opens a report, marks it not
     * applicable and syncs produces exactly this row.
     */
    const skippedDraft = await captured({ skipped: true, submitted: false });

    const only = async (status: "draft" | "submitted" | "published" | "skipped") =>
      (await reports.list(owner(), { status })).reports.map((r) => r.id);

    expect(await only("draft")).toEqual([draft]);
    expect(await only("published")).toEqual([published]);
    /**
     * Skipped covers both of them: it is a statement about what the
     * technician found, not about how far the sync got.
     */
    expect((await only("skipped")).sort()).toEqual([skipped, skippedDraft].sort());
    /**
     * Submitted excludes both published and skipped, which is the one of the
     * four that is a gap between two columns rather than a column of its own.
     */
    expect(await only("submitted")).toEqual([submitted]);
  });

  it("refuses somebody who may read a job but not a report", async () => {
    const id = await captured();
    await expect(reports.get(granted("job:read"), { id })).rejects.toThrow();
    await expect(reports.get(granted("servicereport:read"), { id })).resolves.toBeTruthy();
  });

  it("does not find another company's report", async () => {
    /**
     * ROW LEVEL SECURITY IS WHAT MAKES THIS TRUE, not the organization clause
     * in the query, and a deliberate breakage proved it: removing that clause
     * left this green because the row is invisible to the other tenant's
     * session regardless.
     *
     * The clause stays, because every read in this product carries one and an
     * inconsistent pattern is how the one that matters gets left off. But it
     * is belt to RLS's braces, and this test is about the braces.
     */
    const id = await captured();
    const other: ServiceContext = {
      actor: {
        userId: USER, organizationId: fixtureId("sr:other"),
        roles: ["owner"] as Actor["roles"],
      },
      db: db(),
    };
    await expect(reports.get(other, { id })).rejects.toThrow(NotFoundError);
  });
});

/* -------------------------------------------------------- the office's words */

run("the office's own words", () => {
  it("edits the summary and the observations", async () => {
    const id = await captured();
    const annotated = await reports.annotate(owner(), {
      id, summary: "Capacitor replaced, unit running within spec",
      observations: "Recommend replacement within twelve months",
    });
    expect(annotated.summary).toBe("Capacitor replaced, unit running within spec");
    expect(annotated.observations).toContain("twelve months");
  });

  it("does not let the office rewrite what the technician wrote", async () => {
    /**
     * There is no parameter for it, which is the point: an office that can
     * rewrite the technician's notes has destroyed the one record of what the
     * person in the building actually said. A correction goes in
     * observations, with both visible to whoever reads the file.
     */
    const id = await captured({ notes: "Customer refused the quote" });
    await reports.annotate(owner(), { id, observations: "Quote re-sent" });
    const after = await reports.get(owner(), { id });
    expect(after.technicianNotes).toBe("Customer refused the quote");
    expect(after.observations).toBe("Quote re-sent");
  });

  it("refuses to edit a report the customer already has", async () => {
    /**
     * Changing a published document with no second version means two people
     * holding the same report and reading different things. Unpublishing is a
     * recorded act, which is the way through.
     */
    const id = await captured();
    await reports.publish(owner(), { id });
    await expect(reports.annotate(owner(), { id, summary: "Different" }))
      .rejects.toThrow(/published and the customer has it/);

    await reports.unpublish(owner(), { id, reason: "Correcting the summary" });
    await expect(reports.annotate(owner(), { id, summary: "Different" }))
      .resolves.toMatchObject({ summary: "Different" });
  });

  it("refuses somebody who may read a report but not write one", async () => {
    const id = await captured();
    await expect(reports.annotate(granted("servicereport:read"), { id, summary: "No" }))
      .rejects.toThrow();
  });
});

/* ------------------------------------------------------------- templates */

run("what this company asks a technician to record", () => {
  const field = (over: Partial<reports.TemplateField> = {}): reports.TemplateField => ({
    key: "superheat", label: "Superheat", kind: "numeric", unit: "F", ...over,
  });

  it("declares a template, which only a trade pack could do before", async () => {
    const template = await reports.defineTemplate(owner(), {
      name: "Spring AC service",
      fields: [field({ min: 8, max: 14 }), field({ key: "notes", label: "Notes", kind: "text" })],
    });
    expect(template).toMatchObject({ name: "Spring AC service", version: 1, active: true });
    expect(template.fields).toHaveLength(2);
    /**
     * A declared field is private by default. A compressor superheat reading
     * means nothing to a homeowner, and the safe default for "should a
     * customer read this" is no.
     */
    expect(template.fields[0]!.customerVisible).toBe(false);
  });

  it("refuses two fields under one key", async () => {
    /**
     * A captured reading is stored under its key, so two fields sharing one
     * produce two rows a reader cannot tell apart, and a trend over that key
     * plots both.
     */
    await expect(reports.defineTemplate(owner(), {
      name: "Clashing", fields: [field(), field({ label: "Superheat again" })],
    })).rejects.toThrow(/both use the key/);
  });

  it("refuses half a range, which judges nothing while looking checked", async () => {
    /**
     * `out_of_range` is computed by comparing a reading against the pair. A
     * reading of minus forty against a declared maximum alone is in range,
     * and the field reads as checked.
     */
    await expect(reports.defineTemplate(owner(), {
      name: "Half", fields: [field({ max: 14 })],
    })).rejects.toThrow(/only one end of its range/);
    await expect(reports.defineTemplate(owner(), {
      name: "Backwards", fields: [field({ min: 20, max: 10 })],
    })).rejects.toThrow(/minimum above its maximum/);
  });

  it("refuses a range on something that is not a number", async () => {
    await expect(reports.defineTemplate(owner(), {
      name: "Odd", fields: [field({ kind: "text", min: 1, max: 2 })],
    })).rejects.toThrow(/declares a numeric range/);
  });

  it("refuses a list to choose from with nothing in it", async () => {
    await expect(reports.defineTemplate(owner(), {
      name: "Empty list", fields: [field({ kind: "select", options: [] })],
    })).rejects.toThrow(/declares no options/);
  });

  it("refuses a field with no label, because a technician reads it", async () => {
    await expect(reports.defineTemplate(owner(), {
      name: "Unlabelled", fields: [field({ label: "  " })],
    })).rejects.toThrow(/needs a label/);
  });

  it("allows at most one active template per job type", async () => {
    /**
     * Two means the report a technician is handed depends on which row came
     * back first, so the same work captures different readings on different
     * days and a trend chart is made of two measurements.
     */
    const [jobType] = await raw<{ id: string }[]>`
      insert into public.job_type (organization_id, name) values (${ORG}, 'AC service')
      returning id`;
    await reports.defineTemplate(owner(), {
      name: "First", jobTypeId: jobType!.id, fields: [field()],
    });
    await expect(reports.defineTemplate(owner(), {
      name: "Second", jobTypeId: jobType!.id, fields: [field()],
    })).rejects.toThrow(/already the active template/);
  });

  it("frees a job type once the template on it is retired", async () => {
    const [jobType] = await raw<{ id: string }[]>`
      insert into public.job_type (organization_id, name) values (${ORG}, 'AC service')
      returning id`;
    const first = await reports.defineTemplate(owner(), {
      name: "Old", jobTypeId: jobType!.id, fields: [field()],
    });
    await reports.updateTemplate(owner(), { id: first.id, active: false });
    await expect(reports.defineTemplate(owner(), {
      name: "New", jobTypeId: jobType!.id, fields: [field()],
    })).resolves.toMatchObject({ name: "New" });
  });

  it("bumps the version when the fields move and not when the name does", async () => {
    /**
     * THE RULE THIS WHOLE BLOCK EXISTS FOR. A report stores
     * `template_version`, so it records which set of questions it answered.
     * Editing fields without a bump makes every past report claim it answered
     * the current questions, and a reading that was never asked for reads as
     * missing rather than as not applicable.
     *
     * And a rename must NOT bump, because it changes nothing about what was
     * asked: bumping would strand past reports against a version nothing
     * distinguishes.
     */
    const template = await reports.defineTemplate(owner(), {
      name: "Service", fields: [field()],
    });
    expect(template.version).toBe(1);

    const renamed = await reports.updateTemplate(owner(), { id: template.id, name: "Renamed" });
    expect(renamed.version).toBe(1);

    const changed = await reports.updateTemplate(owner(), {
      id: template.id, fields: [field(), field({ key: "subcool", label: "Subcool" })],
    });
    expect(changed.version).toBe(2);
    expect(changed.fields).toHaveLength(2);
  });

  it("hides retired templates unless asked", async () => {
    const template = await reports.defineTemplate(owner(), { name: "Old", fields: [field()] });
    await reports.updateTemplate(owner(), { id: template.id, active: false });
    expect(await reports.listTemplates(owner())).toHaveLength(0);
    expect(await reports.listTemplates(owner(), { includeRetired: true })).toHaveLength(1);
  });

  it("refuses somebody who may read templates but not declare one", async () => {
    await expect(reports.listTemplates(granted("servicereport:read"))).resolves.toEqual([]);
    await expect(reports.defineTemplate(granted("servicereport:read"), {
      name: "No", fields: [field()],
    })).rejects.toThrow();
  });

  it("refuses a template with no name", async () => {
    await expect(reports.defineTemplate(owner(), { name: "   ", fields: [field()] }))
      .rejects.toThrow(ConflictError);
  });
});
