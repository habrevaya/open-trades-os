import { createHash } from "node:crypto";
import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, externalWork as ew, money as m, rates } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { assertClient, viewOne } from "./external-work";
import * as jobs from "./jobs";
import * as rateCards from "./rate-cards";
import { costPerUseUnit, inForceAt } from "./pricebook";
import { remember, replayed } from "./once";

/**
 * A CLIENT'S OWN CODES BECOME JOB LINES AND PRICES
 *
 * A facilities client writes its own codes on every work order. The office keeps
 * one list per client of what each code means here (a kind of work, a price book
 * item and how many), and accepting an order PROPOSES the job from it: the job
 * type, a line per mapped item priced the way the client's card will price it,
 * and every code nobody mapped named in words.
 *
 * NEVER SILENTLY. The proposal is a read. Making the job is a separate call that
 * carries the proposal's key, so a list changed between looking and pressing is
 * refused with "look again" rather than making a job nobody saw. Accepting by
 * hand, with or without a job id, is untouched (`external-work.ts` `move`).
 */

const usd = (value: string) => m.money(value, "USD");

/* ------------------------------------------------------------ the list */

export interface CodeRowInput {
  code: string;
  description?: string | null | undefined;
  jobTypeId?: string | null | undefined;
  priceBookItemId?: string | null | undefined;
  quantity?: string | undefined;
}

async function rowsOf(tx: Database, ctx: ServiceContext, customerId: string) {
  const rows = await tx.select({
    row: schema.clientWorkCode,
    jobTypeName: schema.jobType.name,
    jobTypeActive: schema.jobType.active,
    itemCode: schema.priceBookItem.code,
    itemActive: schema.priceBookItem.active,
    itemDeleted: schema.priceBookItem.deletedAt,
  }).from(schema.clientWorkCode)
    .leftJoin(schema.jobType, eq(schema.jobType.id, schema.clientWorkCode.jobTypeId))
    .leftJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.clientWorkCode.priceBookItemId))
    .where(and(
      eq(schema.clientWorkCode.organizationId, ctx.actor.organizationId),
      eq(schema.clientWorkCode.customerId, customerId),
    ))
    .orderBy(asc(schema.clientWorkCode.code));

  /** The item's name is its version in force, which is what a line would say. */
  const itemIds = rows.map((r) => r.row.priceBookItemId).filter((id): id is string => id !== null);
  const versions = itemIds.length === 0 ? [] : await tx.select({
    itemId: schema.priceBookItemVersion.itemId,
    name: schema.priceBookItemVersion.name,
  }).from(schema.priceBookItemVersion)
    .where(and(inArray(schema.priceBookItemVersion.itemId, itemIds), inForceAt()));
  const nameOf = new Map(versions.map((v) => [v.itemId, v.name]));

  return rows.map((r) => ({
    id: r.row.id,
    code: r.row.code,
    description: r.row.description,
    jobTypeId: r.row.jobTypeId,
    jobTypeName: r.jobTypeName ?? null,
    jobTypeActive: r.jobTypeActive ?? false,
    priceBookItemId: r.row.priceBookItemId,
    itemCode: r.itemCode ?? null,
    itemName: r.row.priceBookItemId ? nameOf.get(r.row.priceBookItemId) ?? r.itemCode ?? null : null,
    /** Sold means active, not removed, and with a price in force today. */
    itemSold: r.row.priceBookItemId !== null && r.itemActive === true && r.itemDeleted === null
      && nameOf.has(r.row.priceBookItemId),
    quantity: trimQuantity(r.row.quantity),
    updatedAt: r.row.updatedAt.toISOString(),
  }));
}

const trimQuantity = (value: string) => (value.includes(".") ? value.replace(/\.?0+$/, "") : value);

export function listCodes(ctx: ServiceContext, input: { customerId: string }) {
  return guardedRead(ctx, "contract:read", async (tx) => {
    const client = await assertClient(tx, ctx, input.customerId);
    return { customerId: client.id, clientName: client.name, data: await rowsOf(tx, ctx, client.id) };
  });
}

