import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { type Actor } from "@opentradesos/core";
import * as inspections from "../src/services/inspections";
import * as customers from "../src/services/customers";
import * as properties from "../src/services/properties";
import * as fieldOps from "../src/services/field";
import * as dispatchService from "../src/services/dispatch";
import { dispatch } from "../src/http/dispatch";
import { type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * MORE KINDS OF CHECKPOINT, SECTIONS, A CODE REFERENCE, AND A DRAFT
 *
 * Core always took a photo, a note and a count as answers, optional items,
 * sections and a code clause per item. The stored checkpoint had nowhere for
 * any of them, so a programme was one flat list of pass or fail and readings.
 * These hold the stored checkpoint to core's shape: each kind is saved, run
 * from the phone, judged by core, and printed; a heading split in two is
 * refused at the save; a code reference reaches the finding and its quote.
 *
 * A draft is saved work that nobody can use: not offered, not filed against,
 * not checked until it is published, and then checked exactly as a
 * programme saved whole is.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("checkpoint-kinds:org");
const USER = fixtureId("checkpoint-kinds:user");

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"], grants: Actor["grants"] = []): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles, grants, revocations: [] }, db: db(),
});
const owner = () => as(["owner"]);
const inspector = () => as(["technician"], ["compliance:read", "compliance:write"]);

let customerId = "";
let propertyId = "";
let technicianId = "";

const ROOMS = [
  { key: "pump-photo", label: "Photo of the pump nameplate", answerKind: "photo" as const, section: "Pump room" },
  {
    key: "pump-psi", label: "Churn pressure", requiresReading: true, unit: "psi",
    range: { min: 90, max: 120 }, severityOnFail: "major" as const, section: "Pump room",
    codeReference: "NFPA 25 8.3.3.1",
  },
  {
    key: "heads", label: "Spare heads in the cabinet", answerKind: "count" as const, expectedAtLeast: 6,
    severityOnFail: "minor" as const, section: "Riser", codeReference: "NFPA 25 5.4.1.4",
  },
  { key: "riser-note", label: "Anything else at the riser", answerKind: "note" as const, section: "Riser", optional: true },
  { key: "gauge", label: "Gauges in date", severityOnFail: "advisory" as const, optional: true, section: "Riser" },
];

const SPRINKLER = {
  name: "Sprinkler annual",
  standard: "NFPA 25",
  reportAudience: "both" as const,
  authorityName: "Austin Fire Marshal",
  frequencyMonths: 12,
  checkpoints: ROOMS,
};

