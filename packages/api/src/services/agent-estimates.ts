import { and, eq, inArray } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { agents as a, assertCan } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, ConflictError, type ServiceContext,
} from "./context";
import * as jobs from "./jobs";
import * as estimates from "./estimates";
import * as base from "./agents";
import { companyOf, bookItems } from "./agent-facts";
import type { AiDeps } from "./ai";

/**
 * THE ESTIMATE DRAFTER
 *
 * A technician has written "tank leaking at the base, twelve years old, gas
 * pressure fine" and taken three photographs. Turning that into a proposal
 * with a repair, a like for like replacement and an upgrade is half an hour in
 * the office. This drafts it from the job's notes, photo captions, readings and
 * equipment, using ONLY the company's price book: the model chooses items and
 * quantities, and every price on every line is the price book's price in force
 * today. A draft naming an item that is not in the book is refused whole.
 *
 * What it produces is a draft estimate, not a sent one. A person opens it,
 * edits it like any other estimate and sends it from the estimate screen.
 * "Act on its own" only saves the click that turns the draft into that draft
 * estimate; nothing here ever sends anything to a customer.
 */

interface EstimateDraft {
  jobId: string;
  jobNumber: number;
  customerId: string;
  propertyId: string;
  summary: string;
  options: a.PricedOption[];
}

async function facts(ctx: ServiceContext, jobId: string) {
  /** Through the job service, so a job out of this person's scope is not found here either. */
  const job = await jobs.get(ctx, { id: jobId }) as unknown as {
    id: string; number: number; customerId: string; propertyId: string; summary: string;
    description: string | null; customerComplaint: string | null; jobTypeId: string | null; equipmentId: string | null;
  };
  return inTenant(ctx, async (tx) => {
    const visits = await tx.select({ id: schema.visit.id, notes: schema.visit.technicianNotes })
      .from(schema.visit).where(eq(schema.visit.jobId, job.id));
    const subjects = [job.id, ...visits.map((v) => v.id)];
    const photos = await tx.select({ caption: schema.fieldUpload.caption }).from(schema.fieldUpload)
      .where(and(inArray(schema.fieldUpload.subjectId, subjects)));
    const findings = await tx.select({
      description: schema.deficiency.description, action: schema.deficiency.recommendedAction,
      observation: schema.deficiency.observation, severity: schema.deficiency.severity,
    }).from(schema.deficiency)
      .where(and(
        eq(schema.deficiency.propertyId, job.propertyId),
        inArray(schema.deficiency.status, ["open", "quoted", "deferred", "declined"]),
      )).limit(20);
    const [type] = job.jobTypeId
      ? await tx.select({ name: schema.jobType.name }).from(schema.jobType).where(eq(schema.jobType.id, job.jobTypeId)).limit(1)
      : [];
    const equipment = await tx.select().from(schema.equipment)
      .where(job.equipmentId ? eq(schema.equipment.id, job.equipmentId) : eq(schema.equipment.propertyId, job.propertyId))
      .limit(8);
    const facts: a.EstimateFacts = {
      jobNumber: job.number,
      summary: job.summary,
      jobType: type?.name ?? null,
      customerComplaint: job.customerComplaint,
      description: job.description,
      technicianNotes: visits.map((v) => v.notes ?? "").filter((n) => n.trim() !== ""),
      photoCaptions: photos.map((p) => p.caption ?? "").filter((c) => c.trim() !== ""),
      readings: findings.map((f) => {
        const reading = f.observation?.reading;
        return [
          `${f.severity}: ${f.description}`,
          f.action ? `recommended: ${f.action}` : null,
          reading !== undefined && reading !== null ? `reading: ${JSON.stringify(reading)}` : null,
        ].filter(Boolean).join("; ");
      }),
      equipment: equipment.map((e) => [e.category, e.manufacturer, e.model, e.installedOn ? `installed ${e.installedOn}` : null]
        .filter(Boolean).join(", ")),
    };
    return { job, facts };
  });
}

/**
 * Draft options for a job, as the person who asked.
 *
 * `estimate:write` first, because what this makes is an estimate draft and a
 * person who could not write one by hand has no business asking for one.
 */