/**
 * Replace a client's list.
 *
 * The whole list in one call, like a card's listed prices: the page edits it as
 * one form and saves it as one, so a row taken off the form is a row taken off
 * the list. A code twice, a row that maps to nothing, a quantity that is not
 * one, a job type or an item that is not this company's or not in use: each is
 * refused in words before anything is written.
 */
export function setCodes(ctx: ServiceContext, input: { customerId: string; codes: CodeRowInput[] }) {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    const client = await assertClient(tx, ctx, input.customerId);
    /** Locked, so two saves at once replace the list one after the other rather than into each other. */
    await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(eq(schema.customer.id, client.id)).for("update");

    const rows = input.codes.map((row) => ({
      code: row.code.trim(),
      description: row.description?.trim() ? row.description.trim() : null,
      jobTypeId: row.jobTypeId ?? null,
      priceBookItemId: row.priceBookItemId ?? null,
      quantity: (row.quantity ?? "1").trim(),
    }));
    /**
     * A code twice ("The code PLB-07 is in the list twice") is refused here in
     * words, before `client_work_code_code_idx` could see it, along with a row
     * mapped to nothing and a quantity that is not one (`core/external-work`).
     */
    const wrong = ew.checkMappings(rows);
    if (wrong) throw new ConflictError(wrong);

    const typeIds = [...new Set(rows.map((r) => r.jobTypeId).filter((id): id is string => id !== null))];
    if (typeIds.length > 0) {
      const found = await tx.select({ id: schema.jobType.id }).from(schema.jobType)
        .where(and(
          eq(schema.jobType.organizationId, ctx.actor.organizationId),
          inArray(schema.jobType.id, typeIds),
          eq(schema.jobType.active, true),
        ));
      if (found.length !== typeIds.length) {
        throw new ConflictError("One of the kinds of work chosen is not one of this company's job types in use. Choose it again.");
      }
    }
    const itemIds = [...new Set(rows.map((r) => r.priceBookItemId).filter((id): id is string => id !== null))];
    if (itemIds.length > 0) {
      const found = await tx.select({ id: schema.priceBookItem.id }).from(schema.priceBookItem)
        .where(and(
          eq(schema.priceBookItem.organizationId, ctx.actor.organizationId),
          inArray(schema.priceBookItem.id, itemIds),
          eq(schema.priceBookItem.active, true),
          isNull(schema.priceBookItem.deletedAt),
        ));
      if (found.length !== itemIds.length) {
        throw new ConflictError("One of the items chosen is not in this company's price book, or is no longer sold. Choose it again.");
      }
    }

    const before = await rowsOf(tx, ctx, client.id);
    await tx.delete(schema.clientWorkCode).where(and(
      eq(schema.clientWorkCode.organizationId, ctx.actor.organizationId),
      eq(schema.clientWorkCode.customerId, client.id),
    ));
    if (rows.length > 0) {
      await tx.insert(schema.clientWorkCode).values(rows.map((row) => ({
        organizationId: ctx.actor.organizationId,
        customerId: client.id,
        ...row,
      })));
    }
    const after = await rowsOf(tx, ctx, client.id);
    await audit(tx, ctx, "client_work_codes.set", "customer", client.id,
      { codes: before.map(auditRow) }, { codes: after.map(auditRow) });
    return { customerId: client.id, clientName: client.name, data: after };
  });
}

const auditRow = (row: { code: string; jobTypeId: string | null; priceBookItemId: string | null; quantity: string }) => ({
  code: row.code, jobTypeId: row.jobTypeId, priceBookItemId: row.priceBookItemId, quantity: row.quantity,
});

/* ------------------------------------------------------------ the client */

/**
 * Say which client an order is for.
 *
 * The sync can say it when the order arrives; when it does not, the office does,
 * because the codes mean nothing until somebody knows whose they are. Refused
 * once a job is on the order: the job was made for that customer, and moving the
 * order under another would leave the two disagreeing about whose work it is.
 */
