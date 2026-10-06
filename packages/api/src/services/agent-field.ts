import { and, asc, desc, eq, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { agents as a, assertCan, can, money as m } from "@opentradesos/core";
import {
  guardedRead, inTenant, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import * as base from "./agents";
import * as knowledge from "./knowledge";
import { companyOf } from "./agent-facts";
import { inForceAt } from "./pricebook";
import type { AiDeps } from "./ai";

/**
 * THE FIELD ASSISTANT
 *
 * A technician under a house asks, in plain words, "when was this furnace
 * last serviced", "what did Sam write last time", "what do we charge for a
 * capacitor" or "how do we flush a tankless here". The answer comes from the
 * company's own records and its how-to notes, and from nothing else:
 *
 *   WHAT IT IS GIVEN is chosen in plain code, before the model is asked, and
 *   each kind of record only when the person asking may read it themselves:
 *   the equipment at the visit's address and its history (`equipment:read`),
 *   the notes on this visit and the earlier ones there (`visit:read`), price
 *   book prices and never a cost (`pricebook:read`), and the how-to notes.
 *   The visit has to be on their own day. So the assistant can tell a
 *   technician nothing they could not have looked up.
 *
 *   WHAT IT SAYS is held to what it was given: every answer cites the facts
 *   it used, every one of them has to be a fact it was given, and every
 *   amount of money it states has to be a price in those facts. An answer
 *   that fails is not shown, and the refusal is in the agents' log.
 *
 *   WHAT IT COSTS is the same as every other agent: one model call, against
 *   the company's spend ceiling, counted against the assistant's runs a day,
 *   with tokens and cost in the usage table and no word of the question in
 *   it. A question nothing in the records matches is answered without a
 *   model call at all.
 *
 * It runs as the person asking and does nothing but answer: there is no
 * action a model could take, so there is nothing for a company to let it do
 * on its own.
 */

const STOP = new Set([
  "the", "and", "for", "how", "what", "when", "where", "who", "why", "was", "were", "this", "that", "these",
  "those", "with", "from", "have", "has", "had", "does", "did", "our", "are", "you", "your", "can", "should",
  "would", "could", "last", "time", "about", "into", "there", "here", "they", "them", "its", "any", "all",
  "much", "many", "price", "cost", "charge", "change", "need", "tell", "give", "show", "find", "we", "do",
]);

/** The words a question is matched on: lower case, three letters or more, singular, not a filler word. */
export function keywords(question: string): string[] {
  const words = question.toLowerCase().split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !STOP.has(w))
    .map((w) => (w.length > 4 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w));
  return [...new Set(words)].slice(0, 20);
}

/** How well some text matches the question: one for each word it contains, double in a title. */
function score(words: readonly string[], title: string, body: string): number {
  const t = title.toLowerCase();
  const b = body.toLowerCase();
  return words.reduce((sum, w) => sum + (t.includes(w) ? 2 : 0) + (b.includes(w) ? 1 : 0), 0);
}

const clip = (value: string, max: number) => (value.length > max ? `${value.slice(0, max)}...` : value);

interface VisitView { jobNumber: number; summary: string; customerName: string; address: string }

/**
 * Everything the assistant may answer from, for this person and this
 * question. Plain code: what a model is shown is decided here, never by it.
 */
export async function factsFor(tx: Database, ctx: ServiceContext, input: { question: string; visitId?: string | undefined }): Promise<{
  facts: a.FieldFact[]; visit: VisitView | null; jobNumber: number | null;
}> {
  const words = keywords(input.question);
  const facts: a.FieldFact[] = [];
  let visit: VisitView | null = null;
  let jobNumber: number | null = null;

  if (input.visitId) {
    const [row] = await tx.select({
      visitId: schema.visit.id, jobId: schema.job.id, jobNumber: schema.job.number, summary: schema.job.summary,
      description: schema.job.description, complaint: schema.job.customerComplaint, equipmentId: schema.job.equipmentId,
      customerName: schema.customer.name, propertyId: schema.property.id,
      address: sql<string>`${schema.property.addressLine1} || ', ' || ${schema.property.city}`,
    }).from(schema.visit)
      .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
      .innerJoin(schema.property, eq(schema.property.id, schema.job.propertyId))
      .where(eq(schema.visit.id, input.visitId)).limit(1);
    if (!row) throw new NotFoundError("Visit");

    /** On their own day, or somebody who dispatches and so may read any visit. */
    const onDay = ctx.actor.technicianId
      ? (await tx.select({ id: schema.visitAssignment.id }).from(schema.visitAssignment)
        .where(and(
          eq(schema.visitAssignment.visitId, row.visitId),
          eq(schema.visitAssignment.technicianId, ctx.actor.technicianId),
        )).limit(1)).length > 0
      : false;
    if (!onDay && !can(ctx.actor, "visit:dispatch")) throw new NotFoundError("Visit");

    jobNumber = row.jobNumber;
    visit = { jobNumber: row.jobNumber, summary: row.summary, customerName: row.customerName, address: row.address };
    facts.push({
      id: "job", kind: "job", title: `Job ${row.jobNumber}: ${row.summary}`,
      detail: [row.description, row.complaint ? `The customer said: ${row.complaint}` : null].filter(Boolean).join(" ") || row.summary,
      prices: [],
    });

    if (can(ctx.actor, "visit:read")) {
      /** This visit's notes and the latest ones written at the same address, newest first. */
      const notes = await tx.select({
        notes: schema.visit.technicianNotes, number: schema.job.number, summary: schema.job.summary,
        at: sql<Date | null>`coalesce(${schema.visit.completedAt}, ${schema.visit.windowStart})`,
      }).from(schema.visit)
        .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
        .where(and(eq(schema.job.propertyId, row.propertyId), isNotNull(schema.visit.technicianNotes)))
        .orderBy(desc(sql`coalesce(${schema.visit.completedAt}, ${schema.visit.windowStart})`))
        .limit(8);
      for (const [i, n] of notes.entries()) {
        if (!n.notes?.trim()) continue;
        const day = n.at ? new Date(n.at).toISOString().slice(0, 10) : "date not recorded";
        facts.push({
          id: `notes-${i + 1}`, kind: "notes", title: `Notes on job ${n.number} (${n.summary}), ${day}`,
          detail: clip(n.notes.trim(), 1500), prices: [],
        });
      }
    }

    if (can(ctx.actor, "equipment:read")) {
      const kit = await tx.select().from(schema.equipment)
        .where(and(eq(schema.equipment.propertyId, row.propertyId), eq(schema.equipment.active, true)))
        .orderBy(asc(schema.equipment.category)).limit(12);
      const ids = kit.map((e) => e.id);
      /** What was done to each piece, from the jobs that named it, newest first. */
      const jobs = ids.length ? await tx.select({
        equipmentId: schema.job.equipmentId, number: schema.job.number, summary: schema.job.summary,
        at: schema.job.createdAt,
      }).from(schema.job)
        .where(and(inArray(schema.job.equipmentId, ids), ne(schema.job.id, row.jobId)))
        .orderBy(desc(schema.job.createdAt)).limit(40) : [];
      const readings = ids.length ? await tx.select({
        equipmentId: schema.serviceReportField.equipmentId, label: schema.serviceReportField.label,
        numeric: schema.serviceReportField.valueNumeric, text: schema.serviceReportField.valueText,
        unit: schema.serviceReportField.unit, at: schema.serviceReportField.recordedAt,
      }).from(schema.serviceReportField)
        .where(inArray(schema.serviceReportField.equipmentId, ids))
        .orderBy(desc(schema.serviceReportField.recordedAt)).limit(60) : [];
      for (const [i, e] of kit.entries()) {
        const history = [
          ...jobs.filter((j) => j.equipmentId === e.id).slice(0, 6)
            .map((j) => `job ${j.number} on ${j.at.toISOString().slice(0, 10)}: ${j.summary}`),
          ...readings.filter((r) => r.equipmentId === e.id).slice(0, 8)
            .map((r) => `${r.label} ${r.numeric !== null ? Number(r.numeric) : r.text ?? ""}${r.unit ? ` ${r.unit}` : ""} on ${r.at.toISOString().slice(0, 10)}`),
        ];
        facts.push({
          id: `equipment-${i + 1}`, kind: history.length > 0 ? "history" : "equipment",
          title: [e.category, e.manufacturer, e.model].filter(Boolean).join(", "),
          detail: [
            e.serialNumber ? `Serial ${e.serialNumber}.` : null,
            e.location ? `In the ${e.location}.` : null,
            e.installedOn ? `Installed ${e.installedOn}${e.installedByUs ? " by us" : ""}.` : null,
            e.warrantyPartsExpiresOn ? `Parts warranty to ${e.warrantyPartsExpiresOn}.` : null,
            e.warrantyLaborExpiresOn ? `Labour warranty to ${e.warrantyLaborExpiresOn}.` : null,
            row.equipmentId === e.id ? "This job is about this unit." : null,
            history.length > 0 ? `History: ${history.join("; ")}.` : "No service history recorded on it.",
          ].filter(Boolean).join(" "),
          prices: [],
        });
      }
    }
  }

  if (can(ctx.actor, "pricebook:read") && words.length > 0) {
    /** Prices only, the price in force today, and never a cost. */
    const book = await tx.select({
      id: schema.priceBookItem.id, code: schema.priceBookItem.code, name: schema.priceBookItemVersion.name,
      description: schema.priceBookItemVersion.description, price: schema.priceBookItemVersion.price,
    }).from(schema.priceBookItemVersion)
      .innerJoin(schema.priceBookItem, eq(schema.priceBookItem.id, schema.priceBookItemVersion.itemId))
      .where(and(inForceAt(), eq(schema.priceBookItem.active, true)))
      .limit(3000);
    const ranked = book
      .map((item) => ({ item, score: score(words, `${item.name} ${item.code}`, item.description ?? "") }))
      .filter((r) => r.score > 0)
      .sort((x, y) => y.score - x.score || x.item.name.localeCompare(y.item.name))
      .slice(0, 12);
    for (const [i, { item }] of ranked.entries()) {
      facts.push({
        id: `price-${i + 1}`, kind: "price", title: `${item.name} (${item.code})`,
        detail: `${item.name}: ${m.format(m.money(item.price))}.${item.description ? ` ${clip(item.description, 300)}` : ""}`,
        prices: [item.price],
      });
    }
  }

  if (words.length > 0) {
    const notes = await knowledge.inUseWithin(tx);
    const ranked = notes
      .map((note) => ({ note, score: score(words, `${note.title} ${note.tags.join(" ")}`, note.body) }))
      .filter((r) => r.score > 0)
      .sort((x, y) => y.score - x.score)
      .slice(0, 5);
    for (const [i, { note }] of ranked.entries()) {
      facts.push({
        id: `howto-${i + 1}`, kind: "procedure", title: note.title,
        detail: clip(note.body, 3000),
        /** A note may mention a figure, and quoting it as written is quoting the company. */
        prices: a.pricesIn(note.body),
      });
    }
  }

  return { facts, visit, jobNumber };
}

export interface FieldAnswer {
  answered: boolean;
  text: string;
  sources: { kind: string; title: string }[];
}

const NOTHING = "Nothing in your company's records matches that question. Ask the office, or try other words.";

/**
 * Ask, as the person asking.
 *
 * Kept as an applied proposal with the answer and where it came from (never
 * the question), so a retry with the same key answers from the record
 * rather than asking the model, and paying, twice.
 */
export async function ask(
  ctx: ServiceContext, input: { question: string; visitId?: string | undefined }, deps: AiDeps = base.DEFAULT_AGENT_DEPS,
): Promise<FieldAnswer> {
  assertCan(ctx.actor, "field:sync");
  const replay = await inTenant(ctx, (tx) => base.proposalByKey(tx, ctx.idempotencyKey));
  if (replay) return replay.draft as unknown as FieldAnswer;

  const acting = await base.actingAs(ctx.db, ctx.actor.organizationId, "field", ctx);
  if (!acting.ok) throw new ConflictError(acting.reason);
  if (!acting.settings.enabled) {
    throw new ConflictError("The field assistant is off. An owner can turn it on under Settings, AI agents.");
  }

  const gathered = await guardedRead(acting.ctx, "job:read", (tx) => factsFor(tx, acting.ctx, input));
  const where = gathered.jobNumber !== null ? ` on job ${gathered.jobNumber}` : "";

  if (gathered.facts.length === 0) {
    const answer: FieldAnswer = { answered: false, text: NOTHING, sources: [] };
    await keep(acting, answer, null, `Nothing in the records matched a question${where}, so the model was not asked.`);
    return answer;
  }

  const now = (deps.now ?? (() => new Date()))();
  const company = await inTenant(acting.ctx, (tx) => companyOf(tx, ctx.actor.organizationId, now));
  const prompt = a.fieldPrompt({
    company, tone: acting.settings.tone, question: input.question, visit: gathered.visit, facts: gathered.facts,
  });
  const reply = await base.ask(acting, "field", prompt, "field:ask", deps);
  if (!reply.ok) throw new ConflictError(reply.reason);

  if (reply.action.name === "not_in_records") {
    const answer: FieldAnswer = {
      answered: false,
      text: `${String(reply.input["reason"]).trim()} Ask the office if you need it.`,
      sources: [],
    };
    await keep(acting, answer, reply.usageId, `Said the records do not answer a question${where}.`);
    return answer;
  }

  const verdict = a.checkFieldAnswer({
    answer: String(reply.input["answer"]),
    sources: (reply.input["sources"] as string[]) ?? [],
  }, gathered.facts);
  if (!verdict.ok) {
    await inTenant(acting.ctx, (tx) => base.note(tx, acting.ctx, { agent: "field", kind: "refused", detail: verdict.reason }));
    const answer: FieldAnswer = {
      answered: false,
      text: `${verdict.reason} Ask the office, or ask again in other words.`,
      sources: [],
    };
    await keep(acting, answer, reply.usageId, null);
    return answer;
  }

  const answer: FieldAnswer = {
    answered: true,
    text: verdict.answer,
    sources: verdict.sources.map((fact) => ({ kind: fact.kind, title: fact.title })),
  };
  await keep(acting, answer, reply.usageId,
    `Answered a question${where} from ${verdict.sources.length} record${verdict.sources.length === 1 ? "" : "s"}.`);
  return answer;
}

/** The answer, kept under the request's key, and a line in the log saying what happened without saying what was asked. */
async function keep(
  acting: Extract<base.Acting, { ok: true }>, answer: FieldAnswer, usageId: string | null, logLine: string | null,
): Promise<void> {
  const { ctx } = acting;
  await inTenant(ctx, async (tx) => {
    await tx.insert(schema.aiAgentProposal).values({
      organizationId: ctx.actor.organizationId,
      agent: "field",
      action: answer.answered ? "answer" : "not_in_records",
      status: "applied",
      sourceKind: "question",
      sourceId: crypto.randomUUID(),
      summary: answer.answered ? `Answered from ${answer.sources.length} record(s).` : "Not answered from the records.",
      draft: answer as unknown as Record<string, unknown>,
      usageId,
      runAsUserId: ctx.actor.userId,
      startedByUserId: acting.startedBy,
      decidedAt: new Date(),
      idempotencyKey: ctx.idempotencyKey ?? null,
    }).onConflictDoNothing();
    if (logLine) await base.note(tx, ctx, { agent: "field", kind: "answered", detail: logLine });
  });
}

export const handlers = {
  askFieldAssistant: (ctx: ServiceContext, input: { question: string; visitId?: string | undefined }) => ask(ctx, input),
} as const;
