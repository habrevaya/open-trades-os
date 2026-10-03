import { and, eq, isNull, desc, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import * as phoneNumbers from "./phone-numbers";
import { renderWithin } from "./message-templates";
import { automation, comms } from "@opentradesos/core";
import type { ServiceContext } from "./context";
import { raise } from "./tasks";
import { timezoneOf } from "./context";
import { deliverReport, readReportStep } from "./report-delivery";
import { mintGrant } from "./portal";
import { sendTransactional } from "./comms-send";
import * as email from "./email";
import * as reviews from "./reviews";

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
  /**
   * The step succeeded and the run must stop here until this time.
   *
   * Separate from a failure because it is not one, and separate from a plain
   * success because the run cannot carry on in this pass. The runner parks
   * the run with the time on the row, which is what makes the wait survive a
   * deploy rather than living in a timer somebody's process is holding.
   */
  | { ok: true; waitUntil: Date; output?: Record<string, unknown> }
  /**
   * The step decided, and these later steps are not to run.
   *
   * A branch. Offsets from the branch itself rather than absolute indices,
   * because the decision is made by a pure function in core that does not know
   * where in the list it sits. The runner turns them into step rows marked
   * `skipped`, which is what makes the decision durable: a run that parks on a
   * wait inside an arm resumes without re-deciding, and the arm that was not
   * taken is in the log rather than merely absent from it.
   */
  | { ok: true; skipOffsets: number[]; output?: Record<string, unknown> }
  | { ok: false; reason: string };

/** Defined in `lib/render.ts`, because the template service needs it too. */
export { render } from "../lib/render";
import { render, readPath } from "../lib/render";


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
  /**
   * A TEMPLATE CODE, OR A LITERAL BODY, AND THE CODE WINS.
   *
   * A workflow carrying its own copy of a sentence is how the same message
   * ends up written in three places that drift: the arrival notice lives in
   * `dispatch.ts`, an automation that texts on the way carries a second
   * wording, and nothing anywhere compares them. Naming a template means the
   * words live where an operator can change them without editing the
   * automation that sends them.
   *
   * A literal body stays supported, because every workflow built before
   * templates existed has one and an automation that stopped sending on the
   * day this shipped would be a worse outcome than two ways of saying it.
   *
   * A code naming a template this company has not defined falls back to the
   * literal body rather than failing: a step configured with both is a step
   * whose author wanted the template and accepted the literal as the floor.
   */
  const templateCode = typeof config["templateCode"] === "string" ? config["templateCode"] : null;
  const literal = typeof config["body"] === "string" ? config["body"] : "";

  const payload = event.payload as Record<string, unknown>;
  const customerId = (config["customerId"] as string | undefined)
    ?? readPath(payload, "job.customerId") as string | undefined
    ?? readPath(payload, "customer.id") as string | undefined;
  if (!customerId) return { ok: false, reason: "no customer on the event" };

  const [customer] = await tx.select().from(schema.customer)
    .where(and(eq(schema.customer.id, customerId), isNull(schema.customer.deletedAt)))
    .limit(1);
  if (!customer) return { ok: false, reason: "customer not found" };

  // E.164 for a number, so a STOP the carrier recorded is found. See comms.phoneAddress.
  const address = channel === "email" ? customer.email : customer.phone && comms.phoneAddress(customer.phone);
  if (!address) return { ok: false, reason: `customer has no ${channel} address` };

  /**
   * A sending number that is actually cleared to send. Absent one, the send
   * is refused rather than attempted: an unregistered send is not merely
   * rejected by the carrier, it counts against the sender.
   */
  /** The same rule the direct sender uses. See `senderFor` for why not the newest. */
  const from = await phoneNumbers.senderFor(tx, organizationId, {
    smsRequired: channel === "sms" || channel === "mms",
  });

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

  const scope = { ...payload, customer };

  const fromTemplate = templateCode
    ? await renderWithin(tx, organizationId, templateCode, scope)
    : null;

  const rendered = fromTemplate?.body.trim() ? fromTemplate.body : render(literal, scope);

  /**
   * CHECKED HERE RATHER THAN AT THE TOP, because until the template has been
   * looked up there is no way to know whether an empty literal body is a
   * misconfigured step or a step that gets its words from somewhere else.
   * The original check ran before the lookup existed and would have refused
   * every template-driven step in the product.
   */
  if (rendered.trim() === "") {
    return { ok: false, reason: templateCode
      ? `template "${templateCode}" is not defined here and the step has no body to fall back on`
      : "step has no body" };
  }

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

/**
 * WAITING
 *
 * "Wait three days, then chase" is what most of the automations a contractor
 * actually wants look like, and the naive version of this step is
 * `setTimeout`. Three days of setTimeout does not survive a deploy, a restart
 * or a crash, and the symptom is the quietest possible one: the chase never
 * happens and nothing anywhere records that it was supposed to.
 *
 * So the wait is a time written on the run. The process holds nothing, and
 * the same tick that fires schedules picks the run back up.
 *
 * `until` is an absolute time, `minutes`, `hours` and `days` are relative to
 * now. Relative is what people write; absolute is what a branch computing a
 * date needs.
 */
export function waitStep(
  config: Record<string, unknown>,
  now = new Date(),
): StepResult {
  const until = config["until"];
  if (typeof until === "string") {
    const at = new Date(until);
    if (Number.isNaN(at.getTime())) return { ok: false, reason: `not a time: ${until}` };
    /**
     * A wait that is already over is not an error and not a wait. Parking the
     * run would mean a tick, a claim and a resume to achieve nothing, and
     * "wait until the appointment" on a job booked for this morning is an
     * ordinary case rather than a mistake.
     */
    return at <= now ? { ok: true, output: { waited: false } } : { ok: true, waitUntil: at };
  }

  const amounts = [
    ["minutes", 60_000],
    ["hours", 3_600_000],
    ["days", 86_400_000],
  ] as const;

  let ms = 0;
  let given = false;
  for (const [key, unit] of amounts) {
    const value = config[key];
    if (value === undefined) continue;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return { ok: false, reason: `${key} must be a number` };
    }
    // A negative wait is somebody's arithmetic going wrong rather than an
    // instruction, and silently treating it as zero hides that.
    if (value < 0) return { ok: false, reason: `${key} cannot be negative` };
    ms += value * unit;
    given = true;
  }

  if (!given) return { ok: false, reason: "a wait needs until, minutes, hours or days" };
  if (ms === 0) return { ok: true, output: { waited: false } };

  /**
   * A ceiling, because a workflow is not a calendar. A wait measured in
   * years is somebody's units being wrong, and the run would sit in the
   * table until long after anybody remembered making it.
   */
  const MAX = 365 * 86_400_000;
  if (ms > MAX) return { ok: false, reason: "a wait cannot be longer than a year" };

  return { ok: true, waitUntil: new Date(now.getTime() + ms) };
}


