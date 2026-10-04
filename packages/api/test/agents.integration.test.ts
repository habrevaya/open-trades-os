import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { agents as coreAgents, geo, time, type Actor } from "@opentradesos/core";
import * as ai from "../src/services/ai";
import * as agents from "../src/services/agents";
import * as intake from "../src/services/agent-intake";
import * as chat from "../src/services/agent-chat";
import * as estimates from "../src/services/agent-estimates";
import * as collections from "../src/services/agent-collections";
import * as copilot from "../src/services/agent-dispatch";
import * as worker from "../src/services/agent-worker";
import * as comms from "../src/services/comms";
import * as company from "../src/services/company";
import * as geocoding from "../src/services/geocoding";
import * as dispatchMap from "../src/services/dispatch-map";
import { routes } from "../src/contracts";
import "../src/ai/index";
import type {
  AiContent, AiProvider, CompletionOutcome, CompletionRequest, ModelListOutcome, ModelRate,
} from "../src/ai/provider";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * THE AGENTS, AGAINST A FAKE MODEL
 *
 * Every model answer here is scripted, so what is being tested is everything
 * around the model: who an agent acts as, which actions it is offered, what
 * its answer is held to, what it writes down, and that applying a proposal is
 * the ordinary service a person would have called. Two of the scripted models
 * misbehave on purpose: one asks for an action its person may not take, and
 * one tries to quote a price the company never published.
 *
 * No test here reaches a vendor. The provider is injected, the same way the
 * seam's own tests inject it.
 */

const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("agents:org");
const OWNER = fixtureId("agents:owner");
const CSR = fixtureId("agents:csr");
const NARROW = fixtureId("agents:narrow");
const ZONE = "America/Chicago";
const SLUG = "agents-co";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (extra: Partial<ServiceContext> = {}): ServiceContext => ({
  actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(), ...extra,
});
/** Somebody who may configure agents and read messages, and nothing else. */
const narrow = (): ServiceContext => ({
  actor: {
    userId: NARROW, organizationId: ORG, roles: [] as Actor["roles"],
    grants: ["agent:configure", "integration:read", "message:read", "customer:read", "booking:read"],
  },
  db: db(),
});

/* ------------------------------------------------------------- the model */

type Script = (request: CompletionRequest) => AiContent[];

interface FakeModel { provider: AiProvider; requests: CompletionRequest[]; script: Script }

function fakeModel(): FakeModel {
  const model: FakeModel = {
    requests: [],
    script: () => [{ type: "text", text: "nothing scripted" }],
    provider: undefined as unknown as AiProvider,
  };
  model.provider = {
    name: "anthropic",
    toolCallIdentity: { kind: "vendor" },
    defaultModel: "fake-model",
    rateFor: (): ModelRate => ({ inputMicrosPerToken: 1, outputMicrosPerToken: 5, source: "adapter", asOf: "2026-09-25" }),
    async complete(request): Promise<CompletionOutcome> {
      model.requests.push(request);
      const content = model.script(request);
      return {
        ok: true,
        completion: {
          model: request.model, content,
          stop: content.some((c) => c.type === "toolCall") ? "toolUse" : "end",
          usage: { inputTokens: 200, outputTokens: 40, cachedInputTokens: null },
        },
      };
    },
    async models(): Promise<ModelListOutcome> {
      return { ok: true, models: [{ id: "fake-model", label: "Fake" }] };
    },
  };
  return model;
}

const call = (name: string, input: Record<string, unknown>): AiContent[] =>
  [{ type: "toolCall", callId: `call_${name}`, name, input }];

const promptOf = (request: CompletionRequest): string =>
  request.messages.flatMap((m) => m.content).map((c) => (c.type === "text" ? c.text : "")).join("\n");

/** The first open window the agent was shown, read back out of the prompt the way a model reads it. */
function firstWindow(request: CompletionRequest) {
  const match = /"bookableServiceId": "([^"]+)",\s*"date": "([^"]+)",\s*"arrivalWindowId": "([^"]+)"/.exec(promptOf(request));
  if (!match) throw new Error("The prompt had no open window in it.");
  return { bookableServiceId: match[1]!, date: match[2]!, arrivalWindowId: match[3]! };
}

const model = fakeModel();
const NOW = () => time.instantOfLocal(time.dateIn(new Date(), ZONE), 10 * 60, ZONE);
const deps = (): ai.AiDeps => ({ readSecret: async () => "sk-test-not-a-key", provider: model.provider, now: NOW });

/* -------------------------------------------------------------- fixtures */

