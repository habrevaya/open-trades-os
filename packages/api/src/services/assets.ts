import { and, asc, desc, eq, gte, inArray, isNull, lte } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assets as core, money as m, time, isSystem } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, timezoneOf,
  type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";

/**
 * FLEET, TOOLS AND COMPANY ASSETS
 *
 * `packages/core/src/assets/index.ts` decided this module and then sat with
 * no caller for as long as it has existed. It knows that custody is a history
 * rather than a field, that a time interval and a meter interval are
 * different problems, that a projection is a guess and has to say so, and
 * that a lapsed calibration reaches backwards into work already invoiced. It
 * could not do any of it, because there was no table in this product holding
 * a single company tool. `asset:read`, `asset:write` and `asset:checkout`
 * were in the permission catalogue the whole time, excused in
 * `test/permissions-enforced.test.ts` as owed by a module nobody had built.
 *
 * THIS FILE IS MOSTLY PLUMBING AND THAT IS DELIBERATE. Almost every decision
 * below is core's, called rather than restated. Where this file refuses
 * something, it is either translating one of core's refusals into a sentence
 * through `explainRefusal`, or guarding a property of the STORAGE that core
 * cannot see because core has no database. Those are marked.
 *
 * WHAT IS NOT HERE, so nobody goes looking:
 *
 *   `equipment`        the CUSTOMER'S furnace. `services/equipment.ts`.
 *   `rentable_asset`   a dumpster out on hire, which the customer pays for by
 *                      the day. It belongs to the asset_rental capacity model
 *                      in `schema/scheduling.ts` and not to this module: its
 *                      question is utilization and billing, and this module's
 *                      questions are custody, wear and expiry. They share the
 *                      word "asset" and nothing else.
 *   depreciation       core refuses it, because it is an accounting policy
 *                      with tax consequences and belongs beside the ledger. A
 *                      second module that thinks it knows the book value of a
 *                      van is a second answer that drifts from the first.
 *
 * THE THREE PERMISSIONS, and why there are three rather than two.
 *
 *   `asset:read`      every read below.
 *   `asset:write`     the register itself, readings, maintenance plans,
 *                     compliance dates and costs. Saying what the company
 *                     owns and what it costs.
 *   `asset:checkout`  custody, and nothing else. A technician holds this one
 *                     and NOT `asset:write`: they can take the core drill and
 *                     bring it back, and cannot add a van to the fleet or
 *                     move an inspection date. That split is already in the
 *                     role presets, which is where the catalogue's three
 *                     names came from, and it is the reason custody is not
 *                     folded into the write permission.
 */

/* ------------------------------------------------------------ translation */

/**
 * A core refusal, as the sentence an office manager would actually say.
 *
 * A function DECLARATION returning `never` rather than an arrow constant,
 * which is not a style preference. TypeScript only narrows a union after a
 * call when the callee's `never` return type is written down somewhere it can
 * see at the call site, so as an arrow this compiled and then left every
 * `outcome` below still typed as the refusal arm.
 */
function refuse(refusal: core.AssetRefusal): never {
  throw new ConflictError(core.explainRefusal(refusal));
}

type AssetRow = typeof schema.companyAsset.$inferSelect;
type CustodyRow = typeof schema.assetCustody.$inferSelect;
type ReadingRow = typeof schema.assetMeterReading.$inferSelect;
type PlanRow = typeof schema.assetMaintenancePlan.$inferSelect;
type ObligationRow = typeof schema.assetCompliance.$inferSelect;
type CostRow = typeof schema.assetCost.$inferSelect;

const toAssignment = (row: CustodyRow): core.CustodyAssignment => ({
  assetId: row.assetId,
  custodianKind: row.custodianKind,
  custodianId: row.custodianId,
  from: row.heldFrom,
  until: row.heldUntil ?? undefined,
  recordedBy: row.recordedByUserId ?? undefined,
  note: row.note ?? undefined,
});

const toReading = (row: ReadingRow): core.MeterReading => ({
  assetId: row.assetId,
  unit: row.unit,
  value: row.value,
  takenOn: row.takenOn,
  source: row.source,
  reset: row.resetPreviousFinalValue === null ? undefined : {
    previousFinalValue: row.resetPreviousFinalValue,
    reason: row.resetReason ?? "",
  },
});

const toObligation = (row: ObligationRow): core.ComplianceObligation => ({
  assetId: row.assetId,
  kind: row.kind,
  expiresOn: row.expiresOn,
  reference: row.reference ?? undefined,
  lastCertifiedOn: row.lastCertifiedOn ?? undefined,
});

const toCost = (row: CostRow): core.AssetCost => ({
  assetId: row.assetId,
  kind: row.kind,
  amount: m.money(row.amount, row.currency),
  incurredOn: row.incurredOn,
  note: row.note ?? undefined,
});

/**
 * A stored plan as core's `MaintenancePlan`.
 *
 * The two bases need different columns and a row carries one set or the
 * other, which `setPlan` enforces on the way in. The checks here are about a
 * row that got past it anyway: a meter plan with no unit would reach core as
 * `unit: undefined` and silently match no reading, so every asset on it would
 * report "no readings at all" forever while the readings sat in the table.
 */
function toPlan(row: PlanRow): core.MaintenancePlan {
  const base = { assetId: row.assetId, taskId: row.id, label: row.label };
  const lastServicedOn = row.lastServicedOn ?? undefined;

  if (row.basis === "meter") {
    if (row.meterUnit === null || row.everyUnits === null) {
      throw new ConflictError(
        `"${row.label}" is on a meter interval with no unit or no number of units between `
        + `services, so there is nothing to count down. Set the interval again.`,
      );
    }
    return {
      ...base, lastServicedOn,
      interval: { basis: "meter", unit: row.meterUnit, everyUnits: row.everyUnits },
    };
  }

  if (row.model === null || row.startsOn === null) {
    throw new ConflictError(
      `"${row.label}" is on a time interval with no schedule, so no date can come out of it.`,
    );
  }
  return {
    ...base, lastServicedOn,
    interval: {
      basis: "time",
      spec: {
        model: row.model,
        startsOn: row.startsOn,
        ...(row.endsOn ? { endsOn: row.endsOn } : {}),
        ...(row.intervalDays ? { intervalDays: row.intervalDays } : {}),
        ...(row.anchorMonths.length > 0 ? { anchorMonths: row.anchorMonths } : {}),
        ...(row.lastServicedOn ? { lastOccurredOn: row.lastServicedOn } : {}),
      },
    },
  };
}

/** Today, in the company's own zone. Every date in this module is a calendar day. */
const today = async (tx: Database, organizationId: string): Promise<string> =>
  time.dateIn(new Date(), await timezoneOf(tx, organizationId));

/**
 * The acting user, or null for the worker and anything else with no user row.
 *
 * The same rule `audit` in `./context` documents: the system actor is the nil
 * uuid, which is not a row in `user`, and writing it breaks a foreign key
 * underneath the business action and takes the whole transaction with it.
 */
const actingUser = (ctx: ServiceContext): string | null =>
  ctx.portalGrantId || isSystem(ctx.actor) ? null : ctx.actor.userId;

/* ------------------------------------------------------------- the register */

export interface AssetInput {
  kind: core.AssetKind;
  label: string;
  requirementCode?: string | null | undefined;
  identifier?: string | null | undefined;
  meterUnit?: core.MeterUnit | null | undefined;
  meterMaxPerDay?: number | null | undefined;
  quantity?: number | undefined;
  acquiredOn?: string | null | undefined;
  notes?: string | null | undefined;
}

/**
 * Put something on the register.
 *
 * TWO REFUSALS, AND BOTH COME STRAIGHT OUT OF CORE'S KIND PROFILES. The
 * profiles are the product's statement about what makes each kind different
 * to manage, and a row that contradicts one makes the statement a lie on
 * every screen that reads it.
 */
