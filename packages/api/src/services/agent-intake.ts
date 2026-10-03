import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { agents as a } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, inTenant, scopeOf, audit,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { conversationScopeFilter, customerScopeFilter } from "./scope";
import * as booking from "./booking";
import * as jobs from "./jobs";
import * as base from "./agents";
import { companyOf, servicesAndWindows } from "./agent-facts";
import type { AiDeps } from "./ai";

/**
 * THE INTAKE AGENT
 *
 * A text at nine at night says the water heater is leaking. Without this, it
 * waits for somebody to read it in the morning, ring back, take the address,
 * and find a slot. With it, the agent reads the message and drafts the whole
 * booking, and the office books it with one click: the customer matched or
 * new, the address, the problem in a sentence, the service and how soon, and
 * the windows the online booking page would have offered.
 *
 * THE APPROVAL IS THE BOOKING PAGE'S OWN PATH. A booking request is made
 * exactly as the website makes one (so the window is re-checked for room and
 * the marketing touch is recorded), confirmed exactly as the office confirms
 * one (so the customer is matched on the address and the work is credited),
 * and given its visit in the chosen window. Nothing here books anything the
 * booking page and the office screens could not.
 *
 * Reads a text or email thread, a call's transcript or a web form. A company
 * with no online booking services gets the summary and no windows, and books
 * it by hand: the windows come from online booking and nowhere else.
 */

export type SourceKind = "conversation" | "call" | "form_submission";

export interface IntakeSourceInput { kind: SourceKind; id: string }

interface Gathered {
  source: a.IntakeSource;
  customerId: string | null;
  phone: string | null;
  email: string | null;
}

/** What the customer said, from wherever they said it, read as the agent's person. */
async function gather(tx: Database, ctx: ServiceContext, input: IntakeSourceInput): Promise<Gathered> {
  if (input.kind === "conversation") {
    const [conversation] = await tx.select().from(schema.conversation)
      .where(and(
        eq(schema.conversation.id, input.id),
        isNull(schema.conversation.deletedAt),
        conversationScopeFilter(scopeOf(ctx, "conversation"), ctx.actor),
      )).limit(1);
    if (!conversation) throw new NotFoundError("Conversation");
    const messages = await tx.select().from(schema.message)
      .where(eq(schema.message.conversationId, conversation.id))
      .orderBy(desc(schema.message.createdAt)).limit(12);
    const inbound = messages.filter((m) => m.direction === "inbound");
    if (inbound.length === 0) throw new ConflictError("The customer has not written anything in this conversation yet.");
    /** Oldest first, both sides, so "yes, Tuesday works" is read against what it answered. */
    const text = [...messages].reverse()
      .map((m) => `${m.direction === "inbound" ? "Customer" : "Company"}: ${m.subject ? `[${m.subject}] ` : ""}${m.body ?? ""}`)
      .join("\n");
    const byEmail = conversation.channel === "email";
    return {
      source: {
        kind: byEmail ? "email" : "text",
        from: conversation.externalAddress,
        at: inbound[0]!.createdAt.toISOString(),
        text,
      },
      customerId: conversation.customerId,
      phone: byEmail ? null : conversation.externalAddress,
      email: byEmail ? conversation.externalAddress : null,
    };
  }
  if (input.kind === "call") {
    const [call] = await tx.select().from(schema.call).where(eq(schema.call.id, input.id)).limit(1);
    if (!call) throw new NotFoundError("Call");
    const text = call.transcriptText ?? call.transcript;
    if (!text) throw new ConflictError("This call has no transcript to read yet.");
    return {
      source: { kind: "call", from: call.fromE164, at: (call.startedAt ?? call.createdAt).toISOString(), text },
      customerId: call.customerId, phone: call.fromE164, email: null,
    };
  }
  const [submission] = await tx.select().from(schema.formSubmission)
    .where(eq(schema.formSubmission.id, input.id)).limit(1);
  if (!submission) throw new NotFoundError("Form submission");
  const fields = submission.clean ?? submission.raw;
  const text = Object.entries(fields)
    .filter(([key]) => !key.startsWith("ot_"))
    .map(([key, value]) => `${key}: ${typeof value === "string" ? value : JSON.stringify(value)}`)
    .join("\n");
  const pick = (...keys: string[]) => {
    for (const key of keys) {
      const value = fields[key];
      if (typeof value === "string" && value.trim() !== "") return value.trim();
    }
    return null;
  };
  return {
    source: { kind: "form", from: pick("email", "phone"), at: submission.createdAt.toISOString(), text },
    customerId: submission.customerId,
    phone: pick("phone", "mobile", "telephone"),
    email: pick("email"),
  };
}