async function member(userId: string, key: string, role: string, revocations: string[] = []) {
  await raw`delete from public."user" where id = ${userId} or email = ${`${key}@agents.test`}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${key}@agents.test`}, ${key})`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role, revocations)
    values (${ORG}, ${userId}, ${role}::member_role, ${raw.json(revocations as never)}) returning id`;
  return m!.id;
}

async function configure(agent: coreAgents.AgentKind, over: Partial<coreAgents.AgentSettings> = {}, ctx = owner()) {
  return agents.configure(ctx, {
    agent, settings: { ...coreAgents.defaultSettings(agent), enabled: true, runAsUserId: OWNER, ...over },
  });
}

async function inboundText(from: string, body: string): Promise<string> {
  const [c] = await raw<{ id: string }[]>`
    insert into public.conversation (organization_id, channel, external_address, status, last_message_at)
    values (${ORG}, 'sms', ${from}, 'open', now()) returning id`;
  await raw`insert into public.message (organization_id, conversation_id, direction, channel, from_address, to_address, body, status)
            values (${ORG}, ${c!.id}, 'inbound', 'sms', ${from}, '+15125559900', ${body}, 'received')`;
  return c!.id;
}

let serviceId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Agents Plumbing", slug: SLUG });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await member(CSR, "agents-csr", "csr", ["booking:decide"]);
  await member(NARROW, "agents-narrow", "readonly");
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered, capabilities)
            values (${ORG}, '+15125559900', 'main', true, '{"sms":true}'::jsonb)`;

  const [jt] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name) values (${ORG}, 'Water heater repair') returning id`;
  const [svc] = await raw<{ id: string }[]>`
    insert into public.bookable_service (organization_id, job_type_id, public_name, display_price,
      min_notice_hours, max_advance_days, max_per_window)
    values (${ORG}, ${jt!.id}, 'Water heater repair', 149.0000, 0, 30, 5) returning id`;
  serviceId = svc!.id;
  await raw`
    insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week)
    values (${ORG}, 'Morning', '08:00', '12:00', ${[0, 1, 2, 3, 4, 5, 6]})`;
  for (let d = 0; d < 7; d += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at)
              values (${ORG}, ${d}, '07:00', '18:00')`;
  }
  await ai.connect(owner(), { provider: "anthropic", credentialRef: "TEST_AI_KEY", settings: { defaultModel: "fake-model" } });
});
afterAll(async () => {
  if (!raw) return;
  /**
   * Every agent off again, so another file's worker pass does not find this
   * company's agents on and try a model nobody connected for it.
   */
  await raw`delete from public.ai_agent_setting where organization_id = ${ORG}`;
  await raw.end();
});

const activity = (kind: string) => raw<{ detail: string; agent: string }[]>`
  select detail, agent from public.ai_agent_activity where organization_id = ${ORG} and kind = ${kind} order by created_at`;

/* ============================================================ settings === */

run("setting an agent up", () => {
  it("lists all seven agents, off, with what each could do", async () => {
    const listed = await agents.list(owner());
    expect(listed.agents.map((a) => a.agent)).toEqual(["intake", "chat", "voice", "estimate", "collections", "dispatch", "field"]);
    expect(listed.agents.every((a) => !a.settings.enabled)).toBe(true);
  });

  it("will not let somebody hand an agent more access than they have", async () => {
    await expect(configure("intake", {}, narrow())).rejects.toThrow(/can do things you cannot/);
  });

  it("will not let the dispatch copilot act on its own", async () => {
    await expect(configure("dispatch", { mode: "auto" })).rejects.toThrow(/always waits for a person/);
  });

  it("says what the agent may do as the person it acts as", async () => {
    await configure("intake", { runAsUserId: CSR });
    const listed = await agents.list(owner());
    const row = listed.agents.find((a) => a.agent === "intake")!;
    expect(row.runAs?.actions).toEqual(["not_a_booking"]);
    await configure("intake", { enabled: false });
  });

  it("holds each action to the permissions of the route that applies it", () => {
    /**
     * The action's list is what decides whether a model is told about it.
     * The route's list is what a role built from the published API grants.
     * The two must be the same list, or an agent is offered something its
     * person is refused at the last step, or not offered what they could do.
     */
    const pairs: [coreAgents.AgentKind, string, keyof typeof routes][] = [
      ["intake", "propose_booking", "approveIntakeDraft"],
      ["estimate", "draft_estimate", "acceptEstimateDraft"],
      ["collections", "draft_reminder", "sendCollectionReminder"],
      ["dispatch", "propose_assignments", "applyDispatchPlan"],
    ];
    for (const [agent, action, route] of pairs) {
      const declared = coreAgents.AGENTS[agent].actions.find((a) => a.name === action)!.permissions;
      expect([...declared].sort(), `${agent}.${action}`).toEqual([...routes[route].permissions].sort());
    }
  });
});

/* ============================================================== intake === */

run("the intake agent", () => {
  it("drafts a booking from a text, keeping only what is really open and really a candidate", async () => {
    await configure("intake");
    const conversationId = await inboundText("+15125550101", "Hi this is Dana Ruiz, water heater leaking all over the garage. 12 Elm St Austin TX 78701");
    model.script = (request) => {
      const open = firstWindow(request);
      return call("propose_booking", {
        customerId: fixtureId("agents:not-a-candidate"),
        contactName: "Dana Ruiz", phone: "+15125550101",
        address: { line1: "12 Elm St", city: "Austin", state: "TX", postalCode: "78701" },
        problemSummary: "Water heater leaking in the garage.",
        bookableServiceId: open.bookableServiceId,
        urgency: "soon",
        windows: [open, { date: "2031-01-01", arrivalWindowId: open.arrivalWindowId }],
      });
    };
    const pass = await worker.passFor(db(), ORG, deps());
    expect(pass.drafted).toBe(1);

    const listed = await intake.drafts(owner(), { sourceKind: "conversation", sourceId: conversationId });
    const draft = listed.drafts[0]!;
    expect(draft.status).toBe("proposed");
    expect(draft.draft["customerId"]).toBeNull();
    expect((draft.draft["windows"] as unknown[]).length).toBe(1);
    expect(draft.draft["droppedWindows"]).toBe(1);
    expect(draft.runAsUserId).toBe(OWNER);
    expect(draft.startedByUserId).toBeNull();

    // The model was told about the booking action because its person may take it.
    expect(model.requests.at(-1)!.tools!.map((t) => t.name)).toEqual(["propose_booking", "not_a_booking"]);
    // And a second pass does not read the same text again.
    const again = await worker.passFor(db(), ORG, deps());
    expect(again.drafted).toBe(0);
  });

  it("books it in one click, through the booking page's own path, and a retry books nothing twice", async () => {
    const [draft] = (await intake.drafts(owner(), { status: ["proposed"] })).drafts;
    const applied = await intake.approve(owner(), { id: draft!.id });
    expect(applied.status).toBe("applied");
    const outcome = applied.outcome as { jobId: string; visitId: string; bookingRequestId: string; customerId: string };

    const [visit] = await raw<{ window_start: Date; status: string }[]>`
      select window_start, status from public.visit where id = ${outcome.visitId}`;
    expect(visit!.status).toBe("unassigned");
    expect(time.minutesInDay(visit!.window_start, ZONE)).toBe(8 * 60);
    const [request] = await raw<{ status: string; job_id: string }[]>`
      select status, job_id from public.booking_request where id = ${outcome.bookingRequestId}`;
    expect(request).toEqual({ status: "confirmed", job_id: outcome.jobId });
    const [conversation] = await raw<{ customer_id: string; job_id: string }[]>`
      select customer_id, job_id from public.conversation where id = ${draft!.sourceId}::uuid`;
    expect(conversation).toEqual({ customer_id: outcome.customerId, job_id: outcome.jobId });

    const again = await intake.approve(owner(), { id: draft!.id });
    expect(again.outcome).toEqual(applied.outcome);
    const [jobs] = await raw<{ n: number }[]>`select count(*)::int as n from public.job where organization_id = ${ORG}`;
    expect(jobs!.n).toBe(1);
  });

  it("refuses, and logs, a model that asks for an action its person may not take", async () => {
    /**
     * The CSR it runs as has had `booking:decide` taken away, so the model is
     * not told about booking at all. This model books anyway.
     */
    await configure("intake", { runAsUserId: CSR });
    const conversationId = await inboundText("+15125550102", "Need someone for a dripping tap at 5 Oak Ave Austin TX 78702");
    model.script = (request) => call("propose_booking", {
      contactName: "Sneaky", problemSummary: "Tap.", urgency: "routine", windows: [firstWindow(request)],
    });
    const pass = await worker.passFor(db(), ORG, deps());
    expect(pass.drafted).toBe(0);
    expect(model.requests.at(-1)!.tools!.map((t) => t.name)).toEqual(["not_a_booking"]);

    const refused = await activity("refused");
    expect(refused.at(-1)!.detail).toMatch(/booking:decide/);
    expect((await intake.drafts(owner(), { sourceKind: "conversation", sourceId: conversationId })).drafts).toEqual([]);
    const [audit] = await raw<{ actor_agent_id: string }[]>`
      select actor_agent_id from public.audit_log where organization_id = ${ORG} and action = 'ai.agent_refused'`;
    expect(audit!.actor_agent_id).toBe("ai:intake");
  });

  it("refuses an action from another agent's list, however plausible", async () => {
    await configure("intake");
    await inboundText("+15125550103", "Please send me my invoice");
    model.script = () => call("draft_reminder", { body: "Pay $5" });
    await worker.passFor(db(), ORG, deps());
    expect((await activity("refused")).at(-1)!.detail).toMatch(/not something the intake agent can do/);
  });

  it("writes down a message that is not a booking and does not read it again", async () => {
    const conversationId = await inboundText("+15125550104", "Thanks for yesterday!");
    model.script = () => call("not_a_booking", { reason: "A thank you." });
    await worker.passFor(db(), ORG, deps());
    const [row] = (await intake.drafts(owner(), { sourceKind: "conversation", sourceId: conversationId })).drafts;
    expect(row).toMatchObject({ status: "dismissed", action: "not_a_booking" });
  });

  it("books on its own when the company chose that, and says it did", async () => {
    await configure("intake", { mode: "auto" });
    await inboundText("+15125550105", "Hi, Lee Park, no hot water at 9 Pine Rd Austin TX 78703, any time works");
    model.script = (request) => call("propose_booking", {
      contactName: "Lee Park", phone: "+15125550105",
      address: { line1: "9 Pine Rd", city: "Austin", state: "TX", postalCode: "78703" },
      problemSummary: "No hot water.", bookableServiceId: firstWindow(request).bookableServiceId,
      urgency: "soon", windows: [firstWindow(request)],
    });
    await worker.passFor(db(), ORG, deps());
    const [row] = await raw<{ status: string; applied_automatically: boolean; decided_by_user_id: string }[]>`
      select status, applied_automatically, decided_by_user_id from public.ai_agent_proposal
      where organization_id = ${ORG} and agent = 'intake' order by created_at desc limit 1`;
    expect(row).toEqual({ status: "applied", applied_automatically: true, decided_by_user_id: OWNER });
    expect((await activity("applied")).at(-1)!.detail).toMatch(/on its own/);
    await configure("intake", { enabled: false });
  });

  it("drafts on request as the person asking, and a repeat of the key is the same draft", async () => {
    await configure("intake");
    const conversationId = await inboundText("+15125550106", "boiler making a banging noise, 3 Ash Ct Austin TX 78704");
    model.script = (request) => call("propose_booking", {
      contactName: "Sam", problemSummary: "Banging boiler.", urgency: "routine",
      address: { line1: "3 Ash Ct", city: "Austin", state: "TX", postalCode: "78704" },
      bookableServiceId: serviceId, windows: [firstWindow(request)],
    });
    const before = model.requests.length;
    const first = await intake.draftNow(owner({ idempotencyKey: "intake-key-1" }), { sourceKind: "conversation", sourceId: conversationId }, deps());
    const second = await intake.draftNow(owner({ idempotencyKey: "intake-key-1" }), { sourceKind: "conversation", sourceId: conversationId }, deps());
    expect(second.id).toBe(first.id);
    expect(first.startedByUserId).toBe(OWNER);
    expect(model.requests.length).toBe(before + 1);
    await intake.handlers.dismissIntakeDraft(owner(), { id: first.id, reason: "Rang them instead." });
    await configure("intake", { enabled: false });
  });

  it("will not read a thread for a person while the agent is off", async () => {
    const conversationId = await inboundText("+15125550107", "fence fell over");
    await expect(intake.draftNow(owner(), { sourceKind: "conversation", sourceId: conversationId }, deps()))
      .rejects.toThrow(/intake agent is off/);
  });
});

/* ================================================================ chat === */

run("the chat agent on the website", () => {
  beforeAll(async () => {
    if (!url) return;
    await configure("chat", {
      chat: { ...coreAgents.defaultSettings("chat").chat, faq: [{ question: "Do you work weekends?", answer: "Saturdays, 8 to 12." }] },
    });
  });

  it("says it is automated before anything else", async () => {
    const config = await chat.widgetConfig(db(), { companyKey: SLUG });
    expect(config.enabled).toBe(true);
    const opened = await chat.start(db(), { companyKey: SLUG });
    expect(opened.messages[0]!.text).toMatch(/automated assistant/);
    expect(opened.messages[0]!.from).toBe("assistant");
    expect(opened.token.length).toBeGreaterThan(30);
  });

  it("answers from the company's facts and quotes a published price", async () => {
    const opened = await chat.start(db(), { companyKey: SLUG });
    model.script = (request) => {
      expect(promptOf(request)).toContain("Saturdays, 8 to 12.");
      return call("reply", { text: "A water heater repair visit is $149." });
    };
    const after = await chat.say(db(), { companyKey: SLUG, token: opened.token, text: "how much to look at a water heater?" }, {}, deps());
    expect(after.status).toBe("open");
    expect(after.messages.at(-1)).toMatchObject({ from: "assistant", text: "A water heater repair visit is $149." });
  });

  it("does not send a price the company never published, and hands over instead", async () => {
    const opened = await chat.start(db(), { companyKey: SLUG });
    model.script = () => call("reply", { text: "Sure, a new heater installed is $899." });
    const after = await chat.say(db(), { companyKey: SLUG, token: opened.token, text: "price for a new heater installed?" }, {}, deps());
    expect(after.status).toBe("handed_off");
    expect(after.messages.map((m) => m.text).join(" ")).not.toContain("$899");
    expect((await activity("refused")).at(-1)!.detail).toMatch(/\$899\.00, which is not a published price/);
    const [task] = await raw<{ title: string }[]>`
      select title from public.task where organization_id = ${ORG} and entity_type = 'conversation' order by created_at desc limit 1`;
    expect(task!.title).toMatch(/website chat needs a person/);
  });

  it("hands over the moment somebody asks for a person, without asking the model", async () => {
    const opened = await chat.start(db(), { companyKey: SLUG });
    const before = model.requests.length;
    const after = await chat.say(db(), { companyKey: SLUG, token: opened.token, text: "can I talk to a real person please" }, {}, deps());
    expect(after.status).toBe("handed_off");
    expect(model.requests.length).toBe(before);
  });

  it("offers a real window and takes a booking request for the office to confirm", async () => {
    const opened = await chat.start(db(), { companyKey: SLUG });
    model.script = (request) => {
      const open = firstWindow(request);
      return call("create_booking_request", {
        ...open, contactName: "Robin Vale", phone: "+15125550190",
        address: { line1: "77 Lake Dr", city: "Austin", state: "TX", postalCode: "78705" },
        notes: "Heater pilot keeps going out.", text: "Done. The office will confirm your booking shortly.",
      });
    };
    const after = await chat.say(db(), { companyKey: SLUG, token: opened.token, text: "book me in, Robin Vale, 77 Lake Dr Austin TX 78705, 512 555 0190" }, {}, deps());
    expect(after.bookingTaken).toBe(true);
    const [request] = await raw<{ status: string; contact_name: string }[]>`
      select status, contact_name from public.booking_request where organization_id = ${ORG} and contact_name = 'Robin Vale'`;
    expect(request).toEqual({ status: "pending", contact_name: "Robin Vale" });

    // The office books it, and it lands on the board in the window the visitor chose.
    const [pending] = await raw<{ id: string }[]>`
      select id from public.booking_request where organization_id = ${ORG} and contact_name = 'Robin Vale'`;
    const booked = await intake.bookRequest(owner(), { id: pending!.id });
    const again = await intake.bookRequest(owner(), { id: pending!.id });
    expect(again).toEqual(booked);
    const [visit] = await raw<{ window_start: Date }[]>`select window_start from public.visit where id = ${booked.visitId}`;
    expect(time.minutesInDay(visit!.window_start, ZONE)).toBe(8 * 60);
  });

  it("is one message and one answer when the visitor taps send twice", async () => {
    const opened = await chat.start(db(), { companyKey: SLUG });
    model.script = () => call("reply", { text: "Hello again." });
    const before = model.requests.length;
    await chat.say(db(), { companyKey: SLUG, token: opened.token, text: "hello" }, { idempotencyKey: "tap-1" }, deps());
    const twice = await chat.say(db(), { companyKey: SLUG, token: opened.token, text: "hello" }, { idempotencyKey: "tap-1" }, deps());
    expect(model.requests.length).toBe(before + 1);
    expect(twice.messages.filter((m) => m.from === "visitor")).toHaveLength(1);
  });

  it("reaches the visitor's open chat when a person answers from the inbox, and the assistant stops", async () => {
    const opened = await chat.start(db(), { companyKey: SLUG });
    const [session] = await raw<{ conversation_id: string }[]>`
      select conversation_id from public.ai_chat_session where organization_id = ${ORG} order by created_at desc limit 1`;
    await comms.reply(owner(), { id: session!.conversation_id, body: "Hi, this is Jo from the office." });
    const read = await chat.read(db(), { companyKey: SLUG, token: opened.token });
    expect(read.messages.at(-1)).toMatchObject({ from: "person", text: "Hi, this is Jo from the office." });
    expect(read.status).toBe("handed_off");
  });

  it("opens nothing with a token from nowhere", async () => {
    await expect(chat.read(db(), { companyKey: SLUG, token: "x".repeat(43) })).rejects.toThrow(/not found/);
  });
});

run("the chat agent by text", () => {
  it("does not text in quiet hours, and answers through the consent gate when it may", async () => {
    await configure("chat", { chat: { ...coreAgents.defaultSettings("chat").chat, web: true, text: true } });
    const conversationId = await inboundText("+15125550120", "do you do drain cleaning?");
    model.script = () => call("reply", { text: "Yes, we clear drains." });

    const night = time.instantOfLocal(time.dateIn(new Date(), ZONE), 23 * 60, ZONE);
    const quiet = await chat.answerTexts(db(), ORG, { ...deps(), now: () => night });
    expect(quiet).toEqual({ answered: 0, quiet: true });

    const day = await chat.answerTexts(db(), ORG, deps());
    expect(day.answered).toBeGreaterThan(0);
    const [sent] = await raw<{ body: string; status: string }[]>`
      select body, status from public.message where conversation_id = ${conversationId} and direction = 'outbound'`;
    expect(sent!.status).toBe("queued");
    expect(sent!.body).toMatch(/^This is Agents Plumbing's automated assistant/);
    expect(sent!.body).toContain("Yes, we clear drains.");
  });

  it("stays out of a conversation a person in the office is already in", async () => {
    const conversationId = await inboundText("+15125550121", "running late?");
    await raw`insert into public.message (organization_id, conversation_id, direction, channel, from_address, to_address, body, status, sent_by_user_id, created_at)
              values (${ORG}, ${conversationId}, 'outbound', 'sms', '+15125559900', '+15125550121', 'On our way', 'queued', ${OWNER}, now() - interval '1 hour')`;
    await raw`update public.message set created_at = now() where conversation_id = ${conversationId} and direction = 'inbound'`;
    const before = model.requests.length;
    await chat.answerTexts(db(), ORG, deps());
    const [outbound] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.message where conversation_id = ${conversationId} and direction = 'outbound'`;
    expect(outbound!.n).toBe(1);
    expect(model.requests.length).toBe(before);
    await configure("chat", { enabled: false });
  });
});