export async function registerAsset(ctx: ServiceContext, input: AssetInput) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const label = input.label.trim();
    if (label === "") {
      throw new ConflictError("An asset needs a label. It is how somebody finds it on a list.");
    }

    const profile = core.ASSET_KIND_PROFILES[input.kind];
    const quantity = input.quantity ?? 1;

    /**
     * A serialised kind is one row per unit. Twenty core drills are twenty
     * records because any one of them can be the one that does not come back,
     * and a quantity of twenty on one row cannot say which one Ana has.
     */
    if (quantity !== 1 && profile.trackedIndividually) {
      throw new ConflictError(
        `A ${profile.label.toLowerCase()} is tracked one unit at a time, so a quantity of ${quantity} `
        + `is not a thing this register can hold. ${quantity} of them is ${quantity} rows, because any `
        + `one of them can be the one that does not come back and a count cannot say which.`,
      );
    }
    if (quantity < 1) {
      throw new ConflictError("A quantity of none is not an asset. Retire it instead.");
    }

    /**
     * A meter on a kind that has none. A trailer has no engine and a thermal
     * imager has no odometer: a reading against either is a reading against
     * the wrong asset, and accepting one here is what makes it possible.
     */
    const meterUnit = input.meterUnit === undefined ? profile.meter : input.meterUnit;
    if (meterUnit !== null && profile.meter === null) {
      throw new ConflictError(
        `A ${profile.label.toLowerCase()} has no meter. ${profile.distinguishedBy} `
        + `A reading against it would be a reading taken from some other machine.`,
      );
    }

    if (input.meterMaxPerDay != null && meterUnit === null) {
      throw new ConflictError(
        "A ceiling on daily use needs a meter to be a ceiling on. Give this asset a meter unit first.",
      );
    }
    if (input.meterMaxPerDay != null && input.meterMaxPerDay < 1) {
      throw new ConflictError(
        "A daily ceiling of zero refuses every reading that shows any movement at all.",
      );
    }

    /**
     * A plate, a serial or a VIN is a thing a person types, so a collision is a
     * refusal rather than a crash. `services/duplicates.ts` has the reason.
     */
    const identifier = input.identifier?.trim() || null;
    const [row] = await refusingDuplicate(
      "company_asset_identifier_idx",
      `${identifier} is already on the register against another asset. A plate, serial or VIN `
      + `identifies one thing, and two records sharing one means a service record cannot be tied `
      + `to either.`,
      () => tx.insert(schema.companyAsset).values({
        organizationId: ctx.actor.organizationId,
        kind: input.kind,
        label,
        requirementCode: normaliseCode(input.requirementCode),
        identifier,
        meterUnit,
        meterMaxPerDay: input.meterMaxPerDay ?? null,
        quantity,
        acquiredOn: input.acquiredOn ?? null,
        retiredOn: null,
        notes: input.notes ?? null,
      }).returning(),
    );

    await audit(tx, ctx, "asset.registered", "company_asset", row!.id, null, row!);
    return row!;
  });
}

/**
 * The code a crew or a job type names when it asks for one of these.
 *
 * Trimmed and nothing else. NOT lower cased, and that is a decision: the
 * comparison between `crew.required_asset_ids` and
 * `job_type.required_asset_ids` has always been exact equality, so folding
 * case here would give the register a second, looser matching rule and two
 * rules that disagree is worse than one strict one. An empty string is null,
 * because a code that matches nothing and a code that is absent should not be
 * two different states.
 */
const normaliseCode = (code: string | null | undefined): string | null =>
  code === undefined || code === null ? null : code.trim() || null;

export interface AssetUpdate {
  id: string;
  label?: string | undefined;
  requirementCode?: string | null | undefined;
  identifier?: string | null | undefined;
  meterMaxPerDay?: number | null | undefined;
  acquiredOn?: string | null | undefined;
  notes?: string | null | undefined;
}

/**
 * Correct what the register says about something.
 *
 * THE KIND AND THE METER UNIT ARE NOT EDITABLE HERE. Changing either rewrites
 * the meaning of every reading already recorded against the row: a van moved
 * from miles to hours turns 84,000 miles into 84,000 hours, and core's
 * `reading_unit_mismatch` would then refuse every future reading on a history
 * that had already been silently ruined. Something mis-typed as the wrong
 * kind is retired and entered again, so the readings stay with the row they
 * were taken from.
 */
export async function updateAsset(ctx: ServiceContext, input: AssetUpdate) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const before = await loadAsset(tx, ctx.actor.organizationId, input.id);

    if (input.label !== undefined && input.label.trim() === "") {
      throw new ConflictError("An asset needs a label. It is how somebody finds it on a list.");
    }
    if (input.meterMaxPerDay != null && before.meterUnit === null) {
      throw new ConflictError(
        "A ceiling on daily use needs a meter to be a ceiling on, and this asset has none.",
      );
    }

    const [row] = await tx.update(schema.companyAsset).set({
      ...(input.label !== undefined ? { label: input.label.trim() } : {}),
      ...(input.requirementCode !== undefined
        ? { requirementCode: normaliseCode(input.requirementCode) } : {}),
      ...(input.identifier !== undefined
        ? { identifier: input.identifier?.trim() || null } : {}),
      ...(input.meterMaxPerDay !== undefined
        ? { meterMaxPerDay: input.meterMaxPerDay } : {}),
      ...(input.acquiredOn !== undefined ? { acquiredOn: input.acquiredOn } : {}),
      ...(input.notes !== undefined ? { notes: input.notes } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.companyAsset.id, before.id)).returning();

    await audit(tx, ctx, "asset.updated", "company_asset", before.id, before, row!);
    return row!;
  });
}

/**
 * Take something off the fleet.
 *
 * THE ROW SURVIVES, which is this module's whole delete story. A sold van's
 * readings are what its cost per mile was built from and its custody record
 * is what answers "who had it last"; deleting destroys both, so nothing here
 * deletes and `retired_on` is the column something writes.
 *
 * REFUSED WHILE SOMEBODY STILL HAS IT. This is a storage guard rather than a
 * core one, and it is the module's own reason for existing: the problem in
 * the founder's words is a technician leaving with thirty thousand dollars of
 * tools nobody has a list of. Retiring an asset that is open in somebody's
 * custody takes it off every list while it is still in their truck, which is
 * precisely how it stops being anybody's problem.
 */
export async function retireAsset(
  ctx: ServiceContext, input: { id: string; retiredOn?: string | undefined; reason?: string | undefined },
) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const before = await loadAsset(tx, ctx.actor.organizationId, input.id);
    const on = input.retiredOn ?? await today(tx, ctx.actor.organizationId);

    if (before.retiredOn !== null) {
      throw new ConflictError(`${before.label} was already retired on ${before.retiredOn}.`);
    }

    const open = await tx.select().from(schema.assetCustody)
      .where(and(
        eq(schema.assetCustody.organizationId, ctx.actor.organizationId),
        eq(schema.assetCustody.assetId, before.id),
        isNull(schema.assetCustody.heldUntil),
      )).limit(1);
    const held = open[0];
    if (held) {
      throw new ConflictError(
        `${before.label} is still out with ${held.custodianKind} ${held.custodianId}, since ${held.heldFrom}. `
        + `Check it in first. Retiring it now takes it off every list while it is still in somebody's truck, `
        + `which is exactly how thirty thousand dollars of tools stops being anybody's problem.`,
      );
    }

    const [row] = await tx.update(schema.companyAsset).set({
      retiredOn: on,
      notes: input.reason ? `${before.notes ? `${before.notes}\n` : ""}Retired: ${input.reason}` : before.notes,
      updatedAt: new Date(),
    }).where(eq(schema.companyAsset.id, before.id)).returning();

    await audit(tx, ctx, "asset.retired", "company_asset", before.id, before, row!);
    return row!;
  });
}

