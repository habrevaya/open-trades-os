import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, asc, eq, gt, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { events, isSystem, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError, type ServiceContext,
} from "./context";

/**
 * OUTBOUND WEBHOOKS, WHICH THE SCHEMA HAS PROMISED SINCE THE FIRST MIGRATION
 *
 * `webhook_endpoint` was written in the first migrations, carries an `events`
 * array, an `active` flag, a `failure_count` and a `last_delivery_at`, and no
 * code in this product has ever read or written a single one of those
 * columns. The table is named in the automation schema comment as one of the
 * two consumers `domain_event` was built for. It was the one that never
 * arrived.
 *
 * What that costs is the difference between an automation feature and an
 * automation platform. Everything this product knows how to do, it does
 * inside itself: a workflow can text a customer, move a job and raise a task.
 * The moment a company wants any of it to reach their own system, their
 * accountant's system, a spreadsheet or a script somebody wrote in an
 * afternoon, there is nothing. The event log is right there, ordered and
 * durable, and the only way to read it is to be this codebase.
 *
 * SUBSCRIPTIONS ARE VALIDATED AGAINST THE CATALOGUE, EXACTLY LIKE WORKFLOWS
 *
 * `services/workflows.ts` refuses a trigger on an event nothing emits, and
 * the reasoning there applies here with one extra turn of the screw. A
 * workflow subscribed to a dead event is a workflow that never runs, and the
 * person who built it believes they automated something. A webhook
 * subscribed to a dead event is the same failure happening in somebody
 * else's system: they built a receiver, they tested it by hand, they
 * deployed it, and it will never be called. Nothing in this product logs a
 * subscription that matches nothing, because matching nothing is exactly
 * what a quiet week looks like, and no screen can tell the two apart.
 *
 * So `check` below refuses a name the catalogue does not hold, and refuses a
 * name the catalogue holds and nothing emits, and says which. A name this
 * company's own log has already seen is allowed through whatever this build
 * declares, for the same reason the workflow service allows it: it is a real
 * thing in that company's history, written by an older build or a migration,
 * and refusing it would break integrations that work.
 *
 * DELIVERY IS ORDERED, PER ENDPOINT, AND GIVES UP
 *
 * See `deliver`. The short version: each endpoint has its own position in the
 * event log, a failure stops that endpoint at the failing event rather than
 * skipping it, retries back off against `last_delivery_at`, and an endpoint
 * that has failed `FAILURE_LIMIT` times in a row is switched off with a line
 * in the audit log rather than retried forever.
 */

/* ------------------------------------------------------------- the secret */

/**
 * WHY THE SIGNING SECRET IS STORED AND AN APP TOKEN IS NOT
 *
 * `services/apps.ts` stores only a SHA-256 of the token it issues, and that
 * is right: an app token is presented to us, so we only ever need to check a
 * value somebody else is holding, and a one way hash is enough to do it.
 *
 * A webhook signing secret is the opposite direction. We are the one holding
 * it, and we have to REPRODUCE a signature with it on every delivery, which
 * a hash cannot do. There is no version of this where the plaintext is
 * absent from the row, and pretending otherwise by hashing it would simply
 * mean no endpoint could ever be signed.
 *
 * What that buys the rest of the file is a rule with no exceptions: the
 * secret is returned exactly once, in the return value of `register`, and
 * `shape` below is the only way a row leaves this file. `shape` does not
 * take `secretRef` from the row and there is no code path that does, so a
 * list, a read or an update cannot leak it even by accident. An operator who
 * loses it is in the same position as one who loses an app token: they
 * register a new endpoint, which is the same action they would take if it
 * leaked.
 *
 * The column comment says "stored encrypted", which is a deployment
 * property rather than something this file can assert. It is stated here so
 * that whoever wires the secret store knows this is the value to wrap.
 */
const SECRET_PREFIX = "whsec_";

/**
 * 256 bits, same as an app token. The entire integrity of every delivery to
 * this endpoint is this string: a receiver that trusts our signature is
 * trusting nobody else can compute it.
 */
