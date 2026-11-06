import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { packById, type TradePack } from "@opentradesos/trade-packs";
import { audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext } from "./context";

/**
 * THE TRADE PACK'S MARKS, GIVEN BY HAND
 *
 * Two scorecard numbers turn on which job types and items are which:
 * electrical's troubleshooting conversion (`diag_conversion`) needs to know
 * which job type is a troubleshooting call and which items are the charge for
 * finding the fault, and plumbing's drain conversion (`drain_conversion`)
 * which job type is a drain call and which items are the camera inspection,
 * the lining or the excavation it can turn into. The pack marks its own
 * (`marks` in its seed), matched by the codes it seeded. A job type or an item
 * the company made under another code was not counted at all.
 *
 * Here the company marks its own by hand (`pack_marks` on `job_type` and
 * `price_book_item`), and the scorecard reads a hand mark exactly as it reads
 * the pack's (`kpi-catalogue.ts`, `typeMarked` and `itemMarked`). A code the
 * pack seeded and marked stays marked by the pack: a hand mark only ever adds,
 * so a company cannot quietly take the pack's own call out of its number.
 *
 * Only marks a number on the company's own scorecard reads are offered and
 * accepted: a drain mark on an electrical company's job type would change
 * nothing anybody sees, which is worse than refusing it.
 *
 * Read with `report:read`, as the scorecard is; changed with
 * `settings:write`, as applying the trade pack is, and audited.
 */

export type JobTypeMark = "troubleshooting" | "drain";
export type ItemMark = "troubleshooting" | "drain_upsell";

const JOB_TYPE_MARKS: readonly JobTypeMark[] = ["troubleshooting", "drain"];
const ITEM_MARKS: readonly ItemMark[] = ["troubleshooting", "drain_upsell"];

/** Which scorecard number reads each mark, and what it means in words. */
export const MARKS: Record<JobTypeMark | ItemMark, { kpi: string; number: string; jobType: string; item: string }> = {
  troubleshooting: {
    kpi: "diag_conversion",
    number: "Troubleshooting conversion",
    jobType: "a troubleshooting call",
    item: "a charge for finding the fault, so it is not counted as repair work",
  },
  drain: { kpi: "drain_conversion", number: "Drain call conversion", jobType: "a drain call", item: "" },
  drain_upsell: {
    kpi: "drain_conversion",
    number: "Drain call conversion",
    jobType: "",
    item: "a camera inspection, a lining or an excavation a drain call can turn into",
  },
};

async function packOf(tx: Database, organizationId: string): Promise<TradePack | null> {
  const [org] = await tx.select({ primaryTrade: schema.organization.primaryTrade })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  return org?.primaryTrade ? packById(org.primaryTrade) ?? null : null;
}

/** The marks a number on this pack's scorecard reads. */
const offeredBy = <M extends JobTypeMark | ItemMark>(pack: TradePack | null, marks: readonly M[]): M[] =>
  pack ? marks.filter((m) => pack.kpis.some((k) => k.key === MARKS[m].kpi)) : [];

export interface MarkedRow {
  id: string;
  name: string;
  code: string | null;
  /** Marked by the trade pack, through the code it seeded. Not changed here. */
  fromPack: string[];
  /** Marked here by hand. */
  byHand: string[];
}

export interface MarksView {
  /** The company's trade pack, or null when it has chosen none. */
  tradePack: string | null;
  /** The marks a number on its scorecard reads, for job types and for items. */
  offered: { jobType: JobTypeMark[]; item: ItemMark[] };
  /** What each offered mark means and which number reads it. */
  meanings: { mark: string; number: string; jobType: string; item: string }[];
  jobTypes: MarkedRow[];
  items: MarkedRow[];
}

