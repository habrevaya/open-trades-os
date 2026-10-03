import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as inspections from "../src/services/inspections";
import * as fieldOps from "../src/services/field";
import * as dispatch from "../src/services/dispatch";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M33. THE REPORT, THE QUOTE, AND THE PHONE.
 *
 * THE REPORT SAYS WHAT WAS ASKED, NOT WHAT IS ASKED NOW. Revising the
 * programme after the inspection must not change a word of the report, which
 * is the property a compliance file needs and the one the old row could not
 * give: the version number pointed at a list that had been overwritten.
 *
 * A FINDING BECOMES A QUOTE IN ONE ACTION, priced from the price book, and
 * never without the evidence behind it.
 *
 * THE PHONE FILES ANSWERS AND THE SERVER DRAWS THE VERDICT, against the
 * visit's own customer and address, for a technician the company has let
 * file inspections and for nobody else.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("m33report:org");
const USER = fixtureId("m33report:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], grants: Actor["grants"] = []): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles, grants }, db: db(),
});
const owner = () => as(["owner"]);
const technician = () => as(["technician"]);
const inspector = () => as(["technician"], ["compliance:read", "compliance:write"]);

let customerId = "";
let propertyId = "";
let technicianId = "";

const PROGRAM = {
  name: "Annual backflow test",
  standard: "AWWA C510",
  reportAudience: "authority" as const,
  authorityName: "City of Austin Water",
  frequencyMonths: 12,
  checkpoints: [
    {
      key: "shutoff", label: "Number 1 shutoff holds", severityOnFail: "critical" as const,
      remedies: [{ priceBookItemKey: "BF-REBUILD", label: "Rebuild the check assembly", quantity: 1,
        rationale: "A shutoff that does not hold lets water back into the supply." }],
    },
    { key: "psi", label: "Differential pressure", requiresReading: true, unit: "psi",
      range: { min: 5, max: null }, severityOnFail: "major" as const },
    { key: "enclosure", label: "Enclosure tidy", severityOnFail: "advisory" as const },
  ],
};

