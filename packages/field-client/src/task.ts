import type { DayTask } from "./day";

/**
 * FINISHING A TASK WITH A CHECKLIST, ON THE PHONE
 *
 * The same rule the office's task page keeps (`closeVerdict` in core), in the
 * same words, so the phone says what the server will say before the person has
 * gone back to a signal: done with items unticked needs a reason, kept apart
 * from the outcome, because "gauge missing, tyres not checked" on a van check is
 * a finding and folding it into "done" is how it stops being one. The server
 * still decides; this only saves a trip.
 */
export function closeProblem(task: Pick<DayTask, "checklist">, reason: string): string | null {
  const open = task.checklist.filter((item) => !item.done).length;
  if (open === 0 || reason.trim() !== "") return null;
  return `${open === 1 ? "One item is" : `${open} items are`} not ticked. Tick ${open === 1 ? "it" : "them"}, or say why it is done anyway.`;
}

/** The `task.close` payload: what happened, and why items were left unticked when some were. */
export function closePayload(
  task: Pick<DayTask, "checklist">, outcome: string, reason: string,
): Record<string, unknown> {
  const open = task.checklist.some((item) => !item.done);
  return {
    ...(outcome.trim() ? { outcome: outcome.trim().slice(0, 2000) } : {}),
    ...(open && reason.trim() ? { overrideReason: reason.trim().slice(0, 2000) } : {}),
  };
}

/** The `task.tick` payload: an item set to ticked or not, never flipped, so a retry lands where the first did. */
export function tickPayload(itemId: string, done: boolean): Record<string, unknown> {
  return { itemId, done };
}
