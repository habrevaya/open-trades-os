import { and, eq, desc, lt, inArray, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { estimate as est, money as m } from "@opentradesos/core";
import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, clean,
  decodeCursor, paginate, NotFoundError, ConflictError,
  scopeOf,
} from "./context";
import { estimateScopeFilter } from "./scope";
import { audit } from "./customers";
import { nextNumber } from "./jobs";
import type {
  createEstimate, getEstimate, listEstimates, sendEstimate,
  approveEstimate, declineEstimate, convertEstimate,
} from "../contracts/estimates";

const usd = (v: string) => m.money(v, "USD");

/**
 * Statuses an estimate can still be decided from.
 *
 * `expired` is deliberately in this set. An expiry date is a nudge, not a
 * cliff, and a company that would happily honour a three week old quote should
 * not have to rebuild it because a timestamp passed on a Sunday. What expiry
 * does is stop the estimate counting as open pipeline.
 *
 * `draft` is in it for the sale that happens at the kitchen table. A
 * technician builds the options on a tablet, turns it around, and the customer
 * says yes; nothing was ever sent, and requiring a send first would mean
 * recording a fake one. The portal cannot reach a draft in any case, because
 * sending is what issues the grant, so this only widens the office path.
 */
const DECIDABLE = ["draft", "sent", "viewed", "expired"] as const;

/**
 * Creating an estimate.
 *
 * Prices come from the price book VERSION whenever an item id is given, for
 * the same reason they do on an invoice: a client that can name its own price
 * is a client that will, and the version reference is what keeps a document
 * saying what it said after a price rise.
 */
export async function create(ctx: ServiceContext, input: z.infer<typeof createEstimate.input>) {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    if (ctx.idempotencyKey) {
      const seen = await seenBefore(tx, ctx.idempotencyKey, "estimate");
      if (seen) return loadEstimate(tx, ctx, seen);
    }

    const itemIds = input.options
      .flatMap((o) => o.lines.map((l) => l.priceBookItemId))
      .filter((x): x is string => Boolean(x));

    const versions = itemIds.length
      ? await tx.select({
          itemId: schema.priceBookItemVersion.itemId,
          versionId: schema.priceBookItemVersion.id,
          name: schema.priceBookItemVersion.name,
          price: schema.priceBookItemVersion.price,
          cost: schema.priceBookItemVersion.cost,
          taxable: schema.priceBookItemVersion.taxable,
        })
        .from(schema.priceBookItemVersion)
        .where(and(
          inArray(schema.priceBookItemVersion.itemId, itemIds),
          isNull(schema.priceBookItemVersion.effectiveTo),
        ))
      : [];
    const byItem = new Map(versions.map((v) => [v.itemId, v]));

    const number = await nextNumber(tx, ctx.actor.organizationId, "estimate");

    const [row] = await tx.insert(schema.estimate).values({
      organizationId: ctx.actor.organizationId,
      number,
      customerId: input.customerId,
      propertyId: input.propertyId,
      jobId: input.jobId ?? null,
      title: input.title ?? null,
      expiresOn: input.expiresOn ?? null,
      status: "draft",
    }).returning({ id: schema.estimate.id });

    const estimateId = row!.id;

    for (const [index, option] of input.options.entries()) {
      const resolved = option.lines.map((line) => {
        const version = line.priceBookItemId ? byItem.get(line.priceBookItemId) : undefined;
        return {
          versionId: version?.versionId ?? null,
          name: version?.name ?? line.name,
          description: line.description ?? null,
          quantity: line.quantity,
          unitPrice: version?.price ?? line.unitPrice,
          unitCost: version?.cost ?? line.unitCost ?? null,
          discountAmount: line.discountAmount,
          taxable: version?.taxable ?? line.taxable,
          taxRate: (version?.taxable ?? line.taxable) ? input.taxRate : "0",
          isOptional: line.isOptional,
          isSelected: line.isSelected,
          costCode: line.costCode ?? null,
        };
      });

      const computed = est.computeOption(resolved.map((l) => ({
        quantity: l.quantity,
        unitPrice: usd(l.unitPrice),
        discountAmount: usd(l.discountAmount),
        taxable: l.taxable,
        taxRate: l.taxRate,
        isOptional: l.isOptional,
        isSelected: l.isSelected,
        unitCost: l.unitCost === null ? undefined : usd(l.unitCost),
      })));

      const [optionRow] = await tx.insert(schema.estimateOption).values({
        organizationId: ctx.actor.organizationId,
        estimateId,
        name: option.name,
        description: option.description ?? null,
        sortOrder: index,
        isRecommended: option.isRecommended,
        subtotal: m.toString(computed.totals.subtotal),
        taxTotal: m.toString(computed.totals.taxTotal),
        total: m.toString(computed.totals.total),
      }).returning({ id: schema.estimateOption.id });

      await tx.insert(schema.estimateLine).values(resolved.map((line, i) => ({
        organizationId: ctx.actor.organizationId,
        optionId: optionRow!.id,
        priceBookItemVersionId: line.versionId,
        sortOrder: i,
        name: line.name,
        description: line.description,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        unitCost: line.unitCost,
        discountAmount: line.discountAmount,
        taxable: line.taxable,
        taxRate: line.taxRate,
        taxAmount: m.toString(computed.lines[i]!.taxAmount),
        lineTotal: m.toString(computed.lines[i]!.lineTotal),
        isOptional: line.isOptional,
        isSelected: line.isSelected,
        costCode: line.costCode,
      })));
    }

    await recordIdempotency(tx, ctx, "estimate", estimateId);
    await audit(tx, ctx, "estimate.created", "estimate", estimateId, null, { number });
    return loadEstimate(tx, ctx, estimateId);
  });
}

