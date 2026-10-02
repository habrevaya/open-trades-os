import { ConflictError } from "./context";
import { isUniqueViolation } from "./organizations";

/**
 * A DUPLICATE SOMEBODY TYPED IS A REFUSAL, NOT A CRASH
 *
 * The defect this exists for, stated once:
 *
 *   `rentable_asset_identifier_idx` enforced one container number per company.
 *   The service relied on it and nothing turned Postgres's 23505 into a refusal.
 *   A dispatcher registering a can on a number already in the yard got a
 *   server-side exception and a page that would not load, rather than a sentence
 *   telling them the number is taken.
 *
 * It is the whole class rather than one bug. The same held for the van register's
 * plate, for a saved report's name and for a dashboard's name, all three
 * reachable from screens that shipped. Each of those is a thing a person types
 * into a box, and a thing a person types into a box collides.
 *
 * WHY A CATCH AND NOT A PRE-CHECK. Several services select first and refuse if
 * they find a row. That produces the right sentence and is a race: two people
 * saving "Monthly revenue" at once both find nothing and the second one crashes
 * anyway. The index is the only thing that actually decides, so the refusal is
 * built from what the index said.
 *
 * NAMED INDEX, NEVER ANY 23505. Catching every unique violation inside a write
 * would turn an unrelated collision, an idempotency key or a generated document
 * number, into a sentence blaming the wrong field. Those are bugs and have to
 * keep looking like bugs.
 */
export async function refusingDuplicate<T>(
  index: string,
  message: string,
  run: () => Promise<T>,
): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (isUniqueViolation(error, index)) throw new ConflictError(message);
    throw error;
  }
}