/* ------------------------------------------------------------------ branching */

/**
 * Take a branch.
 *
 * NO READS AND NO WRITES. The decision is `automation.decideBranch`, which is pure
 * and tested without a database, and everything this adds is the sentence that
 * goes in the log. A branch that queried anything would be a branch whose answer
 * depended on when it ran, and a run resumed after a three day wait would take the
 * other arm.
 *
 * The output names the arm AND the condition, because the question this log
 * answers is "why did this customer get that text" and "the branch was false" is
 * only half of it.
 */
export function branchStep(
  config: Record<string, unknown>,
  event: typeof schema.domainEvent.$inferSelect,
  /**
   * How many steps follow this one, so an arm that runs off the end is refused
   * here too.
   *
   * The runner knows it and core's reader takes it, and not passing it was a real
   * hole: a branch claiming nine steps in a list of two skipped everything that
   * followed and reported success, so a definition nobody can read ran as "do
   * nothing" and looked fine.
   */
  following: number,
): StepResult {
  const read = automation.readBranch(config, following);
  if (!read.ok) {
    /**
     * Refused at run time as well as at publish, and the duplication is on
     * purpose: a definition published by an older build, or written straight into
     * the table, reaches the runner without having been through `check`.
     */
    return {
      ok: false,
      reason: automation.explainBranch({ at: 0, problem: read.problem }),
    };
  }

  const decision = automation.decideBranch(read.shape, {
    payload: (event.payload ?? {}) as Record<string, unknown>,
  });

  return {
    ok: true,
    skipOffsets: decision.skipOffsets,
    output: {
      taken: decision.taken,
      thenCount: read.shape.thenCount,
      elseCount: read.shape.elseCount,
      conditions: read.shape.conditions as unknown as Record<string, unknown>,
    },
  };
}