const at = new Date("2026-06-01T15:00:00Z");
const answer = (itemKey: string, value: unknown) => ({ itemKey, value: value as never, at, by: "Ray Nunez" });

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Checkpoint Kinds Co", slug: "checkpoint-kinds-co" });
  const customer = await customers.create(owner(), {
    type: "commercial", name: "Riverside Storage", phone: "+15125550977",
    paymentTermsDays: 30, taxExempt: false, tags: [], customFields: {},
  });
  customerId = customer.id;
  const property = await properties.create(owner(), {
    address: { line1: "9 Riverside Dr", city: "Austin", state: "TX", postalCode: "78741", country: "US" },
    hasDog: false, customFields: {}, customerId, customerRole: "owner",
  });
  propertyId = property.id;
  const [membership] = await raw<{ id: string }[]>`
    select id from public.membership where organization_id = ${ORG} and user_id = ${USER}`;
  const [t] = await raw<{ id: string }[]>`insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${membership!.id}, 'Ray Nunez') returning id`;
  technicianId = t!.id;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.deficiency where organization_id = ${ORG}`;
  await raw`delete from public.inspection where organization_id = ${ORG}`;
  await raw`delete from public.inspection_program where organization_id = ${ORG}`;
});

async function visitToday() {
  const today = companyToday();
  const [job] = await raw<{ id: string }[]>`insert into public.job
    (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${Math.floor(Math.random() * 1e6) + 1000}, ${customerId}, ${propertyId}, 'scheduled', 'Sprinkler test') returning id`;
  const [visit] = await raw<{ id: string }[]>`insert into public.visit (organization_id, job_id, status, window_start)
    values (${ORG}, ${job!.id}, 'working', ${`${today}T17:00:00Z`}) returning id`;
  await raw`insert into public.visit_assignment (organization_id, visit_id, technician_id)
    values (${ORG}, ${visit!.id}, ${technicianId})`;
  return { visitId: visit!.id, today };
}

run("photo, note and count checkpoints, sections and code references", () => {
  it("stores each kind in one form, and leaves a pass or fail and a reading as they always were", async () => {
    const row = await inspections.defineProgram(owner(), SPRINKLER);
    const stored = row.checkpoints;
    expect(stored[0]).toEqual({ key: "pump-photo", label: "Photo of the pump nameplate", answerKind: "photo", section: "Pump room" });
    expect(stored[1]).toMatchObject({ requiresReading: true, codeReference: "NFPA 25 8.3.3.1" });
    expect(stored[1]).not.toHaveProperty("answerKind");
    expect(stored[2]).toMatchObject({ answerKind: "count", expectedAtLeast: 6 });
    expect(stored[4]).toEqual({
      key: "gauge", label: "Gauges in date", severityOnFail: "advisory", optional: true, section: "Riser",
    });

    /** Saying "reading" in words stores what `requiresReading` stored, so nothing new is published. */
    const same = await inspections.reviseProgram(owner(), {
      id: row.id, baseVersion: 1,
      checkpoints: ROOMS.map((c) => (c.key === "pump-psi" ? { ...c, answerKind: "reading" as const } : c)),
    });
    expect(same.version).toBe(1);
  });

  it("does not ask how serious a photo or a note is, and refuses a count with nothing to count against", async () => {
    await expect(inspections.defineProgram(owner(), {
      ...SPRINKLER, checkpoints: [{ key: "n", label: "Notes", answerKind: "note" }, { key: "p", label: "Photo", answerKind: "photo" }],
    })).resolves.toMatchObject({ version: 1 });
    await expect(inspections.defineProgram(owner(), {
      ...SPRINKLER, name: "Counting", checkpoints: [{ key: "c", label: "Heads", answerKind: "count", severityOnFail: "minor" }],
    })).rejects.toThrow(/without saying how many there should be/);
    await expect(inspections.defineProgram(owner(), {
      ...SPRINKLER, name: "Counting", checkpoints: [{ key: "c", label: "Heads", answerKind: "count", expectedAtLeast: 2 }],
    })).rejects.toThrow(/"Heads" does not say how serious a fail is/);
  });

  it("refuses a section split in two, because the technician who finishes the first half thinks it is done", async () => {
    await expect(inspections.defineProgram(owner(), {
      ...SPRINKLER,
      checkpoints: [ROOMS[0]!, ROOMS[2]!, { ...ROOMS[1]!, section: "Pump room" }],
    })).rejects.toThrow(/The section "Pump room" is in two places/);
  });

  it("files every kind, lets an optional one be skipped, and carries the code to the finding and the report", async () => {
    const row = await inspections.defineProgram(owner(), SPRINKLER);
    const photo = crypto.randomUUID();
    const filed = await inspections.record(owner(), {
      programId: row.id, propertyId, customerId,
      answers: [
        answer("pump-photo", { kind: "photo", photoIds: [photo] }),
        answer("pump-psi", { kind: "reading", raw: 104 }),
        answer("heads", { kind: "count", count: 4 }),
      ],
    });
    /** Short of spare heads is wear, which does not fail it; the two optional ones skipped do not hold it up. */
    expect(filed).toMatchObject({ result: "pass_with_deficiencies", complete: true, deficiencies: 1 });
    expect(filed.optionalSkipped).toEqual(["riser-note", "gauge"]);
    const [finding] = await raw<{ code: string; description: string }[]>`
      select code, description from public.deficiency where inspection_id = ${filed.id}`;
    expect(finding).toMatchObject({ code: "NFPA 25 5.4.1.4", description: "Spare heads in the cabinet: found 4, expected at least 6." });

    const report = await inspections.report(owner(), { id: filed.id });
    expect(report.items.map((i) => [i.key, i.kind, i.section, i.verdict, i.optional])).toEqual([
      ["pump-photo", "photo", "Pump room", "recorded", false],
      ["pump-psi", "reading", "Pump room", "pass", false],
      ["heads", "count", "Riser", "finding", false],
      ["riser-note", "note", "Riser", "not_answered", true],
      ["gauge", "pass_fail", "Riser", "not_answered", true],
    ]);
    expect(report.items[1]).toMatchObject({ codeReference: "NFPA 25 8.3.3.1", range: "90 to 120 psi" });
    expect(report.items[2]).toMatchObject({ range: "at least 6", answer: "4", codeReference: "NFPA 25 5.4.1.4" });
    expect(report.items[0]!.photos.map((p) => p.id)).toEqual([photo]);
  });

  it("refuses a pass or fail sent to a note checkpoint, rather than guessing", async () => {
    const row = await inspections.defineProgram(owner(), SPRINKLER);
    await expect(inspections.record(owner(), {
      programId: row.id, propertyId, customerId,
      answers: [answer("riser-note", { kind: "pass_fail", passed: true })],
    })).rejects.toThrow(/wrong kind of answer/);
  });

  it("sends the kinds to the phone, and files a note, a count and a photo from it offline", async () => {
    const row = await inspections.defineProgram(owner(), SPRINKLER);
    const { visitId, today } = await visitToday();
    const device = (await fieldOps.register(inspector(), { installationId: `install-${crypto.randomUUID()}` })).deviceId;

    const slice = await dispatchService.snapshot(inspector(), { deviceId: device, from: today, days: 1 });
    const program = slice.inspectionPrograms.find((p) => p.id === row.id)!;
    /** A pass or fail and a reading carry no kind: `requiresReading` tells them, as it always did. */
    expect(program.checkpoints.map((c) => [c.key, c.kind, c.requiresReading, c.section, c.optional])).toEqual([
      ["pump-photo", "photo", false, "Pump room", undefined],
      ["pump-psi", undefined, true, "Pump room", undefined],
      ["heads", "count", false, "Riser", undefined],
      ["riser-note", "note", false, "Riser", true],
      ["gauge", undefined, false, "Riser", true],
    ]);
    expect(program.checkpoints[2]).toMatchObject({ expectedAtLeast: 6, codeReference: "NFPA 25 5.4.1.4" });

    const inspectionId = crypto.randomUUID();
    const photo = crypto.randomUUID();
    const iso = at.toISOString();
    const result = await fieldOps.sync(inspector(), {
      deviceId: device,
      operations: [{
        clientId: crypto.randomUUID(), sequence: 1, kind: "inspection.record", subjectId: inspectionId,
        occurredAt: iso,
        payload: {
          visitId, programId: row.id, programVersion: 1,
          answers: [
            { itemKey: "pump-photo", value: { kind: "photo", photoIds: [photo] }, at: iso, by: "Ray Nunez" },
            { itemKey: "pump-psi", value: { kind: "reading", raw: 100 }, at: iso, by: "Ray Nunez" },
            { itemKey: "heads", value: { kind: "count", count: 8 }, at: iso, by: "Ray Nunez" },
            { itemKey: "riser-note", value: { kind: "note", text: "Riser room used for storage" }, at: iso, by: "Ray Nunez" },
          ],
        },
      }],
    });
    expect(result.results[0]).toMatchObject({ status: "applied", rejection: null });
    const [kept] = await raw<{ result: string; answers: { itemKey: string; value: { kind: string } }[] }[]>`
      select result, answers from public.inspection where id = ${inspectionId}`;
    expect(kept!.result).toBe("pass");
    expect(kept!.answers.map((a) => a.value.kind)).toEqual(["photo", "reading", "count", "note"]);
  });
});

run("a draft programme", () => {
  /** A pack's reading copied before anybody knows the range: core will not judge it, so it cannot be published yet. */
  const UNFINISHED = {
    ...SPRINKLER,
    name: "Sprinkler annual (draft)",
    checkpoints: [{ key: "psi", label: "Churn pressure", requiresReading: true, unit: "psi", severityOnFail: "major" as const }],
  };

  it("is saved unfinished, never offered, never filed against, and published only once it could be filed", async () => {
    const draft = await inspections.defineProgram(owner(), { ...UNFINISHED, draft: true });
    expect(draft).toMatchObject({ draft: true, active: false });

    const listed = await inspections.programs(owner(), { includeRetired: true });
    expect(listed.find((p) => p.id === draft.id)).toMatchObject({ draft: true, ready: false });
    expect((await inspections.programs(owner())).map((p) => p.id)).not.toContain(draft.id);
    const view = await inspections.program(owner(), { id: draft.id });
    expect(view.versions).toEqual([]);
    const kept = await raw`select 1 from public.inspection_program_version where program_id = ${draft.id}`;
    expect(kept).toHaveLength(0);

    await expect(inspections.record(owner(), {
      programId: draft.id, propertyId, customerId, answers: [answer("psi", { kind: "reading", raw: 100 })],
    })).rejects.toThrow(/is a draft. Publish it before an inspection is filed against it/);
    await expect(inspections.setOffered(owner(), { id: draft.id, offered: true })).rejects.toThrow(/is a draft/);
    await expect(inspections.reviseProgram(owner(), { id: draft.id, baseVersion: 1, checkpoints: ROOMS }))
      .rejects.toThrow(/is a draft/);
    await expect(inspections.defineProgram(owner(), { ...SPRINKLER, name: "Copy", copiedFrom: { kind: "program", programId: draft.id } }))
      .rejects.toThrow(/is a draft/);

    /** Publishing applies every check a programme saved whole goes through. */
    await expect(inspections.publishDraft(owner(), { id: draft.id })).rejects.toThrow(/no acceptable range/);

    const saved = await inspections.saveDraft(owner(), {
      id: draft.id, ...UNFINISHED,
      checkpoints: [{ ...UNFINISHED.checkpoints[0]!, range: { min: 90, max: 120 } }],
    });
    expect(saved).toMatchObject({ draft: true, active: false });

    const published = await inspections.publishDraft(owner(), { id: draft.id, note: "Ranges from the pump curve" });
    expect(published).toMatchObject({ draft: false, active: true, version: 1 });
    const versions = await raw<{ version: number; note: string }[]>`
      select version, note from public.inspection_program_version where program_id = ${draft.id}`;
    expect(versions).toEqual([{ version: 1, note: "Ranges from the pump curve" }]);
    await expect(inspections.saveDraft(owner(), { id: draft.id, ...UNFINISHED })).rejects.toThrow(/is published, not a draft/);

    const actions = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and entity_id = ${draft.id} order by created_at`;
    expect(actions.map((a) => a.action)).toEqual([
      "inspection_program.drafted", "inspection_program.draft_saved", "inspection_program.published",
    ]);
  });

  it("is not on the phone", async () => {
    const draft = await inspections.defineProgram(owner(), { ...SPRINKLER, draft: true });
    const { today } = await visitToday();
    const device = (await fieldOps.register(inspector(), { installationId: `install-${crypto.randomUUID()}` })).deviceId;
    const slice = await dispatchService.snapshot(inspector(), { deviceId: device, from: today, days: 1 });
    expect(slice.inspectionPrograms.map((p) => p.id)).not.toContain(draft.id);
  });

  it("takes another programme's place only when it is published, under that one's name", async () => {
    const old = await inspections.defineProgram(owner(), SPRINKLER);
    await expect(inspections.defineProgram(owner(), { ...SPRINKLER, draft: true, replaces: old.id }))
      .rejects.toThrow(/Choose what it replaces when you publish it/);
    const draft = await inspections.defineProgram(owner(), { ...SPRINKLER, draft: true });
    await expect(inspections.publishDraft(owner(), { id: draft.id })).rejects.toThrow(/already offered a programme called/);
    await inspections.publishDraft(owner(), { id: draft.id, replaces: old.id });
    const offered = await inspections.programs(owner());
    expect(offered.map((p) => p.id)).toEqual([draft.id]);
  });

  it("is thrown away, and a published programme is not", async () => {
    const draft = await inspections.defineProgram(owner(), { ...SPRINKLER, draft: true });
    expect(await inspections.discardDraft(owner(), { id: draft.id })).toEqual({ id: draft.id, discarded: true });
    expect(await raw`select 1 from public.inspection_program where id = ${draft.id}`).toHaveLength(0);
    const [line] = await raw`select action from public.audit_log where organization_id = ${ORG} and entity_id = ${draft.id}
      and action = 'inspection_program.draft_discarded'`;
    expect(line).toBeDefined();

    const published = await inspections.defineProgram(owner(), SPRINKLER);
    await expect(inspections.discardDraft(owner(), { id: published.id })).rejects.toThrow(/is published, not a draft/);
  });
});

