import { and, eq, isNull, desc } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { comms } from "@opentradesos/core";
import type { ServiceContext } from "./context";
import { raise } from "./tasks";

/**
 * WHAT A WORKFLOW STEP ACTUALLY DOES
 *
 * One executor so far, and it is the one worth doing first because it
 * exercises everything: the permission the run was granted, the consent
 * decision, the suppression list, and the conversation thread.
 *
 * The property this file exists to hold is that CONSENT IS CHECKED AT SEND
 * TIME, not at authoring time. A workflow written in March is still running
 * in November, and the customer who revoked in June must not receive it. An
 * author cannot know that and must not be trusted to.
 */

export type StepResult =
  | { ok: true; output?: Record<string, unknown> }
  | { ok: false; reason: string };

/**
 * Fills `{{ job.summary }}` style placeholders from the event payload.
 *
 * Substitution only. No expressions, no function calls, nothing evaluated,
 * for the same reason conditions are data: a template language that executes
 * is arbitrary code execution wearing a friendly name, in a product a
 * contractor self hosts.
 *
 * An unresolved placeholder becomes an empty string rather than being left
 * as literal braces, because "Hi {{ customer.name }}" reaching a customer is
 * worse than "Hi ".
 */
export function render(template: string, scope: Record<string, unknown>): string {
  return template.replace(/\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g, (_, path: string) => {
    const value = readPath(scope, path);
    return value === null || value === undefined ? "" : String(value);
  });
}

function readPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const part of path.split(".")) {
    if (part === "__proto__" || part === "constructor" || part === "prototype") return undefined;
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Send a message to the customer this event is about.
 *
 * The recipient comes from the EVENT rather than from a lookup, because a
 * workflow firing on an event a week old should message whoever that event
 * concerned. Following the record forward would text whoever owns the
 * property now.
 */
export async function sendMessage(
  tx: Database,
  ctx: ServiceContext,
  config: Record<string, unknown>,
  event: typeof schema.domainEvent.$inferSelect,
  runId: string,
): Promise<StepResult> {
  const organizationId = ctx.actor.organizationId;
  const channel = (config["channel"] as comms.Channel) ?? "sms";
  const purpose = (config["purpose"] as comms.Purpose) ?? "transactional";
  const body = typeof config["body"] === "string" ? config["body"] : "";
  if (body.trim() === "") return { ok: false, reason: "step has no body" };

  const payload = event.payload as Record<string, unknown>;
  const customerId = (config["customerId"] as string | undefined)
    ?? readPath(payload, "job.customerId") as string | undefined
    ?? readPath(payload, "customer.id") as string | undefined;
  if (!customerId) return { ok: false, reason: "no customer on the event" };

  const [customer] = await tx.select().from(schema.customer)
    .where(and(eq(schema.customer.id, customerId), isNull(schema.customer.deletedAt)))
    .limit(1);
  if (!customer) return { ok: false, reason: "customer not found" };

  const address = channel === "email" ? customer.email : customer.phone;
  if (!address) return { ok: false, reason: `customer has no ${channel} address` };

  /**
   * A sending number that is actually cleared to send. Absent one, the send
   * is refused rather than attempted: an unregistered send is not merely
   * rejected by the carrier, it counts against the sender.
   */
  const [from] = await tx.select().from(schema.phoneNumber)
    .where(and(
      eq(schema.phoneNumber.organizationId, organizationId),
      isNull(schema.phoneNumber.releasedAt),
      channel === "sms" || channel === "mms"
        ? eq(schema.phoneNumber.smsRegistered, true)
        : undefined,
    ))
    .orderBy(desc(schema.phoneNumber.createdAt))
    .limit(1);

  if (!from && channel !== "email") {
    return { ok: false, reason: "no registered sending number" };
  }

  const consents = await tx.select().from(schema.communicationConsent)
    .where(and(
      eq(schema.communicationConsent.organizationId, organizationId),
      eq(schema.communicationConsent.address, address),
      isNull(schema.communicationConsent.supersededAt),
    ));

  const suppressions = await tx.select().from(schema.suppression)
    .where(and(
      eq(schema.suppression.organizationId, organizationId),
      eq(schema.suppression.address, address),
      isNull(schema.suppression.liftedAt),
    ));

  /**
   * The decision, at send time. This is the whole point of the executor.
   */
  const decision = comms.canSend({
    channel,
    purpose,
    consents: consents.map((c) => ({
      channel: c.channel as comms.Channel,
      purpose: c.purpose as comms.Purpose,
      state: c.state as comms.ConsentState,
      capturedAt: c.capturedAt,
      supersededAt: c.supersededAt,
    })),
    suppressions: suppressions.map((s) => ({
      channel: s.channel as comms.Channel,
      purpose: s.purpose as comms.Purpose | null,
      liftedAt: s.liftedAt,
    })),
    channelRegistered: channel === "email" ? true : Boolean(from?.smsRegistered),
  });

  if (!decision.allowed) {
    /**
     * A refusal is a successful step, not a failed one. The workflow did
     * exactly what it should: it checked and did not send. Failing the run
     * would make a correctly suppressed customer look like a broken
     * automation, and an operator would go turn the guard off.
     */
    return { ok: true, output: { sent: false, refused: decision.reason } };
  }

  const rendered = render(body, { ...payload, customer });

  const conversationId = await threadFor(tx, {
    organizationId, channel, address, customerId,
    phoneNumberId: from?.id ?? null,
    jobId: (readPath(payload, "job.id") as string | undefined) ?? null,
  });

  const [message] = await tx.insert(schema.message).values({
    organizationId,
    conversationId,
    direction: "outbound",
    channel,
    purpose,
    fromAddress: channel === "email" ? "" : from!.e164,
    toAddress: address,
    body: rendered,
    status: "queued",
    consentId: decision.consent ? findConsentId(consents, decision.consent) : null,
    /**
     * The RUN, not the event. Several workflows can react to one event, so an
     * event id answers "what happened" and leaves "which automation sent
     * this" ambiguous. The run names the version, the version names the
     * steps, and a customer asking why they got a text is one join away.
     */
    automationRef: `run:${runId}`,
  }).returning({ id: schema.message.id });

  await tx.update(schema.conversation).set({
    lastMessageAt: new Date(),
    lastMessagePreview: rendered.slice(0, 200),
  }).where(eq(schema.conversation.id, conversationId));

  /**
   * Queued rather than sent. Handing it to a provider is the provider
   * adapter's job, and a step that claimed to have sent something it only
   * wrote to a table would make the whole log untrustworthy.
   */
  return { ok: true, output: { sent: false, queued: true, messageId: message!.id } };
}

function findConsentId(
  rows: (typeof schema.communicationConsent.$inferSelect)[],
  consent: { capturedAt: Date; purpose: string; channel: string },
): string | null {
  return rows.find((r) =>
    r.purpose === consent.purpose && r.channel === consent.channel &&
    r.capturedAt.getTime() === consent.capturedAt.getTime())?.id ?? null;
}

/** The open thread with this address, or a new one. */
async function threadFor(tx: Database, input: {
  organizationId: string; channel: comms.Channel; address: string;
  customerId: string; phoneNumberId: string | null; jobId: string | null;
}): Promise<string> {
  const [existing] = await tx.select({ id: schema.conversation.id })
    .from(schema.conversation)
    .where(and(
      eq(schema.conversation.organizationId, input.organizationId),
      eq(schema.conversation.channel, input.channel),
      eq(schema.conversation.externalAddress, input.address),
      isNull(schema.conversation.deletedAt),
    ))
    .orderBy(desc(schema.conversation.createdAt))
    .limit(1);
  if (existing) return existing.id;

  const [created] = await tx.insert(schema.conversation).values({
    organizationId: input.organizationId,
    channel: input.channel,
    externalAddress: input.address,
    phoneNumberId: input.phoneNumberId,
    customerId: input.customerId,
    jobId: input.jobId,
    status: "open",
  }).returning({ id: schema.conversation.id });
  return created!.id;
}


/**
 * Raise a task from a workflow.
 *
 * The step that turns an event into something a person actually sees.
 * Relying on somebody to notice that an estimate went unanswered for five
 * days is relying on a report nobody runs; the event is already in the log,
 * and this is what makes it visible.
 *
 * Idempotent on (run, entity), so a workflow that fires repeatedly does not
 * raise the same task every hour until somebody turns the automation off.
 */
export async function createTask(
  tx: Database,
  ctx: ServiceContext,
  config: Record<string, unknown>,
  event: typeof schema.domainEvent.$inferSelect,
  runId: string,
): Promise<StepResult> {
  const payload = event.payload as Record<string, unknown>;
  const title = render(String(config["title"] ?? ""), payload).trim();
  if (title === "") return { ok: false, reason: "step has no title" };

  const dueInHours = Number(config["dueInHours"] ?? 0);
  const entityId = (config["entityId"] as string | undefined)
    ?? (event.entityId ?? undefined);

  const result = await raise(tx, ctx.actor.organizationId, runId, {
    title,
    body: config["body"] ? render(String(config["body"]), payload) : undefined,
    priority: (config["priority"] as "low" | "normal" | "high" | "urgent" | undefined),
    entityType: (config["entityType"] as string | undefined) ?? event.entityType,
    entityId,
    queue: config["queue"] as string | undefined,
    ...(dueInHours > 0 ? { dueAt: new Date(Date.now() + dueInHours * 3_600_000) } : {}),
  });

  /**
   * A duplicate is a successful step, not a failed one. The workflow did what
   * it should: it checked and did not raise a second copy.
   */
  return { ok: true, output: { taskId: result.id, created: result.created } };
}