export async function get(ctx: ServiceContext, input: z.infer<typeof getEstimate.input>) {
  return guardedRead(ctx, "estimate:read", (tx) => loadEstimate(tx, ctx, input.id));
}

export async function list(ctx: ServiceContext, input: z.infer<typeof listEstimates.input>) {
  return guardedRead(ctx, "estimate:read", async (tx) => {
    const after = decodeCursor(input.cursor);
    const rows = await tx.select({
      id: schema.estimate.id,
      number: schema.estimate.number,
      status: schema.estimate.status,
      customerId: schema.estimate.customerId,
      customerName: schema.customer.name,
      propertyId: schema.estimate.propertyId,
      jobId: schema.estimate.jobId,
      title: schema.estimate.title,
      expiresOn: schema.estimate.expiresOn,
      sentAt: schema.estimate.sentAt,
      viewedAt: schema.estimate.viewedAt,
      decidedAt: schema.estimate.decidedAt,
      declineReason: schema.estimate.declineReason,
      selectedOptionId: schema.estimate.selectedOptionId,
      signerName: schema.estimate.signerName,
      currency: schema.estimate.currency,
      createdAt: schema.estimate.createdAt,
      updatedAt: schema.estimate.updatedAt,
    })
      .from(schema.estimate)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.estimate.customerId))
      .where(and(
        // A technician sees estimates for work they did. See services/scope.ts.
        estimateScopeFilter(scopeOf(ctx, "estimate"), ctx.actor),
        input.status ? inArray(schema.estimate.status, input.status) : undefined,
        input.customerId ? eq(schema.estimate.customerId, input.customerId) : undefined,
        input.jobId ? eq(schema.estimate.jobId, input.jobId) : undefined,
        after ? lt(schema.estimate.id, after) : undefined,
      ))
      .orderBy(desc(schema.estimate.id))
      .limit(input.limit + 1);

    const page = paginate(rows, input.limit, (r) => r.id);

    // One query for every option total on the page rather than one per row.
    const ids = page.data.map((r) => r.id);
    const options = ids.length
      ? await tx.select({
          estimateId: schema.estimateOption.estimateId,
          total: schema.estimateOption.total,
        }).from(schema.estimateOption).where(inArray(schema.estimateOption.estimateId, ids))
      : [];

    /**
     * The headline figure for a multi option estimate is the recommended one
     * where there is one, and otherwise the largest. A list that showed the
     * cheapest option would read as a pipeline half the size of the real one.
     */
    const byEstimate = new Map<string, string[]>();
    for (const o of options) {
      byEstimate.set(o.estimateId, [...(byEstimate.get(o.estimateId) ?? []), o.total]);
    }

    return {
      ...page,
      data: page.data.map((r) => {
        const totals = byEstimate.get(r.id) ?? [];
        const top = totals.reduce((acc, t) => (usd(t).amount > usd(acc).amount ? t : acc), "0");
        return clean(ctx, "estimate", { ...r, total: top, optionCount: totals.length });
      }),
    };
  });
}

