/**
 * WHEN THE WORK ORDER IS CREATED SOMEWHERE ELSE
 *
 * `external_work_order` was written in the first migrations and reached by
 * nothing: no reader, no writer. It is the last table in this schema that was
 * described in detail and never touched, and its own comment says what it is
 * for and what the hard part is:
 *
 *   "In five segments the work order is created elsewhere and we mirror it. The
 *   invariant that matters, and the reason this is not just a few columns on
 *   `job`: THE EXTERNAL SYSTEM IS THE SYSTEM OF RECORD. A local edit that
 *   conflicts loses or escalates."
 *
 * A facilities network (Corrigo, ServiceChannel), a home warranty administrator,
 * a manufacturer's dealer network, a lead marketplace: in each of them a
 * contractor is a vendor working somebody else's queue. The work order arrives,
 * it is accepted or declined, the status is pushed back at every step, and the
 * portal's view of it is the one that decides whether the invoice gets paid.
 *
 * THREE THINGS IN HERE ARE THE DOMAIN RATHER THAN A STATE MACHINE:
 *
 *   ACCEPTANCE IS SOMETIMES IRREVERSIBLE. Some networks make it final the
 *   moment you click it, and a product that lets a dispatcher un-accept has
 *   taught them a habit that costs a chargeback the first time it matters. The
 *   flag is on the row because it differs per network, and it is checked here
 *   rather than described in a comment.
 *
 *   SOME NETWORKS HAVE NO ACCEPT CALL AT ALL. They take a work order by
 *   receiving an invoice for it. Offering an Accept button that posts nowhere
 *   is worse than offering none, because the dispatcher believes the job is
 *   theirs.
 *
 *   A CONFLICT IS NOT A MERGE. When the portal says one thing and we say
 *   another, the portal wins, and the thing we said has to be written down
 *   rather than overwritten. "We marked it complete on the 4th and their portal
 *   says it was still open on the 11th" is a dispute somebody has to be able to
 *   reconstruct, and it is the dispute that decides who pays.
 */

export type WorkOrderState =
  /** Theirs, offered to us. Nothing has been promised either way. */
  | "offered"
  /** Ours. On some networks this cannot be undone. */
  | "accepted"
  /** Declined. A declined order must never become a job. */
  | "rejected"
  | "in_progress"
  | "completed"
  /** They pulled it. Distinct from a rejection: we did not decline it. */
  | "cancelled_by_client"
  /** They sent it back after we completed it. The commonest dispute. */
  | "reopened"
  | "invoiced"
  | "closed";

export const STATES: readonly WorkOrderState[] = [
  "offered", "accepted", "rejected", "in_progress", "completed",
  "cancelled_by_client", "reopened", "invoiced", "closed",
];

export const isState = (value: string): value is WorkOrderState =>
  (STATES as readonly string[]).includes(value);

/**
 * What we may move it to ourselves.
 *
 * Deliberately narrower than what THEY may move it to, which is the whole
 * asymmetry: `cancelled_by_client` and `reopened` are absent from every list
 * because neither is ours to declare. A contractor who could mark an order
 * `cancelled_by_client` could make their own missed deadline look like the
 * client's change of mind, and the portal would disagree the moment anybody
 * looked.
 */
const OURS: Record<WorkOrderState, readonly WorkOrderState[]> = {
  offered: ["accepted", "rejected"],
  accepted: ["in_progress", "rejected"],
  in_progress: ["completed"],
  completed: ["invoiced"],
  /** Back to work, which is the point of a reopen. */
  reopened: ["in_progress", "completed"],
  invoiced: [],
  /** Terminal for us. Only they close and only they cancel. */
  rejected: [],
  cancelled_by_client: [],
  closed: [],
};

/**
 * What they may move it to, which is anything.
 *
 * Not a list, and that is the honest shape. Their portal has states we have
 * never seen, renames them between releases, and skips ours: a validated list
 * would refuse an inbound update because we had not heard of its status, and
 * refusing to record what the system of record says is the one failure mode
 * this whole table exists to prevent. `external_status` keeps their word
 * verbatim for exactly that reason.
 */