/* ------------------------------------------------------------- reports */

/**
 * Run a report and email it.
 *
 * The same `deliverReport` a schedule calls, so a report emailed by an
 * automation is run, addressed, recorded and made once exactly as a scheduled
 * one is. What differs is the occurrence: a schedule's is a day on the clock,
 * and a step's is this step of this run, so a run resumed after a wait does
 * not send the report a second time.
 *
 * It runs as the person who PUBLISHED the version, as they are today. The
 * run's own actor holds only the step's two permissions and no scope, and a
 * report run under no scope is a report of nothing; running it as the company
 * would hand anybody who can publish an automation the owner's view of the
 * books.
 *
 * A report that went to nobody (every address suppressed, nobody allowed to
 * see it) is a successful step that says so, the same way a suppressed text
 * is: the automation did what it should and checked. A report that could not
 * run at all is a failed step.
 */
export async function emailReport(
  tx: Database,
  ctx: ServiceContext,
  config: Record<string, unknown>,
  runId: string,
  step: { index: number; publishedByUserId: string | null; now: Date },
): Promise<StepResult> {
  const read = readReportStep(config);
  if (!read.source) return { ok: false, reason: "step names no report" };

  const result = await deliverReport(tx, {
    organizationId: ctx.actor.organizationId,
    ownerUserId: step.publishedByUserId,
    source: read.source,
    recipients: { userIds: read.userIds, addresses: read.addresses },
    period: read.period,
    at: step.now,
    timezone: await timezoneOf(tx, ctx.actor.organizationId),
    key: `run:${runId}:${step.index}`,
    workflowRunId: runId,
  });

  if (result.status === "failed") return { ok: false, reason: result.error ?? "the report did not run" };
  return {
    ok: true,
    output: {
      deliveryId: result.deliveryId,
      status: result.status,
      queued: result.recipients.filter((r) => r.messageId).length,
      refused: result.recipients.filter((r) => r.refused).map((r) => `${r.address || "somebody"}: ${r.refused}`),
    },
  };
}

/* ------------------------------------------------------------- asking again */

/**
 * Stop the run here unless something is still true.
 *
 * The step a follow up turns on. A branch compares what the event carried, so
 * three days after "an estimate was sent" it can only ever say the estimate
 * was sent; whether the customer has answered since is a fact about now, and
 * this is the one step that asks the database for it. The question is a
 * declared check (`automation.CHECKS`), never a query somebody wrote.
 *
 * A NO IS NOT A FAILURE. The customer approving on day two is the follow up
 * working, so the run finishes as succeeded with the remaining steps written
 * down as skipped, the same rows a branch writes for the arm it did not take.
 * The output says which check and why, because "the follow up did not go"
 * is the question somebody opens the run to answer.
 */
export async function stopUnless(
  tx: Database,
  config: Record<string, unknown>,
  event: typeof schema.domainEvent.$inferSelect,
  following: number,
): Promise<StepResult> {
  const check = config["check"];
  if (!automation.isCheck(check)) {
    return { ok: false, reason: `this build has no check called ${String(check)}` };
  }

  const verdict = await holds(tx, check, event);
  if (verdict.holds) return { ok: true, output: { check, held: true } };

  return {
    ok: true,
    skipOffsets: Array.from({ length: following }, (_, i) => i + 1),
    output: { check, held: false, because: verdict.because },
  };
}