export async function draft(
  ctx: ServiceContext, input: { jobId: string }, deps: AiDeps = base.DEFAULT_AGENT_DEPS,
) {
  assertCan(ctx.actor, "estimate:write");
  const replay = await inTenant(ctx, (tx) => base.proposalByKey(tx, ctx.idempotencyKey));
  if (replay) return base.shape(replay);

  const acting = await base.actingAs(ctx.db, ctx.actor.organizationId, "estimate", ctx);
  if (!acting.ok) throw new ConflictError(acting.reason);
  if (!acting.settings.enabled) throw new ConflictError("The estimate drafter is off. An owner can turn it on under Settings, AI agents.");

  const { job, facts: jobFacts } = await facts(acting.ctx, input.jobId);
  const now = (deps.now ?? (() => new Date()))();
  const { company, book } = await inTenant(acting.ctx, async (tx) => ({
    company: await companyOf(tx, ctx.actor.organizationId, now),
    book: await bookItems(tx, ctx.actor.organizationId, { limit: 300 }),
  }));
  if (book.items.length === 0) throw new ConflictError("The price book is empty, so there is nothing to draft an estimate from.");

  const prompt = a.estimatePrompt({ company, tone: acting.settings.tone, job: jobFacts, book: book.items, bookTruncated: book.truncated });
  const answer = await base.ask(acting, "estimate", prompt, "estimate:draft", deps);
  if (!answer.ok) throw new ConflictError(answer.reason);

  if (answer.action.name === "cannot_estimate") {
    const reason = String(answer.input["reason"]);
    const row = await inTenant(acting.ctx, async (tx) => {
      const { row } = await base.propose(tx, acting, {
        agent: "estimate", action: "cannot_estimate", sourceKind: "job", sourceId: job.id,
        summary: `Could not draft: ${reason}`, draft: { reason, jobId: job.id }, usageId: answer.usageId,
        idempotencyKey: ctx.idempotencyKey,
      });
      const [closed] = await tx.update(schema.aiAgentProposal).set({ status: "dismissed", note: reason, updatedAt: new Date() })
        .where(eq(schema.aiAgentProposal.id, row.id)).returning();
      return closed!;
    });
    return base.shape(row);
  }

  const book2 = new Map(book.items.map((item) => [item.id, item]));
  const priced = a.priceDraft(answer.input["options"] as a.DraftOption[], book2);
  if (!priced.ok) {
    await inTenant(acting.ctx, (tx) => base.note(tx, acting.ctx, { agent: "estimate", kind: "refused", detail: priced.reason }));
    throw new ConflictError(priced.reason);
  }

  const draftBody: EstimateDraft = {
    jobId: job.id, jobNumber: job.number, customerId: job.customerId, propertyId: job.propertyId,
    summary: String(answer.input["summary"]), options: priced.options,
  };
  const { row, created } = await inTenant(acting.ctx, async (tx) => {
    /** A fresh draft replaces the open one for the same job rather than sitting beside it. */
    await tx.update(schema.aiAgentProposal).set({ status: "superseded", updatedAt: new Date() })
      .where(and(
        eq(schema.aiAgentProposal.agent, "estimate"), eq(schema.aiAgentProposal.sourceKind, "job"),
        eq(schema.aiAgentProposal.sourceId, job.id), eq(schema.aiAgentProposal.status, "proposed"),
      ));
    return base.propose(tx, acting, {
      agent: "estimate", action: "draft_estimate", sourceKind: "job", sourceId: job.id,
      summary: `Job ${job.number}: ${priced.options.length} option${priced.options.length === 1 ? "" : "s"}, ${draftBody.summary.slice(0, 140)}`,
      draft: draftBody as unknown as Record<string, unknown>, usageId: answer.usageId,
      idempotencyKey: ctx.idempotencyKey,
    });
  });
  if (created && a.actsAlone("estimate", acting.settings)) return accept(acting.ctx, { id: row.id }, true);
  return base.shape(row);
}

/**
 * Turn a draft into a draft estimate, for a person to edit and send.
 *
 * Through `estimates.create`, the same call the estimate screen makes, with
 * the price book item on every line so the estimate keeps the link to the book
 * and the cost the book holds, and the price already the book's.
 */
export async function accept(ctx: ServiceContext, input: { id: string }, automatic = false) {
  const row = await guardedRead(ctx, "estimate:write", (tx) => base.proposalWithin(tx, "estimate", input.id));
  if (row.status === "applied") return base.shape(row);
  if (row.status !== "proposed" || row.action !== "draft_estimate") {
    throw new ConflictError(`This draft was ${row.status}, so there is nothing to turn into an estimate.`);
  }
  const body = row.draft as unknown as EstimateDraft;
  const estimate = await estimates.create({ ...ctx, idempotencyKey: `ai-estimate:${row.id}` }, {
    customerId: body.customerId,
    propertyId: body.propertyId,
    jobId: body.jobId,
    title: `Options for job ${body.jobNumber}`,
    options: body.options.map((option) => ({
      name: option.name,
      ...(option.description ? { description: option.description } : {}),
      isRecommended: option.recommended,
      lines: option.lines.map((line) => ({
        priceBookItemId: line.priceBookItemId,
        name: line.name,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
        discountAmount: "0",
        taxable: true,
        isOptional: false,
        isSelected: false,
      })),
    })),
  }) as { id: string };
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    const applied = await base.markApplied(tx, ctx, row, {
      automatic,
      outcome: { estimateId: estimate.id },
      detail: `Drafted an estimate for job ${body.jobNumber}${automatic ? " on its own" : ""}. It has not been sent.`,
    });
    return base.shape(applied);
  });
}

export const handlers = {
  listEstimateDrafts: (ctx: ServiceContext, input: { jobId?: string | undefined; limit?: number | undefined }) =>
    base.proposals(ctx, "estimate:read", "estimate", {
      ...(input.jobId ? { sourceKind: "job", sourceId: input.jobId } : {}),
      limit: input.limit,
    }),
  createEstimateDraft: (ctx: ServiceContext, input: { jobId: string }) => draft(ctx, input),
  acceptEstimateDraft: (ctx: ServiceContext, input: { id: string }) => accept(ctx, input),
  dismissEstimateDraft: (ctx: ServiceContext, input: { id: string; reason?: string | undefined }) =>
    base.dismiss(ctx, "estimate:write", "estimate", input),
} as const;