/**
 * Sending.
 *
 * Two things happen together or neither is worth anything: the document is
 * frozen by hashing what will be rendered, and the customer is issued a single
 * use grant to approve it. An approval that cannot be tied to the document the
 * customer saw settles nothing later.
 *
 * The plaintext token exists exactly once, in the return value. Only its hash
 * is written down, so a leaked database backup contains no working links.
 */
export async function send(ctx: ServiceContext, input: z.infer<typeof sendEstimate.input>) {
  return guardedWrite(ctx, "estimate:send", async (tx) => {
    const current = await loadEstimate(tx, ctx, input.id);

    if (current.status === "approved" || current.status === "converted") {
      throw new ConflictError(
        `Estimate ${current.number} has already been approved. Create a revision rather than resending it.`,
      );
    }

    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const expiresAt = new Date(Date.now() + input.expiresInDays * 864e5);

    /**
     * Any grant already outstanding on this estimate is withdrawn first. A
     * revised estimate sent twice would otherwise leave the first link live,
     * and a customer approving through it would be approving numbers that no
     * longer exist.
     */
    await tx.update(schema.portalGrant)
      .set({ revokedAt: new Date() })
      .where(and(
        eq(schema.portalGrant.scope, "estimate"),
        eq(schema.portalGrant.subjectId, input.id),
        isNull(schema.portalGrant.revokedAt),
      ));

    await tx.insert(schema.portalGrant).values({
      organizationId: ctx.actor.organizationId,
      customerId: current.customerId,
      scope: "estimate",
      subjectId: input.id,
      tokenHash,
      expiresAt,
      // One approval per link. A forwarded link cannot approve a second time
      // or switch the chosen option after the fact.
      maxUses: 1,
    });

    await tx.update(schema.estimate)
      .set({ status: "sent", sentAt: new Date(), updatedAt: new Date() })
      .where(eq(schema.estimate.id, input.id));

    await tx.insert(schema.portalEvent).values({
      organizationId: ctx.actor.organizationId,
      customerId: current.customerId,
      estimateId: input.id,
      kind: "estimate_sent",
      headline: `Estimate #${current.number} sent`,
      detail: input.message ?? null,
    });

    await audit(tx, ctx, "estimate.sent", "estimate", input.id,
      { status: current.status }, { status: "sent", channel: input.channel });

    return {
      estimate: await loadEstimate(tx, ctx, input.id),
      approvalUrl: approvalUrl(token),
      expiresAt: expiresAt.toISOString(),
    };
  });
}

/**
 * Recording an approval that happened somewhere else: at the kitchen table, on
 * the phone, in a reply to an email.
 *
 * `capturedVia` is asked for rather than inferred, because "the customer said
 * yes on the phone" and "the customer clicked approve" are different evidence
 * and a company deserves to know which one it has.
 */
