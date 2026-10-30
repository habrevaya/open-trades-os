/**
 * HOW URGENT A JOB IS
 *
 * `job.priority` has been an integer defaulting to zero since the first
 * migration, written by nothing and read by two things that could not say
 * what it meant: the job screen rendered a bare "0", and the report
 * catalogue offered a dimension called Priority that grouped every job in
 * the company into a bucket named "0".
 *
 * An integer with no declared scale is worse than no column. So the scale is
 * declared here, once, and everything that shows it or groups by it reads the
 * same list.
 *
 * Deliberately small, and deliberately not the task vocabulary. A task can be
 * low priority because somebody will get to it eventually; a job is work
 * somebody is waiting at a property for, and "low" is not a thing a
 * dispatcher does with it. Normal is the absence of urgency rather than a
 * choice, which is why it is zero and why a screen does not need to say it.
 */
export interface JobPriority {
  value: number;
  label: string;
  /** What it means to a dispatcher, which is the only reason to set one. */
  meaning: string;
}

export const JOB_PRIORITY: JobPriority[] = [
  { value: 0, label: "Normal", meaning: "Goes in the schedule like everything else." },
  { value: 1, label: "High", meaning: "Fit it in today if there is any room." },
  { value: 2, label: "Emergency", meaning: "Somebody is without heat, water or power." },
];

/** The default, and the one a screen does not need to say out loud. */
export const NORMAL_PRIORITY = 0;

export function priorityLabel(value: number): string {
  return JOB_PRIORITY.find((p) => p.value === value)?.label
    /**
     * A number outside the scale is shown rather than hidden. It came from
     * somewhere, probably an import, and a reader deciding what to do with
     * the job is better served by "priority 7" than by silence.
     */
    ?? `Priority ${value}`;
}

/**
 * The scale as a SQL CASE, for grouping a report by it.
 *
 * Generated from the same list rather than written out beside it, because two
 * copies of a scale is how a report ends up disagreeing with the screen about
 * what a job is.
 */
export function prioritySql(column: string): string {
  const whens = JOB_PRIORITY
    .map((p) => `when ${column} = ${p.value} then '${p.label}'`)
    .join(" ");
  return `case ${whens} else 'Priority ' || ${column}::text end`;
}

/**
 * A BRANCH'S MARK ON A JOB OR INVOICE NUMBER
 *
 * Numbers stay one sequence per company: two branches drawing from one
 * counter is what keeps every number unique without a lock per branch, and
 * Austin's invoices simply have gaps in them. What a company with branches
 * asks for is to tell them apart at a glance, so a branch's short code can be
 * printed in front of the number ("AUS-1042"), when the company turns that on.
 *
 * The prefix is written onto the document when it is made and never worked
 * out again. A job moved to Houston next month, or Austin's code changed, does
 * not renumber anything a customer already holds a copy of.
 */
export const PREFIX_PATTERN = /^[A-Z0-9]{1,8}$/;

/**
 * The prefix a branch code gives, or null when it cannot give one: blank, or
 * not a short run of letters and digits. Upper cased, because a number read
 * aloud over the phone has no lower case.
 */
export function numberPrefix(code: string | null | undefined): string | null {
  const cleaned = (code ?? "").trim().toUpperCase();
  return PREFIX_PATTERN.test(cleaned) ? cleaned : null;
}

/** How a job or invoice number is printed: with its branch's mark, when it has one. */
export function documentNumber(prefix: string | null | undefined, number: number | string): string {
  return prefix ? `${prefix}-${number}` : String(number);
}

/**
 * WHY A JOB IS ON HOLD
 *
 * A fixed list rather than words, because two numbers read it: the plumbing
 * and electrical first time fix rates EXCLUDE "jobs held for a part order"
 * (an electrician's, "or an inspection"), and a figure that read a reason out
 * of a sentence would be guessing. "Part" in a note might be the part the
 * customer is buying themselves.
 */
export type HoldReason = "part" | "inspection" | "customer" | "weather" | "other";

export const HOLD_REASONS: { value: HoldReason; label: string }[] = [
  { value: "part", label: "Waiting on a part" },
  { value: "inspection", label: "Waiting on an inspection" },
  { value: "customer", label: "Waiting on the customer" },
  { value: "weather", label: "Waiting on the weather" },
  { value: "other", label: "Something else" },
];

export function holdReasonLabel(reason: string): string {
  return HOLD_REASONS.find((r) => r.value === reason)?.label ?? reason;
}

