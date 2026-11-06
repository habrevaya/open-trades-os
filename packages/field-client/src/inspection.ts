import type { FieldInspectionProgram } from "./wire";

/**
 * RUNNING AN INSPECTION ON THE PHONE
 *
 * The technician walks the programme's checkpoints and says what they saw:
 * a pass or a fail, a reading, a count, a photo, a note, or not applicable
 * with a reason. This file
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

type FieldCheckpoint = FieldInspectionProgram["checkpoints"][number];
export type CheckpointKind = "pass_fail" | "reading" | "photo" | "note" | "count";

/**
 * The kind of answer a checkpoint takes. A server older than answer kinds
 * sends only `requiresReading`, and then it is a reading or a pass or fail,
 * which is all a checkpoint could be.
 */
export function checkpointKind(checkpoint: FieldCheckpoint): CheckpointKind {
  return checkpoint.kind ?? (checkpoint.requiresReading ? "reading" : "pass_fail");
}

/**
 * The checkpoints under their headings, in the programme's order: the ones
 * next to each other with one heading are one section, as the server reads
 * them. A programme with no headings is one section with no title.
 */
export function sectionsOf(program: FieldInspectionProgram): { title: string | null; checkpoints: FieldCheckpoint[] }[] {
  const sections: { title: string | null; checkpoints: FieldCheckpoint[] }[] = [];
  for (const checkpoint of program.checkpoints) {
    const title = checkpoint.section?.trim() || null;
    const last = sections[sections.length - 1];
    if (last && last.title === title) last.checkpoints.push(checkpoint);
    else sections.push({ title, checkpoints: [checkpoint] });
  }
  return sections;
}

/** What passes, in words beside the box: "5 to 10", "at least 4". Empty when there is nothing to say. */
export function expectationText(checkpoint: FieldCheckpoint): string {
  const kind = checkpointKind(checkpoint);
  if (kind === "count") {
    return checkpoint.expectedAtLeast !== null && checkpoint.expectedAtLeast !== undefined
      ? `at least ${checkpoint.expectedAtLeast}` : "";
  }
  if (kind !== "reading") return "";
  if (checkpoint.min !== null && checkpoint.max !== null) return `${checkpoint.min} to ${checkpoint.max}`;
  if (checkpoint.min !== null) return `at least ${checkpoint.min}`;
  if (checkpoint.max !== null) return `at most ${checkpoint.max}`;
  return "";
}

export interface CheckpointEntry {
  /** A pass or fail checkpoint: true passed, false failed, null not looked at. */
  passed?: boolean | null | undefined;
  /** A reading, as typed. */
  reading?: string | undefined;
  /** A count, as typed. */
  count?: string | undefined;
  /** The answer to a note checkpoint, which is what was seen. */
  text?: string | undefined;
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

/** What a typed count is against how many there should be, said on the phone. */
export function checkCount(checkpoint: FieldCheckpoint, typed: string): ReadingCheck {
  const text = typed.trim().replace(/,/g, "");
  if (text === "") return { state: "empty" };
  if (!/^\d+$/.test(text)) {
    return { state: "not_a_number", message: `"${typed.trim()}" is not a whole number.` };
  }
  const expected = checkpoint.expectedAtLeast;
  if (expected !== null && expected !== undefined && Number(text) < expected) {
    return { state: "out_of_range", message: `Fewer than the ${expected} there should be. This will be a finding.` };
  }
  return { state: "in_range" };
}

/** What a typed reading is against its checkpoint's range, said on the phone. */
export function checkReading(
  checkpoint: FieldCheckpoint, typed: string,
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
    | { kind: "count"; count: number }
    | { kind: "photo"; photoIds: string[] }
    | { kind: "note"; text: string }
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
  /** Readings and counts typed that are not numbers, which are not sent. */
  unreadable: string[];
  /** Optional checkpoints left blank. They do not leave it not finished. */
  optionalSkipped: string[];
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
  const optionalSkipped: string[] = [];
  const at = input.at.toISOString();

  for (const checkpoint of input.program.checkpoints) {
    const entry = input.entries[checkpoint.key];
    const kind = checkpointKind(checkpoint);
    /** Left blank: named, and for an optional checkpoint named as optional, never guessed at. */
    const skip = () => {
      if (checkpoint.optional) optionalSkipped.push(checkpoint.label);
      else unanswered.push(checkpoint.label);
    };
    const extras = {
      ...(entry?.note && entry.note.trim() !== "" && kind !== "note" ? { note: entry.note.trim().slice(0, 2000) } : {}),
      /** A photo checkpoint's photos are its answer, so they are not sent twice. */
      ...(entry?.photoIds && entry.photoIds.length > 0 && kind !== "photo" ? { photoIds: [...entry.photoIds] } : {}),
    };
    if (entry?.notApplicable !== undefined && entry.notApplicable.trim() !== "") {
      answers.push({ itemKey: checkpoint.key, value: { kind: "not_applicable", why: entry.notApplicable.trim().slice(0, 500) }, at, by: input.by, ...extras });
      continue;
    }
    if (kind === "reading" || kind === "count") {
      const typed = (kind === "reading" ? entry?.reading : entry?.count) ?? "";
      const check = kind === "reading" ? checkReading(checkpoint, typed) : checkCount(checkpoint, typed);
      if (check.state === "empty") { skip(); continue; }
      if (check.state === "not_a_number") { unreadable.push(checkpoint.label); skip(); continue; }
      const value = Number(typed.trim().replace(/,/g, ""));
      answers.push({
        itemKey: checkpoint.key,
        value: kind === "reading" ? { kind: "reading", raw: value } : { kind: "count", count: value },
        at, by: input.by, ...extras,
      });
      continue;
    }
    if (kind === "photo") {
      if (!entry?.photoIds || entry.photoIds.length === 0) { skip(); continue; }
      answers.push({ itemKey: checkpoint.key, value: { kind: "photo", photoIds: [...entry.photoIds] }, at, by: input.by, ...extras });
      continue;
    }
    if (kind === "note") {
      const text = entry?.text?.trim() ?? "";
      if (text === "") { skip(); continue; }
      answers.push({ itemKey: checkpoint.key, value: { kind: "note", text: text.slice(0, 2000) }, at, by: input.by, ...extras });
      continue;
    }
    if (entry?.passed === true || entry?.passed === false) {
      answers.push({ itemKey: checkpoint.key, value: { kind: "pass_fail", passed: entry.passed }, at, by: input.by, ...extras });
      continue;
    }
    skip();
  }
  return { answers, unanswered, unreadable, optionalSkipped };
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
    /**
     * The version the technician was shown. Filed after the office published
     * a newer one, the server judges it against this one, the checkpoints
     * that were actually answered.
     */
    programVersion: input.program.version,
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
