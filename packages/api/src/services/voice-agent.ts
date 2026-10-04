import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  agents as a, transcript as tr, voice, SYSTEM_USER_ID,
  type Actor, type telephony,
} from "@opentradesos/core";
import {
  guardedRead, inTenant, scopeOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { customerScopeFilter } from "./scope";
import * as booking from "./booking";
import * as base from "./agents";
import * as tel from "./telephony";
import { companyOf, servicesAndWindows, hoursOf, serviceAreaOf, bookItems } from "./agent-facts";
import type { AiDeps } from "./ai";
import { relayUrl } from "../voice/relay";

/**
 * THE PHONE ASSISTANT, ON A LIVE CALL
 *
 * A phone menu option, the after hours setting or a ring group nobody answered
 * sends a call here. The carrier holds the call and turns speech into text and
 * text into speech (Twilio's ConversationRelay); this file is what answers: it
 * opens the conversation with words no model wrote, hears each thing the
 * caller says, asks the company's own model what to do about it through the
 * same seam and under the same rules as the chat agent, and decides in code
 * what the answer becomes on the line.
 *
 * WHAT IT CAN DO, and only through the services a person's click would use:
 * answer from the company's facts, find the caller among the customers by the
 * number they ring from or what they say, offer windows online booking would
 * offer and take a booking request (`booking.createRequest`, the same as the
 * chat), take a message for the office, and put the caller through to a
 * person. Every model turn runs as the person on the agent's settings, under
 * their permissions and the company's spend ceiling, and counts against the
 * agent's runs a day.
 *
 * WHERE THE CODE RUNS. The first and last steps of an assistant call are the
 * carrier's ordinary webhooks, served by the web app like every other step of
 * a call. The conversation in between is a WebSocket the carrier opens to the
 * voice relay (`bin/voice-relay.ts`), a small process of its own, because the
 * web app's route handlers cannot hold one open. Both write here.
 *
 * WHAT IS KEPT. What the caller said, with card numbers and security codes
 * taken out before it is written down or shown to the model, and what the
 * assistant said, in order, on the session; at the end of the call the same
 * words become the call's transcript when it has none of its own. And one line
 * per thing the assistant did. The caller is told in the first sentence that
 * the call is written down, before they have said anything.
 */

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/** The system, on the carrier's behalf, for the session rows. The assistant's own work runs as its person. */
function carrierActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: base.agentId("voice") };
}

const carrierCtx = (db: Database, organizationId: string): ServiceContext => ({ actor: carrierActor(organizationId), db });

type SessionRow = typeof schema.voiceAgentSession.$inferSelect;
type CallRow = typeof schema.call.$inferSelect;
type Destination = telephony.RoutingDestination;

/* ---------------------------------------------------------- the hand over */

/**
 * Where the assistant puts a caller through to: its ring group when it has one
 * that still exists, otherwise voicemail. Never the assistant again.
 */
async function transferDestination(tx: Database, organizationId: string, settings: a.AgentSettings): Promise<Destination> {
  const id = settings.voice.transferRingGroupId;
  if (!id) return { kind: "voicemail", box: "main" };
  const [group] = await tx.select({ id: schema.ringGroup.id }).from(schema.ringGroup)
    .where(and(eq(schema.ringGroup.organizationId, organizationId), eq(schema.ringGroup.id, id))).limit(1);
  return group ? { kind: "ring_group", id: group.id } : { kind: "voicemail", box: "main" };
}

export type Begun =
  | { ok: true; verb: voice.Verb }
  | { ok: false; why: string; to: Destination };

/**
 * Send a call to the assistant, or say why not and where it goes instead.
 *
 * Inside the carrier's webhook transaction. Refused towards a person, never
 * towards silence: an assistant that is off, a relay this installation never
 * set up, or a caller who has already been through the assistant once on this
 * call (a group whose no answer sends calls back to it) all put the caller
 * through to where the assistant would have.
 */