export async function approve(ctx: ServiceContext, input: z.infer<typeof approveEstimate.input>) {
  return guardedWrite(ctx, "estimate:approve", async (tx) => {
    return decide(tx, ctx, {
      estimateId: input.id,
      optionId: input.optionId,
      selectedLineIds: input.selectedLineIds,
      signerName: input.signerName,
      capturedVia: input.capturedVia,
    });
  });
}

export async function decline(ctx: ServiceContext, input: z.infer<typeof declineEstimate.input>) {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    const current = await loadEstimate(tx, ctx, input.id);

    // A retry from a bad connection is a no-op, not a second decline.
    if (current.status === "declined") return current;

    if (!(DECIDABLE as readonly string[]).includes(current.status)) {
      throw new ConflictError(
        `Estimate ${current.number} is ${current.status} and cannot be declined.`,
      );
    }

    await tx.update(schema.estimate).set({
      status: "declined",
      decidedAt: new Date(),
      declineReason: input.reason ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.estimate.id, input.id));

    await tx.insert(schema.portalEvent).values({
      organizationId: ctx.actor.organizationId,
      customerId: current.customerId,
      estimateId: input.id,
      kind: "estimate_declined",
      headline: `Estimate #${current.number} declined`,
      detail: input.reason ?? null,
      isCustomerVisible: false,
    });

    await audit(tx, ctx, "estimate.declined", "estimate", input.id,
      { status: current.status }, { status: "declined", reason: input.reason ?? null });
    return loadEstimate(tx, ctx, input.id);
  });
}

/**
 * Turning an approved option into work and a bill.
 *
 * The conversion is a COPY, not a re-price. Every line carries its frozen
 * price book version and the tax rate as applied straight onto the invoice,
 * and nothing is looked up again. An invoice that disagrees with the approved
 * quote, even by a cent from a rate that changed overnight, is the fastest way
 * to lose a customer who was, a moment ago, happy.
 *
 * Only the lines the customer actually took are copied. An optional line they
 * left unticked was priced and shown and declined, and billing it is the worst
 * version of this mistake.
 */