/**
 * Customers this might be, within what the agent's person may see.
 *
 * By the number's digits, the email, the customer already on the thread and
 * the first word of a name in the text. The model chooses among these or says
 * nobody; it cannot name anybody else, because a customer id not on this list
 * is dropped when its answer is checked.
 */
async function candidatesFor(tx: Database, ctx: ServiceContext, gathered: Gathered): Promise<a.CustomerCandidate[]> {
  const digits = (gathered.phone ?? "").replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const ors = [
    gathered.customerId ? eq(schema.customer.id, gathered.customerId) : undefined,
    local.length >= 7
      ? sql`right(regexp_replace(coalesce(${schema.customer.phone}, ''), '[^0-9]', '', 'g'), 10) = ${local.slice(-10)}`
      : undefined,
    gathered.email ? ilike(schema.customer.email, gathered.email) : undefined,
  ].filter((x) => x !== undefined);
  if (ors.length === 0) return [];
  const rows = await tx.select({
    id: schema.customer.id, name: schema.customer.name,
    phone: schema.customer.phone, email: schema.customer.email,
  }).from(schema.customer)
    .where(and(
      isNull(schema.customer.deletedAt),
      or(...ors),
      customerScopeFilter(scopeOf(ctx, "customer"), ctx.actor),
    )).limit(5);
  const out: a.CustomerCandidate[] = [];
  for (const row of rows) {
    const [place] = await tx.select({
      line1: schema.property.addressLine1, city: schema.property.city, postal: schema.property.postalCode,
    }).from(schema.customerProperty)
      .innerJoin(schema.property, eq(schema.property.id, schema.customerProperty.propertyId))
      .where(and(eq(schema.customerProperty.customerId, row.id), isNull(schema.customerProperty.endedOn)))
      .orderBy(desc(schema.customerProperty.isPrimary)).limit(1);
    out.push({
      id: row.id, name: row.name, phone: row.phone, email: row.email,
      address: place ? `${place.line1}, ${place.city} ${place.postal}` : null,
    });
  }
  return out;
}

const URGENCY_WORDS = { emergency: "emergency", soon: "soon", routine: "routine" } as const;

/**
 * Read a source and draft a booking, or hand back the open draft for it.
 *
 * `startedBy` is the person who asked, when somebody did; the worker passes
 * none and the agent runs as the person on its settings.
 */
