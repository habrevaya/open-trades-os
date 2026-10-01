import { and, asc, eq, gt, isNull, lt, lte, ne, or } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, type ServiceContext,
} from "./context";

/**
 * WHO GETS THE TWO AM CALL
 *
 * `on_call_rotation` has been in the schema since the first migration with
 * nothing writing it and nothing reading it, which means the answer to the
 * only question it exists for, who do I ring right now, was not in the
 * product at all. Shops run this on a whiteboard and a group text, and the
 * failure mode is not an empty screen: it is two people believing the other
 * one has the phone.
 *
 * WHY THIS IS ITS OWN FILE AND NOT PART OF `crews.ts`.
 *
 * The brief offered either. They share nothing. A rotation points at a
 * technician and a business unit, never at a crew; a crew answers "is this
 * unit able to do this work", a rotation answers "whose phone is on tonight";
 * the two are read by different screens at different times of day and change
 * for different reasons. Folding this into `crews.ts` would make that file
 * the place for two unrelated subjects, which is how a service becomes a
 * junk drawer and how the next person adds a third thing to it. The capacity
 * models get a file each because they are each a model.
 *
 * THE INVARIANT, and everything here is in service of it: AT MOST ONE PERSON
 * IS ON CALL AT ANY INSTANT for any given caller. It is enforced on the way
 * in, by refusing an overlapping window, rather than resolved on the way out
 * by a priority rule. A read that picks a winner from two overlapping rows
 * tells two technicians two different things and neither of them knows it:
 * the dispatcher's screen says one name, the escalation list says the other,
 * and the customer waits while both assume the other went.
 *
 * ON PERMISSIONS. There is no `oncall:*` in the catalogue and inventing one
 * is not an option. Building next week's rota is dispatch work and uses
 * `visit:dispatch`. The rate multiplier is the exception and is checked
 * separately: see `schedule`.
 */

/** Half open, `[startsAt, endsAt)`. See `coveringAt` for why. */
export interface OnCallShift {
  id: string;
  technicianId: string;
  technicianName: string;
  businessUnitId: string | null;
  startsAt: Date;
  endsAt: Date;
  rateMultiplier: string | null;
}

/**
 * Who is on call, at an instant.
 *
 * HALF OPEN, `[startsAt, endsAt)`, which is the same rule
 * `time.dayBoundsIn` uses for a calendar day and for the same reason: a
 * handover at six in the evening is one person until six and the next person
 * from six, and any closed interval makes that instant belong to both or to
 * neither. Both are wrong, and "neither" is the one that silently drops a
 * call.
 *
 * Returns null and SAYS SO IN WORDS when nobody is on. A blank where a name
 * should be reads as "fine" to the person looking at it, and the honest
 * reading is that the company has nobody rostered and somebody needs to fix
 * that before tonight.
 */
export async function whoIsOnCall(
  ctx: ServiceContext,
  input: { at?: string | undefined; businessUnitId?: string | null | undefined } = {},
): Promise<{ at: string; onCall: OnCallShift | null; explanation: string | null }> {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const at = input.at ? new Date(input.at) : new Date();
    if (Number.isNaN(at.getTime())) throw new ConflictError("That is not a time.");

    const shift = await coveringAt(
      tx, ctx.actor.organizationId, at, input.businessUnitId ?? null,
    );

    return {
      at: at.toISOString(),
      onCall: shift,
      explanation: shift
        ? null
        : "Nobody is on call at that time. An after hours call reaching this company now "
          + "has no named technician behind it.",
    };
  });
}

/**
 * The rota, in order.
 *
 * Bounded by a window because a rotation table is one row per weekend
 * forever, and the screen this feeds is "the next few weeks" rather than the
 * history of who had the phone in 2024.
 */
export async function list(
  ctx: ServiceContext, input: { from?: string | undefined; to?: string | undefined } = {},
): Promise<OnCallShift[]> {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const from = input.from ? new Date(input.from) : new Date();
    const to = input.to ? new Date(input.to) : new Date(from.getTime() + 30 * 864e5);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
      throw new ConflictError("That is not a time.");
    }
    if (to <= from) throw new ConflictError("That window ends before it starts.");

    const rows = await tx.select({
      id: schema.onCallRotation.id,
      technicianId: schema.onCallRotation.technicianId,
      technicianName: schema.technician.displayName,
      businessUnitId: schema.onCallRotation.businessUnitId,
      startsAt: schema.onCallRotation.startsAt,
      endsAt: schema.onCallRotation.endsAt,
      rateMultiplier: schema.onCallRotation.rateMultiplier,
    }).from(schema.onCallRotation)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.onCallRotation.technicianId))
      .where(and(
        eq(schema.onCallRotation.organizationId, ctx.actor.organizationId),
        // Overlapping the window rather than contained by it, so a shift that
        // started last night and runs through this morning is on a list of
        // "from now".
        lt(schema.onCallRotation.startsAt, to),
        gt(schema.onCallRotation.endsAt, from),
      ))
      .orderBy(asc(schema.onCallRotation.startsAt));

    return rows;
  });
}