async function holds(
  tx: Database,
  check: automation.CheckKey,
  event: typeof schema.domainEvent.$inferSelect,
): Promise<{ holds: true } | { holds: false; because: string }> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  switch (check) {
    case "estimate_undecided": {
      const id = estimateIdOf(event);
      if (!id) return { holds: false, because: "the event names no estimate" };
      const [row] = await tx.select({
        status: schema.estimate.status, sentAt: schema.estimate.sentAt, number: schema.estimate.number,
      }).from(schema.estimate).where(eq(schema.estimate.id, id)).limit(1);
      if (!row) return { holds: false, because: "the estimate is gone" };
      if (row.status !== "sent" && row.status !== "viewed") {
        return { holds: false, because: `estimate #${row.number} is ${row.status} now` };
      }
      /**
       * SENT AGAIN SINCE is a no as well. A revised estimate sent on day two
       * starts its own follow up from that send, and this run carrying on
       * would chase the customer twice about one quote, the first time with
       * a link to numbers the office has since changed.
       */
      const sentAt = readPath(payload, "estimate.sentAt");
      if (typeof sentAt === "string" && row.sentAt
          && row.sentAt.getTime() > new Date(sentAt).getTime() + 1_000) {
        return { holds: false, because: `estimate #${row.number} was sent again since` };
      }
      return { holds: true };
    }
    case "caller_not_reached":
      return callerNotReached(tx, event);
  }
}

/**
 * Has anybody spoken to the caller since the call nobody answered.
 *
 * Two ways somebody has: they rang again and a person picked up, or a person
 * here rang them. Either is a later call on the same number, matched in E.164
 * because that is how both writers of calls store the caller.
 */
async function callerNotReached(
  tx: Database,
  event: typeof schema.domainEvent.$inferSelect,
): Promise<{ holds: true } | { holds: false; because: string }> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const from = typeof payload["from"] === "string" ? comms.phoneAddress(payload["from"]) : null;
  if (!from) return { holds: false, because: "the event names no caller" };
  const at = typeof payload["startedAt"] === "string" ? new Date(payload["startedAt"]) : event.createdAt;
  const later = await tx.select({ direction: schema.call.direction, status: schema.call.status })
    .from(schema.call)
    .where(and(
      sql`coalesce(${schema.call.startedAt}, ${schema.call.createdAt}) > ${at.toISOString()}::timestamptz`,
      sql`(${schema.call.direction} = 'inbound' and ${schema.call.fromE164} = ${from}
        and ${schema.call.answeredAt} is not null)
        or (${schema.call.direction} = 'outbound' and ${schema.call.toE164} = ${from})`,
    )).limit(1);
  if (later[0]) {
    return {
      holds: false,
      because: later[0].direction === "outbound" ? "somebody here rang them back" : "they rang again and were answered",
    };
  }
  return { holds: true };
}

const estimateIdOf = (event: typeof schema.domainEvent.$inferSelect): string | undefined =>
  (readPath(event.payload, "estimate.id") as string | undefined)
  ?? (event.entityType === "estimate" ? event.entityId ?? undefined : undefined);

/* -------------------------------------------------------- the estimate link */

/**
 * Send the customer a link to their estimate, again.
 *
 * A NEW LINK, NOT THE OLD ONE. Only the hash of a link is ever stored, so the
 * one sent the first time cannot be read back, and that is the point of how
 * links work here. This mints another, single use like the first, and leaves
 * the first alone: the customer may still have the original email open. A
 * revised estimate sent from the office withdraws every outstanding link
 * including this one, which is what stops a reminder pointing at old numbers.
 *
 * ONLY WHILE IT IS STILL AN OPEN QUESTION. Checked here as well as by any
 * `stop_unless` before it, because a step that sends to a customer has to be
 * right on its own: an automation somebody rearranged on the canvas must not
 * text a link to an estimate that was declined an hour ago.
 *
 * NOTHING TO SEND TO IS NOT A FAILURE. A customer with no mobile number skips
 * the text and still gets the email, and a refusal by consent or the
 * suppression list is recorded the same way the plain message step records
 * one. A link minted for a message that did not go is withdrawn, so a refused
 * send leaves nothing live behind it.
 */