export async function convert(ctx: ServiceContext, input: z.infer<typeof convertEstimate.input>) {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    if (ctx.idempotencyKey) {
      const seen = await seenBefore(tx, ctx.idempotencyKey, "estimate_conversion");
      if (seen) return loadConversion(tx, ctx, input.id);
    }

    const current = await loadEstimate(tx, ctx, input.id);

    if (current.status === "converted") return loadConversion(tx, ctx, input.id);
    if (current.status !== "approved") {
      throw new ConflictError(
        `Estimate ${current.number} is ${current.status}. Only an approved estimate converts.`,
      );
    }

    const optionId = current.selectedOptionId as string | null;
    if (!optionId) throw new ConflictError("No option was selected on this estimate.");

    const option = (current.options as Array<Record<string, unknown>>)
      .find((o) => o["id"] === optionId);
    if (!option) throw new NotFoundError("Estimate option");

    const lines = (option["lines"] as Array<Record<string, unknown>>)
      .filter((l) => !l["isOptional"] || l["isSelected"] === true);

    let jobId: string | null = current.jobId as string | null;
    if (input.createJob && !jobId) {
      const number = await nextNumber(tx, ctx.actor.organizationId, "job");
      const [job] = await tx.insert(schema.job).values({
        organizationId: ctx.actor.organizationId,
        number,
        customerId: current.customerId as string,
        propertyId: current.propertyId as string,
        jobTypeId: input.jobTypeId ?? null,
        status: "scheduled",
        summary: (current.title as string | null) ?? `${option["name"]}`,
        leadSource: "estimate",
      }).returning({ id: schema.job.id });
      jobId = job!.id;
    }

    let invoiceId: string | null = null;
    if (input.createInvoice) {
      const number = await nextNumber(tx, ctx.actor.organizationId, "invoice");
      const [invoice] = await tx.insert(schema.invoice).values({
        organizationId: ctx.actor.organizationId,
        number,
        customerId: current.customerId as string,
        propertyId: current.propertyId as string,
        jobId,
        status: "draft",
        subtotal: option["subtotal"] as string,
        taxTotal: option["taxTotal"] as string,
        total: option["total"] as string,
        balance: option["total"] as string,
      }).returning({ id: schema.invoice.id });
      invoiceId = invoice!.id;

      await tx.insert(schema.invoiceLine).values(lines.map((l, i) => ({
        organizationId: ctx.actor.organizationId,
        invoiceId: invoiceId!,
        origin: "job" as const,
        originId: jobId,
        // Frozen on the estimate, carried across untouched.
        priceBookItemVersionId: (l["priceBookItemVersionId"] ?? null) as string | null,
        sortOrder: i,
        name: l["name"] as string,
        description: (l["description"] ?? null) as string | null,
        quantity: l["quantity"] as string,
        unitPrice: l["unitPrice"] as string,
        unitCost: (l["unitCost"] ?? null) as string | null,
        discountAmount: l["discountAmount"] as string,
        taxable: l["taxable"] as boolean,
        taxRate: l["taxRate"] as string,
        taxAmount: l["taxAmount"] as string,
        lineTotal: l["lineTotal"] as string,
        costCode: (l["costCode"] ?? null) as string | null,
      })));
    }

    await tx.update(schema.estimate).set({
      status: "converted",
      jobId,
      updatedAt: new Date(),
    }).where(eq(schema.estimate.id, input.id));

    const [deposit] = await tx.select({ id: schema.deposit.id })
      .from(schema.deposit).where(eq(schema.deposit.estimateId, input.id)).limit(1);

    // The deposit follows the work, so it can be applied to the invoice that
    // comes out of it without anyone hunting for the original estimate.
    if (deposit && jobId) {
      await tx.update(schema.deposit).set({ jobId, updatedAt: new Date() })
        .where(eq(schema.deposit.id, deposit.id));
    }

    await recordIdempotency(tx, ctx, "estimate_conversion", input.id);
    await audit(tx, ctx, "estimate.converted", "estimate", input.id,
      { status: "approved" }, { status: "converted", jobId, invoiceId });

    return {
      estimate: await loadEstimate(tx, ctx, input.id),
      jobId,
      invoiceId,
      depositId: deposit?.id ?? null,
    };
  });
}

/** The result of a conversion that already happened, for a retry. */
async function loadConversion(tx: Database, ctx: ServiceContext, estimateId: string) {
  const estimate = await loadEstimate(tx, ctx, estimateId);
  const [invoice] = await tx.select({ id: schema.invoice.id })
    .from(schema.invoice)
    .where(and(
      eq(schema.invoice.jobId, (estimate.jobId ?? "") as string),
      eq(schema.invoice.organizationId, ctx.actor.organizationId),
    )).limit(1);
  const [deposit] = await tx.select({ id: schema.deposit.id })
    .from(schema.deposit).where(eq(schema.deposit.estimateId, estimateId)).limit(1);

  return {
    estimate,
    jobId: (estimate.jobId ?? null) as string | null,
    invoiceId: invoice?.id ?? null,
    depositId: deposit?.id ?? null,
  };
}

/**
 * The shared body of an approval, whichever side it came from.
 *
 * Exported so the portal service can reuse it without going through a
 * permission check the customer could never satisfy. Callers are responsible
 * for authorizing; this function only enforces that the estimate is in a state
 * where a decision means something.
 */
