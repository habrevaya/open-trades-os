import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, can, inspection as insp, isSystem, setup as setupRules, time } from "@opentradesos/core";
import { packById, packs } from "@opentradesos/trade-packs";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, timezoneOf, type ServiceContext,
} from "./context";
import * as estimates from "./estimates";
import { replayed, remember } from "./once";

/**
 * INSPECTIONS AND THE DEFICIENCY BACKLOG
 *
 * `packages/core/src/inspection` is thirteen hundred lines with forty three
 * exports and it had no caller. Not a thin one: none. Template validation,
 * reading evaluation against ranges, the completeness rollup that refuses to
 * call a half finished inspection a pass, the proposal builder that refuses
 * to price a finding with no evidence behind it, the backlog ageing. All of
 * it written, all of it tested in core, and nothing in the product could
 * reach a line.
 *
 * The three tables were the same story. `inspection` was touched by nothing
 * at all. `deficiency` and `visit_asset` were read by the equipment history
 * I wrote yesterday and written by nothing, which is why that screen's
 * faults section was always empty.
 *
 * So a company doing fire, backflow or boiler work, which is the half of
 * this trade that runs on inspections, had a database ready for it and no
 * way in.
 *
 * TWO SEVERITY VOCABULARIES, ONE OF THEM RIGHT
 *
 * The database enum says critical, major, minor, advisory. Core says safety,
 * failure, wear, recommendation, and attaches a response deadline to each:
 * a safety finding is today, a failure is thirty days, wear is a hundred and
 * eighty, a recommendation has no deadline at all.
 *
 * Core's is the one that decides anything, so it is the one the product
 * thinks in, and the mapping below is stated once rather than re-derived at
 * every call site. The database words survive because trade packs ship them
 * and an authority's own form uses them.
 */
const TO_CORE: Record<string, insp.Severity> = {
  critical: "safety",
  major: "failure",
  minor: "wear",
  advisory: "recommendation",
};
const FROM_CORE: Record<insp.Severity, "critical" | "major" | "minor" | "advisory"> = {
  safety: "critical",
  failure: "major",
  wear: "minor",
  recommendation: "advisory",
};

/**
 * The checkpoint list a trade pack ships, lifted into the template core
 * validates.
 *
 * DERIVED, NEVER STORED ALONGSIDE. Two representations of one programme is
 * the defect this codebase has already produced twice, once in the agreement
 * visit dates and once in the sending number. So `checkpoints` stays the one
 * stored form, this is the one derivation, and a checkpoint list that cannot
 * lift into a valid template is refused when the programme is SAVED rather
 * than discovered when somebody tries to inspect with it.
 *
 * One section, because a flat checkpoint list has no sections in it and
 * inventing them would be this function guessing at structure the author did
 * not write.
 */
export function templateFor(program: {
  name: string;
  standard: string | null;
  checkpoints: {
    key: string; label: string; assetCategory?: string | undefined;
    requiresReading?: boolean | undefined; unit?: string | undefined;
    range?: { min: number | null; max: number | null; borderlineWithin?: number | undefined } | undefined;
    remedies?: { priceBookItemKey: string; label: string; quantity: number; rationale: string }[] | undefined;
    failIsDeficiency?: boolean | undefined;
    severityOnFail?: "critical" | "major" | "minor" | "advisory" | undefined;
  }[];
}): insp.InspectionTemplate {
  return {
    key: "program",
    title: program.name,
    discipline: program.standard ?? "general",
    sections: [{
      key: "checkpoints",
      title: program.name,
      items: program.checkpoints.map((checkpoint) => ({
        key: checkpoint.key,
        prompt: checkpoint.label,
        answer: checkpoint.requiresReading
          ? {
              kind: "reading" as const,
              unit: checkpoint.unit ?? "",
              ...(checkpoint.range ? { range: checkpoint.range } : {}),
            }
          : { kind: "pass_fail" as const },
        /**
         * Only an item that CAN fail carries a failure severity, and core
         * refuses one that can fail without it. `failIsDeficiency: false`
         * is a checkpoint recorded for the record rather than judged, and
         * giving it a severity would manufacture a finding out of an
         * observation.
         */
        ...(checkpoint.remedies ? { remedies: checkpoint.remedies } : {}),
        ...(checkpoint.failIsDeficiency === false
          ? {}
          : { failureSeverity: TO_CORE[checkpoint.severityOnFail ?? "minor"]! }),
      })),
    }],
  };
}

/* ------------------------------------------------------------- programmes */

type Checkpoint = schema.InspectionCheckpoint;

export interface ProgramInput {
  name: string;
  standard?: string | null | undefined;
  reportAudience?: "customer" | "authority" | "both" | undefined;
  authorityName?: string | null | undefined;
  frequencyMonths?: number | null | undefined;
  checkpoints: {
    key: string; label: string; assetCategory?: string | undefined;
    requiresReading?: boolean | undefined; unit?: string | undefined;
    range?: { min: number | null; max: number | null; borderlineWithin?: number | undefined } | undefined;
    remedies?: { priceBookItemKey: string; label: string; quantity: number; rationale: string }[] | undefined;
    failIsDeficiency?: boolean | undefined;
    severityOnFail?: "critical" | "major" | "minor" | "advisory" | undefined;
  }[];
}

/** Where a company's own programme starts from: a trade pack's programme, or another of its own. */
export type CopySource =
  | { kind: "trade_pack"; packId: string; code: string }
  | { kind: "program"; programId: string };

/**
 * What one version of a programme says, in the shape compared from one
 * version to the next. The same parts a trade pack upgrade compares, plus the
 * authority, which a pack never sets and a company does.
 */
interface ProgramContent {
  name: string;
  standard: string | null;
  reportAudience: string;
  authorityName: string | null;
  frequencyMonths: number | null;
  checkpoints: Checkpoint[];
}

const contentOf = (row: ProgramContent): ProgramContent => ({
  name: row.name,
  standard: row.standard,
  reportAudience: row.reportAudience,
  authorityName: row.authorityName,
  frequencyMonths: row.frequencyMonths,
  checkpoints: row.checkpoints,
});

/** The content a person sent, trimmed the way it is stored. */
function cleaned(input: ProgramInput): ProgramContent {
  return {
    name: input.name.trim(),
    standard: input.standard?.trim() || null,
    reportAudience: input.reportAudience ?? "customer",
    authorityName: input.authorityName?.trim() || null,
    frequencyMonths: input.frequencyMonths ?? null,
    checkpoints: input.checkpoints.map((checkpoint) => {
      const assetCategory = checkpoint.assetCategory?.trim();
      const unit = checkpoint.unit?.trim();
      return {
        ...checkpoint,
        key: checkpoint.key.trim(),
        label: checkpoint.label.trim(),
        ...(assetCategory ? { assetCategory } : { assetCategory: undefined }),
        ...(unit ? { unit } : { unit: undefined }),
      };
    }).map((checkpoint) => Object.fromEntries(
      Object.entries(checkpoint).filter(([, value]) => value !== undefined),
    ) as Checkpoint),
  };
}

/**
 * Everything that stops a programme being filed, in words, or nothing.
 *
 * Core's template problems (an item that cannot be answered, a reading with
 * no range or no unit, a range that excludes its own limits), and one this
 * module adds for a programme a company writes: a checkpoint whose fail is a
 * finding has to SAY how serious that finding is. Core refuses to default it
 * ("defaulting is the trap"), and the pack loader defaults it to minor, which
 * is why the rule is here and not in the shape: a person filling in a form
 * who skipped the box has not decided that a fail is wear.
 */
export function problemsOf(input: ProgramInput): string[] {
  const problems: string[] = [];
  if (input.name.trim() === "") problems.push("A programme needs a name.");
  if (input.checkpoints.length === 0) {
    problems.push("A programme with no checkpoints inspects nothing and would report every visit as a pass.");
    return problems;
  }
  for (const checkpoint of input.checkpoints) {
    if (checkpoint.failIsDeficiency !== false && checkpoint.severityOnFail === undefined) {
      problems.push(`"${checkpoint.label || checkpoint.key}" does not say how serious a fail is.`);
    }
  }
  const verdict = insp.validateTemplate(templateFor({
    name: input.name.trim(),
    standard: input.standard?.trim() ?? null,
    checkpoints: input.checkpoints,
  }));
  if (!verdict.ok) problems.push(...verdict.problems.map((p) => p.message));
  return problems;
}

/**
 * Refused at the SAVE, which is the whole point of `validateTemplate` having
 * been written and never called.
 *
 * Its problems are about items that cannot be answered, items that can fail
 * with no stated meaning for the failure, ranges that exclude their own
 * limits. Every one of those is invisible until a technician is standing in
 * a plant room with a phone, and none of them is recoverable there.
 */
