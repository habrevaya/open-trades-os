/**
 * THE CLOCKS A CONTRACT STARTS
 *
 * A commercial client's contract is mostly clocks. Respond within two hours,
 * be on site within four, finish within a day; invoice within thirty days of
 * finishing or the invoice is refused; file a warranty claim within sixty or
 * the claim is. Each is a deadline attached to a job, with a breach and a
 * consequence, and the product already has one primitive for exactly that:
 * an obligation.
 *
 * This file turns a contract's terms and a job's facts into the set of
 * obligations the job should carry, each with whether it has already been
 * met and by what. Pure, so the service can reconcile a job as often as it
 * likes and get the same answer: a clock is raised once, satisfied by the
 * fact that met it, and never moved because somebody looked at it twice.
 */

export type DeadlineKind =
  | "sla.respond" | "sla.arrive" | "sla.complete" | "invoice.submit_by" | "claim.file_by";

export const DEADLINE_KINDS: DeadlineKind[] = [
  "sla.respond", "sla.arrive", "sla.complete", "invoice.submit_by", "claim.file_by",
];

export const DEADLINE_LABEL: Record<DeadlineKind, string> = {
  "sla.respond": "Respond by",
  "sla.arrive": "On site by",
  "sla.complete": "Finished by",
  "invoice.submit_by": "Invoice by",
  "claim.file_by": "Claim by",
};

/** A label for any kind, including the ones raised elsewhere in the product. */
export const deadlineLabel = (kind: string): string =>
  DEADLINE_LABEL[kind as DeadlineKind] ?? kind.replace(/[._]/g, " ");

/** The SLA kinds a contract can state, as the contract writes them. */
export const SLA_KINDS = ["respond", "arrive", "complete"] as const;
export type SlaKind = typeof SLA_KINDS[number];

/** The job priorities an SLA term may be limited to, by the job's own scale. */
export const SLA_PRIORITIES = ["normal", "high", "emergency"] as const;

export interface SlaTerm {
  kind: string;
  minutes: number;
  priority?: string | undefined;
}

export interface ClockTerms {
  sla: readonly SlaTerm[];
  invoiceWithinDays: number | null;
  claimWithinDays: number | null;
}

export interface JobFacts {
  /** When the work was received, which is when every SLA clock starts. */
  receivedAt: Date;
  /** The job's priority on the scale in `work`: 0 normal, 1 high, 2 emergency. */
  priority: number;
  /** When a visit was first booked or dispatched: our response. */
  respondedAt: Date | null;
  arrivedAt: Date | null;
  completedAt: Date | null;
  /** When the first invoice for the job was issued. */
  invoicedAt: Date | null;
  claimFiledAt: Date | null;
  /** Whether somebody other than the customer is being billed for covered work. */
  billsThirdParty: boolean;
}