export interface RegisterEntry {
  id: string;
  kind: core.AssetKind;
  kindLabel: string;
  label: string;
  requirementCode: string | null;
  identifier: string | null;
  meterUnit: core.MeterUnit | null;
  quantity: number;
  acquiredOn: string | null;
  retiredOn: string | null;
  retired: boolean;
  /** Derived every time from the custody history. Never a stored column. */
  heldBy: { custodianKind: core.CustodianKind; custodianId: string; since: string } | null;
  /** The latest reading, so a list can show wear without a second call. */
  latestReading: { value: number; unit: core.MeterUnit; takenOn: string } | null;
  /**
   * Obligations core says this KIND should carry and this asset has no row
   * for. A van with an expired inspection is loud; a van with no inspection
   * record at all is silent, and it is the same van in the same yard.
   */
  missingObligations: core.ComplianceKind[];
}

/** The register, with who has each thing worked out from the history. */
export async function listAssets(
  ctx: ServiceContext,
  input: { kind?: core.AssetKind | undefined; includeRetired?: boolean | undefined } = {},
): Promise<{ on: string; assets: RegisterEntry[] }> {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const on = await today(tx, organizationId);

    const rows = await tx.select().from(schema.companyAsset)
      .where(and(
        eq(schema.companyAsset.organizationId, organizationId),
        ...(input.kind ? [eq(schema.companyAsset.kind, input.kind)] : []),
        ...(input.includeRetired ? [] : [isNull(schema.companyAsset.retiredOn)]),
      ))
      .orderBy(asc(schema.companyAsset.label));

    if (rows.length === 0) return { on, assets: [] };
    const ids = rows.map((r) => r.id);

    const custody = await tx.select().from(schema.assetCustody)
      .where(and(
        eq(schema.assetCustody.organizationId, organizationId),
        inArray(schema.assetCustody.assetId, ids),
      ))
      .orderBy(asc(schema.assetCustody.heldFrom));

    const readings = await tx.select().from(schema.assetMeterReading)
      .where(and(
        eq(schema.assetMeterReading.organizationId, organizationId),
        inArray(schema.assetMeterReading.assetId, ids),
      ))
      .orderBy(asc(schema.assetMeterReading.takenOn));

    const obligations = await tx.select().from(schema.assetCompliance)
      .where(and(
        eq(schema.assetCompliance.organizationId, organizationId),
        inArray(schema.assetCompliance.assetId, ids),
      ));

    return {
      on,
      assets: rows.map((row): RegisterEntry => {
        const history = custody.filter((c) => c.assetId === row.id).map(toAssignment);
        const at = core.custodyAt(history, on);
        const mine = readings.filter((r) => r.assetId === row.id);
        const latest = mine[mine.length - 1];

        return {
          id: row.id,
          kind: row.kind,
          kindLabel: core.ASSET_KIND_PROFILES[row.kind].label,
          label: row.label,
          requirementCode: row.requirementCode,
          identifier: row.identifier,
          meterUnit: row.meterUnit,
          quantity: row.quantity,
          acquiredOn: row.acquiredOn,
          retiredOn: row.retiredOn,
          retired: row.retiredOn !== null,
          /**
           * An incoherent history reads as "nobody has it" on the list rather
           * than throwing, because one broken asset must not blank the whole
           * register. `custodyOf` below returns core's refusal in full, which
           * is where somebody goes to fix it.
           */
          heldBy: at.ok && at.held
            ? {
                custodianKind: at.assignment.custodianKind,
                custodianId: at.assignment.custodianId,
                since: at.assignment.from,
              }
            : null,
          latestReading: latest
            ? { value: latest.value, unit: latest.unit, takenOn: latest.takenOn }
            : null,
          missingObligations: core.missingObligations(
            row.kind, obligations.filter((o) => o.assetId === row.id).map(toObligation),
          ),
        };
      }),
    };
  });
}

/* ------------------------------------------------------------------ custody */

export interface CheckOutInput {
  assetId: string;
  custodianKind: core.CustodianKind;
  custodianId: string;
  /** Defaults to today in the company's own zone. */
  on?: string | undefined;
  note?: string | undefined;
}

/**
 * Give something to somebody, or put it somewhere.
 *
 * THE HISTORY IS APPENDED TO AND NEVER REWRITTEN. The resulting history is
 * put through core's `checkCustodyHistory` before it is written, which is the
 * guard that matters: two open assignments of one asset is the ordinary way
 * this goes wrong, a technician hands the core drill on at a site and nobody
 * closes the first assignment. With a mutable holder column the second write
 * silently wins and the first custodian is forgotten. Here it is refused with
 * both assignments named, because the fix is two seconds today and a thirty
 * thousand dollar argument the week somebody resigns.
 *
 * A BACKDATED CHECK OUT IS ALLOWED and goes through the same check, so
 * recording on Thursday that Ana took it on Monday is fine unless Monday was
 * inside somebody else's period, in which case it is refused rather than
 * quietly accepted into an overlapping history.
 */
export async function checkOut(ctx: ServiceContext, input: CheckOutInput) {
  return guardedWrite(ctx, "asset:checkout", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const asset = await loadAsset(tx, organizationId, input.assetId);
    const on = input.on ?? await today(tx, organizationId);

    if (asset.retiredOn !== null) {
      throw new ConflictError(
        `${asset.label} was retired on ${asset.retiredOn}. The company does not have it to hand out.`,
      );
    }

    await assertCustodianExists(tx, organizationId, input.custodianKind, input.custodianId);

    const history = await custodyHistory(tx, organizationId, asset.id);
    const candidate: core.CustodyAssignment = {
      assetId: asset.id,
      custodianKind: input.custodianKind,
      custodianId: input.custodianId,
      from: on,
      until: undefined,
      recordedBy: actingUser(ctx) ?? undefined,
      note: input.note,
    };

    const checked = core.checkCustodyHistory([...history, candidate]);
    if (!checked.ok) refuse(checked);

    const [row] = await tx.insert(schema.assetCustody).values({
      organizationId,
      assetId: asset.id,
      custodianKind: input.custodianKind,
      custodianId: input.custodianId,
      heldFrom: on,
      heldUntil: null,
      recordedByUserId: actingUser(ctx),
      note: input.note ?? null,
    }).returning();

    await audit(tx, ctx, "asset.checked_out", "company_asset", asset.id, null, row!);
    return row!;
  });
}

/**
 * Bring it back.
 *
 * Half open: an assignment closed on the 4th means the asset was with that
 * custodian up to but not including the 4th, so the next check out can start
 * on the 4th and the asset is in exactly one place that day. Any other
 * reading double counts the day of a handover or loses it.
 */
export async function checkIn(
  ctx: ServiceContext,
  input: { assetId: string; on?: string | undefined; note?: string | undefined },
) {
  return guardedWrite(ctx, "asset:checkout", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const asset = await loadAsset(tx, organizationId, input.assetId);
    const on = input.on ?? await today(tx, organizationId);
    const open = await openAssignment(tx, organizationId, asset.id);

    if (!open) {
      throw new ConflictError(
        `Nobody is recorded as holding ${asset.label}, so there is nothing to check in. `
        + `Checking in something that was never checked out would write a period nobody was in.`,
      );
    }

    /**
     * Core's own refusal, raised here rather than after the write. An
     * assignment that ends before it starts is a backwards period, and a
     * fold over a history containing one answers "who had it" with whichever
     * row happened to sort first.
     */
    const closed: core.CustodyAssignment = { ...toAssignment(open), until: on };
    if (closed.until != null && closed.until < closed.from) {
      refuse({ ok: false, reason: "custody_ends_before_it_starts", assignment: closed });
    }

    const [row] = await tx.update(schema.assetCustody).set({
      heldUntil: on,
      note: input.note ?? open.note,
      updatedAt: new Date(),
    }).where(eq(schema.assetCustody.id, open.id)).returning();

    await audit(tx, ctx, "asset.checked_in", "company_asset", asset.id, open, row!);
    return row!;
  });
}

