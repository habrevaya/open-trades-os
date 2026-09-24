/**
 * THE EVENT CATALOGUE
 *
 * A workflow subscribes to an event by name, and `triggerEvents` is a
 * `string[]`. Two lists had to agree and nothing made them: the names the
 * product emits, and the names the builder offers.
 *
 * They did not agree. The builder offered fourteen triggers. Exactly one of
 * them was ever emitted. A company building "when an invoice is paid, text
 * the customer a review request" got a workflow that saved, appeared in the
 * list, showed as enabled, and never fired once. Nothing logs a subscription
 * that matches nothing, because matching nothing is what a quiet week looks
 * like.
 *
 * And it failed in the other direction too. Five events the product does
 * emit, all of them about agreements, were missing from the builder, so the
 * one part of the product with a working event stream could not be
 * automated.
 *
 * This is the single list. `emit` takes its names from here, the builder
 * offers from here, and a name in one and not the other is a compile error
 * rather than a workflow that does nothing.
 *
 * EVENTS ARE FACTS IN THE PAST TENSE. `invoice.paid`, not `pay_invoice` and
 * not `invoice.payment`. A workflow author reads these as the sentence they
 * complete: "when an invoice is paid, ...". A name that is not a completed
 * fact produces automations that fire at a moment nobody can describe.
 */

export interface EventSpec {
  /** What happened, in the words a workflow author would use. */
  readonly summary: string;
  /** The entity the event hangs off, so a step can open the thing it is about. */
  readonly entity: string;
  /**
   * False while nothing emits it. Such an event is OFFERED NOWHERE: a
   * trigger that cannot fire is worse than a missing feature, because the
   * person who chose it believes they automated something.
   */
  readonly emitted: boolean;
  /** Why it is not emitted yet, when it is not. Read by whoever wires it up. */
  readonly owedBy?: string;
  /**
   * False for events that exist but are not a subscription. The dwell events
   * are emitted by a sweep and carry their own trigger kind; offering them
   * as an event subscription produces a workflow that waits forever for a
   * sweep nobody configured.
   */
  readonly subscribable?: boolean;
}