export function setClient(ctx: ServiceContext, input: { id: string; customerId: string }) {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    const row = await loadOrder(tx, ctx, input.id);
    if (row.jobId) {
      throw new ConflictError("This order already has a job, made for the client it was for then. It stays that client's.");
    }
    const client = await assertClient(tx, ctx, input.customerId);
    const [updated] = await tx.update(schema.externalWorkOrder).set({ customerId: client.id, updatedAt: new Date() })
      .where(eq(schema.externalWorkOrder.id, row.id)).returning();
    await audit(tx, ctx, "external_work_order.client", "external_work_order", row.id,
      { customerId: row.customerId }, { customerId: client.id });
    return viewOne(tx, updated!);
  });
}

async function loadOrder(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.externalWorkOrder)
    .where(and(
      eq(schema.externalWorkOrder.organizationId, ctx.actor.organizationId),
      eq(schema.externalWorkOrder.id, id),
    ))
    .limit(1);
  if (!row) throw new NotFoundError("External work order");
  return row;
}

/* ------------------------------------------------------------ the proposal */

export interface ProposalLine {
  code: string;
  priceBookItemId: string;
  name: string;
  quantity: string;
  /** Our price book's price for one, today. */
  ourPrice: string;
  /** What one is charged at: the client's card when it prices this, else our price. */
  unitPrice: string;
  /** Who priced it, in words: the client's contract, or our price book. */
  pricedBy: string;
  /** The working in a sentence, when a card priced it. */
  note: string | null;
  /** True when the client has a card and it does not price this line. */
  outOfScope: boolean;
}

export interface ProposalView {
  orderId: string;
  customerId: string | null;
  clientName: string | null;
  /** Null when the order can be taken this way; a sentence saying why not, otherwise. */
  refusal: string | null;
  jobTypeId: string | null;
  jobTypeName: string | null;
  jobTypeNote: string | null;
  codes: ew.CodeReading[];
  lines: ProposalLine[];
  unmapped: string[];
  /** The client's addresses the job can be at, with a site number when a contract gives one. */
  places: Array<{ propertyId: string; label: string; siteNumber: string | null }>;
  /** Sent back with the confirmation, so a list changed in between is refused rather than used. */
  key: string;
}

async function placesOf(tx: Database, ctx: ServiceContext, customerId: string) {
  const own = await tx.select({
    propertyId: schema.property.id,
    line1: schema.property.addressLine1, city: schema.property.city,
  }).from(schema.customerProperty)
    .innerJoin(schema.property, eq(schema.property.id, schema.customerProperty.propertyId))
    .where(and(
      eq(schema.customerProperty.organizationId, ctx.actor.organizationId),
      eq(schema.customerProperty.customerId, customerId),
      isNull(schema.customerProperty.endedOn),
      isNull(schema.property.deletedAt),
    ));
  const sites = await tx.select({
    propertyId: schema.property.id,
    line1: schema.property.addressLine1, city: schema.property.city,
    siteNumber: schema.contractSite.siteNumber,
  }).from(schema.contractSite)
    .innerJoin(schema.serviceContract, eq(schema.serviceContract.id, schema.contractSite.contractId))
    .innerJoin(schema.property, eq(schema.property.id, schema.contractSite.propertyId))
    .where(and(
      eq(schema.contractSite.organizationId, ctx.actor.organizationId),
      eq(schema.serviceContract.customerId, customerId),
      isNull(schema.serviceContract.deletedAt),
      isNull(schema.property.deletedAt),
    ));
  const byId = new Map<string, { propertyId: string; label: string; siteNumber: string | null }>();
  const places: Array<{ propertyId: string; line1: string | null; city: string | null; siteNumber: string | null }> = [
    ...sites, ...own.map((p) => ({ ...p, siteNumber: null })),
  ];
  for (const place of places) {
    if (byId.has(place.propertyId)) continue;
    byId.set(place.propertyId, {
      propertyId: place.propertyId,
      label: [place.line1, place.city].filter((p) => p).join(", "),
      siteNumber: place.siteNumber,
    });
  }
  return [...byId.values()].sort((a, b) => a.label.localeCompare(b.label));
}