export async function decide(
  tx: Database,
  ctx: ServiceContext,
  input: {
    estimateId: string;
    optionId: string;
    selectedLineIds: string[];
    signerName: string;
    capturedVia: string;
    signatureImage?: string | undefined;
    ipAddress?: string | undefined;
    userAgent?: string | undefined;
  },
) {
  const current = await loadEstimate(tx, ctx, input.estimateId);

  // A retry is a no-op, but only when it agrees with what was already decided.
  // A second approval choosing a DIFFERENT option is not a retry, it is a
  // contradiction, and silently ignoring it would lose a real disagreement.
  if (current.status === "approved" || current.status === "converted") {
    if (current.selectedOptionId === input.optionId) return current;
    throw new ConflictError(
      `Estimate ${current.number} was already approved on a different option.`,
    );
  }

  if (!(DECIDABLE as readonly string[]).includes(current.status)) {
    throw new ConflictError(
      `Estimate ${current.number} is ${current.status} and cannot be approved.`,
    );
  }

  const option = current.options.find((o) => o.id === input.optionId);
  if (!option) throw new NotFoundError("Estimate option");

  /**
   * Optional lines the customer took are marked before the totals are
   * recomputed, because the total the customer agreed to includes them. Any
   * optional line NOT in the list is explicitly unticked rather than left
   * alone, so a second pass through this function cannot accumulate choices
   * from an earlier attempt.
   */
  const optionalIds = option.lines.filter((l) => l.isOptional).map((l) => l.id);
  if (optionalIds.length) {
    await tx.update(schema.estimateLine)
      .set({ isSelected: false })
      .where(inArray(schema.estimateLine.id, optionalIds));
  }
  const taken = input.selectedLineIds.filter((id) => optionalIds.includes(id));
  if (taken.length) {
    await tx.update(schema.estimateLine)
      .set({ isSelected: true })
      .where(inArray(schema.estimateLine.id, taken));
  }

  const totals = await recomputeOption(tx, ctx, input.optionId);

  await tx.insert(schema.documentSignature).values({
    organizationId: ctx.actor.organizationId,
    subject: "estimate",
    subjectId: input.estimateId,
    signerName: input.signerName,
    imageUrl: input.signatureImage ?? null,
    documentHash: hashDocument({ ...current, approvedTotal: m.toString(totals.total) }),
    selectedOptionId: input.optionId,
    ipAddress: input.ipAddress ?? null,
    userAgent: input.userAgent ?? null,
  });

  await tx.update(schema.estimate).set({
    status: "approved",
    decidedAt: new Date(),
    selectedOptionId: input.optionId,
    signerName: input.signerName,
    updatedAt: new Date(),
  }).where(eq(schema.estimate.id, input.estimateId));

  await tx.insert(schema.portalEvent).values({
    organizationId: ctx.actor.organizationId,
    customerId: current.customerId,
    estimateId: input.estimateId,
    kind: "estimate_approved",
    headline: `Estimate #${current.number} approved`,
    detail: `${option.name}, ${m.toString(totals.total)}`,
  });

  await audit(tx, ctx, "estimate.approved", "estimate", input.estimateId,
    { status: current.status },
    {
      status: "approved",
      optionId: input.optionId,
      total: m.toString(totals.total),
      capturedVia: input.capturedVia,
      signerName: input.signerName,
    });

  return loadEstimate(tx, ctx, input.estimateId);
}

/**
 * Recomputes and rewrites one option's totals from its current lines.
 *
 * Called after the customer changes which optional lines they are taking. The
 * totals are not recomputed on read anywhere, so this is the only place the
 * stored figures can change, and the document keeps saying what it said.
 */
export async function recomputeOption(tx: Database, ctx: ServiceContext, optionId: string) {
  const lines = await tx.select().from(schema.estimateLine)
    .where(eq(schema.estimateLine.optionId, optionId))
    .orderBy(schema.estimateLine.sortOrder);

  const computed = est.computeOption(lines.map((l) => ({
    quantity: l.quantity,
    unitPrice: usd(l.unitPrice),
    discountAmount: usd(l.discountAmount),
    taxable: l.taxable,
    taxRate: l.taxRate,
    isOptional: l.isOptional,
    isSelected: l.isSelected,
    unitCost: l.unitCost === null ? undefined : usd(l.unitCost),
  })));

  await tx.update(schema.estimateOption).set({
    subtotal: m.toString(computed.totals.subtotal),
    taxTotal: m.toString(computed.totals.taxTotal),
    total: m.toString(computed.totals.total),
    updatedAt: new Date(),
  }).where(eq(schema.estimateOption.id, optionId));

  return computed.totals;
}