export interface Clock {
  kind: DeadlineKind;
  dueAt: Date;
  /** When to raise it as a task, before it is due. */
  escalateAt: Date;
  /** What missing it costs, in words for whoever sees it in a queue. */
  consequence: string;
  /** When it was met, if it was. */
  metAt: Date | null;
  /** What met it, for an obligation's `satisfiedByEvent`. */
  metBy: string | null;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

const PRIORITY_NAME = ["normal", "high", "emergency"];

/**
 * The term for this kind and this job's priority.
 *
 * A term for the job's own priority beats a term for any priority, which is
 * how a contract says "four hours, or one hour for an emergency".
 */
export function termFor(terms: readonly SlaTerm[], kind: SlaKind, priority: number): SlaTerm | null {
  const name = PRIORITY_NAME[priority] ?? null;
  return terms.find((t) => t.kind === kind && name !== null && t.priority === name)
    ?? terms.find((t) => t.kind === kind && !t.priority)
    ?? null;
}

/** Whether a contract's clock terms can be used, and why not. */
export function termsProblem(terms: ClockTerms): string | null {
  const seen = new Set<string>();
  for (const term of terms.sla) {
    if (!(SLA_KINDS as readonly string[]).includes(term.kind)) {
      return `"${term.kind}" is not a clock this product keeps. Use respond, arrive or complete.`;
    }
    if (!Number.isInteger(term.minutes) || term.minutes <= 0 || term.minutes > 60 * 24 * 365) {
      return `An SLA of ${term.minutes} minutes is not one anybody can be held to.`;
    }
    if (term.priority && !(SLA_PRIORITIES as readonly string[]).includes(term.priority)) {
      return `"${term.priority}" is not a job priority. Use normal, high or emergency.`;
    }
    const key = `${term.kind}:${term.priority ?? "any"}`;
    if (seen.has(key)) return `Two ${term.kind} terms for the same priority. Keep one.`;
    seen.add(key);
  }
  for (const [name, days] of [["invoicing window", terms.invoiceWithinDays], ["claim window", terms.claimWithinDays]] as const) {
    if (days !== null && (!Number.isInteger(days) || days <= 0 || days > 3650)) {
      return `A ${name} of ${days} days is not a window.`;
    }
  }
  return null;
}

/**
 * When a clock should become a task in somebody's queue.
 *
 * A quarter of the window before it runs out, and never less than fifteen
 * minutes: a two hour response clock warns at half past one, and a thirty
 * day invoicing window warns a week out. Raised as a task rather than only
 * shown, because a deadline that only exists on a screen helps exactly the
 * people already looking at it, and a task is what the company's escalation
 * rules act on when nobody picks it up.
 */
export function escalateAtFor(startsAt: Date, dueAt: Date): Date {
  const window = dueAt.getTime() - startsAt.getTime();
  const lead = Math.min(window, Math.max(15 * MINUTE, Math.round(window / 4)));
  return new Date(dueAt.getTime() - lead);
}

const hoursText = (minutes: number): string =>
  minutes % 1440 === 0 ? `${minutes / 1440} ${minutes === 1440 ? "day" : "days"}`
    : minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? "hour" : "hours"}`
    : `${minutes} minutes`;

/**
 * The clocks this job should carry under these terms.
 *
 * The SLA clocks start when the work was received and are raised whatever
 * has happened since, so a job booked late still shows that it was late.
 * The invoicing window and the claim window start when the work was
 * finished, so they exist only once it has been. The claim clock only exists
 * when somebody other than the customer is paying for covered work: a job
 * with nobody to claim against has nothing to file.
 */
export function clocksFor(terms: ClockTerms, facts: JobFacts): Clock[] {
  const clocks: Clock[] = [];

  const sla: Array<[SlaKind, DeadlineKind, Date | null, string, string]> = [
    ["respond", "sla.respond", facts.respondedAt, "Book a visit", "a visit was booked"],
    ["arrive", "sla.arrive", facts.arrivedAt, "Get somebody on site", "the technician arrived"],
    ["complete", "sla.complete", facts.completedAt, "Finish the work", "the work was finished"],
  ];
  for (const [kind, deadline, metAt, action, met] of sla) {
    const term = termFor(terms.sla, kind, facts.priority);
    if (!term) continue;
    const dueAt = new Date(facts.receivedAt.getTime() + term.minutes * MINUTE);
    clocks.push({
      kind: deadline,
      dueAt,
      escalateAt: escalateAtFor(facts.receivedAt, dueAt),
      consequence: `${action} within ${hoursText(term.minutes)} of the work arriving, as the contract requires. Missing it is a mark on the scorecard the client dispatches by.`,
      metAt,
      metBy: metAt ? `${met} at ${metAt.toISOString()}` : null,
    });
  }

  if (facts.completedAt && terms.invoiceWithinDays) {
    const dueAt = new Date(facts.completedAt.getTime() + terms.invoiceWithinDays * DAY);
    clocks.push({
      kind: "invoice.submit_by",
      dueAt,
      escalateAt: escalateAtFor(facts.completedAt, dueAt),
      consequence: `Invoice within ${terms.invoiceWithinDays} days of finishing. The client refuses an invoice that arrives after that, and the work is then unpaid.`,
      metAt: facts.invoicedAt,
      metBy: facts.invoicedAt ? `an invoice was issued at ${facts.invoicedAt.toISOString()}` : null,
    });
  }

  if (facts.completedAt && terms.claimWithinDays && facts.billsThirdParty) {
    const dueAt = new Date(facts.completedAt.getTime() + terms.claimWithinDays * DAY);
    clocks.push({
      kind: "claim.file_by",
      dueAt,
      escalateAt: escalateAtFor(facts.completedAt, dueAt),
      consequence: `File the claim within ${terms.claimWithinDays} days of finishing. A late claim is denied, and the covered work becomes ours to absorb.`,
      metAt: facts.claimFiledAt,
      metBy: facts.claimFiledAt ? `the claim was filed at ${facts.claimFiledAt.toISOString()}` : null,
    });
  }

  return clocks;
}