export async function run(
  db: Database, organizationId: string, input: IntakeSourceInput,
  options: { startedBy?: ServiceContext | undefined; idempotencyKey?: string | undefined; deps?: AiDeps | undefined } = {},
): Promise<{ draft: base.ProposalView | null; reason: string | null }> {
  const deps = options.deps ?? base.DEFAULT_AGENT_DEPS;
  const acting = await base.actingAs(db, organizationId, "intake", options.startedBy);
  if (!acting.ok) return { draft: null, reason: acting.reason };
  if (!acting.settings.enabled) {
    return { draft: null, reason: "The intake agent is off. An owner can turn it on under Settings, AI agents." };
  }
  const { ctx } = acting;

  const now = (deps.now ?? (() => new Date()))();
  const prepared = await inTenant(ctx, async (tx) => {
    const replay = await base.proposalByKey(tx, options.idempotencyKey);
    if (replay) return { existing: replay } as const;
    const [open] = await tx.select().from(schema.aiAgentProposal)
      .where(and(
        eq(schema.aiAgentProposal.agent, "intake"),
        eq(schema.aiAgentProposal.sourceKind, input.kind),
        eq(schema.aiAgentProposal.sourceId, input.id),
        eq(schema.aiAgentProposal.status, "proposed"),
      )).limit(1);
    if (open) return { existing: open } as const;

    const gathered = await gather(tx, ctx, input);
    const company = await companyOf(tx, organizationId, now);
    const candidates = await candidatesFor(tx, ctx, gathered);
    const { services, windows } = await servicesAndWindows(tx, organizationId, company.timezone, company.today);
    return { existing: null, gathered, company, candidates, services, windows } as const;
  });
  if (prepared.existing) return { draft: base.shape(prepared.existing), reason: null };
  const { gathered, company, candidates, services, windows } = prepared;

  const prompt = a.intakePrompt({
    company, tone: acting.settings.tone, source: gathered.source, candidates,
    services: services.map((s) => ({ id: s.id, name: s.publicName, description: s.publicDescription })),
    windows,
  });
  const answer = await base.ask(acting, "intake", prompt, `intake:${input.kind}`, deps);
  if (!answer.ok) {
    if (options.startedBy) throw new ConflictError(answer.reason);
    return { draft: null, reason: answer.reason };
  }

  if (answer.action.name === "not_a_booking") {
    /**
     * Written down, and closed at once. It is not work for the office's list,
     * and it is what stops the next pass reading the same message again and
     * paying for the same answer.
     */
    const reason = String(answer.input["reason"] ?? "Not a booking.");
    const row = await inTenant(ctx, async (tx) => {
      const { row } = await base.propose(tx, acting, {
        agent: "intake", action: "not_a_booking", sourceKind: input.kind, sourceId: input.id,
        summary: `Not a booking: ${reason}`, draft: { reason }, usageId: answer.usageId,
        idempotencyKey: options.idempotencyKey,
      });
      const [closed] = await tx.update(schema.aiAgentProposal).set({
        status: "dismissed", note: reason, decidedAt: new Date(), updatedAt: new Date(),
      }).where(eq(schema.aiAgentProposal.id, row.id)).returning();
      return closed!;
    });
    return { draft: base.shape(row), reason };
  }

  /* The checks a booking draft is held to before anybody sees it. */
  const input2 = answer.input;
  const customer = candidates.find((c) => c.id === input2["customerId"]) ?? null;
  const service = services.find((s) => s.id === input2["bookableServiceId"]) ?? null;
  const picked = (input2["windows"] as { date: string; arrivalWindowId: string }[] | undefined) ?? [];
  const open = a.openOnly(picked, service?.id ?? null, windows);
  const dropped = picked.length - open.length;
  const address = (input2["address"] as Record<string, string> | undefined) ?? null;
  const missing = [...((input2["missing"] as string[] | undefined) ?? [])];
  if (!address) missing.push("The address.");
  if (!service) missing.push(services.length === 0 ? "No online booking services are set up, so book this one by hand." : "Which service this is.");
  if (!input2["phone"] && !input2["email"] && !gathered.phone && !gathered.email) missing.push("A phone number or email.");

  const draft = {
    customerId: customer?.id ?? null,
    customerName: customer?.name ?? null,
    contactName: String(input2["contactName"]),
    phone: (input2["phone"] as string | undefined) ?? gathered.phone,
    email: (input2["email"] as string | undefined) ?? gathered.email,
    address,
    problemSummary: String(input2["problemSummary"]),
    urgency: URGENCY_WORDS[input2["urgency"] as keyof typeof URGENCY_WORDS],
    bookableServiceId: service?.id ?? null,
    serviceName: service?.publicName ?? null,
    jobTypeId: service?.jobTypeId ?? null,
    windows: open,
    missing,
    /** Said, rather than silently dropped, so the office knows the agent reached for something that was not there. */
    droppedWindows: dropped,
    source: { kind: gathered.source.kind, from: gathered.source.from },
  };
  const summary = `${draft.customerName ?? draft.contactName}: ${draft.problemSummary.slice(0, 160)} (${draft.urgency})`;

  const row = await inTenant(ctx, (tx) => base.propose(tx, acting, {
    agent: "intake", action: "propose_booking", sourceKind: input.kind, sourceId: input.id,
    summary, draft: draft as unknown as Record<string, unknown>, usageId: answer.usageId,
    idempotencyKey: options.idempotencyKey,
  }));

  /**
   * ACTING ALONE, only when the company chose it and the draft is complete.
   * A draft with no window or no address waits for a person whatever the
   * setting says: there is nothing safe to book.
   */
  if (row.created && a.actsAlone("intake", acting.settings) && open.length > 0 && address && service) {
    try {
      await apply(ctx, row.row.id, { automatic: true });
    } catch (error) {
      await inTenant(ctx, (tx) => base.markFailed(tx, ctx, row.row,
        `Could not book it on its own: ${error instanceof Error ? error.message : "unknown error"}. It is waiting for a person.`, true));
    }
    const [after] = await inTenant(ctx, (tx) => tx.select().from(schema.aiAgentProposal)
      .where(eq(schema.aiAgentProposal.id, row.row.id)).limit(1));
    return { draft: base.shape(after!), reason: null };
  }
  return { draft: base.shape(row.row), reason: null };
}