/** The company's job types and items with their marks, the pack's and its own, for the screen. */
export async function list(ctx: ServiceContext): Promise<MarksView> {
  return guardedRead(ctx, "report:read", async (tx) => {
    const pack = await packOf(tx, ctx.actor.organizationId);
    const offered = { jobType: offeredBy(pack, JOB_TYPE_MARKS), item: offeredBy(pack, ITEM_MARKS) };
    const packTypeMarks = new Map((pack?.jobTypes ?? []).map((t) => [t.code, (t.marks ?? []) as string[]]));
    const packItemMarks = new Map((pack?.priceBook ?? []).map((i) => [i.code, (i.marks ?? []) as string[]]));
    const types = await tx.select({
      id: schema.jobType.id, name: schema.jobType.name, code: schema.jobType.code, packMarks: schema.jobType.packMarks,
    }).from(schema.jobType)
      .where(and(eq(schema.jobType.organizationId, ctx.actor.organizationId), eq(schema.jobType.active, true)))
      .orderBy(asc(schema.jobType.name));
    const items = await tx.select({
      id: schema.priceBookItem.id, code: schema.priceBookItem.code, packMarks: schema.priceBookItem.packMarks,
      name: schema.priceBookItemVersion.name,
    }).from(schema.priceBookItem)
      .innerJoin(schema.priceBookItemVersion, eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id))
      .where(and(
        eq(schema.priceBookItem.organizationId, ctx.actor.organizationId),
        eq(schema.priceBookItem.active, true),
        isNull(schema.priceBookItemVersion.effectiveTo),
      ))
      .orderBy(asc(schema.priceBookItemVersion.name), asc(schema.priceBookItemVersion.version));
    /** One row an item, its latest open version's name. */
    const latest = new Map(items.map((i) => [i.id, i]));
    const meant = [...new Set([...offered.jobType, ...offered.item])];
    return {
      tradePack: pack?.id ?? null,
      offered,
      meanings: meant.map((m) => ({ mark: m, ...MARKS[m] })),
      jobTypes: types.map((t) => ({
        id: t.id, name: t.name, code: t.code,
        fromPack: t.code ? (packTypeMarks.get(t.code) ?? []).filter((m) => (offered.jobType as string[]).includes(m)) : [],
        byHand: t.packMarks.filter((m) => (offered.jobType as string[]).includes(m)),
      })),
      items: [...latest.values()].sort((a, b) => a.name.localeCompare(b.name)).map((i) => ({
        id: i.id, name: i.name, code: i.code,
        fromPack: (packItemMarks.get(i.code) ?? []).filter((m) => (offered.item as string[]).includes(m)),
        byHand: i.packMarks.filter((m) => (offered.item as string[]).includes(m)),
      })),
    };
  });
}

/** The marks sent, checked against what the company's scorecard reads, each once. */
function checked<M extends string>(marks: readonly string[], allowed: readonly M[], offered: readonly M[], what: string): M[] {
  const out: M[] = [];
  for (const mark of marks) {
    if (!(allowed as readonly string[]).includes(mark)) {
      throw new ConflictError(`${mark} is not a mark ${what} can have. It can be ${allowed.join(" or ")}.`);
    }
    if (!(offered as readonly string[]).includes(mark)) {
      throw new ConflictError(
        `No number on your trade's scorecard reads ${MARKS[mark as JobTypeMark | ItemMark].jobType || MARKS[mark as JobTypeMark | ItemMark].item}, `
        + "so marking it would change nothing.",
      );
    }
    if (!out.includes(mark as M)) out.push(mark as M);
  }
  return out;
}

/** A job type's hand marks, the whole list replaced. Empty takes them off. */
export async function setJobTypeMarks(ctx: ServiceContext, input: { id: string; marks: string[] }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [before] = await tx.select().from(schema.jobType)
      .where(and(eq(schema.jobType.id, input.id), eq(schema.jobType.organizationId, ctx.actor.organizationId))).limit(1);
    if (!before) throw new NotFoundError("Job type");
    const pack = await packOf(tx, ctx.actor.organizationId);
    const marks = checked(input.marks, JOB_TYPE_MARKS, offeredBy(pack, JOB_TYPE_MARKS), "a job type");
    await tx.update(schema.jobType).set({ packMarks: marks }).where(eq(schema.jobType.id, before.id));
    await audit(tx, ctx, "job_type.pack_marks_set", "job_type", before.id, { packMarks: before.packMarks }, { packMarks: marks });
    return { id: before.id, marks };
  });
}

/** An item's hand marks, the whole list replaced. Empty takes them off. No price changes. */
export async function setItemMarks(ctx: ServiceContext, input: { id: string; marks: string[] }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [before] = await tx.select().from(schema.priceBookItem)
      .where(and(eq(schema.priceBookItem.id, input.id), eq(schema.priceBookItem.organizationId, ctx.actor.organizationId))).limit(1);
    if (!before) throw new NotFoundError("Price book item");
    const pack = await packOf(tx, ctx.actor.organizationId);
    const marks = checked(input.marks, ITEM_MARKS, offeredBy(pack, ITEM_MARKS), "an item");
    await tx.update(schema.priceBookItem).set({ packMarks: marks }).where(eq(schema.priceBookItem.id, before.id));
    await audit(tx, ctx, "price_book_item.pack_marks_set", "price_book_item", before.id, { packMarks: before.packMarks }, { packMarks: marks });
    return { id: before.id, marks };
  });
}

export const handlers = {
  listTradePackMarks: (ctx: ServiceContext) => list(ctx),
  setJobTypePackMarks: (ctx: ServiceContext, input: { id: string; marks: string[] }) => setJobTypeMarks(ctx, input),
  setPriceBookItemPackMarks: (ctx: ServiceContext, input: { id: string; marks: string[] }) => setItemMarks(ctx, input),
} as const;