async function proposalWithin(tx: Database, ctx: ServiceContext, row: typeof schema.externalWorkOrder.$inferSelect): Promise<ProposalView> {
  const state = ew.isState(row.state) ? row.state : "offered";
  const flags = { acceptanceIsIrreversible: row.acceptanceIsIrreversible, acceptsViaInvoiceOnly: row.acceptsViaInvoiceOnly };
  const client = row.customerId ? await assertClient(tx, ctx, row.customerId).catch(() => null) : null;

  const verdict = ew.checkMove(state, "accepted", flags);
  const refusal = row.jobId
    ? "This order already has a job."
    : !verdict.ok ? verdict.refusal.message
      : client === null ? "Say which client this order is for first. Their codes mean nothing until then."
        : null;

  const mappings = client ? await rowsOf(tx, ctx, client.id) : [];
  const proposal = ew.propose(row.clientCodes, mappings.map((m) => ({
    id: m.id, code: m.code, description: m.description,
    jobTypeId: m.jobTypeId, jobTypeName: m.jobTypeName, jobTypeActive: m.jobTypeActive,
    priceBookItemId: m.priceBookItemId, itemName: m.itemName, itemSold: m.itemSold, quantity: m.quantity,
  })), client?.name ?? "the client");

  const lines = await pricedLines(tx, ctx, client?.id ?? null, proposal.jobTypeId, proposal.lines);
  const places = client ? await placesOf(tx, ctx, client.id) : [];

  /**
   * THE KEY covers what the job would be made of: the client, the lines with
   * their quantities and the codes nothing came of. A price is not in it, because
   * the job line records our price and the card prices it again when it is billed.
   */
  const key = createHash("sha256").update(JSON.stringify({
    customerId: client?.id ?? null,
    jobTypeId: proposal.jobTypeId,
    lines: proposal.lines.map((l) => [l.code, l.priceBookItemId, l.quantity]),
    unmapped: proposal.codes.filter((c) => c.unmapped).map((c) => c.code),
  })).digest("hex").slice(0, 32);

  return {
    orderId: row.id,
    customerId: client?.id ?? null,
    clientName: client?.name ?? null,
    refusal,
    jobTypeId: proposal.jobTypeId,
    jobTypeName: proposal.jobTypeName,
    jobTypeNote: proposal.jobTypeNote,
    codes: proposal.codes,
    lines,
    unmapped: proposal.unmapped,
    places,
    key,
  };
}

/** Each proposed line with our price and the price the client's card gives it, if it has one. */
async function pricedLines(
  tx: Database, ctx: ServiceContext, customerId: string | null, jobTypeId: string | null,
  lines: readonly ew.ProposedLine[],
): Promise<ProposalLine[]> {
  if (lines.length === 0) return [];
  const versions = await versionsOf(tx, lines.map((l) => l.priceBookItemId));
  const today = await rateCards.todayFor(tx, ctx.actor.organizationId);
  const cards = customerId
    ? await rateCards.cardsFor(tx, ctx.actor.organizationId, { customerId, ...today })
    : [];
  return lines.map((line) => {
    const v = versions.get(line.priceBookItemId)!;
    if (cards.length === 0) {
      return {
        code: line.code, priceBookItemId: line.priceBookItemId, name: v.name, quantity: line.quantity,
        ourPrice: v.price, unitPrice: v.price, pricedBy: rates.AUTHORITY_LABEL.price_book, note: null, outOfScope: false,
      };
    }
    const priced = rates.priceWork(cards, {
      kind: rateCards.workKindOfItem(v.kind),
      name: v.name,
      priceBookItemId: line.priceBookItemId,
      externalCode: line.code,
      quantity: line.quantity,
      ourPrice: usd(v.price),
      ourPriceIsBook: true,
      unitCost: v.cost ? usd(v.cost) : null,
      at: new Date(),
      jobTypeId,
    });
    return {
      code: line.code, priceBookItemId: line.priceBookItemId, name: v.name, quantity: line.quantity,
      ourPrice: v.price,
      unitPrice: m.toString(priced.unitPrice),
      pricedBy: rates.AUTHORITY_LABEL[priced.authority],
      note: priced.note,
      outOfScope: priced.outOfScope,
    };
  });
}