/**
 * Pass it straight on, without it coming back first.
 *
 * ONE CALL RATHER THAN TWO because the gesture is one gesture and the two
 * halves have to agree on the date. Done as a check in followed by a check
 * out, a slip of a day between them leaves either a gap where the drill was
 * nowhere or an overlap core refuses, and the second rejection arrives after
 * the first write has already landed.
 */
export async function handOver(
  ctx: ServiceContext,
  input: {
    assetId: string; custodianKind: core.CustodianKind; custodianId: string;
    on?: string | undefined; note?: string | undefined;
  },
) {
  return guardedWrite(ctx, "asset:checkout", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const asset = await loadAsset(tx, organizationId, input.assetId);
    const on = input.on ?? await today(tx, organizationId);
    const open = await openAssignment(tx, organizationId, asset.id);

    if (!open) {
      throw new ConflictError(
        `Nobody is recorded as holding ${asset.label}, so there is nobody to hand it over from. `
        + `Check it out instead.`,
      );
    }
    if (open.custodianKind === input.custodianKind && open.custodianId === input.custodianId) {
      throw new ConflictError(
        `${asset.label} is already with ${input.custodianKind} ${input.custodianId}. `
        + `A handover to the same custodian closes a period and opens an identical one, which `
        + `reads on the record as a transfer that never happened.`,
      );
    }
    await assertCustodianExists(tx, organizationId, input.custodianKind, input.custodianId);

    const history = await custodyHistory(tx, organizationId, asset.id);
    const prospective = history.map((a) => (a.until == null ? { ...a, until: on } : a));
    prospective.push({
      assetId: asset.id,
      custodianKind: input.custodianKind,
      custodianId: input.custodianId,
      from: on,
      until: undefined,
      recordedBy: actingUser(ctx) ?? undefined,
      note: input.note,
    });

    const checked = core.checkCustodyHistory(prospective);
    if (!checked.ok) refuse(checked);

    await tx.update(schema.assetCustody)
      .set({ heldUntil: on, updatedAt: new Date() })
      .where(eq(schema.assetCustody.id, open.id));

    const [row] = await tx.insert(schema.assetCustody).values({
      organizationId,
      assetId: asset.id,
      custodianKind: input.custodianKind,
      custodianId: input.custodianId,
      heldFrom: on,
      heldUntil: null,
      recordedByUserId: actingUser(ctx),
      note: input.note ?? null,
    }).returning();

    await audit(tx, ctx, "asset.handed_over", "company_asset", asset.id, open, row!);
    return { closed: open.id, opened: row!.id, on };
  });
}

export interface CustodyView {
  assetId: string;
  label: string;
  on: string;
  held: boolean;
  /** Set when somebody has it on that day. */
  heldBy: { custodianKind: core.CustodianKind; custodianId: string; since: string } | null;
  /** Set when nobody does, saying in words where it was last seen. */
  explanation: string | null;
  history: {
    custodianKind: core.CustodianKind; custodianId: string;
    from: string; until: string | null; note: string | null;
  }[];
}

/** Who had this thing on a day, and the whole history behind the answer. */
export async function custodyOf(
  ctx: ServiceContext, input: { assetId: string; on?: string | undefined },
): Promise<CustodyView> {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const asset = await loadAsset(tx, organizationId, input.assetId);
    const on = input.on ?? await today(tx, organizationId);
    const history = await custodyHistory(tx, organizationId, asset.id);

    const at = core.custodyAt(history, on);
    if (!at.ok) refuse(at);

    return {
      assetId: asset.id,
      label: asset.label,
      on,
      held: at.held,
      heldBy: at.held
        ? {
            custodianKind: at.assignment.custodianKind,
            custodianId: at.assignment.custodianId,
            since: at.assignment.from,
          }
        : null,
      explanation: at.held ? null : at.explanation,
      history: history.map((a) => ({
        custodianKind: a.custodianKind,
        custodianId: a.custodianId,
        from: a.from,
        until: a.until ?? null,
        note: a.note ?? null,
      })),
    };
  });
}

/**
 * Everything one person or one place is holding.
 *
 * THE REPORT THE MODULE EXISTS FOR. It is what somebody runs on the day a
 * technician gives notice, and the answer has to be a list rather than a
 * number. Incoherent histories are returned BESIDE the list rather than
 * instead of it: an asset whose record is broken is exactly the one most
 * likely to be missing, and swallowing it would leave the most important row
 * off the page.
 */
export async function heldBy(
  ctx: ServiceContext,
  input: { custodianKind: core.CustodianKind; custodianId: string; on?: string | undefined },
): Promise<{
  on: string;
  custodianKind: core.CustodianKind;
  custodianId: string;
  assets: { id: string; label: string; kind: core.AssetKind; identifier: string | null; since: string }[];
  unreadable: { assetId: string; explanation: string }[];
}> {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const on = input.on ?? await today(tx, organizationId);

    const rows = await tx.select({
      asset: schema.companyAsset,
      custody: schema.assetCustody,
    }).from(schema.assetCustody)
      .innerJoin(schema.companyAsset, eq(schema.companyAsset.id, schema.assetCustody.assetId))
      .where(eq(schema.assetCustody.organizationId, organizationId))
      .orderBy(asc(schema.assetCustody.heldFrom));

    const byAsset = new Map<string, { label: string; kind: core.AssetKind; identifier: string | null }>();
    const histories = new Map<string, core.CustodyAssignment[]>();
    for (const row of rows) {
      byAsset.set(row.asset.id, {
        label: row.asset.label, kind: row.asset.kind, identifier: row.asset.identifier,
      });
      const list = histories.get(row.asset.id) ?? [];
      list.push(toAssignment(row.custody));
      histories.set(row.asset.id, list);
    }

    const answer = core.heldBy([...histories.values()], input.custodianKind, input.custodianId, on);

    return {
      on,
      custodianKind: input.custodianKind,
      custodianId: input.custodianId,
      assets: answer.assetIds.map((id) => {
        const facts = byAsset.get(id)!;
        const since = (histories.get(id) ?? [])
          .filter((a) => a.from <= on && (a.until == null || on < a.until))
          .map((a) => a.from)[0] ?? on;
        return { id, label: facts.label, kind: facts.kind, identifier: facts.identifier, since };
      }),
      unreadable: answer.refusals.map((refusal) => ({
        assetId: "assetId" in refusal ? refusal.assetId : "unknown",
        explanation: core.explainRefusal(refusal),
      })),
    };
  });
}

/* ----------------------------------------------------------------- readings */

export interface ReadingInput {
  assetId: string;
  value: number;
  takenOn?: string | undefined;
  source?: core.MeterReading["source"] | undefined;
  /** A declared meter replacement. Both halves, or neither. */
  reset?: { previousFinalValue: number; reason: string } | undefined;
}

/**
 * Write down what the meter said.
 *
 * EVERY REFUSAL HERE IS CORE'S. `acceptReading` checks the whole list: a
 * fraction, a negative, a future date, a unit that belongs to a different
 * asset, a reading out of order, a meter running backwards, a declared reset
 * that rewinds the old meter, and the plausibility ceiling.
 *
 * The ceiling is the one that pays for itself. A technician typing 48122 for
 * 4812 on a machine that services every 250 hours pushes the next service out
 * by more than a century, and nothing else in the system will ever flag it:
 * from that point every honest reading looks like it goes backwards and is
 * refused for the wrong reason. The keyboard is the only cheap moment.
 */