export async function begin(tx: Database, organizationId: string, call: CallRow, input: {
  webhookToken: string; actionUrl: string; relayBase: string | undefined;
}): Promise<Begun> {
  const settings = await base.settingWithin(tx, organizationId, "voice");
  const fallback = await transferDestination(tx, organizationId, settings);
  if (!settings.enabled || !settings.runAsUserId) {
    return { ok: false, why: "The phone assistant is switched off, so it went where the assistant puts callers through.", to: fallback };
  }
  if (!input.relayBase) {
    return {
      ok: false,
      why: "The phone assistant could not answer: this installation has no voice relay address (VOICE_RELAY_URL).",
      to: fallback,
    };
  }
  const [already] = await tx.select({ id: schema.voiceAgentSession.id }).from(schema.voiceAgentSession)
    .where(eq(schema.voiceAgentSession.callId, call.id)).limit(1);
  if (already) {
    return { ok: false, why: "The caller had already spoken with the phone assistant on this call, so it went to voicemail.", to: { kind: "voicemail", box: "main" } };
  }

  const token = randomBytes(32).toString("base64url");
  const company = await companyOf(tx, organizationId, new Date());
  const greeting = a.openingWords(company.name, settings.chat.greeting);
  await tx.insert(schema.voiceAgentSession).values({
    organizationId, callId: call.id, tokenHash: hash(token), status: "waiting",
    turns: [{ from: "assistant", text: greeting, at: new Date().toISOString() }],
  });
  return {
    ok: true,
    verb: {
      verb: "relay", url: relayUrl(input.relayBase, input.webhookToken, token), action: input.actionUrl,
      greeting, language: "en-US",
    },
  };
}

/* ------------------------------------------------------- the conversation */

/** A conversation the relay is holding open. */
export interface Live {
  organizationId: string;
  sessionId: string;
  callId: string;
  /** The number the caller rang from, as the carrier gave it on the call. */
  callerNumber: string | null;
}

/**
 * The carrier opened the conversation. Matched by the session token in the
 * address it was given, and then by the call it names, so a token copied
 * onto another call opens nothing.
 */
export async function open(
  db: Database, organizationId: string, sessionToken: string, setup: { callSid: string },
): Promise<Live | null> {
  return inTenant(carrierCtx(db, organizationId), async (tx) => {
    const [row] = await tx.select({ session: schema.voiceAgentSession, call: schema.call })
      .from(schema.voiceAgentSession)
      .innerJoin(schema.call, eq(schema.call.id, schema.voiceAgentSession.callId))
      .where(eq(schema.voiceAgentSession.tokenHash, hash(sessionToken))).limit(1);
    if (!row || row.call.providerCallId !== `twilio:${setup.callSid}`) return null;
    if (row.session.status !== "waiting" && row.session.status !== "talking") return null;
    const now = new Date();
    await tx.update(schema.voiceAgentSession).set({
      status: "talking", connectedAt: row.session.connectedAt ?? now, updatedAt: now,
    }).where(eq(schema.voiceAgentSession.id, row.session.id));
    /**
     * Answered, by the assistant. A call it took a booking on was not a
     * missed call, and the text back the company sends after one must not
     * apologise to somebody who was just helped. A caller it puts through
     * to nobody is announced as missed by that dial, the way any is.
     */
    await tx.update(schema.call).set({
      status: voice.laterStatus(row.call.status, "in_progress"), answeredAt: row.call.answeredAt ?? now, updatedAt: now,
    }).where(eq(schema.call.id, row.call.id));
    return {
      organizationId, sessionId: row.session.id, callId: row.call.id,
      callerNumber: /^\+[1-9]\d{7,14}$/.test(row.call.fromE164) ? row.call.fromE164 : null,
    };
  });
}

async function sessionOf(tx: Database, sessionId: string): Promise<SessionRow> {
  const [row] = await tx.select().from(schema.voiceAgentSession).where(eq(schema.voiceAgentSession.id, sessionId)).limit(1);
  if (!row) throw new NotFoundError("Phone assistant call");
  return row;
}