function assertValid(input: ProgramInput) {
  if (input.name.trim() === "") throw new ConflictError("A programme needs a name.");
  if (input.checkpoints.length === 0) {
    throw new ConflictError(
      "A programme with no checkpoints inspects nothing and would report every visit as a pass.",
    );
  }
  const unstated = input.checkpoints.filter((c) => c.failIsDeficiency !== false && c.severityOnFail === undefined);
  if (unstated.length > 0) {
    throw new ConflictError(
      `${unstated.map((c) => `"${c.label || c.key}"`).join(", ")} ${unstated.length === 1 ? "does" : "do"} not say how `
      + "serious a fail is. Pick one, or say a fail there is not a finding.",
    );
  }
  const verdict = insp.validateTemplate(templateFor({
    name: input.name.trim(),
    standard: input.standard?.trim() ?? null,
    checkpoints: input.checkpoints,
  }));
  if (!verdict.ok) throw new ConflictError(insp.explainTemplateProblems(verdict.problems));
}

/**
 * ONE NAME PER PROGRAMME OFFERED.
 *
 * A technician picks a programme by its name on a phone, and a trade pack
 * knows its programmes by name from one version to the next. Two offered under
 * one name is a coin toss in a plant room. Compared without case or spaces at
 * the ends, under a lock per company so two people saving at once cannot both
 * pass the check. A programme nobody is offered keeps its name; it is the
 * record the old inspections point at.
 */