export async function recordReading(ctx: ServiceContext, input: ReadingInput) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const asset = await loadAsset(tx, organizationId, input.assetId);
    const now = await today(tx, organizationId);
    const takenOn = input.takenOn ?? now;

    if (asset.meterUnit === null) {
      throw new ConflictError(
        `${asset.label} has no meter, so there is no number to record. `
        + `${core.ASSET_KIND_PROFILES[asset.kind].distinguishedBy}`,
      );
    }

    /**
     * Half a reset. The declared final value is what keeps cumulative usage
     * continuous across a meter swap, and the reason is what makes the swap
     * auditable a year later. One without the other is a hole in the
     * machine's life that nothing downstream can see.
     */
    if (input.reset && input.reset.reason.trim() === "") {
      throw new ConflictError(
        "A declared meter replacement needs a reason. It is the only record that the gauge on "
        + "this machine is not the gauge the earlier readings came from.",
      );
    }

    const history = (await readingRows(tx, organizationId, asset.id)).map(toReading);
    const candidate: core.MeterReading = {
      assetId: asset.id,
      unit: asset.meterUnit,
      value: input.value,
      takenOn,
      source: input.source ?? "technician",
      reset: input.reset,
    };

    const outcome = core.acceptReading(history, candidate, {
      now,
      maxPerDay: asset.meterMaxPerDay ?? undefined,
    });
    if (!outcome.ok) refuse(outcome);

    const [row] = await tx.insert(schema.assetMeterReading).values({
      organizationId,
      assetId: asset.id,
      unit: asset.meterUnit,
      value: input.value,
      takenOn,
      source: input.source ?? "technician",
      resetPreviousFinalValue: input.reset?.previousFinalValue ?? null,
      resetReason: input.reset?.reason ?? null,
      recordedByUserId: actingUser(ctx),
    }).returning();

    await audit(tx, ctx, "asset.reading_recorded", "company_asset", asset.id, null, row!);
    return { ...row!, unitsSincePrevious: outcome.unitsSincePrevious };
  });
}

/**
 * The readings, and the usage between two dates when both are given.
 *
 * Usage is reported as core computes it, bounded by the readings that exist
 * inside the window rather than by the window. A month with one reading near
 * the end did not cover the month, and pretending it did is how a cost per
 * hour comes out four times too high.
 */
export async function readings(
  ctx: ServiceContext,
  input: { assetId: string; from?: string | undefined; to?: string | undefined },
) {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const asset = await loadAsset(tx, organizationId, input.assetId);
    const rows = await readingRows(tx, organizationId, asset.id, input.from, input.to);
    const all = rows.map(toReading);

    const usage = input.from && input.to ? core.usageBetween(all, input.from, input.to) : null;

    return {
      assetId: asset.id,
      label: asset.label,
      unit: asset.meterUnit,
      readings: rows.map((r) => ({
        id: r.id,
        value: r.value,
        unit: r.unit,
        takenOn: r.takenOn,
        source: r.source,
        reset: r.resetPreviousFinalValue === null ? null : {
          previousFinalValue: r.resetPreviousFinalValue,
          reason: r.resetReason ?? "",
        },
      })),
      usage: usage === null ? null : usage.ok
        ? {
            ok: true as const,
            unit: usage.unit,
            units: usage.units,
            observedDays: usage.observedDays,
            readingsUsed: usage.readingsUsed,
            crossedAReset: usage.crossedAReset,
            explanation: null,
          }
        : { ok: false as const, unit: null, units: null, observedDays: null, readingsUsed: null, crossedAReset: null, explanation: core.explainRefusal(usage) },
    };
  });
}

/* -------------------------------------------------------------- maintenance */

export interface PlanInput {
  assetId: string;
  label: string;
  basis: "time" | "meter";
  /** Meter basis. */
  everyUnits?: number | undefined;
  /** Time basis, the same fields `recurring_schedule` carries. */
  model?: typeof schema.recurrenceModel.enumValues[number] | undefined;
  startsOn?: string | undefined;
  endsOn?: string | null | undefined;
  intervalDays?: number | null | undefined;
  anchorMonths?: number[] | undefined;
  lastServicedOn?: string | null | undefined;
}

/**
 * Declare a recurring service.
 *
 * THE TWO BASES ARE CHECKED SEPARATELY because they fail differently, and
 * both failures are silent. A meter plan with no interval counts down from
 * nothing. A time plan with neither an interval in days nor anchor months
 * generates no occurrence at all, and a schedule that generates nothing looks
 * exactly like work that is simply not due yet, on every screen, forever.
 */
export async function setPlan(ctx: ServiceContext, input: PlanInput) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const asset = await loadAsset(tx, organizationId, input.assetId);
    const label = input.label.trim();
    if (label === "") throw new ConflictError("A maintenance task needs a label to appear on a worklist under.");

    const anchors = input.anchorMonths ?? [];

    if (input.basis === "meter") {
      if (asset.meterUnit === null) {
        throw new ConflictError(
          `${asset.label} has no meter, so "every so many units" is not an interval it can be on. `
          + `${core.ASSET_KIND_PROFILES[asset.kind].distinguishedBy} Put this task on a time interval.`,
        );
      }
      if (!input.everyUnits || input.everyUnits < 1) {
        throw new ConflictError(
          `A meter interval needs the number of ${asset.meterUnit} between services. `
          + `Without it there is nothing to count down and the task can never come due.`,
        );
      }
    } else {
      if (!input.model || !input.startsOn) {
        throw new ConflictError("A time interval needs a recurrence model and a date to start from.");
      }
      if (input.model === "rule" && anchors.length === 0 && !input.intervalDays) {
        throw new ConflictError(
          "A rule needs either a number of days between services or the months to pin them to. "
          + "With neither it generates nothing, which looks exactly like a service that is not due yet.",
        );
      }
      if (input.model === "anchored_to_completion" && !input.intervalDays) {
        throw new ConflictError(
          "Work measured from the last completion needs to know how many days. That is the whole model: "
          + "ninety days from when the service actually happened, not from when it was booked.",
        );
      }
      for (const month of anchors) {
        if (!Number.isInteger(month) || month < 1 || month > 12) {
          throw new ConflictError(`${month} is not a month. Anchor months are 1 through 12.`);
        }
      }
      if (input.endsOn && input.endsOn < input.startsOn) {
        throw new ConflictError("That schedule ends before it starts.");
      }
    }

    const [row] = await tx.insert(schema.assetMaintenancePlan).values({
      organizationId,
      assetId: asset.id,
      label,
      basis: input.basis,
      model: input.basis === "time" ? input.model ?? null : null,
      startsOn: input.basis === "time" ? input.startsOn ?? null : null,
      endsOn: input.basis === "time" ? input.endsOn ?? null : null,
      intervalDays: input.basis === "time" ? input.intervalDays ?? null : null,
      anchorMonths: anchors,
      meterUnit: input.basis === "meter" ? asset.meterUnit : null,
      everyUnits: input.basis === "meter" ? input.everyUnits ?? null : null,
      lastServicedOn: input.lastServicedOn ?? null,
    }).returning();

    await audit(tx, ctx, "asset.plan_set", "asset_maintenance_plan", row!.id, null, row!);
    return row!;
  });
}

/**
 * It was done.
 *
 * A BACKDATED COMPLETION IS REFUSED, the same rule a route stop's completion
 * follows. Both bases count from this date: the time branch asks the
 * recurrence module for the next occurrence after it, and the meter branch
 * measures usage from the reading nearest it. Moving it backwards therefore
 * pulls a service that has already been done back into the future and throws
 * away the usage counted since.
 */