export function theyMayMoveTo(_from: WorkOrderState, _to: WorkOrderState): boolean {
  void _from;
  void _to;
  return true;
}

export interface Flags {
  /** Some networks make acceptance final the moment it is sent. */
  acceptanceIsIrreversible: boolean;
  /** Some have no accept call: an invoice is the acceptance. */
  acceptsViaInvoiceOnly: boolean;
}

export type MoveRefusal =
  | { reason: "not_allowed"; message: string }
  | { reason: "irreversible"; message: string }
  | { reason: "invoice_only"; message: string }
  | { reason: "theirs_to_say"; message: string };

const THEIRS: readonly WorkOrderState[] = ["cancelled_by_client", "reopened", "closed"];

/**
 * Whether we may make this move, and why not.
 *
 * The refusals are separate reasons rather than one message because they want
 * different things from the person reading them. `invoice_only` is an
 * instruction: submit the invoice. `irreversible` is a warning that arrived too
 * late and whose only use is to say so plainly. `theirs_to_say` is a correction
 * about who decides.
 */
export function checkMove(
  from: WorkOrderState,
  to: WorkOrderState,
  flags: Flags,
): { ok: true } | { ok: false; refusal: MoveRefusal } {
  if (THEIRS.includes(to)) {
    return {
      ok: false,
      refusal: {
        reason: "theirs_to_say",
        message: `Only the client's system can mark a work order ${to.replace(/_/g, " ")}. `
          + "Recording it here from our side would make our record disagree with theirs, and "
          + "theirs is the one that decides whether the invoice gets paid.",
      },
    };
  }

  if (to === "accepted" && flags.acceptsViaInvoiceOnly) {
    return {
      ok: false,
      refusal: {
        reason: "invoice_only",
        message: "This network has no accept call: it takes a work order by receiving an invoice "
          + "for it. Submit the invoice instead. An Accept that posts nowhere is worse than no "
          + "Accept, because it tells a dispatcher the job is theirs when the client has not "
          + "heard from us.",
      },
    };
  }

  if (to === "rejected" && from === "accepted" && flags.acceptanceIsIrreversible) {
    return {
      ok: false,
      refusal: {
        reason: "irreversible",
        message: "This network makes acceptance final. The order is ours and declining it now is "
          + "a conversation with the client rather than a status change: do it their way, and "
          + "expect it to count against the scorecard either way.",
      },
    };
  }

  if (!OURS[from].includes(to)) {
    return {
      ok: false,
      refusal: {
        reason: "not_allowed",
        message: `A work order that is ${from.replace(/_/g, " ")} cannot become `
          + `${to.replace(/_/g, " ")} from our side.`,
      },
    };
  }

  return { ok: true };
}

/**
 * Whether reaching this state owes the client's system an update.
 *
 * `offered` does not: they already know, they sent it. Everything else we do is
 * something they are waiting to hear, and a status we changed and never pushed
 * is a contractor whose scorecard says they never responded.
 */
export function owesPush(state: WorkOrderState): boolean {
  return state !== "offered";
}

/* ------------------------------------------------------------- conflicts */

export type Resolution =
  /** Their update agrees with ours, or advances it. Nothing was lost. */
  | { outcome: "accepted_theirs"; state: WorkOrderState; lost: null }
  /**
   * Their update contradicts a local change we had not pushed. Theirs wins and
   * ours is recorded as lost, which is the escalation the table's own comment
   * asks for.
   */
  | { outcome: "ours_lost"; state: WorkOrderState; lost: WorkOrderState };

/**
 * What to do when the client's system says something different.
 *
 * THEIRS WINS, ALWAYS, and the only question is whether anything of ours went
 * with it. The test is not whether the states differ: a portal confirming the
 * `completed` we pushed differs from nothing and loses nothing. It is whether
 * we were still holding a change they have not seen.
 *
 * `pendingPush` is how we know. If it is false, whatever we last said reached
 * them and their answer is the next word in the conversation. If it is true,
 * they are answering something older, and the thing we were about to tell them
 * has been overtaken.
 */