/**
 * What a hold has to say for its reason to be believed, or null when it says
 * enough.
 *
 * A part hold names the purchase order the part is on: "held for a part
 * order" is the definition's own phrase, and a part nobody has ordered is a
 * job waiting on the office rather than on a supplier. An inspection, and
 * anything else, says which in words, because the next person to open the
 * job has to know what to chase. Only a part hold names an order, so an order
 * on any other reason is refused rather than kept and ignored.
 */
export function holdRefusal(input: { reason: HoldReason; purchaseOrderId?: string | null | undefined; note?: string | null | undefined }): string | null {
  const note = (input.note ?? "").trim();
  if (input.reason === "part" && !input.purchaseOrderId) {
    return "Name the purchase order the part is on. Write the order under Purchasing first if there is none yet.";
  }
  if (input.reason !== "part" && input.purchaseOrderId) {
    return "Only a hold for a part names a purchase order.";
  }
  if (input.reason === "inspection" && note === "") {
    return "Say which inspection the job is waiting on, so whoever picks it up knows who to call.";
  }
  if (input.reason === "other" && note === "") {
    return "Say what the job is waiting on.";
  }
  return null;
}

/**
 * A JOB LEFT ON HOLD TOO LONG
 *
 * Nothing used to say a job had been waiting a long time: the hold sat on the
 * job's page and the job slid off everybody's mind. A company may now say how
 * many days a job can wait before the office is nudged, and the nudge is one
 * task in the office queue for that hold.
 *
 * Counted in the COMPANY'S calendar days, as the page and the board say it
 * ("on hold 3 days"), not in 24 hour spans: a job held at five on a Monday
 * evening has been on hold a day by Tuesday morning, which is what anybody
 * looking at the calendar would say.
 */
export const HOLD_NUDGE_MOST_DAYS = 90;

/** Why a nudge setting is refused, or null when it is a whole number of days from one to ninety, or off (null). */
export function holdNudgeProblem(days: unknown): string | null {
  if (days === null) return null;
  if (typeof days !== "number" || !Number.isInteger(days) || days < 1 || days > HOLD_NUDGE_MOST_DAYS) {
    return `Give the number of days as a whole number from 1 to ${HOLD_NUDGE_MOST_DAYS}, or leave it off.`;
  }
  return null;
}

/** The setting as saved, or null (off) for anything that is not a good number of days. */
export function holdNudgeDays(saved: unknown): number | null {
  return typeof saved === "number" && holdNudgeProblem(saved) === null ? saved : null;
}

