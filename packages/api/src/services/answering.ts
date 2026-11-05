import { and, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { inTenant, type ServiceContext } from "./context";

/**
 * AN ANSWER BEING WRITTEN, MARKED ON ITS IDEMPOTENCY RECORD
 *
 * The field assistant and the website chat answer as the model writes. A
 * phone on one bar of signal drops the stream halfway and asks again with
 * the same idempotency key (the SDK's `events()` does exactly that). Until
 * now the second request either answered from the record, when the first
 * answer had finished, or asked the model again, paying twice and writing a
 * second answer, because nothing said the first was still being written.
 *
 * Now the first request marks its idempotency record `in_flight` before the
 * model is asked, and writes the answer so far onto it (or, for the chat, on
 * the chat itself) as each sentence is finished. A second request with the
 * same key that finds the mark JOINS the answer: it is sent what has been
 * written so far, each sentence after it as it is written, and then the same
 * whole answer the first request gets, read from the record. It never asks
 * the model.
 *
 * A mark nobody has written to for two minutes is a request that died
 * (the process was restarted mid answer): the next request takes it over and
 * asks again, because otherwise the key could never be answered. A first
 * request that failed leaves its mark `failed`, so a retry asks again rather
 * than joining nothing. The mark is taken under a transaction scoped lock on
 * the key, so two requests arriving together cannot both ask.
 */

/** No word written for this long and the request that marked it is taken to have died. */
export const STALE_MS = 120_000;
/** How often a joining request reads the record. Sentences arrive a second or so apart. */
export const JOIN_POLL_MS = 400;
/** The longest a request waits on another's answer before saying so. */
export const JOIN_LIMIT_MS = 180_000;

export type Claim =
  /** Nobody else is answering: this request asks, and writes its progress to `markId`. */
  | { kind: "mine"; markId: string }
  /** Another request is answering now: this one joins it. */
  | { kind: "joining"; markId: string }
  /** The answer was finished a moment ago: read it from the record. */
  | { kind: "done" };

type Mark = typeof schema.integrationEvent.$inferSelect;

/** The mark for a key, found by provider and key within the company. */
async function markOf(tx: Database, organizationId: string, provider: string, key: string): Promise<Mark | null> {
  const [row] = await tx.select().from(schema.integrationEvent).where(and(
    eq(schema.integrationEvent.organizationId, organizationId),
    eq(schema.integrationEvent.provider, provider),
    eq(schema.integrationEvent.idempotencyKey, key),
  )).limit(1);
  return row ?? null;
}

/**
 * Mark an answer as being written, or find that somebody already is.
 * `provider` names the route's own records ("ai-field"); `key` is the
 * caller's idempotency key as that route keeps it.
 */
export async function claim(ctx: ServiceContext, provider: string, key: string, now: Date = new Date()): Promise<Claim> {
  const org = ctx.actor.organizationId;
  return inTenant(ctx, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`answering:${org}:${provider}:${key}`}))`);
    const found = await markOf(tx, org, provider, key);
    if (!found) {
      const [made] = await tx.insert(schema.integrationEvent).values({
        organizationId: org, direction: "inbound", provider, eventType: "answer.writing",
        idempotencyKey: key, status: "in_flight", attempts: 1, responsePayload: { writing: null },
      }).returning({ id: schema.integrationEvent.id });
      return { kind: "mine", markId: made!.id };
    }
    if (found.status === "succeeded") return { kind: "done" };
    if (found.status === "in_flight" && now.getTime() - found.updatedAt.getTime() < STALE_MS) {
      return { kind: "joining", markId: found.id };
    }
    /** Failed, or a request that died mid answer: this one asks again. */
    await tx.update(schema.integrationEvent).set({
      status: "in_flight", attempts: found.attempts + 1, responsePayload: { writing: null }, error: null,
      completedAt: null, updatedAt: now,
    }).where(eq(schema.integrationEvent.id, found.id));
    return { kind: "mine", markId: found.id };
  });
}

/**
 * The answer so far, written onto the mark as each sentence is finished, in
 * order and never at the cost of the answer: a failed write is logged, and
 * the mark's own clock moves with it so a long answer is not taken as dead.
 */
export function progressWriter(ctx: ServiceContext, markId: string): { write: (text: string) => void; flush: () => Promise<void> } {
  let chain: Promise<unknown> = Promise.resolve();
  return {
    write: (text) => {
      chain = chain.then(() => inTenant(ctx, (tx) => tx.update(schema.integrationEvent)
        .set({ responsePayload: { writing: text }, updatedAt: new Date() })
        .where(and(eq(schema.integrationEvent.id, markId), eq(schema.integrationEvent.status, "in_flight")))))
        .catch((error: unknown) => {
          console.error(`[answering] keeping the answer so far failed: ${error instanceof Error ? error.message : String(error)}`);
        });
    },
    flush: async () => { await chain; },
  };
}

/** The answer is finished, and kept where the route keeps it; or it failed, and the next request asks again. */
export async function finish(ctx: ServiceContext, markId: string, ok: boolean, error?: string): Promise<void> {
  await inTenant(ctx, (tx) => tx.update(schema.integrationEvent).set({
    status: ok ? "succeeded" : "failed", completedAt: new Date(), updatedAt: new Date(),
    ...(ok ? { responsePayload: {} } : { error: (error ?? "The answer could not be finished.").slice(0, 500) }),
  }).where(eq(schema.integrationEvent.id, markId)));
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Join an answer another request is writing.
 *
 * `read` reads the finished answer from wherever the route keeps it, or
 * null while there is none yet; `writing` reads the answer so far (the
 * mark's, by default). Each time the answer so far grows it is handed to
 * `show`. Answers the finished answer, or null when the request writing it
 * failed or died, so the caller can ask itself.
 */
export async function join<T>(
  ctx: ServiceContext,
  markId: string,
  read: (tx: Database) => Promise<T | null>,
  show?: ((text: string) => void) | undefined,
  options: {
    writing?: ((tx: Database, mark: Mark) => Promise<string | null>) | undefined;
    now?: (() => Date) | undefined;
    pollMs?: number | undefined;
    limitMs?: number | undefined;
  } = {},
): Promise<T | null> {
  const clock = options.now ?? (() => new Date());
  const started = clock().getTime();
  let shown = "";
  for (;;) {
    const state = await inTenant(ctx, async (tx) => {
      const answer = await read(tx);
      if (answer !== null) return { answer, mark: null, writing: null };
      const [mark] = await tx.select().from(schema.integrationEvent).where(eq(schema.integrationEvent.id, markId)).limit(1);
      const writing = mark
        ? options.writing ? await options.writing(tx, mark) : ((mark.responsePayload ?? {}) as { writing?: string | null }).writing ?? null
        : null;
      return { answer: null, mark: mark ?? null, writing };
    });
    if (state.answer !== null) return state.answer;
    const mark = state.mark;
    if (!mark || mark.status === "failed" || (mark.status === "in_flight" && clock().getTime() - mark.updatedAt.getTime() >= STALE_MS)) {
      return null;
    }
    if (mark.status === "succeeded") {
      /** Finished between the two reads: one more read finds it. */
      const answer = await inTenant(ctx, read);
      return answer;
    }
    if (show && state.writing && state.writing.length > shown.length) {
      shown = state.writing;
      show(shown);
    }
    if (clock().getTime() - started >= (options.limitMs ?? JOIN_LIMIT_MS)) return null;
    await sleep(options.pollMs ?? JOIN_POLL_MS);
  }
}
