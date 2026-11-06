/**
 * THE KINDS OF ANSWER A CHECKPOINT TAKES, on the screen.
 *
 * Shared by the editor (a client component) and the programme's page (a
 * server one), so it lives in neither.
 */
export type Kind = "pass_fail" | "reading" | "photo" | "note" | "count";

/** The kind of answer, from the stored checkpoint: `answerKind`, or a reading or a pass or fail as it always was. */
export function kindOf(c: { answerKind?: Kind | undefined; requiresReading?: boolean | undefined }): Kind {
  return c.answerKind ?? (c.requiresReading ? "reading" : "pass_fail");
}

/** What each kind is called on the screen. */
export const KINDS: { value: Kind; label: string }[] = [
  { value: "pass_fail", label: "Pass or fail" },
  { value: "reading", label: "A reading" },
  { value: "count", label: "A count" },
  { value: "photo", label: "A photo" },
  { value: "note", label: "A note" },
];

/** A photo and a note are what was seen, never a finding, so they are not asked how serious a fail is. */
export const canFail = (kind: string) => kind === "pass_fail" || kind === "reading" || kind === "count";