/**
 * The caller's words, with card numbers and security codes taken out.
 *
 * The whole call is passed through the redaction, not only the new words,
 * because a security code is recognised by following a card number and the
 * two are often said a breath apart. Earlier words are already masked, so
 * passing them again changes nothing; only what was found in the new words is
 * counted.
 */
function redactNew(turns: SessionRow["turns"], said: string): { text: string; counts: Record<string, number> } {
  const segments: tr.Segment[] = [...turns, { from: "caller" as const, text: said, at: "" }].map((turn, index) => ({
    speaker: turn.from, startMs: index, endMs: index, text: turn.text || ".", confidence: 1,
  }));
  const redacted = tr.redactTranscript(segments);
  const last = segments.length - 1;
  const counts: Record<string, number> = {};
  for (const site of redacted.report.sites) {
    if (site.segmentIndex === last) counts[site.category] = (counts[site.category] ?? 0) + 1;
  }
  return { text: redacted.segments[last]!.text, counts };
}

const merge = (into: Record<string, number>, add: Record<string, number>) => {
  const out = { ...into };
  for (const [key, n] of Object.entries(add)) out[key] = (out[key] ?? 0) + n;
  return out;
};

/** Write something said onto the session. Returns the turns as they now stand. */
async function append(db: Database, live: Live, turn: { from: "caller" | "assistant"; text: string }, extra: Partial<SessionRow> = {}) {
  return inTenant(carrierCtx(db, live.organizationId), async (tx) => {
    const session = await sessionOf(tx, live.sessionId);
    let text = turn.text;
    let redactions = session.redactions;
    if (turn.from === "caller") {
      const cleaned = redactNew(session.turns, turn.text);
      text = cleaned.text;
      redactions = merge(redactions, cleaned.counts);
    }
    const turns = [...session.turns, { from: turn.from, text: text.slice(0, 4000), at: new Date().toISOString() }].slice(-200);
    const [after] = await tx.update(schema.voiceAgentSession).set({
      turns, redactions, ...extra, updatedAt: new Date(),
    }).where(eq(schema.voiceAgentSession.id, live.sessionId)).returning();
    return after!;
  });
}

async function act(db: Database, live: Live, action: string, detail: string, extra: Partial<SessionRow> = {}) {
  await inTenant(carrierCtx(db, live.organizationId), async (tx) => {
    const session = await sessionOf(tx, live.sessionId);
    await tx.update(schema.voiceAgentSession).set({
      actions: [...session.actions, { action, detail: detail.slice(0, 500), at: new Date().toISOString() }].slice(-50),
      ...extra, updatedAt: new Date(),
    }).where(eq(schema.voiceAgentSession.id, live.sessionId));
  });
}

export type Heard =
  /** Words were said and the call goes on. */
  | { kind: "go_on" }
  /** The conversation is over: the carrier ends it, and the call's next step says the closing words. */
  | { kind: "end"; reason: string };

/**
 * Close the conversation towards a person or a goodbye. The words are said by
 * the carrier's next step rather than over the relay, so they are heard in
 * full whatever the WebSocket does after it is told to end.
 */