export function reconcile(input: {
  ours: WorkOrderState;
  theirs: WorkOrderState;
  pendingPush: boolean;
}): Resolution {
  if (!input.pendingPush || input.ours === input.theirs) {
    return { outcome: "accepted_theirs", state: input.theirs, lost: null };
  }
  return { outcome: "ours_lost", state: input.theirs, lost: input.ours };
}

/**
 * What a lost local change should be written down as.
 *
 * Not a log line: a sentence somebody reads months later while working out who
 * pays for a trip. The dates are the caller's, because the whole point is that
 * the two systems disagreed about when.
 */
export function conflictNote(input: {
  lost: WorkOrderState;
  theirs: WorkOrderState;
  theirStatus: string | null;
}): string {
  const theirs = input.theirStatus
    ? `${input.theirs.replace(/_/g, " ")} ("${input.theirStatus}")`
    : input.theirs.replace(/_/g, " ");
  return `We had this as ${input.lost.replace(/_/g, " ")} and had not told them yet. Their system `
    + `says ${theirs}, which wins. Our change is recorded here and is not in their record.`;
}

/* --------------------------------------------------------------- sources */

/**
 * The networks this is built for, as the schema names them.
 *
 * Open rather than an enum, on purpose. `source_system` is `text` because a
 * contractor works whichever networks their market has, and a regional
 * warranty administrator nobody here has heard of is as real as Corrigo. The
 * list below is documentation and a set of defaults, not a gate.
 */
export interface SourceProfile {
  key: string;
  label: string;
  /** What the schema's flags should default to for this network. */
  defaults: Flags;
  /** The thing a contractor on this network needs to know first. */
  note: string;
}

export const SOURCES: readonly SourceProfile[] = [
  {
    key: "corrigo",
    label: "Corrigo",
    defaults: { acceptanceIsIrreversible: false, acceptsViaInvoiceOnly: false },
    note: "A facilities network. Status pushes are scored, and a late one costs the next "
      + "dispatch rather than this one.",
  },
  {
    key: "servicechannel",
    label: "ServiceChannel",
    defaults: { acceptanceIsIrreversible: false, acceptsViaInvoiceOnly: false },
    note: "A facilities network with a not-to-exceed on most orders. Exceeding it without a "
      + "raised ceiling is unbilled work, which is M31's authorization ceiling.",
  },
  {
    key: "ahs",
    label: "Home warranty administrator",
    defaults: { acceptanceIsIrreversible: true, acceptsViaInvoiceOnly: false },
    note: "Acceptance is final and the homeowner pays only the call fee. Who pays what is the "
      + "job's party list, not this table.",
  },
  {
    key: "carrier-dealer",
    label: "Manufacturer dealer network",
    defaults: { acceptanceIsIrreversible: false, acceptsViaInvoiceOnly: true },
    note: "Warranty claims are taken by submitting the claim, not by accepting a dispatch, and "
      + "the labour allowance is the manufacturer's schedule rather than our price book.",
  },
  {
    key: "angi",
    label: "Lead marketplace",
    defaults: { acceptanceIsIrreversible: false, acceptsViaInvoiceOnly: false },
    note: "A lead rather than a work order: the customer is ours once accepted, and the fee is "
      + "charged whether or not it closes.",
  },
];

export const sourceProfile = (key: string): SourceProfile | undefined =>
  SOURCES.find((source) => source.key === key);

/** The defaults for a network we have no profile for: the safest of each. */
export const CAUTIOUS: Flags = {
  /**
   * True, because the cost of being wrong is asymmetric. Assuming acceptance
   * can be undone when it cannot teaches a dispatcher a habit that produces a
   * chargeback; assuming it cannot when it can produces one phone call.
   */
  acceptanceIsIrreversible: true,
  /**
   * False, because refusing to accept on a network that does have an accept
   * call would leave every order sitting in `offered` with nobody told.
   */
  acceptsViaInvoiceOnly: false,
};

export function defaultsFor(sourceSystem: string): Flags {
  return sourceProfile(sourceSystem)?.defaults ?? { ...CAUTIOUS };
}