const newSecret = () => `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;

export const SIGNATURE_HEADER = "x-otos-signature";
export const TIMESTAMP_HEADER = "x-otos-timestamp";
export const EVENT_HEADER = "x-otos-event";
/** Stable across retries of the same event, so a receiver can deduplicate. */
export const DELIVERY_HEADER = "x-otos-delivery";

/**
 * The signature a receiver has to reproduce.
 *
 * THE TIMESTAMP IS INSIDE THE SIGNED PAYLOAD, not merely alongside it. A
 * signature over the body alone is valid forever: anybody who captures one
 * delivery can replay it at any later time and the receiver cannot tell,
 * because everything they check still matches. Binding the timestamp into
 * the payload means a replay has to either carry the original timestamp, and
 * be rejected as too old, or carry a new one, and fail the signature.
 *
 * Exported rather than left as prose, and deliberately the same shape as
 * `signLeadWebhook` in the inbound direction, because an integrator handed
 * "sign it with HMAC-SHA256" gets the concatenation order wrong about half
 * the time and a wrong order looks exactly like a wrong secret.
 */
export function signDelivery(input: {
  secret: string; body: string; timestamp: number;
}): { signature: string; timestamp: string } {
  const timestamp = String(input.timestamp);
  return {
    signature: createHmac("sha256", input.secret)
      .update(`${timestamp}.${input.body}`).digest("hex"),
    timestamp,
  };
}

/**
 * How far out of date a delivery may be before a receiver should refuse it.
 *
 * Five minutes, matching the inbound webhook. Long enough for clock drift on
 * a machine nobody administers, short enough that a captured request is
 * useless by the time anybody could use it.
 */
export const MAX_SKEW_MS = 5 * 60 * 1000;

/**
 * The check a receiver performs, written here so they can copy it.
 *
 * Constant time, for the reason `lead-webhook.ts` spells out: a comparison
 * that returns on the first wrong byte hands the correct signature out one
 * character at a time to anybody willing to send a few thousand requests.
 * `timingSafeEqual` throws on a length mismatch, which would itself be a
 * signal, so the lengths are compared first.
 */
export function verifyDelivery(input: {
  secret: string; body: string; timestamp: string; signature: string; now?: number;
}): boolean {
  const sentAt = Number(input.timestamp);
  if (!Number.isFinite(sentAt)) return false;
  if (Math.abs((input.now ?? Date.now()) - sentAt) > MAX_SKEW_MS) return false;

  const expected = Buffer.from(
    createHmac("sha256", input.secret).update(`${input.timestamp}.${input.body}`).digest("hex"),
    "utf8",
  );
  const provided = Buffer.from(input.signature, "utf8");
  if (expected.length !== provided.length) return false;
  return timingSafeEqual(expected, provided);
}

/* --------------------------------------------------------------- the rows */

/**
 * `Partial`, but honest under `exactOptionalPropertyTypes`.
 *
 * A patch arrives from a JSON body, where an absent key and a key explicitly
 * set to undefined are the same answer to "did the caller name this field".
 * Plain `Partial` says `url?: string`, which refuses `string | undefined` and
 * makes every handler forwarding a decoded body fail to compile.
 */
type Patch<T> = { [K in keyof T]?: T[K] | undefined };

export interface EndpointInput {
  url: string;
  /** Names from the catalogue. At least one, and every one of them live. */
  events: string[];
  active?: boolean | undefined;
}

export interface Endpoint {
  id: string;
  url: string;
  events: string[];
  active: boolean;
  /** Consecutive failures. Reset to zero by a delivery that succeeds. */
  failureCount: number;
  /**
   * The last time a delivery was ATTEMPTED, successful or not.
   *
   * Not "the last time one succeeded", and the difference matters twice.
   * Read by a person, a recent attempt beside a failure count of four says
   * "failing right now", where a success-only stamp makes a dead endpoint
   * and a brand new one look identical. Read by `deliver`, it is the anchor
   * the retry backoff is computed from, which is what lets this file back
   * off at all without a next-attempt column it is not allowed to add.
   */
  lastDeliveryAt: string | null;
  createdAt: string;
}

/** The only way a row leaves this file. `secretRef` is not in it. */
function shape(row: typeof schema.webhookEndpoint.$inferSelect): Endpoint {
  return {
    id: row.id,
    url: row.url,
    events: row.events ?? [],
    active: row.active,
    failureCount: row.failureCount,
    lastDeliveryAt: row.lastDeliveryAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

/**
 * Event names this company's log already holds.
 *
 * The same read, for the same reason, as `seenEventNames` in the workflow
 * service: a name an older build emitted is a real thing in this company's
 * history, and refusing a subscription to it would break integrations that
 * are working today.
 */
async function seenEventNames(tx: Database, organizationId: string): Promise<Set<string>> {
  const rows = await tx.selectDistinct({ name: schema.domainEvent.name })
    .from(schema.domainEvent)
    .where(eq(schema.domainEvent.organizationId, organizationId));
  return new Set(rows.map((row: { name: string }) => row.name));
}

/**
 * Everything that makes an endpoint worth registering, checked before it is.
 *
 * Returns the cleaned values rather than a boolean, so the caller cannot
 * validate one string and then store a different one.
 */
function check(input: EndpointInput, seen: ReadonlySet<string>): { url: string; events: string[] } {
  const raw = input.url.trim();
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ConflictError(`"${input.url}" is not a URL we could deliver to.`);
  }

  /**
   * HTTPS ONLY, WITH NO EXCEPTION FOR LOOPBACK.
   *
   * Two separate reasons, and each is sufficient on its own.
   *
   * The payload is a domain event, which means customer names, addresses,
   * job details and amounts. The signature proves who sent it and that it
   * was not altered; it does nothing whatsoever about who can read it. Over
   * http that data is in plaintext across every network between this process
   * and the receiver, and the company whose customers those are never agreed
   * to that.
   *
   * The second reason is why there is no convenience exception for
   * localhost or a private address, which is the carve out somebody always
   * asks for. This URL is fetched BY THE SERVER, so an allowed loopback or
   * private target turns endpoint registration into a way for anybody
   * holding `integration:write` on any tenant to make the host issue
   * requests inside its own network and report back the status codes. On a
   * hosted deployment that is one tenant probing the infrastructure every
   * other tenant runs on. A self hoster with an internal http receiver puts
   * a TLS terminator in front of it, which they already have, or runs the
   * receiver on the same box and still terminates TLS.
   */
  if (parsed.protocol !== "https:") {
    throw new ConflictError(
      "A webhook endpoint has to be https. A delivery carries customer names, addresses and "
      + "amounts, and the signature proves who sent it without hiding any of it from anybody "
      + "on the way.",
    );
  }

  const names = [...new Set(input.events.map((name) => name.trim()).filter((n) => n !== ""))];
  if (names.length === 0) {
    /**
     * An endpoint subscribed to nothing is not an endpoint that is quiet, it
     * is an endpoint that is broken, and the two are indistinguishable from
     * the outside. Somebody registers it, copies the secret, builds the
     * receiver and waits. The `events` column defaults to an empty array, so
     * this is the state a caller reaches by simply not sending the field.
     */
    throw new ConflictError(
      "This endpoint subscribes to nothing, so it would never be called. Pick at least one event.",
    );
  }

  /**
   * REFUSED AT REGISTRATION, because there is no later moment.
   *
   * Identical reasoning to the workflow builder, and worse in effect: the
   * dead subscription is in somebody else's codebase, where this product
   * cannot report on it at all.
   */
  const unknown = names.filter((name) => !events.isEventName(name) && !seen.has(name));
  if (unknown.length > 0) {
    throw new ConflictError(
      `Nothing in this product emits ${unknown.join(" or ")}, so an endpoint subscribed to it `
      + "would never be called. Pick an event from the catalogue.",
    );
  }

  const silent = names.filter((name) => events.isEventName(name)
    && !(events.SUBSCRIBABLE as string[]).includes(name)
    && !seen.has(name));
  if (silent.length > 0) {
    const owed = silent
      .map((name) => events.eventSpec(name as events.EventName).owedBy)
      .filter(Boolean);
    throw new ConflictError(
      `${silent.join(" and ")} is not emitted yet, so an endpoint subscribed to it would never `
      + `be called.${owed.length > 0 ? ` ${owed.join(" ")}` : ""}`,
    );
  }

  return { url: raw, events: names };
}

/* ------------------------------------------------------------ the cursors */

/**
 * WHERE EACH ENDPOINT IS UP TO, AS A ROW IN `event_cursor`
 *
 * One cursor per endpoint rather than one per organization, which the table
 * already supports: `consumer` is text, and its own column comment names
 * `webhook` as a reason it is a column rather than a boolean.
 *
 * Per organization would have been less code and is wrong in three ways at
 * once. A receiver that is down would hold the log for every other receiver
 * the company has. An endpoint registered today would be handed the
 * company's entire history, which for a company that has been running for a
 * year is tens of thousands of deliveries nobody asked for. And there would
 * be nowhere to record that one endpoint is behind while another is current.
 *
 * `register` sets a new endpoint's cursor to the sequence the log is at when
 * it is created, so an endpoint starts from now. That is the behaviour
 * anybody expects and the opposite of what an absent cursor row would do,
 * since an absent row reads as zero and zero means the beginning of time.
 */
const consumerFor = (endpointId: string) => `webhook:${endpointId}`;

async function cursorFor(tx: Database, organizationId: string, endpointId: string): Promise<number> {
  const [row] = await tx.select({ last: schema.eventCursor.lastSequence })
    .from(schema.eventCursor)
    .where(and(
      eq(schema.eventCursor.organizationId, organizationId),
      eq(schema.eventCursor.consumer, consumerFor(endpointId)),
    ))
    .limit(1);
  return row?.last ?? 0;
}

/**
 * Advance, never rewind.
 *
 * `greatest` rather than an assignment, the same guard the workflow worker
 * uses: two passes finishing out of order would otherwise let the slower one
 * move the position backwards, and every event between the two would be
 * delivered a second time.
 */
async function advanceCursor(
  tx: Database, organizationId: string, endpointId: string, to: number,
): Promise<void> {
  await tx.insert(schema.eventCursor)
    .values({
      organizationId, consumer: consumerFor(endpointId), lastSequence: to, updatedAt: new Date(),
    })
    .onConflictDoUpdate({
      target: [schema.eventCursor.organizationId, schema.eventCursor.consumer],
      set: {
        lastSequence: sql`greatest(${schema.eventCursor.lastSequence}, excluded.last_sequence)`,
        updatedAt: new Date(),
      },
    });
}

async function currentSequence(tx: Database, organizationId: string): Promise<number> {
  const [row] = await tx.execute<{ seq: number }>(sql`
    select coalesce(max(sequence), 0) as seq
    from public.domain_event where organization_id = ${organizationId}`);
  return Number(row?.seq ?? 0);
}

/* --------------------------------------------------------------- the CRUD */

/**
 * Register an endpoint and hand back its secret, once.
 *
 * Active immediately, unlike a new workflow, and the difference is not an
 * oversight. A workflow acts: it sends messages and moves money, so it
 * starts switched off because its first run happens before anybody has read
 * it back. A webhook only tells somebody else what already happened, and the
 * receiver was built before this row existed. An endpoint that arrives
 * switched off is an integration that silently does not start, which is the
 * failure this whole file is about.
 */
export async function register(
  ctx: ServiceContext, input: EndpointInput,
): Promise<Endpoint & { secret: string }> {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const { url, events: names } = check(input, await seenEventNames(tx, ctx.actor.organizationId));
    const secret = newSecret();

    const [row] = await tx.insert(schema.webhookEndpoint).values({
      organizationId: ctx.actor.organizationId,
      url,
      secretRef: secret,
      events: names,
      active: input.active ?? true,
    }).returning();

    /**
     * From now, not from the beginning. Written in the same transaction as
     * the insert: a commit that created the endpoint without its cursor
     * would leave a row whose absent cursor reads as zero, and the first
     * delivery pass would replay the company's entire history at a receiver
     * that has been live for four seconds.
     */
    await advanceCursor(
      tx, ctx.actor.organizationId, row!.id,
      await currentSequence(tx, ctx.actor.organizationId),
    );

    /**
     * The secret is not in the audit entry, and this is the one place it
     * would be easy to put it. An audit log is readable by `audit:read`,
     * which is a much longer list of people than the one who registered
     * this endpoint, and a signing secret sitting in it is a signing secret
     * everybody has.
     */
    await audit(tx, ctx, "webhook.registered", "webhook_endpoint", row!.id, null, shape(row!));

    return { ...shape(row!), secret };
  });
}

/**
 * Change where it points or what it listens to.
 *
 * `secretRef` is deliberately absent from the input. Rotating a secret is a
 * different action with a different consequence, because the moment it
 * changes every delivery to a receiver still holding the old one fails
 * signature verification, and an operator who thought they were fixing a
 * typo in a URL should not discover that by reading their own error log.
 */
export async function update(
  ctx: ServiceContext, input: { id: string } & Patch<EndpointInput>,
): Promise<Endpoint> {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);

    /**
     * Merged before validating, like the phone number service: clearing the
     * event list is unremarkable as a patch and leaves an endpoint that can
     * never be called, which is the state `check` exists to refuse.
     */
    const merged: EndpointInput = {
      url: input.url ?? before.url,
      events: input.events ?? (before.events ?? []),
      active: input.active ?? before.active,
    };
    const { url, events: names } = check(
      merged, await seenEventNames(tx, ctx.actor.organizationId),
    );

    /**
     * A CHANGED URL OR A DELIBERATE RE-ENABLE CLEARS THE FAILURE COUNT.
     *
     * Without this an endpoint that reached the limit is stuck. It is
     * switched off, its counter is at the limit, and the operator's only
     * move is to fix their receiver, turn it back on, and watch the very
     * next failure trip the limit again on the first attempt, because the
     * counter is where it was. The only recovery would be to delete and
     * re-register, which loses the cursor and either replays or skips
     * whatever happened in between.
     *
     * Both triggers are somebody stating that the thing that was broken is
     * no longer broken, which is exactly what the counter measures.
     */
    const repaired = url !== before.url || (input.active === true && !before.active);

    const [after] = await tx.update(schema.webhookEndpoint).set({
      url,
      events: names,
      active: merged.active ?? true,
      ...(repaired ? { failureCount: 0 } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.webhookEndpoint.id, input.id)).returning();

    await audit(
      tx, ctx, "webhook.updated", "webhook_endpoint", input.id, shape(before), shape(after!),
    );
    return shape(after!);
  });
}

/**
 * The event names an endpoint may subscribe to, with what each one means.
 *
 * Offered from the same catalogue `check` refuses against, which is the only
 * way the two can agree. A settings screen that builds its own list is how
 * the workflow builder came to offer fourteen triggers of which one was ever
 * emitted, and the person who picked one of the other thirteen believed they
 * had automated something.
 *
 * Names this company's own log holds are included with a null summary rather
 * than dropped. An event an older build wrote is a real thing in their
 * history, a subscription to it works, and showing the bare name is better
 * than hiding a subscription that would deliver.
 */
export async function catalogue(
  ctx: ServiceContext,
): Promise<{ name: string; summary: string | null }[]> {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const seen = await seenEventNames(tx, ctx.actor.organizationId);
    return [...new Set([...events.SUBSCRIBABLE, ...seen])]
      .sort()
      .map((name) => ({
        name,
        summary: events.isEventName(name) ? events.eventSpec(name).summary : null,
      }));
  });
}

export async function list(ctx: ServiceContext): Promise<Endpoint[]> {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const rows = await tx.select().from(schema.webhookEndpoint)
      .where(and(
        eq(schema.webhookEndpoint.organizationId, ctx.actor.organizationId),
        isNull(schema.webhookEndpoint.deletedAt),
      ))
      .orderBy(asc(schema.webhookEndpoint.createdAt));
    return rows.map(shape);
  });
}

/**
 * Stop delivering, and keep the row.
 *
 * Soft deleted rather than removed, so the audit trail for every delivery
 * that ever went to it still names something. A hard delete would leave the
 * question "what was this endpoint that received four thousand of our
 * customers' addresses" with no answer at all.
 *
 * Its cursor IS deleted, because a cursor is a position rather than a
 * record: nothing reads it once the endpoint is gone, and leaving it behind
 * means every removed endpoint a company ever had keeps a row in a table the
 * delivery pass scans.
 */
export async function remove(ctx: ServiceContext, input: { id: string }): Promise<void> {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);

    await tx.update(schema.webhookEndpoint)
      .set({ deletedAt: new Date(), active: false, updatedAt: new Date() })
      .where(eq(schema.webhookEndpoint.id, input.id));

    await tx.delete(schema.eventCursor).where(and(
      eq(schema.eventCursor.organizationId, ctx.actor.organizationId),
      eq(schema.eventCursor.consumer, consumerFor(input.id)),
    ));

    await audit(tx, ctx, "webhook.removed", "webhook_endpoint", input.id, shape(before), null);
  });
}

async function load(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.webhookEndpoint)
    .where(and(
      eq(schema.webhookEndpoint.id, id),
      eq(schema.webhookEndpoint.organizationId, organizationId),
      isNull(schema.webhookEndpoint.deletedAt),
    )).limit(1);
  if (!row) throw new NotFoundError("Webhook endpoint");
  return row;
}

/* ----------------------------------------------------------- the delivery */

/**
 * HOW MANY CONSECUTIVE FAILURES SWITCH AN ENDPOINT OFF, AND WHY THIS NUMBER
 *
 * Twelve, paired with the backoff below, which puts the decision a little
 * over five hours after the first failure.
 *
 * The number is a choice between two bad outcomes and there is no value that
 * avoids both. Too low and a receiver that is redeploying, renewing a
 * certificate or riding out a ten minute outage gets switched off, and the
 * company finds out when somebody asks why their system has been missing
 * jobs since Tuesday. Too high, or no limit at all, and a receiver that was
 * decommissioned a year ago is still being called every hour forever, each
 * call carrying one company's customer data at a URL that now belongs to
 * whoever bought the domain.
 *
 * Five hours is longer than any deploy, any certificate renewal and most
 * incidents, and short enough that a dead receiver is dealt with inside one
 * working day. The endpoint is disabled rather than deleted, the audit log
 * records the last error, and an operator turns it back on with `update`,
 * which clears the counter.
 */
const FAILURE_LIMIT = 12;

/**
 * How long to wait after a failure before trying that event again.
 *
 * Exponential from thirty seconds, capped at an hour, computed from
 * `failureCount` against `lastDeliveryAt`. Doing it this way rather than
 * with a next-attempt column is what keeps this change free of a migration:
 * the two columns needed already exist, and one of them is otherwise only
 * decoration.
 *
 * The cap matters as much as the growth. Uncapped doubling reaches days
 * between attempts by the tenth failure, so an endpoint that came back an
 * hour after it broke would sit idle for most of a week with a queue behind
 * it, which reads to the company as the integration having silently stopped.
 */
const BACKOFF_BASE_MS = 30 * 1000;
const BACKOFF_CAP_MS = 60 * 60 * 1000;

export function backoffMs(failureCount: number): number {
  if (failureCount <= 0) return 0;
  return Math.min(BACKOFF_BASE_MS * 2 ** (failureCount - 1), BACKOFF_CAP_MS);
}

/** How many events one pass reads for one endpoint. */
const BATCH = 100;

/** How long one delivery may take before it counts as a failure. */
const TIMEOUT_MS = 10 * 1000;

export interface DeliveryRequest {
  url: string;
  body: string;
  headers: Record<string, string>;
}

export interface DeliveryResponse {
  status: number;
  ok: boolean;
}

/**
 * The transport, injected.
 *
 * A parameter rather than a direct `fetch` call because this function is the
 * one piece of the product that makes an outbound request to an address a
 * customer chose, and a test that cannot substitute it is a test that either
 * makes real network calls or does not exercise delivery at all. The default
 * is the real thing, so nothing has to be configured to use it.
 */
export type Transport = (request: DeliveryRequest) => Promise<DeliveryResponse>;

const httpTransport: Transport = async (request) => {
  const response = await fetch(request.url, {
    method: "POST",
    headers: request.headers,
    body: request.body,
    /**
     * A receiver that accepts the connection and then never answers would
     * otherwise hold this pass open indefinitely, and every other endpoint
     * for this company waits behind it.
     */
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  return { status: response.status, ok: response.ok };
};

export interface DeliveryAttempt {
  endpointId: string;
  eventId: string;
  eventName: string;
  ok: boolean;
  /** Null when the request never got an answer: a timeout, DNS, a refused connection. */
  status: number | null;
  error: string | null;
  /** True when this attempt is the one that took the endpoint over the limit. */
  disabled: boolean;
}

export interface DeliveryPass {
  organizationId: string;
  attempts: DeliveryAttempt[];
  /** Endpoints skipped this pass because they are waiting out a backoff. */
  backingOff: string[];
}

export interface DeliveryOptions {
  send?: Transport;
  now?: () => Date;
  limit?: number;
}

/**
 * The actor a delivery pass enters a tenant as.
 *
 * It holds the two permissions delivery needs and nothing else, rather than
 * holding nothing and calling `inTenant` directly the way the workflow
 * worker does. The rule in this service layer is that every function goes
 * through `guardedRead` or `guardedWrite`, and a rule with one exception for
 * background work is a rule nobody can check by reading: the next background
 * caller copies the exception instead of the rule. Naming the grants makes
 * the blast radius of the worker a two item list at the top of the file.
 */
function deliveryActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["integration:read", "integration:write"],
    agentId: "webhooks",
  };
}

/**
 * Deliver everything unsent, for one company.
 *
 * Shaped to be called per organization because that is the seam the worker
 * already has: `runWorker` takes an `afterDrain(organizationId)` hook that
 * runs for each tenant that had events, which is exactly the set of tenants
 * with something to deliver.
 *
 * THE NETWORK CALL IS OUTSIDE THE TRANSACTION, and that is the reason this
 * function is written as a sequence of small guarded steps rather than one
 * `guardedWrite` around the whole pass. A ten second request made with a
 * transaction open holds a pooled connection for the whole ten seconds, and
 * one company with twenty slow endpoints would exhaust the pool for every
 * request in the product. Work is read, the request is made with nothing
 * held, and the outcome is written in its own short transaction.
 *
 * DELIVERY STOPS AT THE FIRST FAILURE FOR THAT ENDPOINT, deliberately.
 * Skipping the failed event and carrying on would deliver `job.completed`
 * to a receiver that never got `job.created`, and a receiver built on the
 * assumption that events arrive in order has no way to notice: it sees a
 * completion for a job it has never heard of and either errors or, worse,
 * creates a half-built record. Holding the position means the failing event
 * is retried on the next pass, in order, and everything behind it waits,
 * which is what the failure count and the limit above are for.
 */
export async function deliver(
  db: Database,
  organizationId: string,
  options: DeliveryOptions = {},
): Promise<DeliveryPass> {
  const ctx: ServiceContext = { actor: deliveryActor(organizationId), db };
  const send = options.send ?? httpTransport;
  const clock = options.now ?? (() => new Date());
  const limit = options.limit ?? BATCH;

  const endpoints = await due(ctx, clock());
  const attempts: DeliveryAttempt[] = [];
  const backingOff: string[] = [];

  for (const endpoint of endpoints.all) {
    if (!endpoints.ready.includes(endpoint)) {
      backingOff.push(endpoint.id);
      continue;
    }

    const subscribed = new Set(endpoint.events ?? []);
    const queue = await unsent(ctx, endpoint.id, limit);
    let reached = 0;

    for (const event of queue) {
      /**
       * An event this endpoint does not subscribe to still moves its
       * position. Leaving it would mean an endpoint listening only to
       * `invoice.paid` re-reads every job event this company has produced
       * on every pass, forever, and the read gets slower every day.
       */
      if (!subscribed.has(event.name)) {
        reached = event.sequence;
        continue;
      }

      const at = clock();
      const body = JSON.stringify(envelope(organizationId, event));
      const { signature, timestamp } = signDelivery({
        secret: endpoint.secretRef, body, timestamp: at.getTime(),
      });

      let result: DeliveryResponse | null = null;
      let error: string | null = null;
      try {
        result = await send({
          url: endpoint.url,
          body,
          headers: {
            "content-type": "application/json",
            [SIGNATURE_HEADER]: signature,
            [TIMESTAMP_HEADER]: timestamp,
            [EVENT_HEADER]: event.name,
            /**
             * Stable across every retry of this event to this endpoint, so a
             * receiver that got the delivery and failed to answer in time
             * can recognise the repeat instead of processing it twice.
             */
            [DELIVERY_HEADER]: `${endpoint.id}:${event.id}`,
          },
        });
      } catch (thrown) {
        error = (thrown as Error).message;
      }

      const ok = result?.ok === true;
      const disabled = await settle(ctx, {
        endpointId: endpoint.id,
        ok,
        at,
        /** Recorded on the audit entry when this is the failure that disables it. */
        reason: error ?? (result ? `HTTP ${result.status}` : "no response"),
        url: endpoint.url,
      });

      attempts.push({
        endpointId: endpoint.id,
        eventId: event.id,
        eventName: event.name,
        ok,
        status: result?.status ?? null,
        error: ok ? null : (error ?? `HTTP ${result?.status}`),
        disabled,
      });

      if (!ok) break;
      reached = event.sequence;
    }

    if (reached > 0) await commit(ctx, endpoint.id, reached);
  }

  return { organizationId, attempts, backingOff };
}

/**
 * What a receiver is sent.
 *
 * The organization id is in the body because a receiver serving several
 * companies would otherwise have to infer which one a delivery is about from
 * the URL it registered, and the sequence is there because it is the only
 * value that lets a receiver detect that it missed something.
 */
function envelope(organizationId: string, event: {
  id: string; name: string; sequence: number; entityType: string;
  entityId: string | null; payload: Record<string, unknown>; occurredAt: Date;
}) {
  return {
    id: event.id,
    name: event.name,
    sequence: event.sequence,
    occurredAt: event.occurredAt.toISOString(),
    organizationId,
    entity: { type: event.entityType, id: event.entityId },
    payload: event.payload,
  };
}

/**
 * The endpoints worth trying right now.
 *
 * `all` and `ready` are returned together so the caller can report what it
 * skipped. An endpoint waiting out a backoff being silently absent is how a
 * company ends up asking why nothing has been delivered for an hour with
 * nothing anywhere saying that the answer is "on purpose, until 14:05".
 */
async function due(ctx: ServiceContext, now: Date) {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const all = await tx.select().from(schema.webhookEndpoint)
      .where(and(
        eq(schema.webhookEndpoint.organizationId, ctx.actor.organizationId),
        eq(schema.webhookEndpoint.active, true),
        isNull(schema.webhookEndpoint.deletedAt),
      ))
      .orderBy(asc(schema.webhookEndpoint.createdAt));

    const ready = all.filter((endpoint) => {
      if (endpoint.failureCount === 0 || !endpoint.lastDeliveryAt) return true;
      return now.getTime() - endpoint.lastDeliveryAt.getTime()
        >= backoffMs(endpoint.failureCount);
    });

    return { all, ready };
  });
}

/** One endpoint's unread events, oldest first. */
async function unsent(ctx: ServiceContext, endpointId: string, limit: number) {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const from = await cursorFor(tx, ctx.actor.organizationId, endpointId);
    return tx.select({
      id: schema.domainEvent.id,
      name: schema.domainEvent.name,
      sequence: schema.domainEvent.sequence,
      entityType: schema.domainEvent.entityType,
      entityId: schema.domainEvent.entityId,
      payload: schema.domainEvent.payload,
      occurredAt: schema.domainEvent.occurredAt,
    })
      .from(schema.domainEvent)
      .where(gt(schema.domainEvent.sequence, from))
      .orderBy(asc(schema.domainEvent.sequence))
      .limit(limit);
  });
}

/**
 * Record how an attempt went, and switch the endpoint off if it has now
 * failed enough times in a row.
 *
 * Both columns are written on every attempt, which is the whole point of
 * this function: `failure_count` and `last_delivery_at` have been on this
 * table since the first migration with nothing on either side of them, so an
 * operator looking at an endpoint could not tell a healthy one from one that
 * has never worked.
 *
 * The count is reset to zero by a success rather than decremented, because
 * what it measures is consecutive failures. An endpoint that fails every
 * other delivery forever is a different problem from one that has stopped
 * answering, and a counter that only ever climbed would eventually disable
 * the first as though it were the second.
 */
async function settle(ctx: ServiceContext, input: {
  endpointId: string; ok: boolean; at: Date; reason: string; url: string;
}): Promise<boolean> {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    if (input.ok) {
      await tx.update(schema.webhookEndpoint)
        .set({ failureCount: 0, lastDeliveryAt: input.at, updatedAt: input.at })
        .where(eq(schema.webhookEndpoint.id, input.endpointId));
      return false;
    }

    /**
     * Incremented in SQL rather than read and written back, so two passes
     * overlapping cannot both read three and both write four. The `case`
     * closes the same gap on the switch off: the decision is made from the
     * value the database is about to hold rather than the one this process
     * read a moment ago.
     */
    const [after] = await tx.update(schema.webhookEndpoint)
      .set({
        failureCount: sql`${schema.webhookEndpoint.failureCount} + 1`,
        lastDeliveryAt: input.at,
        active: sql`case when ${schema.webhookEndpoint.failureCount} + 1 >= ${FAILURE_LIMIT}
                    then false else ${schema.webhookEndpoint.active} end`,
        updatedAt: input.at,
      })
      .where(eq(schema.webhookEndpoint.id, input.endpointId))
      .returning();

    const disabled = after !== undefined && !after.active;
    if (disabled) {
      /**
       * WRITTEN STRAIGHT INTO THE AUDIT LOG RATHER THAN THROUGH `audit`.
       *
       * That helper takes `ctx.actor.userId` for the actor column, and a
       * delivery pass runs as the system actor, whose id is the nil uuid and
       * is not a row in the user table. The foreign key would fail here,
       * five layers below anybody who could read the error, and the endpoint
       * would be disabled by an update that then rolled back. `emit` in
       * `services/events.ts` already handles exactly this case for the same
       * reason; `audit` does not.
       */
      await tx.insert(schema.auditLog).values({
        organizationId: ctx.actor.organizationId,
        actorUserId: isSystem(ctx.actor) ? null : ctx.actor.userId,
        actorAgentId: ctx.actor.agentId ?? null,
        action: "webhook.disabled",
        entityType: "webhook_endpoint",
        entityId: input.endpointId,
        before: null,
        /**
         * The last error is here because it is the only place it survives.
         * An operator opening a disabled endpoint otherwise sees a failure
         * count and no reason, and "it stopped working" is not something
         * they can act on, where "connection refused" and "HTTP 410" are two
         * completely different mornings.
         */
        after: {
          url: input.url,
          failureCount: after?.failureCount ?? FAILURE_LIMIT,
          reason: input.reason,
        },
      });
    }
    return disabled;
  });
}

/** Move one endpoint's position, once, at the end of its pass. */
async function commit(ctx: ServiceContext, endpointId: string, to: number): Promise<void> {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    await advanceCursor(tx, ctx.actor.organizationId, endpointId, to);
  });
}

/**
 * Where an endpoint is up to, for a screen that has to explain a backlog.
 *
 * The cursor is the one number that answers "has it had everything", and it
 * lives in a table nobody looking at webhooks would think to open.
 */
export async function position(
  ctx: ServiceContext, input: { id: string },
): Promise<{ id: string; deliveredThrough: number; pending: number }> {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const endpoint = await load(tx, ctx.actor.organizationId, input.id);
    const at = await cursorFor(tx, ctx.actor.organizationId, endpoint.id);
    const subscribed = endpoint.events ?? [];

    /**
     * Counted through the query builder rather than a `sql` fragment holding
     * `= any(...)`. A JavaScript array interpolated into a fragment is bound
     * as one parameter, which Postgres then tries to read as an array
     * literal and refuses, and the refusal only happens once somebody
     * actually opens this screen.
     */
    const [row] = await tx.select({ pending: sql<number>`count(*)::int` })
      .from(schema.domainEvent)
      .where(and(
        eq(schema.domainEvent.organizationId, ctx.actor.organizationId),
        gt(schema.domainEvent.sequence, at),
        inArray(schema.domainEvent.name, subscribed),
      ));

    return { id: endpoint.id, deliveredThrough: at, pending: Number(row?.pending ?? 0) };
  });
}

/* ------------------------------------------------------------- the routes */

/**
 * The shapes the contracts promise.
 *
 * Thin on purpose. Every rule in this file is in the functions above, and a
 * handler that did anything but rename an argument or wrap a list would be a
 * second place to look for what an endpoint does.
 */
export const handlers = {
  registerWebhookEndpoint: (
    ctx: ServiceContext,
    input: { url: string; events: string[]; active?: boolean | undefined },
  ) => register(ctx, input),

  listWebhookEndpoints: async (ctx: ServiceContext): Promise<{ endpoints: Endpoint[] }> =>
    ({ endpoints: await list(ctx) }),

  updateWebhookEndpoint: (
    ctx: ServiceContext,
    input: {
      id: string; url?: string | undefined;
      events?: string[] | undefined; active?: boolean | undefined;
    },
  ) => update(ctx, input),

  /**
   * `remove` returns nothing, because there is nothing left to describe. The
   * route still answers with a body: a 200 with an empty object is the shape
   * a generated client reads as "no fields", and every other write here
   * returns something.
   */
  deleteWebhookEndpoint: async (
    ctx: ServiceContext, input: { id: string },
  ): Promise<{ ok: true }> => {
    await remove(ctx, input);
    return { ok: true };
  },

  getWebhookPosition: (ctx: ServiceContext, input: { id: string }) => position(ctx, input),

  listWebhookEvents: async (
    ctx: ServiceContext,
  ): Promise<{ events: { name: string; summary: string | null }[] }> =>
    ({ events: await catalogue(ctx) }),
} as const;
