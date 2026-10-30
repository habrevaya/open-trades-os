import type { FieldQueue } from "./queue";
import { dateOf, todayIn, type DayVisit } from "./day";

/**
 * CALLING A VISIT OFF FROM THE DOORSTEP
 *
 * A team turned away at the door used to ring the office, which called the
 * visit off on its page with the time they were turned away. The phone now
 * does it itself, with no signal if need be, and the server lands it exactly
 * as the office's call off does: the same columns on the visit (who asked,
 * when, the notice window), the same reason codes, the same audit entry and
 * the same cancellation figures.
 *
 * WHO ASKED is the whole difference between a customer's late cancellation
 * and a rain day, so the phone never decides it. The person picks one line:
 * the customer turned them away (the customer's cancellation, which is never
 * given a reason), or one of the company's own reasons (the codes the office
 * chooses from, with "something else" asking for words).
 *
 * Only for a visit on today's day that nobody has started; the server holds
 * the same line and refuses anything else in words.
 */

export type CallOffChoice = "turned_away" | "weather" | "crew_short" | "equipment" | "other";

/**
 * What the person picks from, in the order shown. The company's four are
 * core's `CANCEL_REASONS`, copied rather than imported so the phone bundle
 * does not carry the domain package for one list; a test holds the two
 * together.
 */
export const CALL_OFF_CHOICES: ReadonlyArray<{ value: CallOffChoice; label: string; by: "customer" | "company" }> = [
  { value: "turned_away", label: "The customer turned us away", by: "customer" },
  { value: "weather", label: "Rain or weather", by: "company" },
  { value: "crew_short", label: "Crew short", by: "company" },
  { value: "equipment", label: "Equipment", by: "company" },
  { value: "other", label: "Something else", by: "company" },
];

/** The line as the person reads it: "The customer turned us away", or "We called it off: rain or weather". */
export function callOffLabel(choice: CallOffChoice): string {
  const picked = CALL_OFF_CHOICES.find((c) => c.value === choice);
  if (!picked) return choice;
  return picked.by === "company" ? `We called it off: ${picked.label.toLowerCase()}` : picked.label;
}

/** The stages a visit can still be called off from: nobody has started the work. */
const CALLABLE: ReadonlyArray<DayVisit["stage"]> = ["upcoming", "en_route", "arrived"];

/** Whether the phone offers to call this visit off: today's, and not started. */
export function canCallOff(visit: Pick<DayVisit, "stage" | "windowStart">, zone: string, now: Date = new Date()): boolean {
  if (!CALLABLE.includes(visit.stage)) return false;
  return dateOf(visit.windowStart, zone) === todayIn(zone, now);
}

export type CallOffPayload =
  | { by: "customer"; note?: string }
  | { by: "company"; reason: { code: Exclude<CallOffChoice, "turned_away">; note?: string } };

/**
 * The choice and the words, checked the way the server checks them, as the
 * payload the queue sends, or what is wrong in words.
 */
export function checkCallOff(
  choice: CallOffChoice | "" | null | undefined, words: string,
): { ok: true; payload: CallOffPayload } | { ok: false; problem: string } {
  const said = words.trim().slice(0, 500);
  if (!choice) return { ok: false, problem: "Say who called it off: the customer, or us and why." };
  const picked = CALL_OFF_CHOICES.find((c) => c.value === choice);
  if (!picked) return { ok: false, problem: "Choose one of the reasons on the list." };
  if (picked.value === "turned_away") return { ok: true, payload: { by: "customer", ...(said ? { note: said } : {}) } };
  if (picked.value === "other" && said === "") return { ok: false, problem: "Say what the reason was, in a few words." };
  const code = picked.value as Exclude<CallOffChoice, "turned_away">;
  return { ok: true, payload: { by: "company", reason: { code, ...(said ? { note: said } : {}) } } };
}

/** Queue the call off. The moment it is pressed is the time it was called off. */
export async function recordCallOff(
  queue: FieldQueue, input: { visitId: string; payload: CallOffPayload; at?: Date | undefined },
) {
  return queue.enqueue({
    kind: "visit.call_off",
    subjectId: input.visitId,
    /** The queue's own clock unless a time is given, so the phone and its tests agree on now. */
    ...(input.at ? { occurredAt: input.at } : {}),
    payload: input.payload as unknown as Record<string, unknown>,
  });
}