/* ========================================================== estimates === */

run("the estimate drafter", () => {
  let jobId = "";
  let good = "";
  let best = "";

  beforeAll(async () => {
    if (!url) return;
    const item = async (code: string, name: string, price: string) => {
      const [i] = await raw<{ id: string }[]>`
        insert into public.price_book_item (organization_id, kind, code) values (${ORG}, 'service', ${code}) returning id`;
      await raw`insert into public.price_book_item_version (organization_id, item_id, version, name, price, cost, effective_from)
                values (${ORG}, ${i!.id}, 1, ${name}, ${price}, 100, now() - interval '1 day')`;
      return i!.id;
    };
    good = await item("WH-REPAIR", "Replace heater valve", "220.0000");
    best = await item("WH-50", "Install 50 gallon heater", "1850.0000");
    const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Pat Estimate') returning id`;
    const [p] = await raw<{ id: string }[]>`insert into public.property (organization_id, address_line1, city, state, postal_code) values (${ORG}, '1 Quote Ln', 'Austin', 'TX', '78701') returning id`;
    await raw`insert into public.customer_property (organization_id, customer_id, property_id) values (${ORG}, ${c!.id}, ${p!.id})`;
    const [j] = await raw<{ id: string }[]>`
      insert into public.job (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, 9001, ${c!.id}, ${p!.id}, 'scheduled', 'Leaking water heater') returning id`;
    jobId = j!.id;
    await raw`insert into public.visit (organization_id, job_id, technician_notes)
              values (${ORG}, ${jobId}, 'Tank weeping at the base, 12 years old. Valve also sticking.')`;
    await configure("estimate", { runAsUserId: null });
  });

  it("drafts options at the price book's prices, never the model's", async () => {
    model.script = (request) => {
      expect(promptOf(request)).toContain("Tank weeping at the base");
      expect(promptOf(request)).not.toContain("\"cost\"");
      return call("draft_estimate", {
        summary: "Old tank failing.",
        options: [
          { name: "Good", lines: [{ priceBookItemId: good, quantity: 1, reason: "valve sticking" }] },
          { name: "Best", recommended: true, lines: [{ priceBookItemId: best, quantity: 1 }] },
        ],
      });
    };
    const draft = await estimates.draft(owner(), { jobId }, deps());
    const options = draft.draft["options"] as { total: string; lines: { unitPrice: string }[] }[];
    expect(options.map((o) => o.total)).toEqual(["220.0000", "1850.0000"]);

    const accepted = await estimates.accept(owner(), { id: draft.id });
    const estimateId = (accepted.outcome as { estimateId: string }).estimateId;
    const [row] = await raw<{ status: string; job_id: string }[]>`select status, job_id from public.estimate where id = ${estimateId}`;
    expect(row).toEqual({ status: "draft", job_id: jobId });
  });

  it("refuses a draft that uses anything not in the price book", async () => {
    model.script = () => call("draft_estimate", {
      summary: "x",
      options: [{ name: "Gold plated", lines: [{ priceBookItemId: fixtureId("agents:invented-item"), quantity: 1 }] }],
    });
    await expect(estimates.draft(owner(), { jobId }, deps())).rejects.toThrow(/not in the price book/);
    expect((await activity("refused")).at(-1)!.detail).toMatch(/not in the price book/);
  });
});