/** How many calendar days a hold has lasted: placed on the 10th, today the 13th, is 3. Never negative. */
export function daysHeld(placedOn: string, today: string): number {
  const days = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${placedOn}T00:00:00Z`)) / 864e5);
  return Number.isFinite(days) ? Math.max(0, days) : 0;
}

/** Whether a hold has lasted long enough to nudge. Off (null) never is. */
export function holdNudgeDue(held: number, days: number | null): boolean {
  return days !== null && held >= days;
}

const dayCount = (n: number): string => `${n} ${n === 1 ? "day" : "days"}`;

/** The reason in words, with what the office wrote about it: "Waiting on a part: condenser fan motor". */
export function holdWords(reason: string, note: string | null | undefined): string {
  const label = holdReasonLabel(reason);
  const said = (note ?? "").trim();
  return said === "" ? label : `${label}: ${said}`;
}

/** The task the office is given: the job, the reason and how long, in one line. */
export function holdNudgeTitle(input: { jobLabel: string; reason: string; held: number }): string {
  return `Job ${input.jobLabel} has been on hold ${dayCount(input.held)}: ${holdReasonLabel(input.reason).toLowerCase()}`;
}

/**
 * What the task says. It names no purchase order: the task is read by anybody
 * who reads the queue, and the order is for those who may read purchasing, who
 * find it on the job's page.
 */
export function holdNudgeBody(input: {
  customerName: string; summary: string; reason: string; note: string | null; held: number;
  since: string; placedBy: string | null; days: number;
}): string {
  return `${input.customerName}: ${input.summary}. ${holdWords(input.reason, input.note)}. `
    + `On hold since ${input.since}${input.placedBy ? `, put there by ${input.placedBy}` : ""}, which is ${dayCount(input.held)}. `
    + `Your company asked to be told after ${dayCount(input.days)}. `
    + "Chase whoever it is waiting on, or take the job off hold on its page when the wait is over. "
    + "This task closes itself when the job comes off hold.";
}

/** What the board card says under a job that is on hold: "On hold 3 days. Waiting on a part: condenser fan motor". */
export function holdOnBoard(input: { reason: string; note: string | null; held: number }): string {
  return `${input.held === 0 ? "On hold since today" : `On hold ${dayCount(input.held)}`}. ${holdWords(input.reason, input.note)}`;
}

/**
 * A PART ASKED FOR FROM THE FIELD, AS THE OFFICE QUEUE READS IT
 *
 * One task per request, naming the job, the part in the technician's words and
 * who asked, and saying what to do: order it, then put the job on hold for the
 * part from the task, naming the order. The phone never places the hold.
 */
export function partRequestTitle(input: { jobLabel: string; part: string }): string {
  const part = input.part.length > 120 ? `${input.part.slice(0, 117)}...` : input.part;
  return `Part needed for job ${input.jobLabel}: ${part}`;
}

export function partRequestBody(input: {
  technicianName: string; customerName: string; address: string; summary: string; part: string; note: string | null;
}): string {
  return `${input.technicianName} asked for this part from ${input.customerName}, ${input.address} (${input.summary}): `
    + `${input.part}.${input.note ? ` They said: ${input.note}` : ""} `
    + "Order it, then put the job on hold for the part from this task, naming the purchase order it is on. "
    + "This task is finished when the hold is placed.";
}

/**
 * WHAT A CUSTOMER SENT TO A JOB, AS THE OFFICE QUEUE READS IT
 *
 * One task a day for each job, however many files the customer sends that day:
 * the title says how many so far, and the body what to do. Finished on its own
 * once everything the customer sent has been opened.
 */
export function customerFilesTitle(input: { customerName: string; jobLabel: string; files: number }): string {
  return `${input.customerName} sent ${input.files === 1 ? "a file" : `${input.files} files`} to job ${input.jobLabel}`;
}

export function customerFilesBody(input: { summary: string; files: number; forVisit: string | null }): string {
  const them = input.files === 1 ? "it" : "them";
  return `From their account, for ${input.forVisit ?? "the job"} (${input.summary}). `
    + `Open the job to look at ${them}: they show as new on the job's page until somebody opens ${them}, `
    + "and the customer can take a file back until then. "
    + "This task is finished when everything they sent has been opened.";
}

/**
 * WHY THE COMPANY CALLED A DAY OFF
 *
 * Cleaning's cancellation rate leaves out the visits the company called off
 * itself, "for weather or staffing", as a separate and more serious number.
 * The reason is a code from a fixed list, with words beside it, because a
 * figure reads the code and words are never read for a meaning. It belongs to
 * the company's own cancellations only: a customer is never asked why they
 * cancelled, and a code on their cancellation is refused.
 */
export type CancelReason = "weather" | "crew_short" | "equipment" | "other";

export const CANCEL_REASONS: { value: CancelReason; label: string }[] = [
  { value: "weather", label: "Rain or weather" },
  { value: "crew_short", label: "Crew short" },
  { value: "equipment", label: "Equipment" },
  { value: "other", label: "Something else" },
];

export function cancelReasonLabel(code: string): string {
  return CANCEL_REASONS.find((r) => r.value === code)?.label ?? code;
}

/**
 * What a company's cancellation has to say, or null when it says enough.
 * "Something else" says what in words, because a code that means nothing is
 * the blank this exists to avoid. Words beside the other three are welcome and
 * not required.
 */
export function cancelReasonProblem(
  by: "customer" | "company", reason: { code: string; note?: string | null | undefined } | null | undefined,
): string | null {
  if (!reason) return null;
  if (by !== "company") {
    return "Only a day the company called off has a reason. A customer is not asked why they cancelled.";
  }
  if (!CANCEL_REASONS.some((r) => r.value === reason.code)) return "Choose rain or weather, crew short, equipment, or something else.";
  if (reason.code === "other" && (reason.note ?? "").trim() === "") return "Say what the reason was, in a few words.";
  return null;
}

/** The reason as the office reads it: "Rain or weather", or "Something else: the van was stolen". */
export function cancelReasonWords(code: string, note: string | null | undefined): string {
  const said = (note ?? "").trim();
  return said === "" ? cancelReasonLabel(code) : `${cancelReasonLabel(code)}: ${said}`;
}
