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