export interface ApproveInput {
  id: string;
  /** The window the office chose, when not the agent's first. */
  date?: string | undefined;
  arrivalWindowId?: string | undefined;
  /** Book it for this customer instead of the agent's match. */
  customerId?: string | undefined;
}

/**
 * Book it.
 *
 * Three steps through three existing paths, each safe to repeat, so a retry
 * after a dropped connection finishes the booking rather than making a second
 * one: the request (deduplicated on the proposal), the confirmation (a no-op
 * on a request already confirmed) and the visit (keyed on the proposal).
 */
export async function approve(ctx: ServiceContext, input: ApproveInput) {
  return apply(ctx, input.id, { automatic: false, choice: input });
}

async function apply(
  ctx: ServiceContext, id: string, options: { automatic: boolean; choice?: ApproveInput | undefined },
) {
  const loaded = await guardedRead(ctx, "booking:decide", async (tx) => {
    const row = await base.proposalWithin(tx, "intake", id);
    const [org] = await tx.select({ slug: schema.organization.slug, timezone: schema.organization.timezone })
      .from(schema.organization).where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    return { row, org: org! };
  });
  const { row, org } = loaded;
  if (row.status === "applied") return base.shape(row);
  if (row.status !== "proposed") throw new ConflictError(`This draft was ${row.status}, so there is nothing to book.`);
  if (row.action !== "propose_booking") throw new ConflictError("This draft is not a booking.");

  const draft = row.draft as {
    customerId: string | null; contactName: string; phone: string | null; email: string | null;
    address: { line1: string; line2?: string; city: string; state: string; postalCode: string } | null;
    problemSummary: string; bookableServiceId: string | null; jobTypeId: string | null;
    windows: a.OpenWindow[];
  };
  const choice = options.choice;
  const chosen = choice?.date && choice.arrivalWindowId
    ? { date: choice.date, arrivalWindowId: choice.arrivalWindowId }
    : draft.windows[0] ?? null;
  if (!draft.bookableServiceId) throw new ConflictError("This draft has no service to book. Book it by hand from the job screen.");
  if (!chosen) throw new ConflictError("Choose a window to book it in.");
  if (!draft.address) throw new ConflictError("This draft has no address. Ask the customer, then book it by hand.");
  if (!draft.phone && !draft.email) throw new ConflictError("This draft has no phone number or email to confirm the booking with.");

  const [window] = await guardedRead(ctx, "booking:decide", (tx) => tx.select().from(schema.arrivalWindow)
    .where(eq(schema.arrivalWindow.id, chosen.arrivalWindowId)).limit(1));
  if (!window) throw new ConflictError("That window no longer exists. Choose another.");

  const email = draft.email && /.+@.+\..+/.test(draft.email) ? draft.email : undefined;
  const request = await booking.createRequest(ctx.db, {
    organizationSlug: org.slug,
    bookableServiceId: draft.bookableServiceId,
    requestedDate: chosen.date,
    arrivalWindowId: chosen.arrivalWindowId,
    contactName: draft.contactName,
    ...(email ? { contactEmail: email } : {}),
    ...(draft.phone ? { contactPhone: draft.phone } : {}),
    addressLine1: draft.address.line1,
    ...(draft.address.line2 ? { addressLine2: draft.address.line2 } : {}),
    city: draft.address.city,
    state: draft.address.state,
    postalCode: draft.address.postalCode,
    notes: draft.problemSummary,
    intakeAnswers: {},
    utm: {},
  }, { idempotencyKey: `ai-intake:${row.id}` });

  const customerId = choice?.customerId ?? draft.customerId ?? undefined;
  const confirmed = await booking.confirm(ctx, {
    id: request.request.id,
    ...(customerId ? { customerId } : {}),
    ...(draft.jobTypeId ? { jobTypeId: draft.jobTypeId } : {}),
  });

  const start = booking.windowStart(chosen.date, window.startsAt, org.timezone);
  const end = booking.windowStart(chosen.date, window.endsAt, org.timezone);
  const visit = await jobs.addVisit({ ...ctx, idempotencyKey: `ai-intake:${row.id}:visit` }, {
    id: confirmed.jobId,
    windowStart: start.toISOString(),
    windowEnd: end.toISOString(),
    estimatedDurationMinutes: 60,
    technicianIds: [],
  });

  return guardedWrite(ctx, "booking:decide", async (tx) => {
    /** The thread, call or form now belongs to the customer and the work it became. */
    if (row.sourceKind === "conversation") {
      await tx.update(schema.conversation).set({
        customerId: sql`coalesce(${schema.conversation.customerId}, ${confirmed.customerId}::uuid)`,
        jobId: sql`coalesce(${schema.conversation.jobId}, ${confirmed.jobId}::uuid)`,
        updatedAt: new Date(),
      }).where(eq(schema.conversation.id, row.sourceId));
    } else if (row.sourceKind === "call") {
      await tx.update(schema.call).set({
        customerId: sql`coalesce(${schema.call.customerId}, ${confirmed.customerId}::uuid)`,
        jobId: sql`coalesce(${schema.call.jobId}, ${confirmed.jobId}::uuid)`,
        updatedAt: new Date(),
      }).where(eq(schema.call.id, row.sourceId));
    } else if (row.sourceKind === "form_submission") {
      await tx.update(schema.formSubmission).set({
        customerId: sql`coalesce(${schema.formSubmission.customerId}, ${confirmed.customerId}::uuid)`,
        jobId: sql`coalesce(${schema.formSubmission.jobId}, ${confirmed.jobId}::uuid)`,
        updatedAt: new Date(),
      }).where(eq(schema.formSubmission.id, row.sourceId));
    }
    const [fresh] = await tx.select().from(schema.aiAgentProposal).where(eq(schema.aiAgentProposal.id, row.id)).limit(1);
    if (fresh?.status === "applied") return base.shape(fresh);
    const applied = await base.markApplied(tx, ctx, row, {
      automatic: options.automatic,
      outcome: {
        bookingRequestId: request.request.id, customerId: confirmed.customerId,
        jobId: confirmed.jobId, visitId: visit.id, date: chosen.date, arrivalWindowId: chosen.arrivalWindowId,
      },
      detail: `Booked ${draft.contactName} for ${chosen.date}${options.automatic ? " on its own" : ""}.`,
    });
    return base.shape(applied);
  });
}