/**
 * Reads the whole estimate on an open transaction.
 *
 * Takes `tx` rather than opening its own, because a service method that calls
 * another service method through a second connection cannot see its own
 * uncommitted writes: creating an estimate and then reading it back would
 * report that the estimate does not exist.
 */
export async function loadEstimate(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.estimate)
    .where(eq(schema.estimate.id, id)).limit(1);
  if (!row) throw new NotFoundError("Estimate");

  const options = await tx.select().from(schema.estimateOption)
    .where(eq(schema.estimateOption.estimateId, id))
    .orderBy(schema.estimateOption.sortOrder);

  const lines = options.length
    ? await tx.select().from(schema.estimateLine)
        .where(inArray(schema.estimateLine.optionId, options.map((o) => o.id)))
        .orderBy(schema.estimateLine.sortOrder)
    : [];

  const shaped = options.map((option) => {
    const own = lines.filter((l) => l.optionId === option.id);
    const computed = est.computeOption(own.map((l) => ({
      quantity: l.quantity,
      unitPrice: usd(l.unitPrice),
      discountAmount: usd(l.discountAmount),
      taxable: l.taxable,
      taxRate: l.taxRate,
      isOptional: l.isOptional,
      isSelected: l.isSelected,
      unitCost: l.unitCost === null ? undefined : usd(l.unitCost),
    })));

    return clean(ctx, "estimateOption", {
      id: option.id,
      name: option.name,
      description: option.description,
      sortOrder: option.sortOrder,
      isRecommended: option.isRecommended,
      subtotal: option.subtotal,
      taxTotal: option.taxTotal,
      total: option.total,
      baseTotal: m.toString(computed.totals.baseTotal),
      optionalTotal: m.toString(computed.totals.optionalTotal),
      cost: computed.totals.cost === null ? null : m.toString(computed.totals.cost),
      margin: computed.totals.margin,
      lines: own.map((l) => clean(ctx, "estimateLine", l)),
    });
  });

  return clean(ctx, "estimate", {
    ...row,
    // Most expensive first, recommended pulled up. Cheapest-first anchors the
    // customer on the cheapest, which defeats the point of offering options.
    options: est.presentationOrder(
      shaped.map((o) => ({ ...o, total: usd(o.total as string) })),
    ).map((o) => ({ ...o, total: m.toString(o.total) })),
  });
}

/**
 * What the customer agreed to, reduced to a hash.
 *
 * Deliberately excludes anything the office can change afterwards without the
 * customer seeing it, and deliberately includes every figure they were shown.
 * A disagreement later about what was agreed is answerable from this and
 * unanswerable from a picture of a name.
 */
function hashDocument(input: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(input, Object.keys(input).sort())).digest("hex");
}

const PORTAL_BASE = process.env.PORTAL_BASE_URL ?? "https://portal.example.com";
const approvalUrl = (token: string) => `${PORTAL_BASE}/e/${token}`;

async function seenBefore(tx: Database, key: string, entityType: string): Promise<string | null> {
  const [row] = await tx.select({ entityId: schema.integrationEvent.entityId })
    .from(schema.integrationEvent)
    .where(and(
      eq(schema.integrationEvent.idempotencyKey, key),
      eq(schema.integrationEvent.entityType, entityType),
    )).limit(1);
  return row?.entityId ?? null;
}

async function recordIdempotency(tx: Database, ctx: ServiceContext, entityType: string, entityId: string) {
  if (!ctx.idempotencyKey) return;
  await tx.insert(schema.integrationEvent).values({
    organizationId: ctx.actor.organizationId,
    idempotencyKey: ctx.idempotencyKey,
    entityType,
    entityId,
    direction: "outbound",
    provider: "internal",
    eventType: `${entityType}.created`,
  });
}