export async function recordService(
  ctx: ServiceContext, input: { planId: string; servicedOn?: string | undefined },
) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const [plan] = await tx.select().from(schema.assetMaintenancePlan)
      .where(and(
        eq(schema.assetMaintenancePlan.id, input.planId),
        eq(schema.assetMaintenancePlan.organizationId, organizationId),
      )).limit(1);
    if (!plan) throw new NotFoundError("Maintenance plan");

    const now = await today(tx, organizationId);
    const servicedOn = input.servicedOn ?? now;

    if (servicedOn > now) {
      throw new ConflictError(
        `A service cannot be recorded as done on ${servicedOn}, which is after today, ${now}. `
        + `Recording it early resets the interval before the work happens.`,
      );
    }
    if (plan.lastServicedOn !== null && servicedOn < plan.lastServicedOn) {
      throw new ConflictError(
        `"${plan.label}" was last done on ${plan.lastServicedOn} and this says ${servicedOn}. `
        + `Moving it backwards pulls a service that has already happened back into the future `
        + `and discards everything counted since.`,
      );
    }

    const [row] = await tx.update(schema.assetMaintenancePlan).set({
      lastServicedOn: servicedOn,
      updatedAt: new Date(),
    }).where(eq(schema.assetMaintenancePlan.id, plan.id)).returning();

    await audit(tx, ctx, "asset.service_recorded", "asset_maintenance_plan", plan.id, plan, row!);
    return row!;
  });
}

export interface MaintenanceLine {
  planId: string;
  assetId: string;
  assetLabel: string;
  label: string;
  lastServicedOn: string | null;
  status: core.MaintenanceStatus;
}

/**
 * What is due, across the fleet or on one asset.
 *
 * CORE DECIDES EVERY LINE AND IT IS HANDED BACK WHOLE. `MaintenanceStatus` is
 * a union of five shapes and flattening it into a date and a boolean is the
 * one thing this endpoint must not do: "projected, weak confidence, from two
 * readings nine days apart" and "due now, the meter already says so" would
 * come out the same, and the first is a guess somebody should argue with
 * while the second is a fact somebody should act on.
 *
 * A meter task whose asset has gone quiet returns `cannot_project` with a
 * sentence rather than a date. That is the honest answer and it is the whole
 * reason core refuses to put a projection through the recurrence machinery.
 */
export async function maintenanceDue(
  ctx: ServiceContext,
  input: { assetId?: string | undefined; now?: string | undefined } = {},
): Promise<{ now: string; due: MaintenanceLine[] }> {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const now = input.now ?? await today(tx, organizationId);

    const rows = await tx.select({
      plan: schema.assetMaintenancePlan,
      assetLabel: schema.companyAsset.label,
    }).from(schema.assetMaintenancePlan)
      .innerJoin(schema.companyAsset, eq(schema.companyAsset.id, schema.assetMaintenancePlan.assetId))
      .where(and(
        eq(schema.assetMaintenancePlan.organizationId, organizationId),
        eq(schema.assetMaintenancePlan.active, true),
        /**
         * A retired van's services are not due. Nothing is going to happen to
         * it and a worklist that keeps offering it trains people to ignore
         * the worklist.
         */
        isNull(schema.companyAsset.retiredOn),
        ...(input.assetId ? [eq(schema.assetMaintenancePlan.assetId, input.assetId)] : []),
      ))
      .orderBy(asc(schema.companyAsset.label), asc(schema.assetMaintenancePlan.label));

    if (rows.length === 0) return { now, due: [] };

    const assetIds = [...new Set(rows.map((r) => r.plan.assetId))];
    const allReadings = (await tx.select().from(schema.assetMeterReading)
      .where(and(
        eq(schema.assetMeterReading.organizationId, organizationId),
        inArray(schema.assetMeterReading.assetId, assetIds),
      ))
      .orderBy(asc(schema.assetMeterReading.takenOn))).map(toReading);

    return {
      now,
      due: rows.map((row): MaintenanceLine => ({
        planId: row.plan.id,
        assetId: row.plan.assetId,
        assetLabel: row.assetLabel,
        label: row.plan.label,
        lastServicedOn: row.plan.lastServicedOn,
        status: core.maintenanceDue(
          toPlan(row.plan),
          allReadings.filter((r) => r.assetId === row.plan.assetId),
          now,
        ),
      })),
    };
  });
}

/* --------------------------------------------------------------- compliance */

/**
 * Set or renew a date that expires.
 *
 * ONE ROW PER KIND PER ASSET, so a renewal moves the date rather than leaving
 * two rows where one says the van is legal and the other says it is not.
 *
 * `lastCertifiedOn` IS ONLY MEANINGFUL FOR CALIBRATION and is refused on the
 * other three, because it is the date a list of reports at risk starts from.
 * Registration, inspection and insurance stop something happening tomorrow;
 * calibration reaches backwards into work already done and already invoiced,
 * which is the one expiry whose cost is not a day off the road.
 */
export async function setObligation(
  ctx: ServiceContext,
  input: {
    assetId: string; kind: core.ComplianceKind; expiresOn: string;
    reference?: string | null | undefined; lastCertifiedOn?: string | null | undefined;
  },
) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const asset = await loadAsset(tx, organizationId, input.assetId);

    if (input.lastCertifiedOn && !core.COMPLIANCE[input.kind].invalidatesPastWork) {
      throw new ConflictError(
        `A ${core.COMPLIANCE[input.kind].label.toLowerCase()} does not certify past work, so a date it was `
        + `last certified good has nothing to mean. It is a calibration field: an instrument out of `
        + `certificate puts every report it produced since that date in question.`,
      );
    }
    if (input.lastCertifiedOn && input.lastCertifiedOn > input.expiresOn) {
      throw new ConflictError(
        `This says it was certified on ${input.lastCertifiedOn} and expires on ${input.expiresOn}, `
        + `which is backwards.`,
      );
    }

    const [row] = await tx.insert(schema.assetCompliance).values({
      organizationId,
      assetId: asset.id,
      kind: input.kind,
      expiresOn: input.expiresOn,
      reference: input.reference ?? null,
      lastCertifiedOn: input.lastCertifiedOn ?? null,
    }).onConflictDoUpdate({
      target: [schema.assetCompliance.assetId, schema.assetCompliance.kind],
      set: {
        expiresOn: input.expiresOn,
        reference: input.reference ?? null,
        lastCertifiedOn: input.lastCertifiedOn ?? null,
        updatedAt: new Date(),
      },
    }).returning();

    await audit(tx, ctx, "asset.obligation_set", "asset_compliance", row!.id, null, row!);
    return row!;
  });
}

export interface ComplianceLine {
  assetId: string;
  assetLabel: string;
  kind: core.ComplianceKind;
  status: core.ComplianceStatus;
  expiresOn: string;
  daysUntilExpiry: number;
  actBy: string;
  lastUsableDay: string;
  movedOffAWeekend: boolean;
  groundsTheAsset: boolean;
  workAtRiskSince: string | null;
  explanation: string;
}

/**
 * What expires when, in the order somebody should deal with it.
 *
 * ORDERED BY WHEN ACTION IS NEEDED rather than by expiry, which is core's
 * decision and is the whole value of the screen: a calibration needing six
 * weeks of notice and expiring in fifty days is more urgent than a
 * registration needing thirty and expiring in forty. Sorted by expiry they
 * come out the other way round, and the instrument goes out of certificate
 * while the screen looked calm.
 */