/**
 * Book a request somebody made themselves, on the website or through the chat
 * agent, into a job with its visit in the window they chose.
 *
 * The same two steps as booking a draft, after the request already exists:
 * the office's confirmation (a no-op on a request already confirmed) and the
 * visit (keyed on the request), so a retry finishes the booking and a chat's
 * booking lands on the board the same way an intake draft's does.
 */
export async function bookRequest(ctx: ServiceContext, input: { id: string }) {
  const found = await guardedRead(ctx, "booking:decide", async (tx) => {
    const [request] = await tx.select().from(schema.bookingRequest)
      .where(eq(schema.bookingRequest.id, input.id)).limit(1);
    if (!request) throw new NotFoundError("Booking request");
    const [window] = request.arrivalWindowId
      ? await tx.select().from(schema.arrivalWindow).where(eq(schema.arrivalWindow.id, request.arrivalWindowId)).limit(1)
      : [];
    const [org] = await tx.select({ timezone: schema.organization.timezone }).from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    return { request, window: window ?? null, timezone: org!.timezone };
  });
  if (found.request.status === "declined") throw new ConflictError("This request was declined, so there is nothing to book.");
  const confirmed = await booking.confirm(ctx, { id: input.id });
  let visitId: string | null = null;
  if (found.window) {
    const visit = await jobs.addVisit({ ...ctx, idempotencyKey: `booking-request:${input.id}:visit` }, {
      id: confirmed.jobId,
      windowStart: booking.windowStart(found.request.requestedDate, found.window.startsAt, found.timezone).toISOString(),
      windowEnd: booking.windowStart(found.request.requestedDate, found.window.endsAt, found.timezone).toISOString(),
      estimatedDurationMinutes: 60,
      technicianIds: [],
    });
    visitId = visit.id;
  }
  return { bookingRequestId: input.id, customerId: confirmed.customerId, jobId: confirmed.jobId, visitId };
}