async function assertNameFree(tx: Database, organizationId: string, name: string, except: string[]) {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`inspection-program-name:${organizationId}`}))`);
  const [clash] = await tx.select({ id: schema.inspectionProgram.id, name: schema.inspectionProgram.name })
    .from(schema.inspectionProgram)
    .where(and(
      eq(schema.inspectionProgram.organizationId, organizationId),
      eq(schema.inspectionProgram.active, true),
      sql`lower(btrim(${schema.inspectionProgram.name})) = lower(btrim(${name}))`,
      ...(except.length > 0 ? [sql`${schema.inspectionProgram.id} not in (${sql.join(except.map((id) => sql`${id}::uuid`), sql`, `)})`] : []),
    ))
    .limit(1);
  if (clash) {
    throw new ConflictError(
      `Technicians are already offered a programme called "${clash.name}". Give this one another name, `
      + "or stop offering that one first.",
    );
  }
}

/**
 * KEEP A VERSION, WHOLE, AS IT WAS PUBLISHED.
 *
 * Called with the programme row as it now stands, after every write that
 * gives it a version: defining one, revising one, a trade pack setting one up
 * or upgrading it. Also called with the row BEFORE a revision, so a programme
 * published before versions were kept gets its old version kept on the way
 * past rather than lost. A version already kept is left exactly as it is.
 */
export async function keepVersion(
  tx: Database,
  row: typeof schema.inspectionProgram.$inferSelect,
  by: { userId?: string | null; note?: string | null; changed?: string[]; tradePackId?: string | null; at?: Date },
) {
  await tx.insert(schema.inspectionProgramVersion).values({
    organizationId: row.organizationId,
    programId: row.id,
    version: row.version,
    ...contentOf(row),
    changed: by.changed ?? [],
    note: by.note?.trim() || null,
    tradePackId: by.tradePackId ?? null,
    publishedByUserId: by.userId ?? null,
    publishedAt: by.at ?? row.updatedAt,
  }).onConflictDoNothing({ target: [schema.inspectionProgramVersion.programId, schema.inspectionProgramVersion.version] });
}

const personOf = (ctx: ServiceContext) => (isSystem(ctx.actor) ? null : ctx.actor.userId);

/**
 * WRITE A PROGRAMME OF THE COMPANY'S OWN.
 *
 * From nothing, or from a copy of a trade pack's programme or of one the
 * company already has. The copy is made on the screen and saved here, so what
 * is stored is always something a technician can file: every pack programme
 * shipped today asks for a reading with no range somewhere, which core
 * refuses to judge, and a copy that kept that would be a programme nobody can
 * finish. Where it came from is kept with it.
 *
 * `replaces` stops offering another programme in the same step, so "use my
 * version of the pack's backflow test instead of the pack's" never leaves a
 * moment with both on the phone, or neither.
 */
export async function defineProgram(
  ctx: ServiceContext,
  input: ProgramInput & { copiedFrom?: CopySource | undefined; replaces?: string | undefined; note?: string | null | undefined },
) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    /** A retry under the same idempotency key gets the programme the first one wrote, not a second. */
    const again = await replayed<{ id: string }>(tx, ctx, "inspection_program");
    if (again) return loadProgram(tx, ctx.actor.organizationId, again.id);
    assertValid(input);
    const content = cleaned(input);

    const replaced = input.replaces ? await loadProgram(tx, ctx.actor.organizationId, input.replaces, { lock: true }) : null;
    await assertNameFree(tx, ctx.actor.organizationId, content.name, replaced ? [replaced.id] : []);
    const copiedFrom = input.copiedFrom ? await sourceOf(tx, ctx.actor.organizationId, input.copiedFrom) : null;

    const [row] = await tx.insert(schema.inspectionProgram).values({
      organizationId: ctx.actor.organizationId,
      ...content,
      copiedFrom,
    }).returning();
    await keepVersion(tx, row!, { userId: personOf(ctx), note: input.note ?? null, at: row!.createdAt });

    if (replaced && replaced.active) {
      await tx.update(schema.inspectionProgram).set({ active: false, updatedAt: new Date() })
        .where(eq(schema.inspectionProgram.id, replaced.id));
      await audit(tx, ctx, "inspection_program.withdrawn", "inspection_program", replaced.id,
        { active: true }, { active: false, replacedBy: row!.id });
    }
    await audit(tx, ctx, "inspection_program.defined", "inspection_program", row!.id, null, row!);
    await remember(tx, ctx, "inspection_program", row!.id, { id: row!.id });
    return row!;
  });
}

/** The source of a copy, checked and named, as it is kept on the copy. */
async function sourceOf(tx: Database, organizationId: string, source: CopySource): Promise<schema.InspectionProgramCopiedFrom> {
  if (source.kind === "trade_pack") {
    const pack = packById(source.packId);
    const program = pack?.inspectionPrograms.find((p) => p.code === source.code);
    if (!pack || !program) throw new NotFoundError("Trade pack programme");
    return { kind: "trade_pack", packId: pack.id, packVersion: pack.version, code: program.code, name: program.name };
  }
  const program = await loadProgram(tx, organizationId, source.programId);
  return { kind: "program", programId: program.id, version: program.version, name: program.name };
}

/**
 * Change a programme by publishing a new VERSION.
 *
 * An inspection records the version it was performed under, because a report
 * in a compliance file has to keep meaning what it meant. Editing the
 * checkpoints in place rewrites what every past inspection claims to have
 * checked, which is the one thing a compliance record must never do. So the
 * version being replaced is kept whole first, and the new one is kept beside
 * it the moment it is published.
 *
 * `baseVersion` is the version the person was looking at. Two people editing
 * one programme would otherwise each publish over the other without either
 * seeing the other's change, so a version that has moved on is refused.
 *
 * A programme a trade pack set up keeps its name: the pack knows it by that
 * name from one version to the next, and so does any retention rule for it.
 * To call it something else, copy it.
 *
 * Nothing changed publishes nothing: a version that says what the last one
 * said would be a version number that means nothing.
 */
export async function reviseProgram(
  ctx: ServiceContext,
  input: Partial<ProgramInput> & { id: string; baseVersion?: number | undefined; note?: string | null | undefined },
) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    /** A retry of a publish that landed publishes nothing more: the base version it names has moved on. */
    const again = await replayed<{ id: string }>(tx, ctx, "inspection_program_version");
    if (again) return loadProgram(tx, ctx.actor.organizationId, again.id);
    const before = await loadProgram(tx, ctx.actor.organizationId, input.id, { lock: true });
    if (input.baseVersion !== undefined && input.baseVersion !== before.version) {
      throw new ConflictError(
        `Somebody published version ${before.version} of ${before.name} while this was open at version `
        + `${input.baseVersion}. Open it again to see what they changed, then make yours.`,
      );
    }
    const merged: ProgramInput = {
      name: input.name ?? before.name,
      standard: input.standard !== undefined ? input.standard : before.standard,
      reportAudience: input.reportAudience
        ?? (before.reportAudience as "customer" | "authority" | "both"),
      authorityName: input.authorityName !== undefined ? input.authorityName : before.authorityName,
      frequencyMonths: input.frequencyMonths !== undefined
        ? input.frequencyMonths : before.frequencyMonths,
      checkpoints: input.checkpoints ?? before.checkpoints,
    };
    assertValid(merged);
    const content = cleaned(merged);

    if (before.tradePackId && content.name !== before.name) {
      throw new ConflictError(
        `${before.name} came with a trade pack, which knows it by that name. Keep the name, `
        + "or make a copy and give the copy the new one.",
      );
    }
    const changed = setupRules.changedParts(
      contentOf(before) as unknown as Record<string, unknown>,
      content as unknown as Record<string, unknown>,
    );
    if (changed.length === 0) return before;
    if (before.active && content.name.toLowerCase() !== before.name.trim().toLowerCase()) {
      await assertNameFree(tx, ctx.actor.organizationId, content.name, [before.id]);
    }

    await keepVersion(tx, before, {});
    const now = new Date();
    const [after] = await tx.update(schema.inspectionProgram).set({
      ...content,
      version: before.version + 1,
      updatedAt: now,
    }).where(eq(schema.inspectionProgram.id, input.id)).returning();
    await keepVersion(tx, after!, { userId: personOf(ctx), note: input.note ?? null, changed, at: now });

    await audit(tx, ctx, "inspection_program.revised", "inspection_program", input.id, before, after!);
    await remember(tx, ctx, "inspection_program_version", input.id, { id: input.id, version: after!.version });
    return after!;
  });
}

/**
 * OFFER A PROGRAMME TO TECHNICIANS, OR STOP.
 *
 * Stopping keeps the programme and every version of it, because the
 * inspections done under it point at them. Offering it again checks it can be
 * filed and that no other programme technicians are offered has its name,
 * because a programme that cannot be filed is twenty minutes of a
 * technician's work that goes nowhere.
 */
export async function setOffered(ctx: ServiceContext, input: { id: string; offered: boolean }) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const before = await loadProgram(tx, ctx.actor.organizationId, input.id, { lock: true });
    if (before.active === input.offered) return before;
    if (input.offered) {
      const problems = problemsOf(before as ProgramInput);
      if (problems.length > 0) {
        throw new ConflictError(`${before.name} cannot be filed as it stands. ${problems.join(" ")} Publish a version that fixes it first.`);
      }
      await assertNameFree(tx, ctx.actor.organizationId, before.name, [before.id]);
    }
    const [after] = await tx.update(schema.inspectionProgram).set({ active: input.offered, updatedAt: new Date() })
      .where(eq(schema.inspectionProgram.id, before.id)).returning();
    await audit(tx, ctx, input.offered ? "inspection_program.offered" : "inspection_program.withdrawn",
      "inspection_program", before.id, { active: before.active }, { active: after!.active });
    return after!;
  });
}

/** A programme as the list and the API show it. */
function summaryOfProgram(row: typeof schema.inspectionProgram.$inferSelect) {
  const problems = problemsOf(row as ProgramInput);
  return {
    id: row.id,
    name: row.name,
    standard: row.standard,
    reportAudience: row.reportAudience,
    authorityName: row.authorityName,
    frequencyMonths: row.frequencyMonths,
    version: row.version,
    checkpointCount: row.checkpoints.length,
    active: row.active,
    tradePackId: row.tradePackId,
    copiedFrom: row.copiedFrom ?? null,
    /** Whether an inspection can be filed against it, and what stops one when it cannot. */
    ready: problems.length === 0,
    problems,
  };
}

export async function programs(ctx: ServiceContext, input: { includeRetired?: boolean | undefined } = {}) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const rows = await tx.select().from(schema.inspectionProgram)
      .where(and(
        eq(schema.inspectionProgram.organizationId, ctx.actor.organizationId),
        ...(input.includeRetired ? [] : [eq(schema.inspectionProgram.active, true)]),
      ))
      .orderBy(desc(schema.inspectionProgram.active), asc(schema.inspectionProgram.name));
    return rows.map(summaryOfProgram);
  });
}

/**
 * One programme as it stands, with every version it has had, newest first.
 * A programme published before versions were kept lists the version it is on
 * from its own row, and nothing older, because nothing older was kept.
 */
export async function program(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const row = await loadProgram(tx, ctx.actor.organizationId, input.id);
    const kept = await tx.select({
      version: schema.inspectionProgramVersion.version,
      name: schema.inspectionProgramVersion.name,
      changed: schema.inspectionProgramVersion.changed,
      note: schema.inspectionProgramVersion.note,
      tradePackId: schema.inspectionProgramVersion.tradePackId,
      publishedAt: schema.inspectionProgramVersion.publishedAt,
      publishedBy: schema.user.name,
      publishedByEmail: schema.user.email,
    }).from(schema.inspectionProgramVersion)
      .leftJoin(schema.user, eq(schema.user.id, schema.inspectionProgramVersion.publishedByUserId))
      .where(eq(schema.inspectionProgramVersion.programId, row.id))
      .orderBy(desc(schema.inspectionProgramVersion.version));
    const versions = kept.map((v) => ({
      version: v.version, name: v.name, changed: v.changed, note: v.note, tradePackId: v.tradePackId,
      publishedAt: v.publishedAt, publishedBy: v.publishedBy ?? v.publishedByEmail ?? null,
    }));
    if (!versions.some((v) => v.version === row.version)) {
      versions.unshift({
        version: row.version, name: row.name, changed: [], note: null, tradePackId: row.tradePackId,
        publishedAt: row.updatedAt, publishedBy: null,
      });
    }
    const [{ count } = { count: 0 }] = await tx.select({ count: sql<number>`count(*)::int` })
      .from(schema.inspection).where(eq(schema.inspection.programId, row.id));
    return {
      program: { ...summaryOfProgram(row), checkpoints: row.checkpoints },
      versions,
      inspections: count,
    };
  });
}

/** One version of a programme, whole, as it was published. */
export async function programVersion(ctx: ServiceContext, input: { id: string; version: number }) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const row = await loadProgram(tx, ctx.actor.organizationId, input.id);
    const content = await contentAt(tx, row, input.version);
    if (!content) throw new NotFoundError(`Version ${input.version} of ${row.name}`);
    return {
      id: row.id, current: input.version === row.version, ...content,
      problems: problemsOf(content as ProgramInput),
    };
  });
}

/**
 * What a programme said at one version: the kept copy, or the programme row
 * itself when that is the version it is on and nothing was kept for it yet.
 * Null for a version that was never kept.
 */
async function contentAt(
  tx: Database, row: typeof schema.inspectionProgram.$inferSelect, version: number,
): Promise<(ProgramContent & { version: number }) | null> {
  const [kept] = await tx.select().from(schema.inspectionProgramVersion)
    .where(and(
      eq(schema.inspectionProgramVersion.programId, row.id),
      eq(schema.inspectionProgramVersion.version, version),
    )).limit(1);
  if (kept) return { ...contentOf(kept), version };
  if (version === row.version) return { ...contentOf(row), version };
  return null;
}

/**
 * THE PROGRAMMES THE TRADE PACKS DECLARE, TO START ONE OF YOUR OWN FROM.
 *
 * Every pack's, the company's own trades first. Each says what has to be
 * fixed before it could be filed, because today every one of them asks for a
 * reading with no range somewhere and core will not judge a number against
 * nothing. Where the company already has the pack's programme, it is named, so
 * the screen can offer to use the copy instead of it.
 */
export async function packPrograms(ctx: ServiceContext) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const [org] = await tx.select({ primaryTrade: schema.organization.primaryTrade }).from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    const applied = await tx.selectDistinct({ packId: schema.tradePackApplication.packId })
      .from(schema.tradePackApplication)
      .where(eq(schema.tradePackApplication.organizationId, ctx.actor.organizationId));
    const ours = new Set([...(org?.primaryTrade ? [org.primaryTrade] : []), ...applied.map((a) => a.packId)]);
    const rows = await tx.select({
      id: schema.inspectionProgram.id, name: schema.inspectionProgram.name,
      active: schema.inspectionProgram.active, tradePackId: schema.inspectionProgram.tradePackId,
    }).from(schema.inspectionProgram)
      .where(and(
        eq(schema.inspectionProgram.organizationId, ctx.actor.organizationId),
        sql`${schema.inspectionProgram.tradePackId} is not null`,
      ));

    const ordered = [...packs].sort((a, b) => Number(ours.has(b.id)) - Number(ours.has(a.id)) || a.name.localeCompare(b.name));
    return ordered.flatMap((pack) => pack.inspectionPrograms.map((p) => {
      const mine = rows.find((r) => r.name === p.name && r.tradePackId?.split("@")[0] === pack.id);
      const content: ProgramInput = {
        name: p.name, standard: p.standard ?? null, reportAudience: p.reportAudience,
        frequencyMonths: p.frequencyMonths ?? null, checkpoints: p.checkpoints,
      };
      return {
        packId: pack.id,
        packName: pack.name,
        packVersion: pack.version,
        yourTrade: ours.has(pack.id),
        code: p.code,
        name: p.name,
        standard: p.standard ?? null,
        reportAudience: p.reportAudience,
        frequencyMonths: p.frequencyMonths ?? null,
        checkpoints: p.checkpoints as Checkpoint[],
        problems: problemsOf(content),
        /** The company's own row of this programme, set up by the pack, when it has one. */
        inCompany: mine ? { id: mine.id, offered: mine.active } : null,
      };
    }));
  });
}

/**
 * What a checkpoint can say it is about: the kinds of equipment the
 * company's trades declare, the ones its programmes already name, and, for
 * somebody who may see equipment, the kinds on its register. A suggestion
 * list, not a rule: a checkpoint about "the whole property" names nothing.
 */
export async function appliesToChoices(ctx: ServiceContext): Promise<string[]> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const [org] = await tx.select({ primaryTrade: schema.organization.primaryTrade }).from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    const applied = await tx.selectDistinct({ packId: schema.tradePackApplication.packId })
      .from(schema.tradePackApplication)
      .where(eq(schema.tradePackApplication.organizationId, ctx.actor.organizationId));
    const ids = new Set([...(org?.primaryTrade ? [org.primaryTrade] : []), ...applied.map((a) => a.packId)]);
    const found = new Set<string>();
    for (const id of ids) {
      const pack = packById(id);
      for (const category of pack?.equipmentCategories ?? []) found.add(category.code);
      for (const program of pack?.inspectionPrograms ?? []) {
        for (const checkpoint of program.checkpoints) if (checkpoint.assetCategory) found.add(checkpoint.assetCategory);
      }
    }
    const programmes = await tx.select({ checkpoints: schema.inspectionProgram.checkpoints })
      .from(schema.inspectionProgram)
      .where(eq(schema.inspectionProgram.organizationId, ctx.actor.organizationId));
    for (const row of programmes) for (const c of row.checkpoints) if (c.assetCategory) found.add(c.assetCategory);
    if (can(ctx.actor, "equipment:read")) {
      const kinds = await tx.selectDistinct({ category: schema.equipment.category }).from(schema.equipment)
        .where(and(eq(schema.equipment.organizationId, ctx.actor.organizationId), isNull(schema.equipment.deletedAt)))
        .limit(200);
      for (const k of kinds) if (k.category.trim() !== "") found.add(k.category.trim());
    }
    return [...found].sort((a, b) => a.localeCompare(b));
  });
}

/**
 * The repair codes a programme names that the company's price book does not
 * have. Not a refusal at the save: a copy of a pack's programme names the
 * pack's codes, and the person writing it may be adding the items next. The
 * quote refuses a missing code in words when somebody tries it; this says so
 * earlier, on the programme's own page.
 */
export async function missingRepairCodes(ctx: ServiceContext, input: { id: string }): Promise<string[]> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const row = await loadProgram(tx, ctx.actor.organizationId, input.id);
    const codes = [...new Set(row.checkpoints.flatMap((c) => (c.remedies ?? []).map((r) => r.priceBookItemKey)))];
    if (codes.length === 0) return [];
    const have = await tx.select({ code: schema.priceBookItem.code }).from(schema.priceBookItem)
      .where(and(eq(schema.priceBookItem.organizationId, ctx.actor.organizationId), inArray(schema.priceBookItem.code, codes)));
    const held = new Set(have.map((h) => h.code));
    return codes.filter((code) => !held.has(code));
  });
}

/* ----------------------------------------------------------- an inspection */

/**
 * Record what was found, and let core decide what it adds up to.
 *
 * THE OUTCOME IS NOT AN INPUT. A technician says what they saw; whether that
 * is a pass is a conclusion from the template, and `assessInspection` is what
 * draws it. Accepting an outcome from the caller would let a half finished
 * inspection be filed as a pass, which is the single most dangerous artefact
 * this module can produce: that report goes in a compliance file, gets handed
 * to a buyer, gets shown to an insurer, and asserts that somebody looked at
 * things nobody looked at.
 */
export interface RecordInput {
  /**
   * The inspection's own id, when the caller made one. The phone does, offline,
   * because a signature taken on the same screen has to name the inspection
   * before the server has heard of it. A second filing under an id that
   * exists returns the first rather than filing twice.
   */
  id?: string | undefined;
  programId: string;
  /**
   * The version of the programme the technician was shown, when the caller
   * knows it. The phone does: an inspection run offline against version 3 and
   * sent after version 4 was published is judged against version 3, the
   * checkpoints it actually answered, and keeps version 3. Without it the
   * version in force is used, which is what a filing from the office means.
   */
  programVersion?: number | undefined;
  propertyId: string;
  customerId: string;
  answers: insp.RecordedAnswer[];
  jobId?: string | null;
  visitId?: string | null;
  inspectorName?: string | null;
  inspectorLicense?: string | null;
  performedOn?: string;
  /** Who signed the report off, and the signature's upload from the phone. */
  signedByName?: string | null;
  signedAt?: Date | null;
  signatureUploadId?: string | null;
}

export async function record(ctx: ServiceContext, input: RecordInput) {
  return guardedWrite(ctx, "compliance:write", (tx) => recordIn(tx, ctx, input));
}

/**
 * The filing itself, inside a transaction somebody else opened. The field
 * sync files an inspection inside its own batch, in a savepoint, after
 * checking `compliance:write` itself; everything else comes through `record`.
 */
export async function recordIn(tx: Database, ctx: ServiceContext, input: RecordInput) {
  {
    if (input.id) {
      const [existing] = await tx.select().from(schema.inspection)
        .where(and(eq(schema.inspection.id, input.id), eq(schema.inspection.organizationId, ctx.actor.organizationId)))
        .limit(1);
      if (existing) return summaryOf(tx, existing);
    }
    const current = await loadProgram(tx, ctx.actor.organizationId, input.programId);
    /**
     * The version the answers were given against. One that was never kept
     * (asked for by a phone that held a programme from before versions were
     * kept) falls back to the version in force, which is what filing did
     * before versions were kept at all.
     */
    const program = {
      id: current.id,
      ...((input.programVersion !== undefined && input.programVersion !== current.version
        ? await contentAt(tx, current, input.programVersion)
        : null) ?? { ...contentOf(current), version: current.version }),
    };

    const assessment = insp.assessInspection(templateFor(program), input.answers);
    if (!assessment.ok) throw new ConflictError(explainAssessment(assessment));

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const performedOn = input.performedOn ?? time.dateIn(new Date(), zone);

    const [row] = await tx.insert(schema.inspection).values({
      ...(input.id ? { id: input.id } : {}),
      organizationId: ctx.actor.organizationId,
      programId: program.id,
      /**
       * Stamped with the version, because a report in a compliance file has
       * to keep meaning what it meant. Without it, revising a programme
       * silently changes what every past inspection claims to have checked.
       */
      programVersion: program.version,
      propertyId: input.propertyId,
      customerId: input.customerId,
      jobId: input.jobId ?? null,
      visitId: input.visitId ?? null,
      performedOn,
      result: toResult(assessment),
      inspectorName: input.inspectorName?.trim() || null,
      inspectorLicense: input.inspectorLicense?.trim() || null,
      nextDueOn: program.frequencyMonths
        ? addMonths(performedOn, program.frequencyMonths)
        : null,
      /**
       * The checkpoints and the answers, kept with the inspection, so the
       * report printed next year is printed from what was asked and what was
       * said, not from the programme as somebody has since revised it.
       */
      checkpoints: program.checkpoints,
      answers: input.answers.map((answer) => ({
        itemKey: answer.itemKey,
        value: { ...answer.value } as Record<string, unknown> & { kind: string },
        at: answer.at.toISOString(),
        by: answer.by,
        ...(answer.note !== undefined ? { note: answer.note } : {}),
        ...(answer.photoIds !== undefined ? { photoIds: [...answer.photoIds] } : {}),
        ...(answer.equipmentId !== undefined ? { equipmentId: answer.equipmentId } : {}),
      })),
      statement: assessment.statement,
      signedByName: input.signedByName?.trim() || null,
      signedAt: input.signedByName?.trim() ? input.signedAt ?? new Date() : null,
      signatureUploadId: input.signatureUploadId ?? null,
    }).returning();

    /**
     * Findings become rows, so they outlive the visit and land on a backlog
     * somebody works. A deficiency that exists only inside one report is a
     * fault nobody follows up.
     */
    /**
     * WHICH MACHINE EACH ANSWER WAS ABOUT, checked once against the register.
     *
     * `deficiency.equipment_id` had no writer, so the equipment history's
     * fault section was always empty and the column sat in
     * `unwritten-columns.test.ts` as a known gap. A checkpoint may now name
     * the unit it was about, and the finding carries it.
     *
     * Checked here rather than taken on trust, and in ONE query rather than
     * one per finding: an inspection of eight rooftop units produces a
     * reference per unit, and a per finding lookup would be eight round trips
     * inside a transaction a technician's phone is waiting on.
     *
     * At the property this inspection is about, not merely existing. A fault
     * attached to a machine at a different address is worse than no
     * attachment: it puts a repair on somebody else's equipment history.
     */
    const named = [...new Set(
      input.answers.map((a) => a.equipmentId).filter((id): id is string => typeof id === "string"),
    )];
    const here = new Set<string>();
    if (named.length > 0) {
      const rows = await tx.select({ id: schema.equipment.id }).from(schema.equipment)
        .where(and(
          eq(schema.equipment.organizationId, ctx.actor.organizationId),
          inArray(schema.equipment.id, named),
          eq(schema.equipment.propertyId, input.propertyId),
          isNull(schema.equipment.deletedAt),
        ));
      for (const row of rows) here.add(row.id);
      const stray = named.filter((id) => !here.has(id));
      if (stray.length > 0) {
        throw new ConflictError(
          `Equipment ${stray[0]} is not on the register at this property. A fault attached to `
          + "a machine at a different address puts a repair on somebody else's equipment "
          + "history.",
        );
      }
    }
    const unitOf = new Map(
      input.answers
        .filter((a) => typeof a.equipmentId === "string")
        .map((a) => [a.itemKey, a.equipmentId!]),
    );

    const byKey = new Map(program.checkpoints.map((c) => [c.key, c]));
    for (const found of assessment.deficiencies) {
      const checkpoint = byKey.get(found.itemKey);
      await tx.insert(schema.deficiency).values({
        organizationId: ctx.actor.organizationId,
        inspectionId: row!.id,
        propertyId: input.propertyId,
        customerId: input.customerId,
        severity: FROM_CORE[found.severity],
        checkpointKey: found.itemKey,
        /**
         * The unit the answer that produced this finding was about, or null
         * when the checkpoint was about the property. Half the checkpoints on
         * a real programme have no machine: "is the gas meter accessible" has
         * none, and inventing an equipment row for the building to satisfy a
         * column would be worse than the null.
         */
        equipmentId: unitOf.get(found.itemKey) ?? null,
        code: found.codeReference ?? null,
        description: found.summary,
        foundOn: performedOn,
        /**
         * The evidence, kept with the finding rather than only in the
         * report. Core refuses to price a deficiency with no observation,
         * and that refusal only means anything if the photo and the reading
         * survive the visit.
         */
        /** Frozen onto the finding, so revising the programme cannot rewrite an old quote. */
        remedies: [...found.remedies],
        observation: {
          itemKey: found.observation.itemKey,
          prompt: found.observation.prompt,
          recorded: found.observation.recorded,
          at: found.observation.at.toISOString(),
          by: found.observation.by,
          photoIds: [...found.observation.photoIds],
          ...(found.observation.reading ? { reading: found.observation.reading } : {}),
        },
        /**
         * The deadline comes from the severity scale rather than from a
         * field somebody fills in. A safety finding is today and a
         * recommendation has no deadline, and leaving that to be typed is
         * how every finding ends up with the same date.
         */
        correctByOn: deadlineFor(found.severity, performedOn),
        ...(checkpoint?.assetCategory ? {} : {}),
      });
    }

    await audit(tx, ctx, "inspection.recorded", "inspection", row!.id, null, {
      result: row!.result, deficiencies: assessment.deficiencies.length,
    });

    return {
      id: row!.id,
      result: row!.result,
      /** Core's own sentence, not one reassembled here. */
      statement: assessment.statement,
      complete: assessment.complete,
      unanswered: [...assessment.unanswered],
      optionalSkipped: [...assessment.optionalSkipped],
      counts: assessment.counts as Record<string, number>,
      nextDueOn: row!.nextDueOn,
      deficiencies: assessment.deficiencies.length,
    };
  }
}

/**
 * What a replayed filing gets back: the same summary, recomputed from what
 * was kept, so a phone retrying after a lost response sees what it filed.
 */
async function summaryOf(tx: Database, row: typeof schema.inspection.$inferSelect) {
  const template = templateFor({
    name: "", standard: null,
    checkpoints: row.checkpoints ?? [],
  });
  const assessment = insp.assessInspection(template, (row.answers ?? []).map(toRecorded));
  const [{ count } = { count: 0 }] = await tx.select({ count: sql<number>`count(*)::int` })
    .from(schema.deficiency).where(eq(schema.deficiency.inspectionId, row.id));
  return {
    id: row.id,
    result: row.result,
    statement: row.statement ?? (assessment.ok ? assessment.statement : ""),
    complete: assessment.ok ? assessment.complete : false,
    unanswered: assessment.ok ? [...assessment.unanswered] : [],
    optionalSkipped: assessment.ok ? [...assessment.optionalSkipped] : [],
    counts: (assessment.ok ? assessment.counts : {}) as Record<string, number>,
    nextDueOn: row.nextDueOn,
    deficiencies: Number(count),
  };
}

/** A stored answer back into core's shape. */
function toRecorded(answer: typeof schema.inspection.$inferSelect["answers"][number]): insp.RecordedAnswer {
  return {
    itemKey: answer.itemKey,
    value: answer.value as unknown as insp.AnswerValue,
    at: new Date(answer.at),
    by: answer.by,
    ...(answer.note !== undefined ? { note: answer.note } : {}),
    ...(answer.photoIds !== undefined ? { photoIds: answer.photoIds } : {}),
    ...(answer.equipmentId !== undefined ? { equipmentId: answer.equipmentId } : {}),
  };
}

function explainAssessment(refusal: insp.AssessmentRefusal): string {
  switch (refusal.reason) {
    case "invalid_template":
      return insp.explainTemplateProblems(refusal.problems);
    case "unknown_item":
      /**
       * The template changed under a technician who was offline, and the
       * work they did recording it is real. Naming the items is what lets
       * somebody put it somewhere rather than lose it.
       */
      return `This inspection answers items the programme no longer has: ${refusal.detail.join(", ")}. `
        + "The programme was revised after the work started. Those answers are still real, so they are "
        + "refused rather than dropped.";
    case "wrong_answer_kind":
      return `The wrong kind of answer was recorded for ${refusal.detail.join(", ")}.`;
  }
}

/**
 * Core's outcome, in the database's words.
 *
 * `incomplete` maps to `partial` rather than to `fail`, because they are
 * different facts and a compliance file needs to tell them apart: a failed
 * inspection says the thing is wrong, and a partial one says nobody has
 * finished looking.
 */
function toResult(assessment: insp.InspectionAssessment) {
  switch (assessment.outcome) {
    case "passed": return "pass" as const;
    case "passed_with_recommendations": return "pass_with_deficiencies" as const;
    case "failed": return "fail" as const;
    case "incomplete": return "partial" as const;
  }
}

function deadlineFor(severity: insp.Severity, from: string): string | null {
  const within = insp.SEVERITY[severity].respondWithinDays;
  return within === null ? null : shiftDays(from, within);
}

/* --------------------------------------------------------------- backlog */

/**
 * Everything found and not yet put right, worst and most overdue first.
 *
 * The ageing comes from core, against a `now` that is a parameter there for
 * a reason: a backlog report has to be reproducible, and one measured against
 * whenever it happened to run says something different every time it is run
 * for the same month end.
 */
export async function backlog(
  ctx: ServiceContext,
  input: { propertyId?: string; customerId?: string; includeSettled?: boolean; now?: Date } = {},
) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const now = input.now ?? new Date();
    /** For a fault with no found date, the company's day it was written down. */
    const zone = await timezoneOf(tx, ctx.actor.organizationId);

    const rows = await tx.select({
      deficiency: schema.deficiency,
      line1: schema.property.addressLine1,
      city: schema.property.city,
      customerName: schema.customer.name,
    }).from(schema.deficiency)
      .innerJoin(schema.property, eq(schema.property.id, schema.deficiency.propertyId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.deficiency.customerId))
      .where(and(
        eq(schema.deficiency.organizationId, ctx.actor.organizationId),
        ...(input.propertyId ? [eq(schema.deficiency.propertyId, input.propertyId)] : []),
        ...(input.customerId ? [eq(schema.deficiency.customerId, input.customerId)] : []),
        /**
         * Settled states are excluded in SQL, not after the fetch. Filtering
         * afterwards applies the limit first, so a company with five hundred
         * corrected faults would page through finished work and see an empty
         * backlog.
         */
        ...(input.includeSettled
          ? []
          : [sql`${schema.deficiency.status} not in ('corrected', 'declined', 'void')`]),
      ))
      .orderBy(desc(schema.deficiency.severity), asc(schema.deficiency.foundOn));

    return rows.map(({ deficiency, line1, city, customerName }) => {
      const severity = TO_CORE[deficiency.severity] ?? "wear";
      const standing = insp.backlogStanding({
        itemKey: deficiency.checkpointKey ?? deficiency.id,
        severity,
        foundAt: new Date(`${deficiency.foundOn ?? time.dateIn(deficiency.createdAt, zone)}T00:00:00Z`),
      }, now);

      return {
        id: deficiency.id,
        status: deficiency.status,
        severity,
        /** The database's word too, because an authority's form asks for it. */
        recordedSeverity: deficiency.severity,
        description: deficiency.description,
        recommendedAction: deficiency.recommendedAction,
        equipmentId: deficiency.equipmentId,
        customerName,
        address: [line1, city].filter(Boolean).join(", "),
        foundOn: deficiency.foundOn,
        correctByOn: deficiency.correctByOn,
        ageDays: standing.ageDays,
        overdue: standing.overdue,
        /** The quote it became, once somebody quoted it. */
        estimateId: deficiency.estimateId,
        /** Whether the checkpoint declared a repair, so quoting it needs no typed price. */
        hasRemedy: deficiency.remedies.length > 0,
        /** Core's sentence. For the list, not for a chart. */
        statement: standing.statement,
      };
    }).sort((a, b) =>
      Number(b.overdue) - Number(a.overdue)
      || insp.compareSeverity(a.severity, b.severity)
      || b.ageDays - a.ageDays);
  });
}

/**
 * Move a finding along.
 *
 * The states that END it need a reason, and declining needs one most of all:
 * a customer who declined a safety finding is the single sentence somebody
 * will want in writing later, and a blank there is the record that was not
 * kept.
 */
export async function setDeficiencyStatus(
  ctx: ServiceContext,
  input: {
    id: string;
    status: "open" | "quoted" | "approved" | "scheduled" | "corrected" | "declined" | "deferred" | "void";
    reason?: string;
    /** Why the customer said no, as a code, with `declined` only. */
    declineCode?: insp.DeclineCode;
    jobId?: string | null;
    on?: string;
  },
) {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    if (input.declineCode !== undefined && input.status !== "declined") {
      throw new ConflictError("Why the customer said no goes with declining the finding.");
    }
    const [before] = await tx.select().from(schema.deficiency)
      .where(and(
        eq(schema.deficiency.id, input.id),
        eq(schema.deficiency.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!before) throw new NotFoundError("Deficiency");

    if (before.status === "corrected" && input.status !== "corrected") {
      throw new ConflictError(
        "That finding is already corrected. Reopening it would say the repair did not happen; "
        + "record a new finding instead.",
      );
    }

    /**
     * A code says why in a word the figures can read, and is the reason in
     * words when none are given: "Already booked with another company" is
     * the sentence somebody wants in writing, as much as a typed one.
     */
    const reason = input.reason?.trim()
      || (input.status === "declined" && input.declineCode ? insp.DECLINE_CODE_WORDS[input.declineCode] : null);
    if ((input.status === "declined" || input.status === "void") && !reason) {
      throw new ConflictError(
        `A ${input.status} finding needs a reason. A customer who declined a safety finding is the `
        + "sentence somebody wants in writing later.",
      );
    }

    const on = input.on ?? time.dateIn(new Date(), await timezoneOf(tx, ctx.actor.organizationId));

    const [after] = await tx.update(schema.deficiency).set({
      status: input.status,
      ...(input.status === "corrected"
        ? { correctedOn: on, correctedByJobId: input.jobId ?? before.correctedByJobId }
        : {}),
      ...(input.status === "declined" ? { declinedOn: on, declineReason: reason, declineCode: input.declineCode ?? null } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.deficiency.id, input.id)).returning();

    await audit(tx, ctx, "deficiency.status", "deficiency", input.id,
      { status: before.status }, { status: input.status, reason, ...(input.declineCode ? { declineCode: input.declineCode } : {}) });

    return { id: input.id, status: after!.status };
  });
}

/**
 * What the open findings at a property would be quoted as.
 *
 * `proposeWork` refuses a finding with no observation and a remedy with no
 * rationale, which is the property this whole module exists to have: a price
 * with a story and no evidence is the artefact it is built to make
 * impossible. The refusal names the findings so somebody can go and attach
 * the photo or the reading they took.
 */
export async function proposal(ctx: ServiceContext, input: { propertyId: string }) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const rows = await tx.select().from(schema.deficiency)
      .where(and(
        eq(schema.deficiency.organizationId, ctx.actor.organizationId),
        eq(schema.deficiency.propertyId, input.propertyId),
        inArray(schema.deficiency.status, ["open", "deferred"]),
      ));

    if (rows.length === 0) {
      return { ok: false as const, reason: "nothing_to_propose" as const, detail: "Nothing open here." };
    }

    return insp.proposeWork(rows.map((row) => ({
      itemKey: row.checkpointKey ?? row.id,
      severity: TO_CORE[row.severity] ?? "wear",
      summary: row.description,
      /**
       * The observation the technician recorded, read back off the row. A
       * finding with none is refused by core rather than priced, and the
       * refusal is the feature: the office finds out before the customer
       * does, and the answer is to go and attach the photo.
       *
       * Findings entered by hand, and every finding written before the
       * column existed, have none. Those come back in the refusal by name,
       * which is exactly right: they are prices with no evidence.
       */
      ...(row.observation
        ? {
            observation: {
              itemKey: row.observation.itemKey,
              prompt: row.observation.prompt,
              recorded: row.observation.recorded,
              at: new Date(row.observation.at),
              by: row.observation.by,
              photoIds: row.observation.photoIds,
            },
          }
        : {}),
      remedies: row.remedies,
      ...(row.code ? { codeReference: row.code } : {}),
    })));
  });
}

/* ------------------------------------------------------------ the report */

export interface ReportItem {
  key: string;
  prompt: string;
  kind: "pass_fail" | "reading";
  unit: string | null;
  /** "350 to 450 psi", for a reading. */
  range: string | null;
  /** What was recorded, as words: "Pass", "412 psi", "Not applicable: no meter on site". */
  answer: string | null;
  /**
   * What it came to. `finding` carries a severity; `borderline` is a reading
   * inside its range and near the edge of it, which is NOT a failure.
   */
  verdict: "pass" | "borderline" | "finding" | "not_applicable" | "not_answered";
  severity: string | null;
  note: string | null;
  by: string | null;
  at: string | null;
  equipmentId: string | null;
  photos: { id: string; storageKey: string | null }[];
}

export interface InspectionReport {
  id: string;
  organizationName: string;
  program: {
    id: string | null; name: string; standard: string | null; reportAudience: string;
    authorityName: string | null; version: number | null;
  };
  customer: { id: string; name: string };
  property: { id: string; address: string };
  performedOn: string | null;
  result: string | null;
  statement: string | null;
  inspectorName: string | null;
  inspectorLicense: string | null;
  nextDueOn: string | null;
  submittedAt: Date | null;
  submissionReference: string | null;
  items: ReportItem[];
  deficiencies: {
    id: string; severity: insp.Severity; label: string; recordedSeverity: string; description: string;
    code: string | null; correctByOn: string | null; status: string; estimateId: string | null;
  }[];
  signature: { name: string; at: Date | null; storageKey: string | null } | null;
  /**
   * False for an inspection filed before its checkpoints were kept with it.
   * Its prompts then come from the programme as it is now, and the report
   * says so rather than passing them off as what was asked.
   */
  checkpointsKept: boolean;
}

/**
 * THE INSPECTION REPORT, FROM THE DATA HELD.
 *
 * Every checkpoint as it was asked, what was recorded against it, the range
 * a reading was judged against and what it came to, the findings with their
 * severity, code and correction date, the photographs, the inspector and
 * their licence, the signature, and when it is next due. The same document
 * whoever reads it; a programme whose report goes to an authority prints the
 * authority's name and the standard at the top, because that is the reader
 * the report is for.
 *
 * Rendered from the checkpoints and answers frozen on the inspection, so a
 * report reprinted after the programme was revised still says what was
 * asked. Each item's verdict is core's assessment again, not a word stored
 * at filing, so the report and the backlog cannot disagree about a reading.
 *
 * WHAT IT IS NOT: an authority's own form. A fire marshal's office that
 * insists on its form gets the same facts copied onto it; there is no per
 * authority formatter, and the module doc says so.
 */
export async function report(ctx: ServiceContext, input: { id: string }): Promise<InspectionReport> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const [row] = await tx.select().from(schema.inspection)
      .where(and(eq(schema.inspection.id, input.id), eq(schema.inspection.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("Inspection");

    const [current] = row.programId
      ? await tx.select().from(schema.inspectionProgram).where(eq(schema.inspectionProgram.id, row.programId)).limit(1)
      : [];
    /**
     * The programme as it read at the version the inspection was done under:
     * its name, standard and authority at the top of the report, not
     * whatever somebody has since revised them to. The programme as it is now
     * only when that version was never kept.
     */
    const asDone = current && row.programVersion !== null
      ? await contentAt(tx, current, row.programVersion)
      : null;
    const program = current ? { id: current.id, ...(asDone ?? contentOf(current)) } : undefined;
    const checkpoints = row.checkpoints ?? program?.checkpoints ?? [];
    const template = templateFor({ name: program?.name ?? "", standard: program?.standard ?? null, checkpoints });
    const answers = row.answers ?? [];
    const assessment = insp.assessInspection(template, answers.map(toRecorded));

    const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    const [customer] = await tx.select({ id: schema.customer.id, name: schema.customer.name })
      .from(schema.customer).where(eq(schema.customer.id, row.customerId)).limit(1);
    const [property] = await tx.select().from(schema.property).where(eq(schema.property.id, row.propertyId)).limit(1);
    const deficiencies = await tx.select().from(schema.deficiency)
      .where(eq(schema.deficiency.inspectionId, row.id));

    const photoIds = [...new Set(answers.flatMap((a) => [
      ...(a.photoIds ?? []),
      ...(a.value.kind === "photo" && Array.isArray(a.value["photoIds"]) ? a.value["photoIds"] as string[] : []),
    ]))];
    const signatureIds = row.signatureUploadId ? [row.signatureUploadId] : [];
    const uploads = photoIds.length + signatureIds.length === 0 ? [] : await tx.select({
      clientId: schema.fieldUpload.clientId, storageKey: schema.fieldUpload.storageKey,
    }).from(schema.fieldUpload).where(inArray(schema.fieldUpload.clientId, [...photoIds, ...signatureIds]));
    const stored = new Map(uploads.map((u) => [u.clientId, u.storageKey]));

    const findings = assessment.ok ? new Map(assessment.deficiencies.map((d) => [d.itemKey, d])) : new Map();
    const notApplicable = new Set(assessment.ok ? assessment.notApplicable : []);
    const unanswered = new Set(assessment.ok ? [...assessment.unanswered, ...assessment.optionalSkipped] : []);
    const byKey = new Map(answers.map((a) => [a.itemKey, a]));

    const items: ReportItem[] = checkpoints.map((checkpoint) => {
      const answer = byKey.get(checkpoint.key);
      const reading = checkpoint.requiresReading === true;
      const finding = findings.get(checkpoint.key) as insp.Deficiency | undefined;
      const value = answer?.value;
      let verdict: ReportItem["verdict"] = "pass";
      if (notApplicable.has(checkpoint.key)) verdict = "not_applicable";
      else if (unanswered.has(checkpoint.key) || !answer) verdict = "not_answered";
      else if (finding && insp.SEVERITY[finding.severity].failsInspection) verdict = "finding";
      else if (finding && reading) verdict = "borderline";
      else if (finding) verdict = "finding";
      return {
        key: checkpoint.key,
        prompt: checkpoint.label,
        kind: reading ? "reading" : "pass_fail",
        unit: checkpoint.unit ?? null,
        range: reading && checkpoint.range ? insp.describeRange(checkpoint.range, checkpoint.unit ?? "") : null,
        answer: value ? describeAnswer(value, checkpoint.unit ?? null) : null,
        verdict,
        severity: finding ? insp.SEVERITY[finding.severity].label : null,
        note: answer?.note ?? null,
        by: answer?.by ?? null,
        at: answer?.at ?? null,
        equipmentId: answer?.equipmentId ?? null,
        photos: [
          ...(answer?.photoIds ?? []),
          ...(value?.kind === "photo" && Array.isArray(value["photoIds"]) ? value["photoIds"] as string[] : []),
        ].map((id) => ({ id, storageKey: stored.get(id) ?? null })),
      };
    });

    return {
      id: row.id,
      organizationName: org?.name ?? "",
      program: {
        id: program?.id ?? null,
        name: program?.name ?? "Inspection",
        standard: program?.standard ?? null,
        reportAudience: program?.reportAudience ?? "customer",
        authorityName: program?.authorityName ?? null,
        version: row.programVersion,
      },
      customer: { id: row.customerId, name: customer?.name ?? "" },
      property: {
        id: row.propertyId,
        address: property
          ? [property.addressLine1, property.city, [property.state, property.postalCode].filter(Boolean).join(" ")]
            .filter(Boolean).join(", ")
          : "",
      },
      performedOn: row.performedOn,
      result: row.result,
      statement: row.statement ?? (assessment.ok ? assessment.statement : null),
      inspectorName: row.inspectorName,
      inspectorLicense: row.inspectorLicense,
      nextDueOn: row.nextDueOn,
      submittedAt: row.submittedAt,
      submissionReference: row.submissionReference,
      items,
      deficiencies: deficiencies.map((d) => {
        const severity = TO_CORE[d.severity] ?? "wear";
        return {
          id: d.id, severity, label: insp.SEVERITY[severity].label, recordedSeverity: d.severity,
          description: d.description, code: d.code, correctByOn: d.correctByOn, status: d.status,
          estimateId: d.estimateId,
        };
      }).sort((a, b) => insp.compareSeverity(a.severity, b.severity)),
      signature: row.signedByName
        ? { name: row.signedByName, at: row.signedAt, storageKey: row.signatureUploadId ? stored.get(row.signatureUploadId) ?? null : null }
        : null,
      checkpointsKept: row.checkpoints !== null,
    };
  });
}

/** An answer as the report prints it. */
function describeAnswer(value: Record<string, unknown> & { kind: string }, unit: string | null): string {
  switch (value.kind) {
    case "pass_fail": return value["passed"] === true ? "Pass" : "Fail";
    case "reading": return value["raw"] === null || value["raw"] === undefined || value["raw"] === ""
      ? "No reading" : `${String(value["raw"])}${unit ? ` ${unit}` : ""}`;
    case "note": return String(value["text"] ?? "");
    case "count": return String(value["count"] ?? "");
    case "photo": {
      const count = Array.isArray(value["photoIds"]) ? value["photoIds"].length : 0;
      return `${count} ${count === 1 ? "photo" : "photos"}`;
    }
    case "not_applicable": return `Not applicable: ${String(value["why"] ?? "")}`;
    default: return "";
  }
}

/** Inspections filed, newest first, for the list beside the backlog. */
export async function recent(
  ctx: ServiceContext, input: { propertyId?: string | undefined; visitId?: string | undefined; limit?: number | undefined } = {},
) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const rows = await tx.select({
      inspection: schema.inspection,
      programName: schema.inspectionProgram.name,
      customerName: schema.customer.name,
      line1: schema.property.addressLine1,
      city: schema.property.city,
    }).from(schema.inspection)
      .leftJoin(schema.inspectionProgram, eq(schema.inspectionProgram.id, schema.inspection.programId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.inspection.customerId))
      .innerJoin(schema.property, eq(schema.property.id, schema.inspection.propertyId))
      .where(and(
        eq(schema.inspection.organizationId, ctx.actor.organizationId),
        ...(input.propertyId ? [eq(schema.inspection.propertyId, input.propertyId)] : []),
        ...(input.visitId ? [eq(schema.inspection.visitId, input.visitId)] : []),
      ))
      .orderBy(desc(schema.inspection.performedOn), desc(schema.inspection.createdAt))
      .limit(input.limit ?? 50);
    return rows.map((r) => ({
      id: r.inspection.id,
      programName: r.programName ?? "Inspection",
      performedOn: r.inspection.performedOn,
      result: r.inspection.result,
      customerName: r.customerName,
      address: [r.line1, r.city].filter(Boolean).join(", "),
      visitId: r.inspection.visitId,
      nextDueOn: r.inspection.nextDueOn,
    }));
  });
}

/* ---------------------------------------------------------- one action quote */

/**
 * TURN ONE FINDING INTO A QUOTE, IN ONE ACTION.
 *
 * The remedies the checkpoint declared, frozen on the finding, become the
 * lines of a new estimate for the customer at that property, priced from
 * the contractor's own price book by item code through the estimate
 * service's own pricing. The evidence goes with it: what was seen, by whom
 * and when, and why each line follows from it, in the option's description
 * the customer reads. The finding moves to quoted with the estimate and the
 * amount on it, so the backlog shows it is in front of the customer.
 *
 * REFUSED, in words, when:
 *
 *   The finding has no observation. Core's proposal builder refuses a price
 *   with no evidence, and that refusal is the reason the module exists.
 *
 *   A remedy names a price book code this company does not have. The quote
 *   would be missing the line that fixes the problem.
 *
 *   The checkpoint declared no remedy and no price was given. There is then
 *   nothing to price; give the price for correcting it and that becomes the
 *   line.
 *
 * A finding already quoted returns its estimate rather than writing a
 * second, which is what makes the button safe to press twice.
 */
export async function quoteDeficiency(
  ctx: ServiceContext, input: { id: string; price?: string | null | undefined },
): Promise<{ deficiencyId: string; estimateId: string; amount: string | null; created: boolean }> {
  assertCan(ctx.actor, "estimate:write");
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const [row] = await tx.select().from(schema.deficiency)
      .where(and(eq(schema.deficiency.id, input.id), eq(schema.deficiency.organizationId, ctx.actor.organizationId)))
      .limit(1);
    if (!row) throw new NotFoundError("Deficiency");
    if (row.estimateId) {
      return { deficiencyId: row.id, estimateId: row.estimateId, amount: row.quotedAmount, created: false };
    }
    if (row.status !== "open" && row.status !== "deferred") {
      throw new ConflictError(`That finding is ${row.status}, so there is nothing to quote.`);
    }

    const proposal = insp.proposeWork([{
      itemKey: row.checkpointKey ?? row.id,
      severity: TO_CORE[row.severity] ?? "wear",
      summary: row.description,
      ...(row.observation ? {
        observation: {
          itemKey: row.observation.itemKey, prompt: row.observation.prompt,
          recorded: row.observation.recorded, at: new Date(row.observation.at),
          by: row.observation.by, photoIds: row.observation.photoIds,
        },
      } : {}),
      remedies: row.remedies,
      ...(row.code ? { codeReference: row.code } : {}),
    }]);
    if (!proposal.ok) {
      throw new ConflictError(
        proposal.reason === "unobserved_deficiency"
          ? "This finding has no observation behind it: no reading, no note, no photo. A price with no evidence is "
            + "the one thing this will not write. Record what was seen first."
          : proposal.reason === "unjustified_remedy"
            ? `A repair on this finding's checkpoint cannot be priced: ${proposal.detail.join(" ")}`
            : String(proposal.detail),
      );
    }

    const lines = proposal.groups.flatMap((g) => g.lines);
    const codes = [...new Set(lines.map((l) => l.priceBookItemKey))];
    const items = codes.length === 0 ? [] : await tx.select({ id: schema.priceBookItem.id, code: schema.priceBookItem.code })
      .from(schema.priceBookItem)
      .where(and(eq(schema.priceBookItem.organizationId, ctx.actor.organizationId), inArray(schema.priceBookItem.code, codes)));
    const byCode = new Map(items.map((i) => [i.code, i.id]));
    const missing = codes.filter((code) => !byCode.has(code));
    if (missing.length > 0) {
      throw new ConflictError(
        `The repair for this finding names ${missing.join(", ")}, which ${missing.length === 1 ? "is" : "are"} not in your price book. `
        + "Add the item, or correct the code on the programme, so the quote has the line that fixes the problem.",
      );
    }

    const estimateLines: { priceBookItemId?: string; name: string; description?: string; quantity: string; unitPrice: string;
      discountAmount: string; taxable: boolean; isOptional: boolean; isSelected: boolean }[] =
      lines.map((line) => ({
        priceBookItemId: byCode.get(line.priceBookItemKey)!,
        name: line.label,
        description: line.rationale,
        quantity: String(line.quantity),
        unitPrice: "0",
        discountAmount: "0",
        taxable: true,
        isOptional: false,
        isSelected: false,
      }));
    if (estimateLines.length === 0) {
      if (input.price === undefined || input.price === null || input.price === "") {
        throw new ConflictError(
          "No repair is declared on this finding's checkpoint, so there is nothing to price it from. "
          + "Give the price for correcting it and that becomes the line.",
        );
      }
      const price = String(input.price).trim();
      if (!/^\d+(\.\d{1,4})?$/.test(price)) throw new ConflictError(`${input.price} is not an amount of money.`);
      estimateLines.push({
        name: `Correct: ${row.description}`, quantity: "1", unitPrice: price,
        discountAmount: "0", taxable: true, isOptional: false, isSelected: false,
      });
    }

    const evidence = row.observation
      ? `Found ${row.foundOn ?? row.observation.at.slice(0, 10)} by ${row.observation.by}: ${row.observation.recorded}`
      : row.description;
    const estimate = await estimates.create({ ...ctx, db: tx, idempotencyKey: `deficiency-quote:${row.id}` }, {
      customerId: row.customerId,
      propertyId: row.propertyId,
      title: `Correct: ${row.description}`.slice(0, 200),
        options: [{
        name: insp.SEVERITY[TO_CORE[row.severity] ?? "wear"].heading.slice(0, 100),
        description: [evidence, row.code ? `Code reference: ${row.code}.` : null].filter(Boolean).join(" ").slice(0, 2000),
        isRecommended: true,
        lines: estimateLines,
      }],
    });
    const total = estimate.options[0]?.total ?? null;

    await tx.update(schema.deficiency).set({
      status: "quoted", estimateId: estimate.id, quotedAmount: total, updatedAt: new Date(),
    }).where(eq(schema.deficiency.id, row.id));
    await audit(tx, ctx, "deficiency.quoted", "deficiency", row.id,
      { status: row.status }, { status: "quoted", estimateId: estimate.id, amount: total });
    return { deficiencyId: row.id, estimateId: estimate.id, amount: total, created: true };
  });
}