export async function sendEstimateLink(
  tx: Database,
  ctx: ServiceContext,
  config: Record<string, unknown>,
  event: typeof schema.domainEvent.$inferSelect,
  runId: string,
): Promise<StepResult> {
  const organizationId = ctx.actor.organizationId;
  const channel = config["channel"] === "email" ? "email" as const : "sms" as const;
  const estimateId = estimateIdOf(event);
  if (!estimateId) return { ok: false, reason: "the event names no estimate" };

  const [estimate] = await tx.select().from(schema.estimate)
    .where(eq(schema.estimate.id, estimateId)).limit(1);
  if (!estimate) return { ok: false, reason: "estimate not found" };
  if (estimate.status !== "sent" && estimate.status !== "viewed") {
    return { ok: true, output: { sent: false, because: `estimate #${estimate.number} is ${estimate.status}` } };
  }

  const [customer] = await tx.select().from(schema.customer)
    .where(and(eq(schema.customer.id, estimate.customerId), isNull(schema.customer.deletedAt)))
    .limit(1);
  if (!customer) return { ok: false, reason: "customer not found" };

  const address = channel === "email" ? customer.email : customer.phone;
  if (!address) {
    return { ok: true, output: { sent: false, because: `customer has no ${channel === "email" ? "email address" : "phone number"}` } };
  }

  const [org] = await tx.select({ name: schema.organization.name })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);

  const link = await mintGrant(tx, {
    organizationId,
    customerId: estimate.customerId,
    scope: "estimate",
    subjectId: estimate.id,
    expiresInDays: 30,
    maxUses: 1,
  });

  const scope = {
    customer: { ...customer, name: customer.name.split(" ")[0] || customer.name, fullName: customer.name },
    estimate: { id: estimate.id, number: estimate.number, title: estimate.title ?? "" },
    organization: { name: org?.name ?? "" },
    link: link.url,
  };
  const body = render(String(config["body"] ?? ""), scope).trim();
  if (body === "") return { ok: false, reason: "step has no body" };
  if (!body.includes(link.url)) {
    /**
     * A reminder that does not carry the link is a message telling somebody
     * there is a link. Refused as a configuration problem rather than sent,
     * so the canvas edit that dropped `{{ link }}` shows up as a failed step.
     */
    await withdraw(tx, link.row.id);
    return { ok: false, reason: "the message does not include {{ link }}, so it would not carry the estimate" };
  }

  let messageId: string | null = null;
  let refused: string | null = null;
  if (channel === "sms") {
    const outcome = await sendTransactional(tx, {
      organizationId, address, body, customerId: customer.id,
    });
    if (outcome.sent) messageId = outcome.messageId;
    else refused = outcome.explanation;
  } else {
    const subject = render(String(config["subject"] ?? "Your estimate"), scope).trim() || "Your estimate";
    const outcome = await email.queue({ ...ctx, db: tx }, {
      to: address, subject, text: body, customerId: customer.id,
    });
    if (outcome.queued) messageId = outcome.messageId;
    else refused = outcome.explanation;
  }

  if (!messageId) {
    await withdraw(tx, link.row.id);
    return { ok: true, output: { sent: false, channel, refused } };
  }

  /** Which automation sent it, one join from the message. Same as `sendMessage`. */
  await tx.update(schema.message).set({ automationRef: `run:${runId}` })
    .where(eq(schema.message.id, messageId));

  await tx.insert(schema.portalEvent).values({
    organizationId,
    customerId: estimate.customerId,
    estimateId: estimate.id,
    kind: "estimate_sent",
    headline: `Estimate #${estimate.number} sent again`,
    detail: channel === "email" ? "By email, from an automation" : "By text, from an automation",
    isCustomerVisible: false,
  });

  return { ok: true, output: { sent: false, queued: true, channel, messageId } };
}

async function withdraw(tx: Database, grantId: string): Promise<void> {
  await tx.update(schema.portalGrant).set({ revokedAt: new Date() })
    .where(eq(schema.portalGrant.id, grantId));
}

/* ----------------------------------------------------------------- reviews */