/* ======================================================== collections === */

run("the collections agent", () => {
  let invoiceId = "";

  beforeAll(async () => {
    if (!url) return;
    const [c] = await raw<{ id: string }[]>`
      insert into public.customer (organization_id, type, name, phone) values (${ORG}, 'residential', 'Owen Late', '+15125550150') returning id`;
    const due = time.dateIn(new Date(Date.now() - 20 * 864e5), ZONE);
    const [i] = await raw<{ id: string }[]>`
      insert into public.invoice (organization_id, number, customer_id, status, issued_on, due_on, total, balance)
      values (${ORG}, 7001, ${c!.id}, 'open', ${due}, ${due}, 240.0000, 240.0000) returning id`;
    invoiceId = i!.id;
    await configure("collections", {
      collections: { steps: [
        { afterDays: 3, tone: "Friendly.", channel: "text" },
        { afterDays: 14, tone: "Clear.", channel: "text" },
      ] },
    });
  });

  it("refuses a reminder naming an amount the invoice does not owe", async () => {
    model.script = () => call("draft_reminder", { body: "You owe $2,400. Please pay." });
    const outcome = await collections.run(db(), ORG, { deps: deps() });
    expect(outcome.drafted).toBe(0);
    expect((await activity("refused")).at(-1)!.detail).toMatch(/invoice 7001 named an amount/);
  });

  it("drafts the latest step due, once, and a person sends it through the consent gate", async () => {
    model.script = (request) => {
      expect(promptOf(request)).toContain("$240.00");
      return call("draft_reminder", { body: "Hi Owen, a reminder that $240.00 is now overdue on invoice 7001." });
    };
    const first = await collections.run(db(), ORG, { deps: deps() });
    expect(first.drafted).toBe(1);
    const again = await collections.run(db(), ORG, { deps: deps() });
    expect(again.drafted).toBe(0);

    const [draft] = (await collections.handlers.listCollectionReminders(owner(), { status: ["proposed"] })).drafts;
    expect(draft!.draft["stepDays"]).toBe(14);
    await raw`update public.organization set settings = settings || '{"quietHours": null}'::jsonb where id = ${ORG}`;
    const sent = await collections.send(owner(), { id: draft!.id });
    expect(sent.status).toBe("applied");
    const [message] = await raw<{ body: string; status: string }[]>`
      select body, status from public.message where id = ${(sent.outcome as { messageId: string }).messageId}`;
    expect(message!.status).toBe("queued");
    expect(message!.body).toMatch(/Pay here: /);
    expect(invoiceId).not.toBe("");
  });
});

