/**
 * A UNIT RECORDED FROM THE FIELD, MATCHED BY ITS SERIAL ACROSS THE COMPANY
 *
 * The serial number is the identity of a furnace: the only thing that
 * survives a customer moving out and the next owner calling. The office has
 * matched it across the whole company for a while, retired units included,
 * because the unit a landlord moved between two rentals or a maker swapped
 * under warranty is already on file somewhere else. The phone matched only
 * at the address it was standing in, so the same unit recorded on site was
 * a second record and its history split in two.
 *
 * THE SAME RULES AS THE OFFICE, decided here once for both:
 *
 *  - A serial is matched on its letters and digits, upper case. The same
 *    plate is typed "ab-1234 x" and "AB1234X" by two people on two days.
 *    A serial with no letters or digits in it matches nothing.
 *  - The same unit live at this address is that unit: it is updated, never
 *    added again.
 *  - The serial on file anywhere else, or taken off a register here, needs
 *    a person to say whether it is the same unit (a move on the existing
 *    record) or another unit with the same plate. The office answers in the
 *    form; the phone cannot ask, so its record is held for the office with
 *    the matches named, rather than added as a second record nobody chose.
 *  - Somebody who has seen the matches and says it is a different unit
 *    adds it.
 */

/** A serial as a match key: letters and digits, upper case. */
export function serialKey(serial: string): string {
  return serial.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

export interface SerialOnFile {
  id: string;
  propertyId: string;
  /** Taken off the register: retired, replaced or removed. */
  retired: boolean;
}

export type SerialDecision =
  | { action: "update"; equipmentId: string }
  | { action: "add" }
  | { action: "ask"; matches: SerialOnFile[] };

export function decideSerial(input: {
  serial: string | null | undefined;
  propertyId: string;
  /** Every unit in the company whose serial has the same key. */
  matches: readonly SerialOnFile[];
  /** Somebody saw the matches and says this is a different unit. */
  confirmedDifferent?: boolean | undefined;
}): SerialDecision {
  if (!input.serial || serialKey(input.serial) === "") return { action: "add" };
  const here = input.matches.find((m) => m.propertyId === input.propertyId && !m.retired);
  if (here) return { action: "update", equipmentId: here.id };
  if (input.matches.length > 0 && !input.confirmedDifferent) return { action: "ask", matches: [...input.matches] };
  return { action: "add" };
}