export async function complianceOutlook(
  ctx: ServiceContext,
  input: { now?: string | undefined; lookaheadDays?: number | undefined } = {},
): Promise<{
  now: string;
  alerts: ComplianceLine[];
  missing: { assetId: string; assetLabel: string; kind: core.ComplianceKind; explanation: string }[];
}> {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const now = input.now ?? await today(tx, organizationId);

    const assetRows = await tx.select().from(schema.companyAsset)
      .where(and(
        eq(schema.companyAsset.organizationId, organizationId),
        isNull(schema.companyAsset.retiredOn),
      ));
    if (assetRows.length === 0) return { now, alerts: [], missing: [] };

    const labels = new Map(assetRows.map((a) => [a.id, a.label]));
    const obligationRows = await tx.select().from(schema.assetCompliance)
      .where(and(
        eq(schema.assetCompliance.organizationId, organizationId),
        inArray(schema.assetCompliance.assetId, assetRows.map((a) => a.id)),
      ));

    const alerts = core.complianceOutlook(
      obligationRows.map(toObligation),
      now,
      input.lookaheadDays === undefined ? {} : { lookaheadDays: input.lookaheadDays },
    );

    return {
      now,
      alerts: alerts.map((alert): ComplianceLine => ({
        assetId: alert.obligation.assetId,
        assetLabel: labels.get(alert.obligation.assetId) ?? alert.obligation.assetId,
        kind: alert.obligation.kind,
        status: alert.status,
        expiresOn: alert.obligation.expiresOn,
        daysUntilExpiry: alert.daysUntilExpiry,
        actBy: alert.actBy,
        lastUsableDay: alert.lastUsableDay,
        movedOffAWeekend: alert.movedOffAWeekend,
        groundsTheAsset: alert.groundsTheAsset,
        workAtRiskSince: alert.workAtRiskSince ?? null,
        explanation: core.explainAlert(alert),
      })),
      /**
       * The silent half. An outlook built only from the rows that exist can
       * never say that a van has no inspection record at all, and that is the
       * same van in the same yard with the same problem as one whose
       * inspection expired.
       */
      missing: assetRows.flatMap((asset) =>
        core.missingObligations(
          asset.kind, obligationRows.filter((o) => o.assetId === asset.id).map(toObligation),
        ).map((kind) => ({
          assetId: asset.id,
          assetLabel: asset.label,
          kind,
          explanation:
            `${asset.label} is a ${core.ASSET_KIND_PROFILES[asset.kind].label.toLowerCase()} and has no `
            + `${core.COMPLIANCE[kind].label.toLowerCase()} on file at all. `
            + `${core.COMPLIANCE[kind].description}`,
        })),
      ),
    };
  });
}

/* --------------------------------------------------------------------- cost */

/** Money spent on one thing. Never depreciation: see the header. */
export async function recordCost(
  ctx: ServiceContext,
  input: {
    assetId: string; kind: core.AssetCostKind; amount: string; incurredOn: string;
    currency?: string | undefined; note?: string | undefined;
  },
) {
  return guardedWrite(ctx, "asset:write", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const asset = await loadAsset(tx, organizationId, input.assetId);

    /** Through core's parser, so a value money cannot hold is refused here. */
    const amount = m.money(input.amount, input.currency ?? "USD");
    if (m.isNegative(amount)) {
      throw new ConflictError(
        "A cost is not negative. A refund or a credit against a repair is its own entry, "
        + "and recording it as a negative cost makes the month it lands in look free.",
      );
    }

    const [row] = await tx.insert(schema.assetCost).values({
      organizationId,
      assetId: asset.id,
      kind: input.kind,
      amount: m.toString(amount),
      currency: amount.currency,
      incurredOn: input.incurredOn,
      note: input.note ?? null,
    }).returning();

    await audit(tx, ctx, "asset.cost_recorded", "asset_cost", row!.id, null, row!);
    return row!;
  });
}

/**
 * What this thing costs to keep, and what it costs per hour or per mile.
 *
 * THE PER UNIT FIGURE IS A REFUSAL WHEN THERE IS NO RECORDED USE, never a
 * zero and never an infinity, which is core's decision and the reason this
 * endpoint returns a union. Zero reads as "this van is free", so the cheapest
 * asset in the fleet becomes the one nobody is reading the odometer on: the
 * exact opposite of the truth, and the kind of wrong that gets acted on.
 *
 * `reliable` is reported rather than enforced. Three weeks of data on a van
 * that has had one oil change and no tyres is not a cost per mile, it is a
 * cost per mile of three weeks in which nothing broke.
 */
export async function costOf(
  ctx: ServiceContext,
  input: {
    assetId: string; from: string; to: string;
    includeAcquisition?: boolean | undefined; currency?: string | undefined;
  },
) {
  return guardedRead(ctx, "asset:read", async (tx) => {
    const organizationId = ctx.actor.organizationId;
    const asset = await loadAsset(tx, organizationId, input.assetId);
    const currency = input.currency ?? "USD";

    const costRows = await tx.select().from(schema.assetCost)
      .where(and(
        eq(schema.assetCost.organizationId, organizationId),
        eq(schema.assetCost.assetId, asset.id),
        gte(schema.assetCost.incurredOn, input.from),
        lte(schema.assetCost.incurredOn, input.to),
      ))
      .orderBy(desc(schema.assetCost.incurredOn));
    const costs = costRows.map(toCost);

    const summary = core.costsOverPeriod(costs, input.from, input.to, currency);
    const readingRecords = (await readingRows(tx, organizationId, asset.id)).map(toReading);

    const perUnit = core.costPerUnitOfUse({
      assetId: asset.id,
      costs,
      readings: readingRecords,
      from: input.from,
      to: input.to,
      currency,
      includeAcquisition: input.includeAcquisition ?? false,
    });

    return {
      assetId: asset.id,
      label: asset.label,
      from: input.from,
      to: input.to,
      currency,
      total: m.toString(summary.total),
      runningTotal: m.toString(summary.runningTotal),
      acquisition: m.toString(summary.acquisition),
      byKind: Object.fromEntries(
        core.ASSET_COST_KINDS.map((kind) => [kind, m.toString(summary.byKind[kind])]),
      ) as Record<core.AssetCostKind, string>,
      perUnit: perUnit.ok
        ? {
            ok: true as const,
            unit: perUnit.unit,
            units: perUnit.units,
            cost: m.toString(perUnit.cost),
            perUnit: m.toString(perUnit.perUnit),
            observedDays: perUnit.observedDays,
            reliable: perUnit.reliable,
            caveat: perUnit.caveat,
            explanation: null,
          }
        : {
            ok: false as const,
            unit: null, units: null, cost: null, perUnit: null,
            observedDays: null, reliable: null, caveat: null,
            explanation: core.explainRefusal(perUnit),
          },
    };
  });
}

/* ------------------------------------------------------------------ loading */

/**
 * NO SOFT DELETE FILTER ON ANY OF THESE TABLES, AND THAT IS A DECISION.
 *
 * Every table in this schema carries `deleted_at` and nothing in this module
 * sets one. Retirement is the mechanism here and `retired_on` is a column
 * something writes: `retireAsset` above. `test/unwritten-columns.test.ts`
 * makes the argument and counts the tables that get it wrong: a filter on a
 * column nothing sets is decoration, it makes a query look guarded when it is
 * not, and in review it is indistinguishable from one that is doing work.
 *
 * `loadAsset` DOES NOT FILTER RETIRED EITHER, which is separate and also
 * deliberate. A sold van's readings and custody record are still readable,
 * and have to be: the question "who had it last" is asked about things that
 * have left. The functions that must not touch a retired asset refuse it by
 * name, with a sentence, rather than reporting it as not found.
 */