const jobIdOf = (event: typeof schema.domainEvent.$inferSelect): string | undefined =>
  (readPath(event.payload, "jobId") as string | undefined)
  ?? (readPath(event.payload, "job.id") as string | undefined)
  ?? (event.entityType === "job" ? event.entityId ?? undefined : undefined);

/**
 * Ask the reviews module whether to ask, and write its answer down.
 *
 * THE MODULE DECIDES, NOT THE AUTOMATION. `reviews.requestWithin` is the
 * function the office uses: the company's review rules, the cooldown on this
 * customer, an open complaint, a callback still running, an opt out. An
 * automation that decided for itself would be the one that eventually asked a
 * customer with a complaint open, which is the review that costs the most.
 *
 * NOT TWICE ABOUT ONE JOB. A request already sent for this job is left as it
 * is: re-deciding would overwrite the record that it went.
 *
 * WHEN THE RULES SAY LATER, THE RUN WAITS. "Not before nine in the morning"
 * is an answer with a time on it, and the run parks until then rather than
 * sending now or dropping it.
 */
export async function requestReview(
  tx: Database,
  ctx: ServiceContext,
  config: Record<string, unknown>,
  event: typeof schema.domainEvent.$inferSelect,
  now: Date,
): Promise<StepResult> {
  const jobId = jobIdOf(event);
  if (!jobId) return { ok: true, output: { asked: false, because: "the event names no job" } };

  const [already] = await tx.select({ id: schema.reviewRequest.id })
    .from(schema.reviewRequest)
    .where(and(
      eq(schema.reviewRequest.jobId, jobId),
      eq(schema.reviewRequest.state, "sent"),
      isNull(schema.reviewRequest.deletedAt),
    )).limit(1);
  if (already) return { ok: true, output: { asked: false, because: "already asked about this job" } };

  const platform = typeof config["platform"] === "string" && config["platform"].trim() !== ""
    ? config["platform"].trim()
    : undefined;

  const outcome = await reviews.requestWithin(tx, ctx.actor.organizationId, {
    jobId, ...(platform ? { platform } : {}),
  }, now);

  const output: Record<string, unknown> = {
    asked: outcome.asked,
    ...(outcome.withheld ? { withheld: outcome.withheld, because: outcome.explanation } : {}),
    ...(outcome.sendAt ? { sendAt: outcome.sendAt.toISOString() } : {}),
  };

  if (outcome.asked && outcome.sendAt && outcome.sendAt > now) {
    return { ok: true, waitUntil: outcome.sendAt, output };
  }
  return { ok: true, output };
}

/**
 * Send the review request the module queued for this job, if it did.
 *
 * Nothing queued is the ordinary case when the rules withheld it, and is a
 * successful step that sends nothing. A queued request is sent through the
 * same consent gate as every other message, marked sent with the message that
 * carried it, or marked failed with the refusal, so the reviews screen and the
 * run say the same thing about it.
 */