async function versionsOf(tx: Database, itemIds: readonly string[]) {
  const rows = await tx.select({
    itemId: schema.priceBookItemVersion.itemId,
    versionId: schema.priceBookItemVersion.id,
    name: schema.priceBookItemVersion.name,
    description: schema.priceBookItemVersion.description,
    price: schema.priceBookItemVersion.price,
    cost: costPerUseUnit,
    taxable: schema.priceBookItemVersion.taxable,
    kind: schema.priceBookItem.kind,
  }).from(schema.priceBookItemVersion)
    .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceBookItemVersion.itemId))
    .where(and(inArray(schema.priceBookItemVersion.itemId, [...new Set(itemIds)]), inForceAt()));
  return new Map(rows.map((r) => [r.itemId, r]));
}

export function proposal(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "contract:read", async (tx) => proposalWithin(tx, ctx, await loadOrder(tx, ctx, input.id)));
}

/* ------------------------------------------------------------ confirmed */

export interface AcceptAsProposedInput {
  id: string;
  /** The key the proposal gave. A different one means the list changed since it was shown. */
  key: string;
  /** Where the work is: one of the client's addresses. */
  propertyId: string;
  /** The kind of work, as the office confirmed it: the proposal's, another, or none. */
  jobTypeId: string | null;
  summary?: string | undefined;
}

/**
 * Accept the order and make its job from the proposal the office looked at.
 *
 * In one transaction: the job for the client at the address chosen, with the job
 * type the office confirmed, a line per mapped item at our price with the
 * client's code on it (so their card prices it by that code when it is billed),
 * every code nothing came of written in the job's notes, and the order accepted
 * with the job on it, owing the client a push. Needs `contract:write` to accept
 * and `job:write` to make the job; either missing refuses the lot.
 */