/* ============================================================ dispatch === */

run("the dispatch copilot", () => {
  const DAY = time.dateIn(new Date(Date.now() + 2 * 864e5), ZONE);
  let ray = "";
  let sam = "";
  let open = "";

  beforeAll(async () => {
    if (!url) return;
    const tech = async (key: string, name: string, skills: string[]) => {
      const userId = fixtureId(`agents:tech:${key}`);
      const membershipId = await member(userId, `agents-${key}`, "technician");
      const [t] = await raw<{ id: string }[]>`
        insert into public.technician (organization_id, membership_id, display_name, skills)
        values (${ORG}, ${membershipId}, ${name}, ${raw.json(skills as never)}) returning id`;
      return t!.id;
    };
    ray = await tech("ray", "Ray Ortiz", ["gas-fitting"]);
    sam = await tech("sam", "Sam Reyes", []);
    const yard = await company.createLocation(owner(), {
      name: "Yard", addressLine1: "2400 Cullen Ave", city: "Austin", state: "TX", postalCode: "78757",
    });
    await geocoding.placePin(owner(), { entity: "location", id: yard.id, latitude: 30.30, longitude: -97.70 });
    await dispatchMap.updateTechnician(owner(), { id: ray, homeLocationId: yard.id });
    await dispatchMap.updateTechnician(owner(), { id: sam, homeLocationId: yard.id });
    const [gas] = await raw<{ id: string }[]>`
      insert into public.job_type (organization_id, name, required_skills)
      values (${ORG}, 'Gas repair', ${raw.json(["gas-fitting"] as never)}) returning id`;
    const [c] = await raw<{ id: string }[]>`insert into public.customer (organization_id, type, name) values (${ORG}, 'residential', 'Gail Gas') returning id`;
    const [p] = await raw<{ id: string }[]>`
      insert into public.property (organization_id, address_line1, city, state, postal_code, latitude, longitude, location_precision, location_source)
      values (${ORG}, '40 Open St', 'Austin', 'TX', '78701', ${geo.formatCoordinate(30.31)}, ${geo.formatCoordinate(-97.69)}, 'rooftop', 'test') returning id`;
    const [j] = await raw<{ id: string }[]>`
      insert into public.job (organization_id, number, customer_id, property_id, job_type_id, status, summary)
      values (${ORG}, 9101, ${c!.id}, ${p!.id}, ${gas!.id}, 'scheduled', 'Gas smell') returning id`;
    const [v] = await raw<{ id: string }[]>`
      insert into public.visit (organization_id, job_id, status, window_start, window_end, estimated_duration_minutes)
      values (${ORG}, ${j!.id}, 'unassigned', ${time.instantOfLocal(DAY, 9 * 60, ZONE)}, ${time.instantOfLocal(DAY, 17 * 60, ZONE)}, 60)
      returning id`;
    open = v!.id;
    await configure("dispatch", { runAsUserId: null });
  });

  it("drops a pick the board's own checks refuse, and says so", async () => {
    model.script = (request) => {
      expect(promptOf(request)).toMatch(/Sam Reyes cannot be sent/);
      return call("propose_assignments", { summary: "Sam is free.", assignments: [{ visitId: open, technicianId: sam, why: "Free all day." }] });
    };
    const plan = await copilot.plan(owner(), { date: DAY }, deps());
    expect(plan.draft["assignments"]).toEqual([]);
    expect((plan.draft["dropped"] as string[])[0]).toMatch(/checks do not allow/);
  });

  it("explains and proposes, and a dispatcher applies it through the board's own assignment", async () => {
    model.script = () => call("propose_assignments", {
      summary: "One open gas job; Ray is the only one certified.",
      assignments: [{ visitId: open, technicianId: ray, why: "Ray is gas certified and starts nearby." }],
    });
    const plan = await copilot.plan(owner(), { date: DAY }, deps());
    expect((plan.draft["assignments"] as { matchesOptimiser: boolean }[])[0]!.matchesOptimiser).toBe(true);
    const applied = await copilot.apply(owner(), { id: plan.id });
    expect((applied.outcome as { assigned: string[] }).assigned).toEqual([open]);
    const [a] = await raw<{ technician_id: string }[]>`select technician_id from public.visit_assignment where visit_id = ${open}`;
    expect(a!.technician_id).toBe(ray);
  });
});

/* ============================================================ the bill === */

run("what the agents cost", () => {
  it("records every model call against the agent that made it, and nothing of what was said", async () => {
    const rows = await raw<{ agent_id: string; purpose: string; detail: string | null }[]>`
      select agent_id, purpose, detail from public.ai_usage where organization_id = ${ORG} and agent_id like 'ai:%'`;
    expect(new Set(rows.map((r) => r.agent_id))).toEqual(new Set(["ai:intake", "ai:chat", "ai:estimate", "ai:collections", "ai:dispatch"]));
    for (const row of rows) expect(JSON.stringify(row)).not.toMatch(/Dana|water heater leaking/i);
  });

  it("stops at the agent's daily limit and says so", async () => {
    await configure("intake", { limits: { ...coreAgents.defaultSettings("intake").limits, runsPerDay: 1 } });
    await inboundText("+15125550199", "hello there, gutter fell off at 1 Rain St Austin TX 78701");
    model.script = () => call("not_a_booking", { reason: "x" });
    const before = model.requests.length;
    await worker.passFor(db(), ORG, deps());
    expect(model.requests.length).toBe(before);
    expect((await activity("skipped")).at(-1)!.detail).toMatch(/used today's 1 runs/);
    await configure("intake", { enabled: false });
  });
});