export async function sendReviewRequest(
  tx: Database,
  ctx: ServiceContext,
  config: Record<string, unknown>,
  event: typeof schema.domainEvent.$inferSelect,
  runId: string,
  now: Date,
): Promise<StepResult> {
  const organizationId = ctx.actor.organizationId;
  const channel = config["channel"] === "email" ? "email" as const : "sms" as const;
  const jobId = jobIdOf(event);
  if (!jobId) return { ok: true, output: { sent: false, because: "the event names no job" } };

  const [request] = await tx.select().from(schema.reviewRequest)
    .where(and(
      eq(schema.reviewRequest.jobId, jobId),
      eq(schema.reviewRequest.state, "queued"),
      isNull(schema.reviewRequest.deletedAt),
    )).limit(1);
  if (!request) return { ok: true, output: { sent: false, because: "nothing is queued for this job" } };
  if (request.sendAt && request.sendAt > now) {
    return { ok: true, output: { sent: false, because: "it is not due yet", sendAt: request.sendAt.toISOString() } };
  }

  const url = request.platform ? await reviews.reviewUrlFor(tx, request.platform) : null;
  if (!url) {
    return {
      ok: false,
      reason: request.platform
        ? `no link is declared for ${request.platform}, so there is nowhere to send them`
        : "the request names no review site, so there is nowhere to send them",
    };
  }

  const [customer] = await tx.select().from(schema.customer)
    .where(eq(schema.customer.id, request.customerId)).limit(1);
  const [org] = await tx.select({ name: schema.organization.name })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);

  const scope = {
    customer: { ...(customer ?? {}), name: customer?.name.split(" ")[0] || customer?.name || "" },
    organization: { name: org?.name ?? "" },
    review: { url, platform: request.platform },
  };
  const body = render(String(config["body"] ?? ""), scope).trim();
  if (body === "") return { ok: false, reason: "step has no body" };

  const address = channel === "email" ? customer?.email : customer?.phone;
  let messageId: string | null = null;
  let refused: string | null = address ? null : `customer has no ${channel === "email" ? "email address" : "phone number"}`;
  if (address && channel === "sms") {
    const outcome = await sendTransactional(tx, { organizationId, address, body, customerId: request.customerId });
    if (outcome.sent) messageId = outcome.messageId;
    else refused = outcome.explanation;
  } else if (address) {
    const subject = render(String(config["subject"] ?? "How did we do?"), scope).trim() || "How did we do?";
    const outcome = await email.queue({ ...ctx, db: tx }, {
      to: address, subject, text: body, customerId: request.customerId,
    });
    if (outcome.queued) messageId = outcome.messageId;
    else refused = outcome.explanation;
  }

  if (!messageId) {
    await tx.update(schema.reviewRequest).set({
      state: "failed", withheldDetail: refused, updatedAt: new Date(),
    }).where(and(eq(schema.reviewRequest.id, request.id), eq(schema.reviewRequest.state, "queued")));
    return { ok: true, output: { sent: false, refused } };
  }

  await tx.update(schema.message).set({ automationRef: `run:${runId}` })
    .where(eq(schema.message.id, messageId));
  await tx.update(schema.reviewRequest).set({
    state: "sent", sentAt: new Date(), messageId, updatedAt: new Date(),
  }).where(and(eq(schema.reviewRequest.id, request.id), eq(schema.reviewRequest.state, "queued")));

  return { ok: true, output: { sent: false, queued: true, messageId } };
}

/* --------------------------------------------------------- a missed call */

/**
 * Text back the number that rang.
 *
 * The number comes from the event (`from`), never from a customer record,
 * because the caller is usually nobody yet. The send is `sendTransactional`,
 * the one gate every conversational text goes through: a suppression or a
 * revocation stops it, it is queued rather than claimed as sent, and it goes
 * from the number `senderFor` picks, which is never a tracking number. A
 * reply to it therefore lands in the ordinary inbox thread rather than being
 * credited to a campaign as a new lead.
 *
 * A refusal is a successful step that did not send, the same as the other
 * senders: a caller who said STOP must not turn the automation red.
 */
export async function textCaller(
  tx: Database,
  ctx: ServiceContext,
  config: Record<string, unknown>,
  event: typeof schema.domainEvent.$inferSelect,
  runId: string,
): Promise<StepResult> {
  const payload = (event.payload ?? {}) as Record<string, unknown>;
  const from = typeof payload["from"] === "string" ? payload["from"] : null;
  if (!from) return { ok: false, reason: "the event names no caller to text" };

  const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
    .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
  const body = render(String(config["body"] ?? ""), {
    ...payload, organization: { name: org?.name ?? "" },
  }).trim();
  if (body === "") return { ok: false, reason: "step has no body" };

  const outcome = await sendTransactional(tx, {
    organizationId: ctx.actor.organizationId,
    address: from,
    body,
    customerId: typeof payload["customerId"] === "string" ? payload["customerId"] : null,
  });
  if (!outcome.sent) return { ok: true, output: { sent: false, refused: outcome.reason } };

  await tx.update(schema.message).set({ automationRef: `run:${runId}` })
    .where(eq(schema.message.id, outcome.messageId));
  return { ok: true, output: { sent: false, queued: true, messageId: outcome.messageId } };
}