const at = "2026-10-01T15:00:00.000Z";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});
afterAll(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Backflow Reports Co", slug: "backflow-reports-co" });
  const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name)
    values (${ORG}, 'commercial', 'Riverside Plaza') returning id`;
  customerId = c!.id;
  const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '9 Riverside Dr', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
            values (${ORG}, ${customerId}, ${propertyId})`;
  const [membership] = await raw<{ id: string }[]>`
    select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Ray Nunez') returning id`;
  technicianId = t!.id;
  const [item] = await raw<{ id: string }[]>`insert into public.price_book_item (organization_id, kind, code)
    values (${ORG}, 'service', 'BF-REBUILD') returning id`;
  await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, effective_from)
    values (${ORG}, ${item!.id}, 1, 'Backflow check rebuild', '385', now() - interval '1 day')`;
});

async function fileOne(programId: string) {
  return inspections.record(owner(), {
    programId, propertyId, customerId,
    inspectorName: "Ray Nunez", inspectorLicense: "BPAT-4471", signedByName: "Ray Nunez",
    performedOn: "2026-10-01",
    answers: [
      { itemKey: "shutoff", value: { kind: "pass_fail", passed: false }, at: new Date(at), by: "Ray Nunez",
        note: "Leaks past the seat", photoIds: ["2f1b0c70-1111-4444-8888-000000000001"] },
      { itemKey: "psi", value: { kind: "reading", raw: 7.5 }, at: new Date(at), by: "Ray Nunez" },
      { itemKey: "enclosure", value: { kind: "not_applicable", why: "No enclosure on this assembly" }, at: new Date(at), by: "Ray Nunez" },
    ],
  });
}

run("the inspection report", () => {
  it("prints every checkpoint as it was asked, what was recorded, and what it came to", async () => {
    const program = await inspections.defineProgram(owner(), PROGRAM);
    const filed = await fileOne(program.id);
    expect(filed.result).toBe("fail");

    const report = await inspections.report(owner(), { id: filed.id });
    expect(report.program).toMatchObject({
      name: "Annual backflow test", standard: "AWWA C510", reportAudience: "authority",
      authorityName: "City of Austin Water", version: 1,
    });
    expect(report.inspectorLicense).toBe("BPAT-4471");
    expect(report.nextDueOn).toBe("2027-10-01");
    expect(report.items.map((i) => [i.key, i.answer, i.verdict])).toEqual([
      ["shutoff", "Fail", "finding"],
      ["psi", "7.5 psi", "pass"],
      ["enclosure", "Not applicable: No enclosure on this assembly", "not_applicable"],
    ]);
    expect(report.items[0]!.severity).toBe("Safety");
    expect(report.items[0]!.note).toBe("Leaks past the seat");
    expect(report.items[0]!.photos).toEqual([{ id: "2f1b0c70-1111-4444-8888-000000000001", storageKey: null }]);
    expect(report.items[1]!.range).toBe("at least 5 psi");
    expect(report.deficiencies).toEqual([expect.objectContaining({ label: "Safety", status: "open" })]);
    expect(report.signature).toMatchObject({ name: "Ray Nunez" });
    expect(report.checkpointsKept).toBe(true);
  });

  it("still says what was asked after the programme is revised", async () => {
    const program = await inspections.defineProgram(owner(), PROGRAM);
    const filed = await fileOne(program.id);
    await inspections.reviseProgram(owner(), {
      id: program.id,
      checkpoints: [{ key: "psi", label: "Pressure drop across check 1", requiresReading: true, unit: "psid",
        range: { min: 1, max: null }, severityOnFail: "major" as const }],
    });
    const report = await inspections.report(owner(), { id: filed.id });
    expect(report.items.map((i) => i.prompt)).toEqual([
      "Number 1 shutoff holds", "Differential pressure", "Enclosure tidy",
    ]);
    expect(report.items[1]!.range).toBe("at least 5 psi");
  });

  it("is a compliance record, and refused to a role without compliance:read", async () => {
    const program = await inspections.defineProgram(owner(), PROGRAM);
    const filed = await fileOne(program.id);
    await expect(inspections.report(technician(), { id: filed.id })).rejects.toThrow();
  });
});

run("a finding into a quote", () => {
  it("writes an estimate from the declared repair, priced from the price book, with the evidence", async () => {
    const program = await inspections.defineProgram(owner(), PROGRAM);
    await fileOne(program.id);
    const [finding] = await raw<{ id: string }[]>`select id from public.deficiency where organization_id = ${ORG}`;

    const quoted = await inspections.quoteDeficiency(owner(), { id: finding!.id });
    expect(quoted).toMatchObject({ created: true, amount: "385.0000" });
    const [estimate] = await raw<{ customer_id: string; property_id: string; title: string }[]>`
      select customer_id, property_id, title from public.estimate where id = ${quoted.estimateId}`;
    expect(estimate).toMatchObject({ customer_id: customerId, property_id: propertyId });
    const [option] = await raw<{ description: string }[]>`
      select description from public.estimate_option where estimate_id = ${quoted.estimateId}`;
    expect(option!.description).toContain("Ray Nunez");
    const [line] = await raw<{ name: string; unit_price: string; description: string }[]>`
      select l.name, l.unit_price, l.description from public.estimate_line l
      join public.estimate_option o on o.id = l.option_id where o.estimate_id = ${quoted.estimateId}`;
    expect(line).toMatchObject({ name: "Backflow check rebuild", unit_price: "385.0000" });
    expect(line!.description).toContain("lets water back into the supply");

    const [after] = await raw<{ status: string; estimate_id: string }[]>`
      select status, estimate_id from public.deficiency where id = ${finding!.id}`;
    expect(after).toEqual({ status: "quoted", estimate_id: quoted.estimateId });

    /** Pressing it twice is one quote. */
    const again = await inspections.quoteDeficiency(owner(), { id: finding!.id });
    expect(again).toMatchObject({ estimateId: quoted.estimateId, created: false });
  });

  it("refuses a finding with no evidence, and one with no repair unless given a price", async () => {
    const [bare] = await raw<{ id: string }[]>`insert into public.deficiency
      (organization_id, property_id, customer_id, description, severity)
      values (${ORG}, ${propertyId}, ${customerId}, 'Typed in by hand', 'major') returning id`;
    await expect(inspections.quoteDeficiency(owner(), { id: bare!.id })).rejects.toThrow(/no observation behind it/);

    const program = await inspections.defineProgram(owner(), {
      ...PROGRAM, checkpoints: [{ key: "gate", label: "Gate latches", severityOnFail: "major" as const }],
    });
    await inspections.record(owner(), {
      programId: program.id, propertyId, customerId,
      answers: [{ itemKey: "gate", value: { kind: "pass_fail", passed: false }, at: new Date(at), by: "Ray" }],
    });
    const [unmapped] = await raw<{ id: string }[]>`
      select id from public.deficiency where organization_id = ${ORG} and checkpoint_key = 'gate'`;
    await expect(inspections.quoteDeficiency(owner(), { id: unmapped!.id })).rejects.toThrow(/Give the price/);
    const priced = await inspections.quoteDeficiency(owner(), { id: unmapped!.id, price: "140" });
    expect(priced.amount).toBe("140.0000");
  });

  it("needs estimate:write as well as compliance:write", async () => {
    const program = await inspections.defineProgram(owner(), PROGRAM);
    await fileOne(program.id);
    const [finding] = await raw<{ id: string }[]>`select id from public.deficiency where organization_id = ${ORG}`;
    await expect(inspections.quoteDeficiency(as(["dispatcher"], ["compliance:write"]), { id: finding!.id }))
      .rejects.toThrow();
  });
});

run("an inspection from the phone", () => {
  async function visitToday() {
    const [job] = await raw<{ id: string }[]>`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 1, ${customerId}, ${propertyId}, 'scheduled', 'Annual backflow test') returning id`;
    const [visit] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start)
      values (${ORG}, ${job!.id}, 'working', now()) returning id`;
    await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
      values (${ORG}, ${visit!.id}, ${technicianId})`;
    return { jobId: job!.id, visitId: visit!.id };
  }

  const operation = (visitId: string, programId: string, inspectionId: string, sequence: number) => ({
    clientId: crypto.randomUUID(), sequence, kind: "inspection.record" as const, subjectId: inspectionId,
    occurredAt: new Date().toISOString(),
    payload: {
      visitId, programId, programName: "Annual backflow test", signedByName: "Ray Nunez",
      inspectorLicense: "BPAT-4471",
      answers: [
        { itemKey: "shutoff", value: { kind: "pass_fail", passed: true }, at, by: "Ray Nunez" },
        { itemKey: "psi", value: { kind: "reading", raw: 3 }, at, by: "Ray Nunez" },
      ],
    },
  });

  it("files answers against the visit's own address and lets the server draw the verdict", async () => {
    const program = await inspections.defineProgram(owner(), PROGRAM);
    const { visitId, jobId } = await visitToday();
    const device = (await fieldOps.register(inspector(), { installationId: `install-${crypto.randomUUID()}` })).deviceId;
    const inspectionId = crypto.randomUUID();

    const result = await fieldOps.sync(inspector(), {
      deviceId: device, operations: [operation(visitId, program.id, inspectionId, 1)],
    });
    expect(result.results[0]).toMatchObject({ status: "applied", rejection: null });

    const [row] = await raw<{ visit_id: string; job_id: string; property_id: string; result: string; signed_by_name: string }[]>`
      select visit_id, job_id, property_id, result, signed_by_name from public.inspection where id = ${inspectionId}`;
    /** 3 psi against at least 5, and enclosure never answered: a failure the phone never claimed. */
    expect(row).toEqual({ visit_id: visitId, job_id: jobId, property_id: propertyId, result: "fail", signed_by_name: "Ray Nunez" });

    const snapshot = await dispatch.snapshot(inspector(), { deviceId: device, from: new Date().toISOString().slice(0, 10), days: 2 });
    expect(snapshot.inspectionPrograms.map((p) => p.name)).toEqual(["Annual backflow test"]);
    expect(snapshot.inspectionPrograms[0]!.checkpoints[1]).toEqual({
      key: "psi", label: "Differential pressure", requiresReading: true, unit: "psi", min: 5, max: null,
    });
    expect(snapshot.visits.find((v) => v.id === visitId)!.inspections).toEqual([
      expect.objectContaining({ id: inspectionId, result: "fail", programName: "Annual backflow test" }),
    ]);
  });

  it("refuses a technician the company has not let file inspections, in words, and offers them no programme", async () => {
    const program = await inspections.defineProgram(owner(), PROGRAM);
    const { visitId } = await visitToday();
    const device = (await fieldOps.register(technician(), { installationId: `install-${crypto.randomUUID()}` })).deviceId;
    const result = await fieldOps.sync(technician(), {
      deviceId: device, operations: [operation(visitId, program.id, crypto.randomUUID(), 1)],
    });
    expect(result.results[0]!.status).toBe("rejected");
    expect(result.results[0]!.rejection).toMatch(/may not file inspections/);
    const snapshot = await dispatch.snapshot(technician(), { deviceId: device, from: new Date().toISOString().slice(0, 10), days: 2 });
    expect(snapshot.inspectionPrograms).toEqual([]);
  });

  it("refuses equipment from another address and files nothing of that inspection", async () => {
    const program = await inspections.defineProgram(owner(), PROGRAM);
    const { visitId } = await visitToday();
    const [elsewhere] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code)
      values (${ORG}, '1 Other St', 'Austin', 'TX', '78701') returning id`;
    const [unit] = await raw<{ id: string }[]>`insert into public.equipment (organization_id, property_id, category)
      values (${ORG}, ${elsewhere!.id}, 'backflow') returning id`;
    const device = (await fieldOps.register(inspector(), { installationId: `install-${crypto.randomUUID()}` })).deviceId;
    const op = operation(visitId, program.id, crypto.randomUUID(), 1);
    (op.payload.answers[0] as Record<string, unknown>)["equipmentId"] = unit!.id;
    const result = await fieldOps.sync(inspector(), { deviceId: device, operations: [op] });
    expect(result.results[0]!.status).toBe("rejected");
    expect(result.results[0]!.rejection).toMatch(/not on the register at this property/);
    const [{ n }] = await raw<{ n: number }[]>`select count(*)::int as n from public.inspection where organization_id = ${ORG}`;
    expect(n).toBe(0);
  });
});
