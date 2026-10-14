/**
 * TAKING A MERGE BACK
 *
 * Joining two customer records is the right answer to a duplicate and the
 * wrong one to two people who share a phone number, and the second is found
 * out a week later when the landlord's invoices turn up on the tenant's
 * statement. So a merge can be undone, for a while, when nothing has
 * happened since that cannot be put back.
 *
 * WHAT CANNOT BE PUT BACK is decided by the service, which can see the
 * records; what is here is the arithmetic that does not need a database: how
 * long a merge stays undoable, and how the reasons it cannot be read to a
 * person. A refusal names every reason at once, so nobody fixes one and is
 * told about the next.
 *
 * Conservative on purpose. Money written to the kept record since the merge
 * blocks the undo, rather than being split between the two by a guess: an
 * invoice or a payment on the wrong person's account is worse than a merge
 * that stands.
 */

/** How long after a merge it can still be undone. */
export const UNDO_WINDOW_DAYS = 30;

/** The last moment a merge made at `mergedAt` can be undone. */
export function undoableUntil(mergedAt: Date): Date {
  return new Date(mergedAt.getTime() + UNDO_WINDOW_DAYS * 86_400_000);
}

export const withinWindow = (mergedAt: Date, now: Date): boolean =>
  now.getTime() <= undoableUntil(mergedAt).getTime();

/** Something in the way, counted: "2 payments", "1 job". */
export interface Count { label: string; n: number }

/** "1 invoice, 2 payments and 3 ledger entries". The labels are plural and singular is worked out here. */
export function counted(counts: readonly Count[]): string {
  const words = counts.filter((c) => c.n > 0).map((c) => `${c.n} ${c.n === 1 ? singular(c.label) : c.label}`);
  if (words.length <= 1) return words[0] ?? "";
  return `${words.slice(0, -1).join(", ")} and ${words[words.length - 1]}`;
}

/** The labels this product counts with, each a plain plural. */
function singular(label: string): string {
  const irregular: Record<string, string> = {
    "property links": "property link", "invoices they pay for": "invoice they pay for",
    "consent records": "consent record", "ledger entries": "ledger entry", "deliveries": "delivery",
    "deficiencies": "deficiency", "addresses": "address",
  };
  if (irregular[label]) return irregular[label]!;
  return label.endsWith("s") ? label.slice(0, -1) : label;
}

export interface Blockers {
  /** Already undone, with when. */
  undoneOn?: string | undefined;
  /** Merged longer ago than the window, with the day it was merged. */
  tooOld?: string | undefined;
  /** The duplicate is no longer merged into the kept record: restored, or moved since. */
  duplicateMoved?: boolean | undefined;
  /** The kept record has gone since: removed, or merged into another. */
  keptGone?: string | undefined;
  /** Money written to the kept record since the merge. */
  moneySince?: readonly Count[] | undefined;
  /** Records the merge moved that are no longer on the kept record. */
  movedAway?: readonly Count[] | undefined;
  /** Work booked on the kept record since the merge, at an address that goes back. */
  workAtReturningAddress?: readonly Count[] | undefined;
}

/**
 * Every reason a merge cannot be undone, each a sentence a person can act
 * on, in the order they would act on them. Empty when it can be.
 */
export function reasons(b: Blockers, names: { kept: string; duplicate: string }): string[] {
  const out: string[] = [];
  if (b.undoneOn) out.push(`This merge was already undone on ${b.undoneOn}.`);
  if (b.tooOld) {
    out.push(`It was merged on ${b.tooOld}, and a merge can be undone for ${UNDO_WINDOW_DAYS} days. Move what belongs to ${names.duplicate} by hand.`);
  }
  if (b.keptGone) out.push(b.keptGone);
  if (b.duplicateMoved) out.push(`${names.duplicate} is no longer merged into ${names.kept}.`);
  if (b.moneySince && counted(b.moneySince)) {
    out.push(`Since the merge, ${counted(b.moneySince)} ${total(b.moneySince) === 1 ? "was" : "were"} written to ${names.kept}. Money cannot be split back between them by a guess, so the merge stands.`);
  }
  if (b.movedAway && counted(b.movedAway)) {
    out.push(`${capital(counted(b.movedAway))} the merge moved ${total(b.movedAway) === 1 ? "is" : "are"} no longer on ${names.kept}, so ${total(b.movedAway) === 1 ? "it" : "they"} cannot be moved back.`);
  }
  if (b.workAtReturningAddress && counted(b.workAtReturningAddress)) {
    out.push(`Since the merge, ${counted(b.workAtReturningAddress)} ${total(b.workAtReturningAddress) === 1 ? "was" : "were"} booked for ${names.kept} at an address that would go back to ${names.duplicate}.`);
  }
  return out;
}

const total = (counts: readonly Count[]) => counts.reduce((sum, c) => sum + c.n, 0);
const capital = (text: string) => text.charAt(0).toUpperCase() + text.slice(1);