export interface ShiftInput {
  technicianId: string;
  startsAt: string;
  endsAt: string;
  businessUnitId?: string | null | undefined;
  /** Multiplier on labor for work taken in this window. A pay declaration. */
  rateMultiplier?: string | null | undefined;
}

/**
 * Put somebody on call.
 *
 * THE OVERLAP REFUSAL IS THE WHOLE FUNCTION. See the file header: two rows
 * covering one instant is two people being told different things, and it is
 * discovered at two in the morning by a customer.
 *
 * A null business unit means the whole company, so it conflicts with
 * everything in its window, and a company wide shift plus a branch shift over
 * the same hours is refused rather than resolved by precedence. Precedence
 * would be a rule living in a read that the person building the rota never
 * sees.
 *
 * THE RATE MULTIPLIER NEEDS A SECOND PERMISSION, and this is deliberate
 * rather than fussy. Declaring that a night's work is paid at one and a half
 * is a statement about what somebody is owed, and
 * `packages/core/src/access/permissions.ts` separates `payroll:configure`
 * from everything else precisely because "the person who runs the export is
 * usually not the person entitled to decide that". A dispatcher may build the
 * rota all day. Setting the money on it is a different act and is checked as
 * one, so a shift with no multiplier needs no payroll rights at all.
 */
export async function schedule(ctx: ServiceContext, input: ShiftInput) {
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    const startsAt = new Date(input.startsAt);
    const endsAt = new Date(input.endsAt);
    if (Number.isNaN(startsAt.getTime()) || Number.isNaN(endsAt.getTime())) {
      throw new ConflictError("That is not a time.");
    }
    if (endsAt <= startsAt) {
      throw new ConflictError("That shift ends before it starts, so it covers nothing.");
    }

    const multiplier = input.rateMultiplier ?? null;
    if (multiplier !== null) {
      /**
       * Checked here rather than at the route, because the route's permission
       * list is what a caller must hold to reach the endpoint at all and this
       * is conditional on the body. A dispatcher building a rota with no pay
       * declaration on it is not asking for payroll rights.
       */
      assertCan(ctx.actor, "payroll:configure");
      if (!/^\d+(\.\d{1,6})?$/.test(multiplier)) {
        throw new ConflictError("A rate multiplier is a decimal number, for example 1.5.");
      }
      if (Number(multiplier) < 1) {
        throw new ConflictError(
          "A rate multiplier below 1 pays somebody less for being woken at two in the morning. "
          + "If that is really the arrangement it belongs in a wage scale, not here.",
        );
      }
    }

    const [technician] = await tx.select({ id: schema.technician.id })
      .from(schema.technician)
      .where(and(
        eq(schema.technician.id, input.technicianId),
        eq(schema.technician.organizationId, ctx.actor.organizationId),
        eq(schema.technician.active, true),
      )).limit(1);
    if (!technician) {
      throw new ConflictError("That technician is not active in this company.");
    }

    const clash = await overlapping(
      tx, ctx.actor.organizationId, startsAt, endsAt, input.businessUnitId ?? null, null,
    );
    if (clash) {
      throw new ConflictError(
        `${clash.technicianName} is already on call from ${clash.startsAt.toISOString()} `
        + `to ${clash.endsAt.toISOString()}. Two people on call over the same hours means `
        + "each of them believes the other has the phone.",
      );
    }

    const [row] = await tx.insert(schema.onCallRotation).values({
      organizationId: ctx.actor.organizationId,
      technicianId: input.technicianId,
      businessUnitId: input.businessUnitId ?? null,
      startsAt,
      endsAt,
      rateMultiplier: multiplier,
    }).returning();

    await audit(tx, ctx, "on_call.scheduled", "on_call_rotation", row!.id, null, row!);
    return row!;
  });
}