/* --------------------------------------------------------------- reading */

export function drafts(ctx: ServiceContext, input: {
  status?: ("proposed" | "applied" | "dismissed" | "failed" | "superseded")[] | undefined;
  sourceKind?: string | undefined; sourceId?: string | undefined; limit?: number | undefined;
}) {
  return base.proposals(ctx, "booking:read", "intake", input);
}

/**
 * Ask for a draft by hand, as the person asking.
 *
 * Guarded by `message:read` before anything else, because reading the
 * customer's message is the first thing it does.
 */
export async function draftNow(
  ctx: ServiceContext, input: { sourceKind: SourceKind; sourceId: string; fresh?: boolean | undefined },
  deps?: AiDeps,
) {
  await guardedWrite(ctx, "message:read", async (tx) => {
    if (!input.fresh) return;
    /** A person asking for a fresh draft closes the open one as superseded, rather than leaving two. */
    const updated = await tx.update(schema.aiAgentProposal).set({ status: "superseded", updatedAt: new Date() })
      .where(and(
        eq(schema.aiAgentProposal.agent, "intake"),
        eq(schema.aiAgentProposal.sourceKind, input.sourceKind),
        eq(schema.aiAgentProposal.sourceId, input.sourceId),
        eq(schema.aiAgentProposal.status, "proposed"),
      )).returning({ id: schema.aiAgentProposal.id });
    for (const row of updated) await audit(tx, ctx, "ai.proposal_superseded", "ai_agent_proposal", row.id, null, null);
  });
  const outcome = await run(ctx.db, ctx.actor.organizationId, { kind: input.sourceKind, id: input.sourceId }, {
    startedBy: ctx, idempotencyKey: ctx.idempotencyKey, deps,
  });
  if (!outcome.draft) throw new ConflictError(outcome.reason ?? "Nothing was drafted.");
  return outcome.draft;
}

/* ---------------------------------------------------------------- the worker */