export function acceptAsProposed(ctx: ServiceContext, input: AcceptAsProposedInput) {
  return guardedWrite(ctx, "contract:write", async (tx) => {
    assertCan(ctx.actor, "job:write");
    const seen = await replayed<{ orderId: string; jobId: string }>(tx, ctx, "external_work_order.accept_as_proposed");
    if (seen) return { order: await viewOne(tx, await loadOrder(tx, ctx, seen.orderId)), jobId: seen.jobId };

    /** Locked, so two presses at once make one job and the second is refused as already accepted. */
    await tx.select({ id: schema.externalWorkOrder.id }).from(schema.externalWorkOrder)
      .where(and(
        eq(schema.externalWorkOrder.organizationId, ctx.actor.organizationId),
        eq(schema.externalWorkOrder.id, input.id),
      )).for("update");
    const row = await loadOrder(tx, ctx, input.id);
    const shown = await proposalWithin(tx, ctx, row);
    if (shown.refusal) throw new ConflictError(shown.refusal);
    if (shown.key !== input.key) {
      throw new ConflictError(
        "The client's codes or their list changed since this was shown. Look at the proposal again before making the job.",
      );
    }
    if (!shown.places.some((p) => p.propertyId === input.propertyId)) {
      throw new ConflictError(`Choose one of ${shown.clientName}'s addresses for the job.`);
    }
    if (input.jobTypeId) {
      const [type] = await tx.select({ id: schema.jobType.id }).from(schema.jobType)
        .where(and(
          eq(schema.jobType.organizationId, ctx.actor.organizationId),
          eq(schema.jobType.id, input.jobTypeId),
          eq(schema.jobType.active, true),
        )).limit(1);
      if (!type) throw new ConflictError("That kind of work is not one of this company's job types in use. Choose it again.");
    }

    const label = row.externalNumber ?? row.externalId;
    const source = ew.sourceProfile(row.sourceSystem)?.label ?? row.sourceSystem;
    const codeNotes = shown.codes.map((c) => `${c.code}${c.description ? ` ${c.description}` : ""}${c.quantity ? ` x ${c.quantity}` : ""}`);
    const description = [
      `Work order ${label} from ${source}.`,
      codeNotes.length ? `Their codes: ${codeNotes.join("; ")}.` : "",
      ...shown.unmapped.map((words) => `Not mapped: ${words}`),
    ].filter((p) => p).join("\n");

    /** As the person, without the caller's key: that key is this call's, and the job keeps none of its own. */
    const { idempotencyKey: _callersKey, ...person } = ctx;
    void _callersKey;
    const inner: ServiceContext = { ...person, db: tx };
    const job = await jobs.create(inner, {
      customerId: shown.customerId!,
      propertyId: input.propertyId,
      ...(input.jobTypeId ? { jobTypeId: input.jobTypeId } : {}),
      summary: (input.summary?.trim() || `${source} order ${label}`).slice(0, 300),
      /**
       * No purchase order number: the client's order number is in the summary
       * and the notes, and whether it is also their PO is theirs to say.
       */
      description: description.slice(0, 5000),
      tags: [],
      customFields: {},
    });

    if (shown.lines.length > 0) {
      const versions = await versionsOf(tx, shown.lines.map((l) => l.priceBookItemId));
      await tx.insert(schema.jobLine).values(shown.lines.map((line) => {
        const v = versions.get(line.priceBookItemId)!;
        return {
          organizationId: ctx.actor.organizationId,
          jobId: job.id,
          kind: v.kind === "labor" ? "labor" as const : v.kind === "equipment" ? "equipment" as const : "part" as const,
          source: "office" as const,
          priceBookItemVersionId: v.versionId,
          name: v.name,
          description: v.description ?? null,
          quantity: line.quantity,
          /** Our price, as every line records it. The client's card prices it again when it is billed. */
          unitPrice: v.price,
          unitCost: v.cost ?? null,
          taxable: v.taxable,
          clientCode: line.code,
        };
      }));
    }

    const [updated] = await tx.update(schema.externalWorkOrder).set({
      state: "accepted",
      jobId: job.id,
      pendingPush: ew.owesPush("accepted"),
      lastPushError: null,
      updatedAt: new Date(),
    }).where(eq(schema.externalWorkOrder.id, row.id)).returning();

    await audit(tx, ctx, "external_work_order.accepted", "external_work_order", row.id, row, {
      ...updated,
      fromCodes: {
        jobId: job.id,
        jobTypeId: input.jobTypeId,
        proposedJobTypeId: shown.jobTypeId,
        lines: shown.lines.map((l) => ({ code: l.code, priceBookItemId: l.priceBookItemId, quantity: l.quantity })),
        unmapped: shown.codes.filter((c) => c.unmapped).map((c) => c.code),
      },
    });
    await remember(tx, ctx, "external_work_order.accept_as_proposed", row.id, { orderId: row.id, jobId: job.id });
    return { order: await viewOne(tx, updated!), jobId: job.id };
  });
}

export const handlers = {
  listClientWorkCodes: (ctx: ServiceContext, input: { customerId: string }) => listCodes(ctx, input),
  setClientWorkCodes: (ctx: ServiceContext, input: { customerId: string; codes: CodeRowInput[] }) =>
    setCodes(ctx, input),
  setExternalWorkOrderClient: (ctx: ServiceContext, input: { id: string; customerId: string }) =>
    setClient(ctx, input),
  getExternalWorkOrderProposal: (ctx: ServiceContext, input: { id: string }) => proposal(ctx, input),
  acceptExternalWorkOrderAsProposed: (ctx: ServiceContext, input: AcceptAsProposedInput) =>
    acceptAsProposed(ctx, input),
} as const;