/* ---------------------------------------------------------------- helpers */

async function loadProgram(tx: Database, organizationId: string, id: string, options: { lock?: boolean } = {}) {
  const query = tx.select().from(schema.inspectionProgram)
    .where(and(
      eq(schema.inspectionProgram.id, id),
      eq(schema.inspectionProgram.organizationId, organizationId),
    )).limit(1);
  const [row] = options.lock ? await query.for("update") : await query;
  if (!row) throw new NotFoundError("Inspection programme");
  return row;
}

const DAY = 86_400_000;
const shiftDays = (date: string, by: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10);

/** Clamped to the end of a short month, same rule as the agreement schedules. */
function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

export const handlers = {
  listInspectionPrograms: async (ctx: ServiceContext, input: { includeRetired?: boolean | undefined } = {}) =>
    ({ programs: await programs(ctx, input) }),
  getInspectionProgram: (ctx: ServiceContext, input: { id: string }) => program(ctx, input),
  getInspectionProgramVersion: (ctx: ServiceContext, input: { id: string; version: number }) => programVersion(ctx, input),
  listTradePackInspectionPrograms: async (ctx: ServiceContext) => ({ programs: await packPrograms(ctx) }),
  defineInspectionProgram: async (ctx: ServiceContext, input: ProgramInput & {
    copiedFrom?: CopySource | undefined; replaces?: string | undefined; note?: string | null | undefined;
  }) => {
    const row = await defineProgram(ctx, input);
    return (await program(ctx, { id: row.id })).program;
  },
  reviseInspectionProgram: async (ctx: ServiceContext, input: ProgramInput & {
    id: string; baseVersion: number; note?: string | null | undefined;
  }) => {
    /**
     * The whole programme as it should now read. Whatever is left out is
     * left out of the new version, so the version is exactly what was sent.
     */
    const row = await reviseProgram(ctx, {
      id: input.id, baseVersion: input.baseVersion, note: input.note ?? null,
      name: input.name, standard: input.standard ?? null, reportAudience: input.reportAudience ?? "customer",
      authorityName: input.authorityName ?? null, frequencyMonths: input.frequencyMonths ?? null,
      checkpoints: input.checkpoints,
    });
    return (await program(ctx, { id: row.id })).program;
  },
  setInspectionProgramOffered: async (ctx: ServiceContext, input: { id: string; offered: boolean }) => {
    const row = await setOffered(ctx, input);
    return { id: row.id, offered: row.active, version: row.version };
  },

  recordInspection: (
    ctx: ServiceContext,
    input: {
      programId: string; programVersion?: number | undefined; propertyId: string; customerId: string;
      answers: {
        itemKey: string;
        /**
         * Spelled out rather than `insp.AnswerValue`, which carries readonly
         * arrays: the contract infers mutable ones and the two are not assignable
         * in that direction. Widening core's type to satisfy a handler would be
         * the wrong end to fix it.
         */
        value:
          | { kind: "pass_fail"; passed: boolean }
          | { kind: "reading"; raw: string | number | null }
          | { kind: "photo"; photoIds: string[] }
          | { kind: "note"; text: string }
          | { kind: "count"; count: number }
          | { kind: "not_applicable"; why: string };
        at: string;
        by: string;
        note?: string | undefined;
        photoIds?: string[] | undefined;
        equipmentId?: string | undefined;
      }[];
      jobId?: string | null | undefined;
      visitId?: string | null | undefined;
      inspectorName?: string | null | undefined;
      inspectorLicense?: string | null | undefined;
      performedOn?: string | undefined;
      signedByName?: string | null | undefined;
    },
  ) => record(ctx, {
    programId: input.programId,
    ...(input.programVersion !== undefined ? { programVersion: input.programVersion } : {}),
    propertyId: input.propertyId,
    customerId: input.customerId,
    /**
     * `at` becomes a Date here and nowhere else.
     *
     * The wire carries an instant as a string because JSON has no date, and core
     * takes a `Date` because it compares them. Parsing at the edge rather than
     * inside the assessment keeps the decision clock-free: core is handed the
     * moment the device recorded, never one this process invented.
     */
    answers: input.answers.map((answer) => ({
      itemKey: answer.itemKey,
      value: answer.value,
      at: new Date(answer.at),
      by: answer.by,
      ...(answer.note !== undefined ? { note: answer.note } : {}),
      ...(answer.photoIds !== undefined ? { photoIds: answer.photoIds } : {}),
      ...(answer.equipmentId !== undefined ? { equipmentId: answer.equipmentId } : {}),
    })),
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    ...(input.visitId !== undefined ? { visitId: input.visitId } : {}),
    ...(input.inspectorName !== undefined ? { inspectorName: input.inspectorName } : {}),
    ...(input.inspectorLicense !== undefined ? { inspectorLicense: input.inspectorLicense } : {}),
    ...(input.performedOn !== undefined ? { performedOn: input.performedOn } : {}),
    ...(input.signedByName !== undefined ? { signedByName: input.signedByName } : {}),
  }),

  listDeficiencies: async (
    ctx: ServiceContext,
    input: {
      propertyId?: string | undefined; customerId?: string | undefined;
      includeSettled?: boolean | undefined; now?: string | undefined;
    },
  ) => ({
    deficiencies: await backlog(ctx, {
      ...(input.propertyId !== undefined ? { propertyId: input.propertyId } : {}),
      ...(input.customerId !== undefined ? { customerId: input.customerId } : {}),
      ...(input.includeSettled !== undefined ? { includeSettled: input.includeSettled } : {}),
      ...(input.now !== undefined ? { now: new Date(input.now) } : {}),
    }),
  }),

  getInspectionReport: (ctx: ServiceContext, input: { id: string }) => report(ctx, input),
  listInspections: async (ctx: ServiceContext, input: { propertyId?: string | undefined; limit?: number | undefined }) =>
    ({ inspections: await recent(ctx, input) }),
  quoteDeficiency: (ctx: ServiceContext, input: { id: string; price?: string | null | undefined }) =>
    quoteDeficiency(ctx, input),

  setDeficiencyStatus: (
    ctx: ServiceContext,
    input: {
      id: string;
      status: "open" | "quoted" | "approved" | "scheduled" | "corrected" | "declined" | "deferred" | "void";
      reason?: string | undefined;
      declineCode?: insp.DeclineCode | undefined;
      jobId?: string | null | undefined;
      on?: string | undefined;
    },
  ) => setDeficiencyStatus(ctx, {
    id: input.id,
    status: input.status,
    ...(input.reason !== undefined ? { reason: input.reason } : {}),
    ...(input.declineCode !== undefined ? { declineCode: input.declineCode } : {}),
    ...(input.jobId !== undefined ? { jobId: input.jobId } : {}),
    ...(input.on !== undefined ? { on: input.on } : {}),
  }),
} as const;