/**
 * New things to read, since the agent was last turned on.
 *
 * Only what arrived after the setting was saved, so turning the agent on does
 * not read a year of old texts and bill for it. Each source is read once:
 * anything with any proposal at all, including a "not a booking", is skipped,
 * and a conversation is read again only when the customer has written since
 * its last draft.
 */
export async function pending(tx: Database, organizationId: string, since: Date, settings: a.AgentSettings, limit: number) {
  const out: IntakeSourceInput[] = [];
  const channels: ("sms" | "mms" | "email")[] = [
    ...(settings.intake.texts ? ["sms", "mms"] as const : []),
    ...(settings.intake.emails ? ["email"] as const : []),
  ];
  if (channels.length > 0) {
    const rows = await tx.execute<{ id: string }>(sql`
      select c.id from public.conversation c
      where c.organization_id = ${organizationId}
        and c.deleted_at is null
        and c.channel::text in ${sql.raw(`(${channels.map((c) => `'${c}'`).join(",")})`)}
        and exists (
          select 1 from public.message m
          where m.conversation_id = c.id and m.direction = 'inbound' and m.created_at > ${since.toISOString()}::timestamptz
            and m.created_at > coalesce((
              select max(p.created_at) from public.ai_agent_proposal p
              where p.organization_id = c.organization_id and p.agent = 'intake'
                and p.source_kind = 'conversation' and p.source_id = c.id::text
            ), '-infinity'::timestamptz)
        )
        and not exists (
          select 1 from public.ai_agent_proposal p
          where p.organization_id = c.organization_id and p.agent = 'intake' and p.status = 'proposed'
            and p.source_kind = 'conversation' and p.source_id = c.id::text
        )
        and not exists (select 1 from public.ai_chat_session s where s.conversation_id = c.id)
      order by c.last_message_at asc nulls last
      limit ${limit}`);
    out.push(...rows.map((r) => ({ kind: "conversation" as const, id: r.id })));
  }
  if (settings.intake.calls && out.length < limit) {
    const rows = await tx.execute<{ id: string }>(sql`
      select k.id from public.call k
      where k.organization_id = ${organizationId}
        and coalesce(k.transcript_text, k.transcript) is not null
        and k.updated_at > ${since.toISOString()}::timestamptz
        and not exists (
          select 1 from public.ai_agent_proposal p
          where p.organization_id = k.organization_id and p.agent = 'intake'
            and p.source_kind = 'call' and p.source_id = k.id::text
        )
      order by k.created_at asc limit ${limit - out.length}`);
    out.push(...rows.map((r) => ({ kind: "call" as const, id: r.id })));
  }
  if (settings.intake.forms && out.length < limit) {
    const rows = await tx.execute<{ id: string }>(sql`
      select f.id from public.form_submission f
      where f.organization_id = ${organizationId}
        and f.created_at > ${since.toISOString()}::timestamptz
        and f.job_id is null
        and not exists (
          select 1 from public.ai_agent_proposal p
          where p.organization_id = f.organization_id and p.agent = 'intake'
            and p.source_kind = 'form_submission' and p.source_id = f.id::text
        )
      order by f.created_at asc limit ${limit - out.length}`);
    out.push(...rows.map((r) => ({ kind: "form_submission" as const, id: r.id })));
  }
  return out;
}

export const handlers = {
  listIntakeDrafts: (ctx: ServiceContext, input: Parameters<typeof drafts>[1]) => drafts(ctx, input),
  createIntakeDraft: (ctx: ServiceContext, input: { sourceKind: SourceKind; sourceId: string; fresh?: boolean | undefined }) =>
    draftNow(ctx, input),
  approveIntakeDraft: (ctx: ServiceContext, input: ApproveInput) => approve(ctx, input),
  bookBookingRequest: (ctx: ServiceContext, input: { id: string }) => bookRequest(ctx, input),
  dismissIntakeDraft: (ctx: ServiceContext, input: { id: string; reason?: string | undefined }) =>
    base.dismiss(ctx, "booking:decide", "intake", input),
} as const;