/**
 * The handover.
 *
 * Not an edit of who is on call, and that distinction is the point. The shift
 * that has already been worked stays on the record ending at the moment it
 * really ended, and a new shift starts there. An update in place would
 * rewrite the night so that the person who actually took the calls until
 * midnight was never on, which is wrong on the rota, wrong on an overtime
 * run, and wrong in the one conversation where it matters, the one about why
 * nobody answered.
 *
 * The incoming technician finishes the window the outgoing one was covering,
 * carrying the same rate multiplier. A handover is not the moment to change
 * what the night pays, and carrying it also means this writes no new pay
 * declaration and so needs no payroll rights.
 */
export async function handOver(
  ctx: ServiceContext,
  input: { toTechnicianId: string; at?: string | undefined; businessUnitId?: string | null | undefined },
) {
  return guardedWrite(ctx, "visit:dispatch", async (tx) => {
    const at = input.at ? new Date(input.at) : new Date();
    if (Number.isNaN(at.getTime())) throw new ConflictError("That is not a time.");

    const current = await coveringAt(
      tx, ctx.actor.organizationId, at, input.businessUnitId ?? null,
    );
    if (!current) {
      throw new ConflictError(
        "Nobody is on call at that time, so there is nothing to hand over. "
        + "Put somebody on call instead.",
      );
    }

    if (current.technicianId === input.toTechnicianId) {
      throw new ConflictError(
        "They are already on call. A handover to the person holding the phone would "
        + "split the shift in two and change nothing.",
      );
    }

    /**
     * A handover exactly on the boundary is refused. At `startsAt` it would
     * leave the outgoing technician a shift of zero length that reads as
     * somebody having been on call and never been; at `endsAt` the shift is
     * over and the right call is to roster the next one.
     */
    if (at <= current.startsAt) {
      throw new ConflictError(
        "That is at or before the start of the shift, which would leave the outgoing "
        + "technician a shift of no length. Change who is on call instead of handing over.",
      );
    }
    if (at >= current.endsAt) {
      throw new ConflictError("That shift is already over. Roster the next one instead.");
    }

    const [incoming] = await tx.select({ id: schema.technician.id })
      .from(schema.technician)
      .where(and(
        eq(schema.technician.id, input.toTechnicianId),
        eq(schema.technician.organizationId, ctx.actor.organizationId),
        eq(schema.technician.active, true),
      )).limit(1);
    if (!incoming) {
      throw new ConflictError("That technician is not active in this company.");
    }

    await tx.update(schema.onCallRotation)
      .set({ endsAt: at, updatedAt: new Date() })
      .where(eq(schema.onCallRotation.id, current.id));

    const [row] = await tx.insert(schema.onCallRotation).values({
      organizationId: ctx.actor.organizationId,
      technicianId: input.toTechnicianId,
      businessUnitId: current.businessUnitId,
      startsAt: at,
      endsAt: current.endsAt,
      rateMultiplier: current.rateMultiplier,
    }).returning();

    await audit(tx, ctx, "on_call.handed_over", "on_call_rotation", row!.id,
      { technicianId: current.technicianId, endsAt: current.endsAt },
      { technicianId: input.toTechnicianId, startsAt: at, endsAt: current.endsAt });

    return {
      handedOverAt: at.toISOString(),
      from: { id: current.id, technicianId: current.technicianId, endsAt: at.toISOString() },
      to: { id: row!.id, technicianId: input.toTechnicianId, endsAt: current.endsAt.toISOString() },
    };
  });
}

/* ----------------------------------------------------------------- lookups */

/**
 * NO SOFT DELETE FILTER ON THESE TABLES, AND THAT IS A DECISION.
 *
 * `crew`, `route`, `route_stop` and `on_call_rotation` all carry a
 * `deleted_at` column because every table in this schema does, and nothing in
 * this product sets one. `active` is the retire mechanism here and it is a
 * column something writes: `crews.update`, `routes.setStopActive` and the
 * route's own flag.
 *
 * `test/unwritten-columns.test.ts` makes the argument at length and counts
 * the tables that get it wrong. Its summary is the reason this filter is
 * absent rather than present: a filter on a column nothing sets is
 * decoration, it makes a query look guarded when it is not, and it is
 * indistinguishable in review from one that is doing work. The day one of
 * these tables gets a real delete, the filter goes in beside it.
 */

/**
 * The shift covering an instant.
 *
 * `startsAt <= at < endsAt`. One row by construction, because `schedule`
 * refuses an overlap, so this does not have to choose and deliberately does
 * not try: if two rows ever did cover one instant it would mean the guard had
 * been bypassed, and picking one quietly is how that stays unnoticed.
 */