async function loadAsset(tx: Database, organizationId: string, id: string): Promise<AssetRow> {
  const [row] = await tx.select().from(schema.companyAsset)
    .where(and(
      eq(schema.companyAsset.id, id),
      eq(schema.companyAsset.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Asset");
  return row;
}

async function custodyHistory(
  tx: Database, organizationId: string, assetId: string,
): Promise<core.CustodyAssignment[]> {
  const rows = await tx.select().from(schema.assetCustody)
    .where(and(
      eq(schema.assetCustody.organizationId, organizationId),
      eq(schema.assetCustody.assetId, assetId),
    ))
    .orderBy(asc(schema.assetCustody.heldFrom));
  return rows.map(toAssignment);
}

async function openAssignment(
  tx: Database, organizationId: string, assetId: string,
): Promise<CustodyRow | undefined> {
  const rows = await tx.select().from(schema.assetCustody)
    .where(and(
      eq(schema.assetCustody.organizationId, organizationId),
      eq(schema.assetCustody.assetId, assetId),
      isNull(schema.assetCustody.heldUntil),
    ))
    .orderBy(desc(schema.assetCustody.heldFrom))
    .limit(1);
  return rows[0];
}

async function readingRows(
  tx: Database, organizationId: string, assetId: string,
  from?: string | undefined, to?: string | undefined,
): Promise<ReadingRow[]> {
  return tx.select().from(schema.assetMeterReading)
    .where(and(
      eq(schema.assetMeterReading.organizationId, organizationId),
      eq(schema.assetMeterReading.assetId, assetId),
      ...(from ? [gte(schema.assetMeterReading.takenOn, from)] : []),
      ...(to ? [lte(schema.assetMeterReading.takenOn, to)] : []),
    ))
    .orderBy(asc(schema.assetMeterReading.takenOn));
}

/**
 * The custodian is a real row of the right kind.
 *
 * `asset_custody.custodian_id` is polymorphic, so Postgres cannot check it:
 * one column cannot reference three tables. Without this, a technician id
 * written under `custodian_kind = 'location'` is a perfectly valid row, the
 * register says the chipper is at a yard that is actually a person, and
 * nothing in the database or the type system ever disagrees.
 */
async function assertCustodianExists(
  tx: Database, organizationId: string, kind: core.CustodianKind, id: string,
): Promise<void> {
  if (kind === "technician") {
    const [row] = await tx.select({ id: schema.technician.id }).from(schema.technician)
      .where(and(
        eq(schema.technician.id, id),
        eq(schema.technician.organizationId, organizationId),
        eq(schema.technician.active, true),
      )).limit(1);
    if (!row) throw new ConflictError("That is not an active technician in this company.");
    return;
  }
  if (kind === "location") {
    const [row] = await tx.select({ id: schema.location.id }).from(schema.location)
      .where(and(
        eq(schema.location.id, id),
        eq(schema.location.organizationId, organizationId),
      )).limit(1);
    if (!row) throw new ConflictError("That is not a location in this company.");
    return;
  }
  const [row] = await tx.select({ id: schema.job.id }).from(schema.job)
    .where(and(
      eq(schema.job.id, id),
      eq(schema.job.organizationId, organizationId),
      isNull(schema.job.deletedAt),
    )).limit(1);
  if (!row) throw new ConflictError("That is not a job in this company.");
}

/* ---------------------------------------------------------------- handlers */

/**
 * The shapes the route registry wires to, written out rather than inferred.
 *
 * The same pattern `services/crews.ts` and `services/reviews.ts` use: an
 * explicit return type on each one, so a change to a service's shape that
 * breaks the published contract is a compile error here rather than a
 * response that no longer matches the document generated from it.
 */
export const handlers = {
  listAssets: (ctx: ServiceContext, input: {
    kind?: core.AssetKind | undefined; includeRetired?: boolean | undefined;
  }): Promise<{ on: string; assets: RegisterEntry[] }> => listAssets(ctx, input),

  registerAsset: async (ctx: ServiceContext, input: AssetInput): Promise<{
    id: string; label: string; kind: core.AssetKind; meterUnit: core.MeterUnit | null;
  }> => {
    const row = await registerAsset(ctx, input);
    return { id: row.id, label: row.label, kind: row.kind, meterUnit: row.meterUnit };
  },

  updateAsset: async (ctx: ServiceContext, input: AssetUpdate): Promise<{
    id: string; label: string; requirementCode: string | null;
  }> => {
    const row = await updateAsset(ctx, input);
    return { id: row.id, label: row.label, requirementCode: row.requirementCode };
  },

  retireAsset: async (ctx: ServiceContext, input: {
    id: string; retiredOn?: string | undefined; reason?: string | undefined;
  }): Promise<{ id: string; label: string; retiredOn: string | null }> => {
    const row = await retireAsset(ctx, input);
    return { id: row.id, label: row.label, retiredOn: row.retiredOn };
  },

  checkOutAsset: async (ctx: ServiceContext, input: CheckOutInput): Promise<{
    id: string; assetId: string; custodianKind: core.CustodianKind;
    custodianId: string; heldFrom: string;
  }> => {
    const row = await checkOut(ctx, input);
    return {
      id: row.id, assetId: row.assetId, custodianKind: row.custodianKind,
      custodianId: row.custodianId, heldFrom: row.heldFrom,
    };
  },

  checkInAsset: async (ctx: ServiceContext, input: {
    assetId: string; on?: string | undefined; note?: string | undefined;
  }): Promise<{ id: string; assetId: string; heldFrom: string; heldUntil: string | null }> => {
    const row = await checkIn(ctx, input);
    return { id: row.id, assetId: row.assetId, heldFrom: row.heldFrom, heldUntil: row.heldUntil };
  },

  handOverAsset: (ctx: ServiceContext, input: {
    assetId: string; custodianKind: core.CustodianKind; custodianId: string;
    on?: string | undefined; note?: string | undefined;
  }): Promise<{ closed: string; opened: string; on: string }> => handOver(ctx, input),

  getAssetCustody: (ctx: ServiceContext, input: {
    assetId: string; on?: string | undefined;
  }): Promise<CustodyView> => custodyOf(ctx, input),

  listAssetsHeldBy: (ctx: ServiceContext, input: {
    custodianKind: core.CustodianKind; custodianId: string; on?: string | undefined;
  }) => heldBy(ctx, input),

  recordAssetReading: async (ctx: ServiceContext, input: ReadingInput): Promise<{
    id: string; assetId: string; value: number; unit: core.MeterUnit;
    takenOn: string; unitsSincePrevious: number;
  }> => {
    const row = await recordReading(ctx, input);
    return {
      id: row.id, assetId: row.assetId, value: row.value, unit: row.unit,
      takenOn: row.takenOn, unitsSincePrevious: row.unitsSincePrevious,
    };
  },

  listAssetReadings: (ctx: ServiceContext, input: {
    assetId: string; from?: string | undefined; to?: string | undefined;
  }) => readings(ctx, input),

  setAssetMaintenancePlan: async (ctx: ServiceContext, input: PlanInput): Promise<{
    id: string; assetId: string; label: string; basis: "time" | "meter";
  }> => {
    const row = await setPlan(ctx, input);
    return { id: row.id, assetId: row.assetId, label: row.label, basis: row.basis };
  },

  recordAssetService: async (ctx: ServiceContext, input: {
    planId: string; servicedOn?: string | undefined;
  }): Promise<{ id: string; label: string; lastServicedOn: string | null }> => {
    const row = await recordService(ctx, input);
    return { id: row.id, label: row.label, lastServicedOn: row.lastServicedOn };
  },

  getAssetMaintenanceDue: (ctx: ServiceContext, input: {
    assetId?: string | undefined; now?: string | undefined;
  }): Promise<{ now: string; due: MaintenanceLine[] }> => maintenanceDue(ctx, input),

  setAssetObligation: async (ctx: ServiceContext, input: {
    assetId: string; kind: core.ComplianceKind; expiresOn: string;
    reference?: string | null | undefined; lastCertifiedOn?: string | null | undefined;
  }): Promise<{ id: string; assetId: string; kind: core.ComplianceKind; expiresOn: string }> => {
    const row = await setObligation(ctx, input);
    return { id: row.id, assetId: row.assetId, kind: row.kind, expiresOn: row.expiresOn };
  },

  getAssetComplianceOutlook: (ctx: ServiceContext, input: {
    now?: string | undefined; lookaheadDays?: number | undefined;
  }) => complianceOutlook(ctx, input),

  recordAssetCost: async (ctx: ServiceContext, input: {
    assetId: string; kind: core.AssetCostKind; amount: string; incurredOn: string;
    currency?: string | undefined; note?: string | undefined;
  }): Promise<{ id: string; assetId: string; amount: string; incurredOn: string }> => {
    const row = await recordCost(ctx, input);
    return { id: row.id, assetId: row.assetId, amount: row.amount, incurredOn: row.incurredOn };
  },

  getAssetCost: (ctx: ServiceContext, input: {
    assetId: string; from: string; to: string;
    includeAcquisition?: boolean | undefined; currency?: string | undefined;
  }) => costOf(ctx, input),
} as const;
