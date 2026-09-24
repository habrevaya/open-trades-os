import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * DEADLINES ACROSS EVERYTHING
 *
 * One table rather than a date column on six, because the question is always
 * "what is about to breach", across all of them. The contract follows: there
 * is no listSlaBreaches and no listWarrantyDeadlines, only this, filtered by
 * kind.
 *
 * `overdue` is COMPUTED against the clock on every read, never taken from
 * the stored state. A read filtering on state would report a clean queue
 * whenever the sweep that sets it was not running, and a monitor whose
 * failure mode is a clean bill of health is worse than no monitor.
 */
export const ObligationState = z.enum([
  "open", "satisfied", "breached", "waived", "cancelled",
]);

export const Obligation = z.object({
  id: Uuid,
  /** "sla.acknowledge", "dispatch.completed_after_cancellation", "warranty.register_by". */
  kind: z.string(),
  entityType: z.string(),
  entityId: Uuid,
  state: ObligationState,
  dueAt: z.string().datetime(),
  /** What it costs to miss this, in the words of whoever raised it. */
  consequence: z.string().nullable(),
  overdue: z.boolean(),
  /** Negative once past. Minutes, because an SLA is rarely measured in days. */
  minutesRemaining: z.number().int(),
  escalateAt: z.string().datetime().nullable(),
  escalatedAt: z.string().datetime().nullable(),
  breachedAt: z.string().datetime().nullable(),
});

export const listObligations = defineRoute({
  method: "get",
  path: "/v1/obligations",
  summary: "What is live, soonest first",
  description:
    "Past due rows come first, because they sort by due date and theirs is in the past. Rows somebody has finished with (satisfied, waived, cancelled) are excluded in the query, not after the page is cut.",
  module: "M34",
  permissions: ["task:read"],
  input: z.object({
    overdueOnly: z.coerce.boolean().optional(),
    kind: z.string().max(100).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
  }),
  output: z.object({ obligations: z.array(Obligation) }),
});

export const satisfyObligation = defineRoute({
  method: "post",
  path: "/v1/obligations/{id}/satisfy",
  summary: "It was met",
  description:
    "satisfiedByEvent is required. A scorecard built from rows recording only that somebody clicked cannot be defended to the customer holding the contract it came from.",
  module: "M34",
  permissions: ["task:write"],
  idempotent: true,
  input: z.object({ id: Uuid, satisfiedByEvent: z.string().min(1).max(500) }),
  output: Obligation,
});

export const waiveObligation = defineRoute({
  method: "post",
  path: "/v1/obligations/{id}/waive",
  summary: "It will not be met, and that is a decision",
  description:
    "Distinct from satisfying and from cancelling, because the three are different answers: we did it, we agreed not to, and the thing it was attached to went away. A scorecard that collapsed them would be useless.",
  module: "M34",
  permissions: ["task:write"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().min(1).max(500) }),
  output: Obligation,
});

export const sweepObligations = defineRoute({
  method: "post",
  path: "/v1/obligations/sweep",
  summary: "Stamp what has gone past and note what needs escalating",
  description:
    "Does NOT make a breach visible: the list computes overdue from the clock, so this running late, or not at all, delays a stamp and never hides a deadline. Idempotent, so it is safe on any schedule.",
  module: "M34",
  permissions: ["task:write"],
  idempotent: true,
  input: z.object({}),
  output: z.object({ breached: z.number().int(), escalated: z.number().int() }),
});

export const obligationRoutes = {
  listObligations, satisfyObligation, waiveObligation, sweepObligations,
} as const;
