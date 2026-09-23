/**
 * ENUM VALUES, IN AN OPERATOR'S WORDS
 *
 * A column rendering `on_hold` or `equipment` straight out of the database is
 * showing somebody our schema: a detail they did not ask for and cannot act
 * on. Worse, `working` means "in progress" to us and reads as an instruction
 * to a dispatcher scanning a column.
 *
 * In one file because the first version had the job labels copied into three
 * pages, which is the drift this codebase keeps finding: two screens naming
 * one state differently is how a support call starts, and nothing would have
 * caught it.
 *
 * Every map falls back to the raw value at the call site rather than throwing
 * or rendering blank, so a status added to the schema before it is added here
 * shows as itself. Ugly is recoverable; missing is not.
 */

/**
 * A job's life, which is longer than a visit's.
 *
 * The first version of this map was invented: `draft`, `dispatched` and
 * `working` are not job statuses and never have been, and `lead`,
 * `estimating`, `invoiced` and `paid` were missing. Every chip on the jobs
 * list fell through to a neutral grey, so the column meant to let a
 * dispatcher find the red ones was one colour. A test against the enum found
 * it in a second; reading the schema would have too.
 */
export const JOB_STATUS: Record<string, string> = {
  lead: "Lead",
  estimating: "Estimating",
  scheduled: "Scheduled",
  in_progress: "In progress",
  on_hold: "On hold",
  completed: "Completed",
  invoiced: "Invoiced",
  paid: "Paid",
  cancelled: "Cancelled",
};

export const VISIT_STATUS: Record<string, string> = {
  unassigned: "Unassigned",
  scheduled: "Scheduled",
  dispatched: "Dispatched",
  en_route: "On the way",
  working: "On site",
  completed: "Completed",
  cancelled: "Cancelled",
  no_show: "No show",
  /**
   * The customer cancelled and the technician was already there, or finished
   * anyway. It is a real outcome and it is billable, which is why it is not
   * folded into "completed".
   */
  completed_after_cancellation: "Completed after cancelling",
};

export const INVOICE_STATUS: Record<string, string> = {
  draft: "Draft",
  open: "Open",
  partially_paid: "Part paid",
  paid: "Paid",
  void: "Void",
  written_off: "Written off",
};

export const PRICE_BOOK_KIND: Record<string, string> = {
  service: "Service",
  material: "Material",
  equipment: "Equipment",
  labor: "Labour",
  fee: "Fee",
  discount: "Discount",
};

export const PHONE_PURPOSE: Record<string, string> = {
  main: "Main line",
  tracking: "Campaign tracking",
  user: "Assigned to a person",
  sending: "Outbound only",
  fax: "Fax",
};

/** Look up a label, falling back to the stored value. */
export const label = (map: Record<string, string>, value: string): string =>
  map[value] ?? value;

/**
 * THE COLOUR, WHICH IS A SEPARATE JUDGEMENT FROM THE WORD
 *
 * A dispatcher scanning a column is looking for the ones that need them, so
 * the tone says "does this want attention" rather than "what stage is this".
 * Most states are deliberately neutral: colouring everything is the same as
 * colouring nothing.
 *
 * Keyed on the same enums and tested against them, because the first version
 * of these maps was keyed on invented values and every chip fell through to
 * grey, which is the failure that looks most like a design choice.
 */
export type Tone = "neutral" | "info" | "success" | "warning" | "danger";

export const JOB_TONE: Record<string, Tone> = {
  lead: "neutral",
  estimating: "info",
  scheduled: "info",
  in_progress: "warning",
  // The one that wants somebody to do something about it.
  on_hold: "danger",
  completed: "success",
  invoiced: "success",
  paid: "success",
  cancelled: "neutral",
};

export const VISIT_TONE: Record<string, Tone> = {
  unassigned: "warning",
  scheduled: "neutral",
  dispatched: "info",
  en_route: "info",
  working: "warning",
  completed: "success",
  cancelled: "neutral",
  no_show: "danger",
  completed_after_cancellation: "success",
};

export const INVOICE_TONE: Record<string, Tone> = {
  draft: "neutral",
  open: "info",
  partially_paid: "warning",
  paid: "success",
  void: "neutral",
  written_off: "danger",
};

export const tone = (map: Record<string, Tone>, value: string): Tone =>
  map[value] ?? "neutral";
