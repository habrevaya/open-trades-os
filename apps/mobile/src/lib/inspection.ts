import {
  checkCount, checkReading, checkpointKind,
  type CheckpointEntry, type FieldInspectionProgram, type ReadingCheck,
} from "@opentradesos/field-client";

/**
 * WHAT THE INSPECTION SCREEN SAYS, WITHOUT THE SCREEN.
 *
 * The answers themselves are built by the field client, the same code the
 * day page uses. These are the phone's own sentences around them.
 */

type Checkpoint = FieldInspectionProgram["checkpoints"][number];

/** A reading or a count against what passes, or null for a kind with nothing to check as it is typed. */
export function checkTyped(checkpoint: Checkpoint, entry: CheckpointEntry): ReadingCheck | null {
  const kind = checkpointKind(checkpoint);
  if (kind === "reading") return checkReading(checkpoint, entry.reading ?? "");
  if (kind === "count") return checkCount(checkpoint, entry.count ?? "");
  return null;
}

/** The line on a photo checkpoint: what is still to do, or what was taken. */
export function photoAnswerLine(photos: number): string {
  if (photos <= 0) return "Take a photo to answer this.";
  return `${photos} ${photos === 1 ? "photo" : "photos"} taken.`;
}

/** Asked before filing with checkpoints left blank. Optional ones left blank are not named: they do not hold it up. */
export function notFinishedLine(unanswered: string[]): string {
  return `Not answered: ${unanswered.join(", ")}. It will be filed as not finished, which is not a pass.`;
}