async function ending(db: Database, live: Live, how: "transfer" | "hang_up", words: string, reason: string | null): Promise<Heard> {
  await append(db, live, { from: "assistant", text: words });
  await inTenant(carrierCtx(db, live.organizationId), async (tx) => {
    await tx.update(schema.voiceAgentSession).set({
      ending: how,
      status: how === "transfer" ? "transferred" : "ended",
      closingWords: words.slice(0, 600),
      ...(reason ? { transferReason: reason.slice(0, 500) } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.voiceAgentSession.id, live.sessionId));
  });
  if (how === "transfer") await act(db, live, "transfer", `Put the caller through: ${reason ?? "they asked"}`);
  return { kind: "end", reason: how };
}

/**
 * Customers the caller might be, within what the assistant's person may see.
 *
 * By the number they ring from on the first turn; by what they said when the
 * model asks to look them up. The model picks among these or nobody, and an
 * address on file is only used once the caller has confirmed it.
 */
async function candidates(tx: Database, ctx: ServiceContext, query: {
  phone: string | null; name: string | null; postalCode: string | null;
}): Promise<a.CustomerCandidate[]> {
  const digits = (query.phone ?? "").replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const name = query.name?.trim() ?? "";
  const postal = query.postalCode?.trim() ?? "";
  const ors = [
    local.length >= 7
      ? sql`right(regexp_replace(coalesce(${schema.customer.phone}, ''), '[^0-9]', '', 'g'), 10) = ${local.slice(-10)}`
      : undefined,
    name.length >= 3 ? ilike(schema.customer.name, `%${name.replace(/[%_\\]/g, "")}%`) : undefined,
  ].filter((x) => x !== undefined);
  if (ors.length === 0) return [];
  const rows = await tx.select({
    id: schema.customer.id, name: schema.customer.name, phone: schema.customer.phone, email: schema.customer.email,
  }).from(schema.customer)
    .where(and(isNull(schema.customer.deletedAt), or(...ors), customerScopeFilter(scopeOf(ctx, "customer"), ctx.actor)))
    .limit(5);
  const out: a.CustomerCandidate[] = [];
  for (const row of rows) {
    const [place] = await tx.select({
      line1: schema.property.addressLine1, city: schema.property.city, postal: schema.property.postalCode,
    }).from(schema.customerProperty)
      .innerJoin(schema.property, eq(schema.property.id, schema.customerProperty.propertyId))
      .where(and(eq(schema.customerProperty.customerId, row.id), isNull(schema.customerProperty.endedOn)))
      .orderBy(desc(schema.customerProperty.isPrimary)).limit(1);
    /** A postal code the caller gave narrows a name to the right household. */
    if (postal && name && place && place.postal !== postal) continue;
    out.push({
      id: row.id, name: row.name, phone: row.phone, email: row.email,
      address: place ? `${place.line1}, ${place.city} ${place.postal}` : null,
    });
  }
  return out;
}

/**
 * What the caller said, and the assistant's answer to it.
 *
 * `speak` sends words to the carrier straight away; it is how "one moment
 * while I look that up" is heard before the second model call rather than
 * after it. The caller's words are written down first, so they are on the
 * call whatever happens next.
 */
export async function hear(
  db: Database, live: Live, utterance: string, speak: (text: string) => Promise<void>,
  deps: AiDeps = base.DEFAULT_AGENT_DEPS,
): Promise<Heard> {
  const said = utterance.trim();
  const session = said === ""
    ? await inTenant(carrierCtx(db, live.organizationId), (tx) => sessionOf(tx, live.sessionId))
    : await append(db, live, { from: "caller", text: said }, { misses: 0 });
  if (session.status !== "talking") return { kind: "end", reason: "over" };

  const acting = await base.actingAs(db, live.organizationId, "voice");
  const limit = acting.settings.limits.messagesPerChat;
  const first = a.beforeModel({ utterance: said, turnsTaken: session.agentTurns, turnLimit: limit, misses: session.misses });
  if (first.kind === "again") {
    await inTenant(carrierCtx(db, live.organizationId), (tx) => tx.update(schema.voiceAgentSession)
      .set({ misses: sql`${schema.voiceAgentSession.misses} + 1`, updatedAt: new Date() })
      .where(eq(schema.voiceAgentSession.id, live.sessionId)));
    await say(db, live, first.say, speak);
    return { kind: "go_on" };
  }
  if (first.kind === "transfer") return ending(db, live, "transfer", first.say, first.reason);
  if (!acting.ok) return ending(db, live, "transfer", a.UNSURE, acting.reason);

  return turn(db, live, acting, speak, deps, { lookedUp: false, found: null });
}

async function say(db: Database, live: Live, text: string, speak: (text: string) => Promise<void>) {
  await append(db, live, { from: "assistant", text });
  await speak(text);
}

/** One model turn, and what it becomes. At most two per thing the caller says: a look up, then its answer. */
async function turn(
  db: Database, live: Live, acting: Extract<base.Acting, { ok: true }>,
  speak: (text: string) => Promise<void>, deps: AiDeps,
  look: { lookedUp: boolean; found: a.CustomerCandidate[] | null },
): Promise<Heard> {
  const { ctx, settings } = acting;
  const now = (deps.now ?? (() => new Date()))();
  const context = await inTenant(ctx, async (tx) => {
    const session = await sessionOf(tx, live.sessionId);
    const company = await companyOf(tx, live.organizationId, now);
    const { services, windows } = await servicesAndWindows(tx, live.organizationId, company.timezone, company.today, { perService: 4 });
    const published = await bookItems(tx, live.organizationId, { ids: settings.chat.publicPriceItemIds, limit: 200 });
    const facts: a.ChatFacts = {
      hours: await hoursOf(tx, live.organizationId),
      serviceArea: await serviceAreaOf(tx, live.organizationId),
      services: services.map((s) => ({ id: s.id, name: s.publicName, description: s.publicDescription, price: s.displayPrice })),
      publicPrices: published.items.map((item) => ({ name: item.name, price: item.price })),
      faq: settings.chat.faq,
      windows,
    };
    const found = look.found ?? await candidates(tx, ctx, { phone: live.callerNumber, name: null, postalCode: null });
    return { session, company, facts, found };
  });

  const prompt = a.voicePrompt({
    company: context.company, tone: settings.tone, facts: context.facts,
    turns: context.session.turns.map((t) => ({ from: t.from, text: t.text })),
    caller: { number: live.callerNumber, candidates: context.found, lookedUp: look.lookedUp },
    bookingTaken: context.session.bookingRequestId !== null, messageTaken: context.session.messageTaken,
  });
  const result = await base.ask(acting, "voice", prompt, "voice:call", deps);
  await inTenant(carrierCtx(db, live.organizationId), (tx) => tx.update(schema.voiceAgentSession)
    .set({ agentTurns: sql`${schema.voiceAgentSession.agentTurns} + 1`, updatedAt: new Date() })
    .where(eq(schema.voiceAgentSession.id, live.sessionId)));
  if (!result.ok) return ending(db, live, "transfer", a.UNSURE, `The assistant could not answer: ${result.reason}`);

  const allowed = [
    ...context.facts.services.flatMap((s) => (s.price ? [s.price] : [])),
    ...context.facts.publicPrices.map((p) => p.price),
  ];
  let decision = a.decideVoice({
    action: result.action.name, args: result.input, allowedPrices: allowed, windows: context.facts.windows,
    callerNumber: live.callerNumber, bookingTaken: context.session.bookingRequestId !== null,
    messageTaken: context.session.messageTaken, lookedUp: look.lookedUp,
  });
  if (decision.kind === "refused") {
    const reason = decision.reason;
    await inTenant(ctx, (tx) => base.note(tx, ctx, { agent: "voice", kind: "refused", detail: reason }));
    decision = decision.then;
  }

  switch (decision.kind) {
    case "say":
      await say(db, live, decision.text, speak);
      return { kind: "go_on" };

    case "look_up": {
      await say(db, live, decision.text, speak);
      const query = decision.query;
      const found = await inTenant(ctx, (tx) => candidates(tx, ctx, query));
      await act(db, live, "look_up", found.length > 0
        ? `Looked the caller up and found ${found.length === 1 ? found[0]!.name : `${found.length} customers`}.`
        : "Looked the caller up and found nobody.");
      return turn(db, live, acting, speak, deps, { lookedUp: true, found });
    }

    case "book": {
      try {
        const made = await booking.createRequest(db, {
          organizationSlug: context.company.slug,
          bookableServiceId: decision.request.bookableServiceId,
          requestedDate: decision.request.date,
          arrivalWindowId: decision.request.arrivalWindowId,
          contactName: decision.request.contactName,
          contactPhone: decision.request.phone,
          addressLine1: decision.request.address.line1,
          ...(decision.request.address.line2 ? { addressLine2: decision.request.address.line2 } : {}),
          city: decision.request.address.city,
          state: decision.request.address.state,
          postalCode: decision.request.address.postalCode,
          ...(decision.request.notes ? { notes: decision.request.notes } : {}),
          intakeAnswers: {},
          utm: {},
        }, { idempotencyKey: `ai-voice:${live.sessionId}` });
        await act(db, live, "booking_request",
          `Took a booking request from ${decision.request.contactName} for ${decision.window.label}. It is waiting in Online booking for the office to confirm.`,
          { bookingRequestId: made.request.id });
        await inTenant(ctx, (tx) => base.note(tx, ctx, {
          agent: "voice", kind: "answered",
          detail: `Took a booking request on a call from ${decision.request.contactName} for ${decision.request.date}. It is waiting in Online booking for the office to confirm.`,
        }));
        await say(db, live, decision.text, speak);
      } catch (error) {
        if (!(error instanceof ConflictError) && !(error instanceof NotFoundError)) throw error;
        await say(db, live, "Sorry, that time has just been taken. Could you pick another?", speak);
      }
      return { kind: "go_on" };
    }

    case "message": {
      const who = decision.callerName ?? "A caller";
      const back = decision.callbackNumber ?? "the number they called from";
      const match = context.found.length === 1 ? context.found[0]! : null;
      const message = decision.message;
      await inTenant(carrierCtx(db, live.organizationId), (tx) => tx.insert(schema.task).values({
        organizationId: live.organizationId,
        title: `Phone message from ${who}`.slice(0, 200),
        body: `${message}\n\nCall back on ${back}. Taken by the phone assistant.`.slice(0, 4000),
        priority: "normal",
        entityType: match ? "customer" : "call",
        entityId: match ? match.id : live.callId,
      }));
      await act(db, live, "message", `Took a message from ${who} for the office, to call back on ${back}.`, { messageTaken: true });
      await say(db, live, decision.text, speak);
      return { kind: "go_on" };
    }

    case "transfer":
      return ending(db, live, "transfer", decision.text, decision.reason);

    case "hang_up":
      await act(db, live, "goodbye", "Said goodbye when the caller was done.");
      return ending(db, live, "hang_up", decision.text, null);
  }
}

/** A key pressed on the call. Only 0 means anything: a person, please. */
export async function pressed(db: Database, live: Live, digit: string): Promise<Heard> {
  const verdict = a.keyPressed(digit);
  if (!verdict || verdict.kind !== "transfer") return { kind: "go_on" };
  return ending(db, live, "transfer", verdict.say, verdict.reason);
}

/**
 * The caller talked over the assistant. What it had got through is what they
 * heard, so the last thing it said is written down as far as that.
 */
export async function interrupted(db: Database, live: Live, heard: string): Promise<void> {
  await inTenant(carrierCtx(db, live.organizationId), async (tx) => {
    const session = await sessionOf(tx, live.sessionId);
    const turns = [...session.turns];
    const last = turns.at(-1);
    if (!last || last.from !== "assistant" || heard.trim() === "" || !last.text.startsWith(heard.trim())) return;
    turns[turns.length - 1] = { ...last, text: `${heard.trim()} [cut off]` };
    await tx.update(schema.voiceAgentSession).set({ turns, updatedAt: new Date() })
      .where(eq(schema.voiceAgentSession.id, live.sessionId));
  });
}

/**
 * The WebSocket closed. A conversation still talking when it did was dropped:
 * the caller hung up, or the carrier lost it. Its words are kept all the same,
 * here rather than only at the carrier's next step, because a caller who
 * hangs up as they are being put through brings no next step.
 */
export async function closed(db: Database, live: Live): Promise<void> {
  await inTenant(carrierCtx(db, live.organizationId), async (tx) => {
    const session = await sessionOf(tx, live.sessionId);
    if (session.status === "waiting") return;
    if (session.status === "talking") {
      await tx.update(schema.voiceAgentSession).set({ status: "dropped", updatedAt: new Date() })
        .where(eq(schema.voiceAgentSession.id, live.sessionId));
    }
    await finish(tx, carrierCtx(db, live.organizationId), live.sessionId);
  });
}

/* ------------------------------------------------------- after the relay */

export type After =
  | { say: string | null; then: "hang_up" }
  | { say: string | null; then: "transfer"; to: Destination; why: string };

/**
 * The carrier's next step once the conversation is over: what to say, and
 * where the caller goes. Read from the session the assistant wrote, never
 * from anything the carrier hands back, so the decision is the one made in
 * code during the call.
 */
export async function afterRelay(tx: Database, ctx: ServiceContext, call: CallRow): Promise<After> {
  const organizationId = ctx.actor.organizationId;
  const [session] = await tx.select().from(schema.voiceAgentSession)
    .where(eq(schema.voiceAgentSession.callId, call.id)).limit(1);
  const settings = await base.settingWithin(tx, organizationId, "voice");
  const to = await transferDestination(tx, organizationId, settings);
  if (!session) return { say: null, then: "transfer", to: { kind: "voicemail", box: "main" }, why: "The phone assistant had no record of this call." };

  if (session.ending === "hang_up") {
    await finish(tx, ctx, session.id);
    return { say: session.closingWords, then: "hang_up" };
  }
  if (session.ending === "transfer") {
    await finish(tx, ctx, session.id);
    return { say: session.closingWords, then: "transfer", to, why: `The phone assistant put the caller through: ${session.transferReason ?? "they asked"}` };
  }

  /**
   * Over with nothing decided: the relay never answered, or the conversation
   * broke off mid call. The caller is still there, so they go to a person.
   */
  const never = session.status === "waiting";
  await tx.update(schema.voiceAgentSession).set({
    status: "dropped", ending: "transfer",
    transferReason: never ? "The phone assistant could not be reached." : "The conversation with the phone assistant broke off.",
    updatedAt: new Date(),
  }).where(eq(schema.voiceAgentSession.id, session.id));
  await finish(tx, ctx, session.id);
  return {
    say: never ? "Sorry, our assistant is not available right now. Putting you through." : a.UNSURE,
    then: "transfer", to,
    why: never
      ? "The phone assistant could not be reached (is the voice relay running?), so the caller was put through."
      : "The conversation with the phone assistant broke off, so the caller was put through.",
  };
}

/**
 * Close the session's record: the words onto the call as its transcript,
 * when the call has none of its own, and one line in the agents' log saying
 * what the assistant did. Once only, whichever of the relay closing and the
 * carrier's next step gets here first.
 */
async function finish(tx: Database, ctx: ServiceContext, sessionId: string): Promise<void> {
  const [session] = await tx.update(schema.voiceAgentSession).set({ endedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(schema.voiceAgentSession.id, sessionId), isNull(schema.voiceAgentSession.endedAt))).returning();
  if (!session) return;
  const [call] = await tx.select().from(schema.call).where(eq(schema.call.id, session.callId)).limit(1);
  if (!call) return;

  const heard = session.turns.filter((t) => t.text.trim() !== "");
  if (call.transcriptStatus === null && heard.some((t) => t.from === "caller")) {
    const start = (session.connectedAt ?? session.createdAt).getTime();
    const end = (session.endedAt ?? new Date()).getTime();
    const offsets = heard.map((t) => Math.max(0, Date.parse(t.at) - start));
    /** Each line runs until the next one starts, so no two overlap and none runs backwards. */
    for (let i = 1; i < offsets.length; i += 1) offsets[i] = Math.max(offsets[i]!, offsets[i - 1]!);
    const segments = heard.map((t, i) => ({
      speaker: t.from, text: t.text, confidence: 1,
      startMs: offsets[i]!, endMs: i + 1 < offsets.length ? offsets[i + 1]! : Math.max(offsets[i]!, end - start),
    }));
    try {
      await tel.attachTranscriptIn(tx, ctx, { callId: call.id, segments, source: "assistant" });
      /** What was taken out as the caller spoke, which a second pass over masked words cannot count. */
      await tx.update(schema.call).set({ transcriptRedactionCounts: session.redactions, updatedAt: new Date() })
        .where(eq(schema.call.id, call.id));
    } catch (error) {
      /** Somebody on the call declined recording, or its recording was deleted: the words stay on the session only. */
      if (!(error instanceof ConflictError)) throw error;
    }
  }

  const did = session.actions.filter((x) => x.action !== "look_up").map((x) => x.detail);
  const summary = `Answered a call from ${call.fromE164}${did.length > 0 ? `: ${did.join(" ")}` : "."}`;
  await tx.insert(schema.aiAgentActivity).values({
    organizationId: ctx.actor.organizationId,
    agent: "voice",
    kind: session.ending === "transfer" ? "handed_off" : "answered",
    detail: summary.slice(0, 1000),
  });
}

/* ------------------------------------------------------------------ reads */

export interface AssistantView {
  status: SessionRow["status"];
  turns: { from: "caller" | "assistant"; text: string; at: string }[];
  actions: { action: string; detail: string; at: string }[];
  transferReason: string | null;
  bookingRequestId: string | null;
  messageTaken: boolean;
  redactions: Record<string, number>;
  connectedAt: string | null;
  endedAt: string | null;
}

/**
 * What the assistant heard, said and did on one call, for the call screen.
 *
 * `message:read`, the permission that reads the call: the conversation is
 * the call, and whoever may read one may read the other.
 */
export async function forCall(ctx: ServiceContext, callId: string): Promise<AssistantView | null> {
  return guardedRead(ctx, "message:read", async (tx) => {
    const [session] = await tx.select().from(schema.voiceAgentSession)
      .where(and(eq(schema.voiceAgentSession.organizationId, ctx.actor.organizationId), eq(schema.voiceAgentSession.callId, callId)))
      .limit(1);
    if (!session) return null;
    return {
      status: session.status,
      turns: session.turns,
      actions: session.actions,
      transferReason: session.transferReason,
      bookingRequestId: session.bookingRequestId,
      messageTaken: session.messageTaken,
      redactions: Object.fromEntries(Object.entries(session.redactions).filter(([, n]) => n > 0)),
      connectedAt: session.connectedAt?.toISOString() ?? null,
      endedAt: session.endedAt?.toISOString() ?? null,
    };
  });
}

/** Which of these calls the assistant answered, for marking them on the call log. */
export async function answeredAmong(ctx: ServiceContext, callIds: readonly string[]): Promise<Set<string>> {
  if (callIds.length === 0) return new Set();
  return guardedRead(ctx, "message:read", async (tx) => {
    const rows = await tx.select({ callId: schema.voiceAgentSession.callId }).from(schema.voiceAgentSession)
      .where(and(
        eq(schema.voiceAgentSession.organizationId, ctx.actor.organizationId),
        sql`${schema.voiceAgentSession.callId} in (${sql.join(callIds.map((id) => sql`${id}::uuid`), sql`, `)})`,
      ));
    return new Set(rows.map((r) => r.callId));
  });
}

/** Whether the phone assistant can be sent calls, for the phone settings screen. */
export async function readiness(ctx: ServiceContext): Promise<{ on: boolean; relay: boolean }> {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const settings = await base.settingWithin(tx, ctx.actor.organizationId, "voice");
    return { on: settings.enabled && settings.runAsUserId !== null, relay: Boolean(process.env["VOICE_RELAY_URL"]) };
  });
}

export const handlers = {
  getCallAssistant: async (ctx: ServiceContext, input: { id: string }) => {
    const view = await forCall(ctx, input.id);
    if (!view) throw new NotFoundError("Phone assistant call");
    return view;
  },
} as const;