run("drafts over HTTP", () => {
  const call = async (ctx: ServiceContext, method: string, path: string, body?: unknown, key?: string) => {
    const response = await dispatch(new Request(`http://x${path}`, {
      method,
      headers: { "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }), { db: db(), resolveSession: async () => ctx });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  };

  it("saves, saves again, publishes once for a retried key, and refuses somebody who may only read", async () => {
    const made = await call(owner(), "POST", "/v1/inspection-programs", { ...SPRINKLER, draft: true });
    expect(made.status).toBe(201);
    expect(made.body).toMatchObject({ draft: true, active: false, ready: true });
    const id = made.body["id"] as string;

    const reader = as(["office_manager"], ["compliance:read"]);
    expect((await call(reader, "PUT", `/v1/inspection-programs/${id}/draft`, SPRINKLER)).status).toBe(403);
    expect((await call(reader, "POST", `/v1/inspection-programs/${id}/publish`, {})).status).toBe(403);
    expect((await call(reader, "DELETE", `/v1/inspection-programs/${id}/draft`)).status).toBe(403);
    expect((await call(reader, "POST", "/v1/inspection-programs", { ...SPRINKLER, draft: true })).status).toBe(403);
    expect((await call(reader, "GET", `/v1/inspection-programs/${id}`)).status).toBe(200);

    const saved = await call(owner(), "PUT", `/v1/inspection-programs/${id}/draft`, { ...SPRINKLER, frequencyMonths: 6 });
    expect(saved.body).toMatchObject({ draft: true, frequencyMonths: 6 });

    const key = crypto.randomUUID();
    const published = await call(owner(), "POST", `/v1/inspection-programs/${id}/publish`, { note: "Ready" }, key);
    expect(published.status).toBe(201);
    expect(published.body).toMatchObject({ draft: false, active: true, version: 1 });
    const again = await call(owner(), "POST", `/v1/inspection-programs/${id}/publish`, { note: "Ready" }, key);
    expect(again.body).toMatchObject({ id, draft: false, version: 1 });

    const gone = await call(owner(), "DELETE", `/v1/inspection-programs/${id}/draft`);
    expect(gone.status).toBe(409);
  });
});