async function coveringAt(
  tx: Database, organizationId: string, at: Date, businessUnitId: string | null,
): Promise<OnCallShift | null> {
  const rows = await tx.select({
    id: schema.onCallRotation.id,
    technicianId: schema.onCallRotation.technicianId,
    technicianName: schema.technician.displayName,
    businessUnitId: schema.onCallRotation.businessUnitId,
    startsAt: schema.onCallRotation.startsAt,
    endsAt: schema.onCallRotation.endsAt,
    rateMultiplier: schema.onCallRotation.rateMultiplier,
  }).from(schema.onCallRotation)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.onCallRotation.technicianId))
    .where(and(
      eq(schema.onCallRotation.organizationId, organizationId),
      lte(schema.onCallRotation.startsAt, at),
      gt(schema.onCallRotation.endsAt, at),
      /**
       * A company wide shift covers every business unit, so a caller asking
       * about a branch is answered by the branch's own row or by the company
       * wide one. Asking with no business unit asks about the company and
       * takes whatever is on.
       */
      businessUnitId
        ? or(
            isNull(schema.onCallRotation.businessUnitId),
            eq(schema.onCallRotation.businessUnitId, businessUnitId),
          )
        : undefined,
    ))
    .orderBy(asc(schema.onCallRotation.startsAt))
    .limit(1);

  return rows[0] ?? null;
}

/** Any shift whose window and audience collide with the one proposed. */
async function overlapping(
  tx: Database, organizationId: string,
  startsAt: Date, endsAt: Date, businessUnitId: string | null, exceptId: string | null,
): Promise<OnCallShift | null> {
  const rows = await tx.select({
    id: schema.onCallRotation.id,
    technicianId: schema.onCallRotation.technicianId,
    technicianName: schema.technician.displayName,
    businessUnitId: schema.onCallRotation.businessUnitId,
    startsAt: schema.onCallRotation.startsAt,
    endsAt: schema.onCallRotation.endsAt,
    rateMultiplier: schema.onCallRotation.rateMultiplier,
  }).from(schema.onCallRotation)
    .innerJoin(schema.technician, eq(schema.technician.id, schema.onCallRotation.technicianId))
    .where(and(
      eq(schema.onCallRotation.organizationId, organizationId),
      /**
       * Half open on both sides, so a shift ending at six and one starting at
       * six do not overlap. That is the ordinary shape of a rota and refusing
       * it would make a clean handover impossible to roster.
       */
      lt(schema.onCallRotation.startsAt, endsAt),
      gt(schema.onCallRotation.endsAt, startsAt),
      /**
       * A null business unit on EITHER side is company wide and therefore
       * collides. Two different branches running their own rotas over the
       * same hours is a normal arrangement and is not a collision.
       */
      businessUnitId
        ? or(
            isNull(schema.onCallRotation.businessUnitId),
            eq(schema.onCallRotation.businessUnitId, businessUnitId),
          )
        : undefined,
      exceptId ? ne(schema.onCallRotation.id, exceptId) : undefined,
    ))
    .orderBy(asc(schema.onCallRotation.startsAt))
    .limit(1);

  return rows[0] ?? null;
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  getOnCallNow: (ctx: ServiceContext, input: {
    at?: string | undefined; businessUnitId?: string | null | undefined;
  }): Promise<{ at: string; onCall: OnCallShift | null; explanation: string | null }> =>
    whoIsOnCall(ctx, input),

  listOnCallRotations: async (ctx: ServiceContext, input: {
    from?: string | undefined; to?: string | undefined;
  }): Promise<{ shifts: OnCallShift[] }> => ({ shifts: await list(ctx, input) }),

  scheduleOnCall: async (ctx: ServiceContext, input: {
    technicianId: string; startsAt: string; endsAt: string;
    businessUnitId?: string | null | undefined;
    rateMultiplier?: string | null | undefined;
  }): Promise<{ id: string; technicianId: string; startsAt: Date; endsAt: Date }> => {
    const row = await schedule(ctx, input);
    return {
      id: row.id, technicianId: row.technicianId,
      startsAt: row.startsAt, endsAt: row.endsAt,
    };
  },

  handOverOnCall: (ctx: ServiceContext, input: {
    toTechnicianId: string; at?: string | undefined;
    businessUnitId?: string | null | undefined;
  }): Promise<{
    handedOverAt: string;
    from: { id: string; technicianId: string; endsAt: string };
    to: { id: string; technicianId: string; endsAt: string };
  }> => handOver(ctx, input),
} as const;
