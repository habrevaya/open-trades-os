import type { FieldInspectionProgram } from "./wire";

/**
 * RUNNING AN INSPECTION ON THE PHONE
 *
 * The technician walks the programme's checkpoints and says what they saw:
 * a pass or a fail, a reading, or not applicable with a reason. This file
 * turns what they tapped and typed into the answers the server files, and
 * says before anything is saved when a reading is not a number or is
 * outside its range.
 *
 * IT NEVER DECIDES THE VERDICT. Whether the inspection passed is the
 * server's conclusion, drawn from the programme by the same core the office
 * uses, because a phone that could file "pass" is a phone that could file a
 * half finished inspection as a pass. So an unanswered checkpoint is simply
 * left out, and the server calls the inspection partial; the phone only
 * warns that it will.
 *
 * Pure, and here rather than in either app, so the phone app and the web
 * day page build exactly the same answers and a test holds them to it.
 */

export interface CheckpointEntry {
  /** A pass or fail checkpoint: true passed, false failed, null not looked at. */
  passed?: boolean | null | undefined;
  /** A reading, as typed. */
  reading?: string | undefined;
  /** Not applicable, with why. A blank reason is no answer at all. */
  notApplicable?: string | undefined;
  note?: string | undefined;
  /** Photographs taken against this checkpoint: their upload ids. */
  photoIds?: string[] | undefined;
}

export type ReadingCheck =
  | { state: "empty" }
  | { state: "not_a_number"; message: string }
  | { state: "in_range" }
  | { state: "out_of_range"; message: string };

/** What a typed reading is against its checkpoint's range, said on the phone. */
export function checkReading(
  checkpoint: FieldInspectionProgram["checkpoints"][number], typed: string,
): ReadingCheck {
  const text = typed.trim().replace(/,/g, "");
  if (text === "") return { state: "empty" };
  if (!/^-?\d+(\.\d+)?$/.test(text)) {
    return { state: "not_a_number", message: `"${typed.trim()}" is not a number.` };
  }
  const value = Number(text);
  const unit = checkpoint.unit ? ` ${checkpoint.unit}` : "";
  if (checkpoint.min !== null && value < checkpoint.min) {
    return { state: "out_of_range", message: `Below the ${checkpoint.min}${unit} it should be at least. This will be a finding.` };
  }
  if (checkpoint.max !== null && value > checkpoint.max) {
    return { state: "out_of_range", message: `Above the ${checkpoint.max}${unit} it should be at most. This will be a finding.` };
  }
  return { state: "in_range" };
}

export interface InspectionAnswer {
  itemKey: string;
  value:
    | { kind: "pass_fail"; passed: boolean }
    | { kind: "reading"; raw: number }
    | { kind: "not_applicable"; why: string };
  at: string;
  by: string;
  note?: string;
  photoIds?: string[];
}

export interface BuiltInspection {
  answers: InspectionAnswer[];
  /** Checkpoints with no usable answer. The server will call the inspection partial. */
  unanswered: string[];
  /** Readings typed that are not numbers, which are not sent. */
  unreadable: string[];
}

/**
 * The answers to send, from what was entered. A checkpoint with nothing
 * usable on it is left out and named, never sent as a guess: a reading of
 * "about twelve" is not a reading, and a blank not applicable is a skip.
 */
export function buildInspection(input: {
  program: FieldInspectionProgram;
  entries: Record<string, CheckpointEntry | undefined>;
  by: string;
  at: Date;
}): BuiltInspection {
  const answers: InspectionAnswer[] = [];
  const unanswered: string[] = [];
  const unreadable: string[] = [];
  const at = input.at.toISOString();

  for (const checkpoint of input.program.checkpoints) {
    const entry = input.entries[checkpoint.key];
    const extras = {
      ...(entry?.note && entry.note.trim() !== "" ? { note: entry.note.trim().slice(0, 2000) } : {}),
      ...(entry?.photoIds && entry.photoIds.length > 0 ? { photoIds: [...entry.photoIds] } : {}),
    };
    if (entry?.notApplicable !== undefined && entry.notApplicable.trim() !== "") {
      answers.push({ itemKey: checkpoint.key, value: { kind: "not_applicable", why: entry.notApplicable.trim().slice(0, 500) }, at, by: input.by, ...extras });
      continue;
    }
    if (checkpoint.requiresReading) {
      const check = checkReading(checkpoint, entry?.reading ?? "");
      if (check.state === "empty") { unanswered.push(checkpoint.label); continue; }
      if (check.state === "not_a_number") { unreadable.push(checkpoint.label); unanswered.push(checkpoint.label); continue; }
      answers.push({
        itemKey: checkpoint.key,
        value: { kind: "reading", raw: Number(entry!.reading!.trim().replace(/,/g, "")) },
        at, by: input.by, ...extras,
      });
      continue;
    }
    if (entry?.passed === true || entry?.passed === false) {
      answers.push({ itemKey: checkpoint.key, value: { kind: "pass_fail", passed: entry.passed }, at, by: input.by, ...extras });
      continue;
    }
    unanswered.push(checkpoint.label);
  }
  return { answers, unanswered, unreadable };
}

/**
 * The payload of the `inspection.record` operation. The inspection's id is
 * the operation's subject, made on the phone, so the signature taken on the
 * same screen and a retry both name the same inspection.
 */
export function inspectionPayload(input: {
  visitId: string;
  program: FieldInspectionProgram;
  built: BuiltInspection;
  inspectorName?: string | undefined;
  inspectorLicense?: string | undefined;
  signedByName?: string | undefined;
  signatureUploadId?: string | undefined;
}): Record<string, unknown> {
  const text = (value: string | undefined) => (value && value.trim() !== "" ? value.trim() : undefined);
  return {
    visitId: input.visitId,
    programId: input.program.id,
    /** For the day screen to name it before the server has answered. */
    programName: input.program.name,
    answers: input.built.answers,
    ...(text(input.inspectorName) ? { inspectorName: text(input.inspectorName) } : {}),
    ...(text(input.inspectorLicense) ? { inspectorLicense: text(input.inspectorLicense) } : {}),
    ...(text(input.signedByName) ? { signedByName: text(input.signedByName) } : {}),
    ...(input.signatureUploadId ? { signatureUploadId: input.signatureUploadId } : {}),
  };
}

/** The server's verdict, in words for the day screen. */
export function resultLabel(result: string | null): string {
  switch (result) {
    case "pass": return "Passed";
    case "pass_with_deficiencies": return "Passed, with findings";
    case "fail": return "Failed";
    case "partial": return "Not finished";
    case null: return "Filed";
    default: return result.replace(/_/g, " ");
  }
}
