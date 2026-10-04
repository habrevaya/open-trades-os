import { describe, it, expect } from "vitest";
import {
  buildInspection, checkReading, inspectionPayload, projectDay, resultLabel,
  type FieldInspectionProgram, type FieldSnapshot, type QueuedOperation,
} from "../src/index";

/**
 * AN INSPECTION RUN ON THE PHONE.
 *
 * The phone builds answers and never a verdict. The two things these tests
 * hold it to: a checkpoint nobody answered is left out rather than guessed,
 * so the server calls the inspection partial; and a reading that is not a
 * number is said on the phone and never sent as one.
 */

const program: FieldInspectionProgram = {
  id: "p1", name: "Annual backflow test", standard: "AWWA", version: 2,
  checkpoints: [
    { key: "shutoff", label: "Number 1 shutoff holds", requiresReading: false, unit: null, min: null, max: null },
    { key: "psi", label: "Differential pressure", requiresReading: true, unit: "psi", min: 5, max: null },
    { key: "relief", label: "Relief valve opens", requiresReading: false, unit: null, min: null, max: null },
  ],
};
const at = new Date("2026-10-03T15:00:00Z");

describe("building the answers", () => {
  it("sends what was seen, and names what was not answered rather than guessing", () => {
    const built = buildInspection({
      program, by: "Ray Nunez", at,
      entries: { shutoff: { passed: true, note: " Held at 2 psid " }, psi: { reading: "4.5" } },
    });
    expect(built.answers).toEqual([
      { itemKey: "shutoff", value: { kind: "pass_fail", passed: true }, at: at.toISOString(), by: "Ray Nunez", note: "Held at 2 psid" },
      { itemKey: "psi", value: { kind: "reading", raw: 4.5 }, at: at.toISOString(), by: "Ray Nunez" },
    ]);
    expect(built.unanswered).toEqual(["Relief valve opens"]);
  });

  it("never sends a reading that is not a number", () => {
    const built = buildInspection({ program, by: "R", at, entries: { psi: { reading: "about 12" } } });
    expect(built.answers.find((a) => a.itemKey === "psi")).toBeUndefined();
    expect(built.unreadable).toEqual(["Differential pressure"]);
  });

  it("takes not applicable only with a reason", () => {
    const blank = buildInspection({ program, by: "R", at, entries: { relief: { notApplicable: "  " } } });
    expect(blank.unanswered).toContain("Relief valve opens");
    const said = buildInspection({ program, by: "R", at, entries: { relief: { notApplicable: "No relief valve on this assembly" } } });
    expect(said.answers).toContainEqual(expect.objectContaining({
      itemKey: "relief", value: { kind: "not_applicable", why: "No relief valve on this assembly" },
    }));
  });

  it("says before saving when a reading is outside its range", () => {
    expect(checkReading(program.checkpoints[1]!, "4").state).toBe("out_of_range");
    expect(checkReading(program.checkpoints[1]!, "5").state).toBe("in_range");
    expect(checkReading(program.checkpoints[1]!, "1,250").state).toBe("in_range");
    expect(checkReading(program.checkpoints[1]!, "lots").state).toBe("not_a_number");
  });

  it("carries the visit, the programme and who signed it, and no verdict", () => {
    const built = buildInspection({ program, by: "R", at, entries: { shutoff: { passed: false } } });
    const payload = inspectionPayload({
      visitId: "v1", program, built, signedByName: " Ray Nunez ", signatureUploadId: "u1",
    });
    expect(payload).toEqual({
      visitId: "v1", programId: "p1", programName: "Annual backflow test",
      answers: built.answers, signedByName: "Ray Nunez", signatureUploadId: "u1",
    });
    expect(Object.keys(payload)).not.toContain("result");
  });
});

describe("the day shows it", () => {
  const snapshot = (inspections: FieldSnapshot["visits"][number]["inspections"]): FieldSnapshot => ({
    revision: 1, unchanged: false, priceBook: [], openTimeEntry: null,
    visits: [{
      id: "v1", jobId: "j1", jobNumber: 1, sequence: 1, status: "working", summary: "Test",
      description: null, customerComplaint: null, technicianNotes: null, arrivedAt: null,
      windowStart: null, windowEnd: null, routeOrder: 1, estimatedDurationMinutes: 60,
      customer: { id: "c", name: "C", phone: null },
      property: { id: "pr", addressLine1: "1 St", city: "A", state: "TX", postalCode: "1", gateCode: null, accessNotes: null, hazardNotes: null, hasDog: false },
      checklist: [], amountDue: null, report: { id: null, submitted: false, fields: [] }, parts: [],
      inspections,
    }],
  });
  const op = (status: QueuedOperation["status"] = "pending"): QueuedOperation => ({
    clientId: "op1", sequence: 1, kind: "inspection.record", subjectId: "i1",
    occurredAt: at.toISOString(), payload: { visitId: "v1", programName: "Annual backflow test" },
    status, attempts: 0,
  });

  it("lists an inspection filed on this phone as waiting, under its visit", () => {
    const day = projectDay({ snapshot: snapshot([]), operations: [op()] });
    expect(day.visits[0]!.inspections).toEqual([
      { id: "i1", programName: "Annual backflow test", result: null, waiting: true },
    ]);
    expect(day.visits[0]!.waiting).toBe(1);
  });

  it("takes the server's verdict once it has one, rather than listing it twice", () => {
    const day = projectDay({
      snapshot: snapshot([{ id: "i1", programId: "p1", programName: "Annual backflow test", result: "fail", performedOn: "2026-10-03" }]),
      operations: [], applied: [op("pending")],
    });
    expect(day.visits[0]!.inspections).toEqual([
      { id: "i1", programName: "Annual backflow test", result: "fail", waiting: false },
    ]);
    expect(resultLabel("fail")).toBe("Failed");
    expect(resultLabel("partial")).toBe("Not finished");
  });
});