export const EVENTS = {
  /* ------------------------------------------------------------------ work */

  "job.created": { summary: "A job was booked", entity: "job", emitted: true },
  "job.updated": { summary: "A job changed in any way", entity: "job", emitted: true },

  /**
   * One per status, as well as `job.updated`.
   *
   * "When a job is completed" is what every workflow author actually wants,
   * and making them subscribe to `job.updated` and filter it is a worse
   * product. The emitter builds these names from the status enum, so a
   * status added to the database without a line here is a compile error
   * rather than an event nobody can subscribe to.
   */
  "job.lead": { summary: "A job became a lead", entity: "job", emitted: true },
  "job.estimating": { summary: "A job moved to estimating", entity: "job", emitted: true },
  "job.scheduled": { summary: "A job was scheduled", entity: "job", emitted: true },
  "job.in_progress": { summary: "Work started on a job", entity: "job", emitted: true },
  "job.on_hold": { summary: "A job was put on hold", entity: "job", emitted: true },
  "job.completed": { summary: "A job was finished", entity: "job", emitted: true },
  "job.invoiced": { summary: "A job was invoiced", entity: "job", emitted: true },
  "job.paid": { summary: "A job was paid", entity: "job", emitted: true },
  "job.cancelled": { summary: "A job was cancelled", entity: "job", emitted: true },

  "visit.completed": {
    summary: "A technician finished a visit",
    entity: "visit",
    emitted: true,
  },

  /* ----------------------------------------------------------------- money */

  "invoice.issued": { summary: "An invoice was raised", entity: "invoice", emitted: true },
  "invoice.paid": {
    summary: "An invoice was paid in full",
    entity: "invoice",
    emitted: true,
  },
  "payment.received": {
    summary: "A payment came in, whether or not it cleared an invoice",
    entity: "payment",
    emitted: true,
  },

  "agreement.sold": {
    summary: "A membership or service agreement was sold", entity: "agreement", emitted: true,
  },
  "agreement.cancelled": {
    summary: "An agreement was cancelled", entity: "agreement", emitted: true,
  },
  "agreement.visit_delivered": {
    summary: "A visit included in an agreement was delivered", entity: "agreement", emitted: true,
  },
  "agreement.visit_skipped": {
    summary: "A member declined one of their visits", entity: "agreement", emitted: true,
  },
  "agreement.visit_unskipped": {
    summary: "A member changed their mind about a skipped visit", entity: "agreement", emitted: true,
  },

  /* ------------------------------------------------------------- customers */

  "booking.requested": {
    summary: "Somebody asked for an appointment online",
    entity: "booking_request",
    emitted: true,
  },
  "message.received": {
    summary: "A customer texted in",
    entity: "conversation",
    emitted: true,
  },

  /* ------------------------------------------------------------- the clock */

  "workflow.scheduled": {
    summary: "A scheduled workflow was due", entity: "workflow", emitted: true,
  },

  /**
   * DWELL EVENTS ARE EMITTED BY THE SWEEP, NOT BY AN ACTION.
   *
   * "This estimate has been sitting unanswered for nine days" is not a thing
   * that happens, it is a thing that becomes true while nobody is looking.
   * They carry their own trigger kind in the builder, so they are in the
   * catalogue to be valid names and are not offered as event subscriptions:
   * subscribing to one without the sweep configured produces a workflow that
   * waits forever.
   */
  "estimate.dwelling": {
    summary: "An estimate has been sitting unanswered", entity: "estimate",
    emitted: true, subscribable: false,
  },
  "invoice.dwelling": {
    summary: "An invoice has been sitting unpaid", entity: "invoice",
    emitted: true, subscribable: false,
  },
  "task.dwelling": {
    summary: "A task has been sitting open", entity: "task",
    emitted: true, subscribable: false,
  },
  "job.dwelling": {
    summary: "A job has been sitting in one status", entity: "job",
    emitted: true, subscribable: false,
  },

  /* ----------------------------------------------------- not yet emitted */

  "visit.scheduled": {
    summary: "A visit was put on the board",
    entity: "visit",
    emitted: false,
    owedBy: "M09. Dispatch writes the visit and emits nothing.",
  },
  "estimate.sent": {
    summary: "An estimate went to the customer",
    entity: "estimate",
    emitted: false,
    owedBy: "M07 records the delivery without emitting.",
  },
  "estimate.approved": {
    summary: "A customer approved an estimate",
    entity: "estimate",
    emitted: false,
    owedBy: "M07. The portal records the signature; nothing emits.",
  },
  "estimate.declined": {
    summary: "A customer declined an estimate",
    entity: "estimate",
    emitted: false,
    owedBy: "M07.",
  },
  "invoice.sent": {
    summary: "An invoice was delivered to the customer",
    entity: "invoice",
    emitted: false,
    owedBy: "M13. invoice_delivery has no writer, so there is no send to emit at.",
  },
  "invoice.overdue": {
    summary: "An invoice passed its due date unpaid",
    entity: "invoice",
    emitted: false,
    owedBy: "M13. Nothing sweeps for it, so there is no moment to emit at. The dwell trigger covers the same ground today.",
  },
  "payment.failed": {
    summary: "A payment was declined",
    entity: "payment",
    emitted: false,
    owedBy: "M13. No card processor is connected, so nothing can fail yet.",
  },
} as const satisfies Record<string, EventSpec>;

export type EventName = keyof typeof EVENTS;

export const EVENT_NAMES = Object.keys(EVENTS) as EventName[];

/**
 * The events a workflow may subscribe to.
 *
 * Only the ones something emits. An unemitted event is documented in the
 * catalogue so whoever wires it up knows what it is for, and it is offered
 * nowhere until it fires: a trigger that cannot fire is worse than an absent
 * feature, because the person who chose it believes they automated something
 * and finds out when the thing they automated did not happen.
 */
export const SUBSCRIBABLE = EVENT_NAMES.filter((name) => {
  const spec: EventSpec = EVENTS[name];
  return spec.emitted && spec.subscribable !== false;
});

export const isEventName = (value: string): value is EventName =>
  Object.prototype.hasOwnProperty.call(EVENTS, value);

export const eventSpec = (name: EventName): EventSpec => EVENTS[name];
