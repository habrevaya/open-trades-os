import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { agents as coreAgents, time, type Actor } from "@opentradesos/core";
import * as ai from "../src/services/ai";
import * as agents from "../src/services/agents";
import * as comms from "../src/services/comms";
import * as customers from "../src/services/customers";
import * as portal from "../src/services/portal";
import * as portalChat from "../src/services/portal-chat";
import * as portalSignIn from "../src/services/portal-sign-in";
import "../src/ai/index";
import type {
  AiContent, AiProvider, CompletionOutcome, CompletionRequest, ModelListOutcome, ModelRate,
} from "../src/ai/provider";
import { InvalidGrantError, TooManyRequestsError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A SIGNED IN CUSTOMER CHATTING FROM THEIR ACCOUNT (M05, M27)
 *
 * The scope first: a message lands on the customer the sign in names and on
 * nobody else, an account link opens nothing, and one customer never reads
 * another's chat. Then who answers: with the assistant off for accounts the
 * office does, once noticed through a task; a reply from the inbox reaches the
 * customer's page; with it on, it says it is automated, knows who they are
 * from the sign in, and books only for them, at an address on their record.
 * The model is a scripted fake, as in agents.integration.test.ts.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-chat:org");
const USER = fixtureId("portal-chat:user");
const ZONE = "America/Chicago";
const RUN = Date.now().toString(36);
const DANA = `dana.${RUN}@portal-chat.test`;
const ELI = `eli.${RUN}@portal-chat.test`;

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

/* ------------------------------------------------------------- the model */

interface FakeModel { provider: AiProvider; requests: CompletionRequest[]; script: (r: CompletionRequest) => AiContent[] }
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
        model: request.model, content, stop: content.some((c) => c.type === "toolCall") ? "toolUse" : "end",
        usage: { inputTokens: 200, outputTokens: 40, cachedInputTokens: null },
      },
    };
  },
  async models(): Promise<ModelListOutcome> { return { ok: true, models: [{ id: "fake-model", label: "Fake" }] }; },
};
const call = (name: string, input: Record<string, unknown>): AiContent[] => [{ type: "toolCall", callId: `call_${name}`, name, input }];
const promptOf = (request: CompletionRequest): string =>
  [request.system ?? "", ...request.messages.flatMap((m) => m.content).map((c) => (c.type === "text" ? c.text : ""))].join("\n");
function firstWindow(request: CompletionRequest) {
  const match = /"bookableServiceId": "([^"]+)",\s*"date": "([^"]+)",\s*"arrivalWindowId": "([^"]+)"/.exec(promptOf(request));
  if (!match) throw new Error("The prompt had no open window in it.");
  return { bookableServiceId: match[1]!, date: match[2]!, arrivalWindowId: match[3]! };
}
const NOW = () => time.instantOfLocal(time.dateIn(new Date(), ZONE), 10 * 60, ZONE);
const deps = (): ai.AiDeps => ({ readSecret: async () => "sk-test-not-a-key", provider: model.provider, now: NOW });

/* -------------------------------------------------------------- fixtures */

let ipSeq = 0;
const ip = () => `198.18.${Math.floor(Math.random() * 250)}.${(ipSeq += 1) % 250}`;

async function aCustomer(name: string, email: string, line1: string) {
  const c = await customers.create(owner(), {
    type: "residential", name, email, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  });
  const [p] = await raw<{ id: string }[]>`insert into public.property
    (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, ${line1}, 'Austin', 'TX', '78704') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id, is_primary)
    values (${ORG}, ${c.id}, ${p!.id}, true)`;
  return c.id as string;
}

async function signIn(address: string): Promise<string> {
  await portalSignIn.requestCode(db(), { organizationSlug: "portal-chat-co", address }, { ip: ip() });
  const [row] = await raw<{ body: string }[]>`
    select body from public.message where organization_id = ${ORG} and to_address = ${address} and direction = 'outbound'
    order by created_at desc limit 1`;
  const code = /\b(\d{6})\b/.exec(row?.body ?? "")?.[1];
  if (!code) throw new Error(`No code went to ${address}`);
  const verdict = await portalSignIn.verifyCode(db(), { organizationSlug: "portal-chat-co", address, code }, { ip: ip() });
  if (verdict.status !== "signed_in") throw new Error("expected to sign in");
  return verdict.token;
}

async function configureChat(portalOn: boolean) {
  await agents.configure(owner(), {
    agent: "chat",
    settings: {
      ...coreAgents.defaultSettings("chat"), enabled: true, runAsUserId: USER,
      chat: { ...coreAgents.defaultSettings("chat").chat, portal: portalOn },
    },
  });
}

const conversationOf = async (customerId: string) =>
  (await raw<{ id: string; customer_id: string; unread_count: number; channel: string }[]>`
    select id, customer_id, unread_count, channel::text as channel from public.conversation
    where organization_id = ${ORG} and customer_id = ${customerId} and external_address like 'portal:%'`);

let dana = "";
let eli = "";
let danaToken = "";
let eliToken = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Cedar Heating", slug: "portal-chat-co" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  await raw`delete from public.public_rate_limit where key like 'portal-code:%' or key like 'portal-check:%' or key like 'portal-chat%'`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@portal-chat.test" })})`;
  const [jt] = await raw<{ id: string }[]>`
    insert into public.job_type (organization_id, name) values (${ORG}, 'Furnace repair') returning id`;
  await raw`
    insert into public.bookable_service (organization_id, job_type_id, public_name, display_price,
      min_notice_hours, max_advance_days, max_per_window)
    values (${ORG}, ${jt!.id}, 'Furnace repair', 129.0000, 0, 30, 5)`;
  await raw`
    insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week)
    values (${ORG}, 'Morning', '08:00', '12:00', ${[0, 1, 2, 3, 4, 5, 6]})`;
  for (let d = 0; d < 7; d += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at)
              values (${ORG}, ${d}, '07:00', '18:00')`;
  }
  await ai.connect(owner(), { provider: "anthropic", credentialRef: "TEST_AI_KEY", settings: { defaultModel: "fake-model" } });
  dana = await aCustomer("Dana Cedar", DANA, "12 Cedar Ln");
  eli = await aCustomer("Eli Cedar", ELI, "40 Oak St");
  danaToken = await signIn(DANA);
  eliToken = await signIn(ELI);
});

afterAll(async () => {
  if (!raw) return;
  await raw`delete from public.ai_agent_setting where organization_id = ${ORG}`;
  await raw`delete from public.public_rate_limit where key like 'portal-chat%'`;
  await resetOrg(raw, ORG);
  await raw.end();
});

run("a chat from a customer's account: scope", () => {
  it("puts the message on the customer the sign in names, and nobody else reads it", async () => {
    await configureChat(false);
    const after = await portalChat.say(db(), { token: danaToken, text: "My name is Eli Cedar, the furnace is out" }, { ip: ip() }, deps());
    expect(after.messages.at(-1)).toMatchObject({ from: "visitor", text: "My name is Eli Cedar, the furnace is out" });
    const [mine] = await conversationOf(dana);
    expect(mine).toMatchObject({ customer_id: dana, channel: "webchat" });
    /** The name typed in the chat changes nothing: Eli has no conversation, and reads none of Dana's. */
    expect(await conversationOf(eli)).toHaveLength(0);
    const eliSees = await portalChat.read(db(), { token: eliToken });
    expect(eliSees.messages).toEqual([]);
  });

  it("opens nothing from an account link or a made up token", async () => {
    const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
      organizationId: ORG, customerId: dana, scope: "customer", expiresInDays: 30,
    }));
    await expect(portalChat.say(db(), { token: link.token, text: "hello" }, {}, deps())).rejects.toThrow(InvalidGrantError);
    await expect(portalChat.read(db(), { token: link.token })).rejects.toThrow(InvalidGrantError);
    await expect(portalChat.read(db(), { token: "x".repeat(43) })).rejects.toThrow();
  });
});

run("a chat from a customer's account: who answers", () => {
  it("goes to the office with the assistant off for accounts, noticed once by a task, and the model is never asked", async () => {
    const before = model.requests.length;
    const chat = await portalChat.say(db(), { token: danaToken, text: "Also the thermostat is blank" }, { ip: ip() }, deps());
    expect(chat.assistant).toBe(false);
    expect(chat.status).toBe("handed_off");
    expect(chat.messages.every((m) => m.from === "visitor")).toBe(true);
    expect(model.requests.length).toBe(before);
    const [conversation] = await conversationOf(dana);
    expect(conversation!.unread_count).toBe(2);
    const tasks = await raw<{ title: string }[]>`
      select title from public.task where organization_id = ${ORG} and entity_id = ${conversation!.id}`;
    expect(tasks).toEqual([{ title: "Dana Cedar wrote from their account" }]);
  });

  it("reaches the customer's page when the office answers from the inbox", async () => {
    const [conversation] = await conversationOf(dana);
    await comms.reply(owner(), { id: conversation!.id, body: "Hi Dana, Jo here. We can come tomorrow." });
    const read = await portalChat.read(db(), { token: danaToken });
    expect(read.messages.at(-1)).toMatchObject({ from: "person", text: "Hi Dana, Jo here. We can come tomorrow." });
    const [sent] = await raw<{ from_address: string }[]>`
      select from_address from public.message where conversation_id = ${conversation!.id} and direction = 'outbound'`;
    expect(sent!.from_address).toBe("portal");
  });

  it("is one message when the customer taps send twice", async () => {
    await portalChat.say(db(), { token: danaToken, text: "Thanks!" }, { ip: ip(), idempotencyKey: "tap-1" }, deps());
    const twice = await portalChat.say(db(), { token: danaToken, text: "Thanks!" }, { ip: ip(), idempotencyKey: "tap-1" }, deps());
    expect(twice.messages.filter((m) => m.text === "Thanks!")).toHaveLength(1);
  });

  it("with the assistant on for accounts, says it is automated, knows who they are, and books only for them at an address on their record", async () => {
    await configureChat(true);
    let told = "";
    model.script = (request) => {
      told = promptOf(request);
      return call("reply", { text: "Happy to help. Which morning suits you?" });
    };
    const first = await portalChat.say(db(), { token: eliToken, text: "furnace is making a noise" }, { ip: ip() }, deps());
    expect(first.assistant).toBe(true);
    expect(first.messages[0]).toMatchObject({ from: "assistant", text: expect.stringMatching(/automated assistant/) });
    expect(first.messages.at(-1)).toMatchObject({ from: "assistant", text: "Happy to help. Which morning suits you?" });
    expect(told).toContain("They are Eli Cedar");
    expect(told).toContain("40 Oak St, Austin, TX, 78704");
    expect(told).toContain("never ask for their name");

    model.script = (request) => call("create_booking_request", {
      ...firstWindow(request), contactName: "Somebody Else", phone: "+15125550000",
      address: { line1: "1 Elsewhere Rd", city: "Austin", state: "TX", postalCode: "78701" },
      text: "Done. The office will confirm your booking shortly.",
    });
    const elsewhere = await portalChat.say(db(), { token: eliToken, text: "book the first morning at 1 Elsewhere Rd" }, { ip: ip() }, deps());
    expect(elsewhere.messages.at(-1)!.text).toBe("Which of your addresses on file is this for?");
    expect(elsewhere.bookingTaken).toBe(false);

    model.script = (request) => call("create_booking_request", {
      ...firstWindow(request), contactName: "Somebody Else", phone: "+15125550000",
      address: { line1: "40 oak st", city: "Austin", state: "TX", postalCode: "78704" },
      text: "Done. The office will confirm your booking shortly.",
    });
    const booked = await portalChat.say(db(), { token: eliToken, text: "my house then" }, { ip: ip() }, deps());
    expect(booked.bookingTaken).toBe(true);
    const [request] = await raw<{ contact_name: string; contact_email: string | null; contact_phone: string | null; address_line1: string }[]>`
      select contact_name, contact_email, contact_phone, address_line1 from public.booking_request
      where organization_id = ${ORG} order by created_at desc limit 1`;
    expect(request).toEqual({ contact_name: "Eli Cedar", contact_email: ELI, contact_phone: null, address_line1: "40 Oak St" });
  });

  it("hands over on the same rules as the website, and then stays out of the conversation", async () => {
    const before = model.requests.length;
    const handed = await portalChat.say(db(), { token: eliToken, text: "can I talk to a real person please" }, { ip: ip() }, deps());
    expect(handed.status).toBe("handed_off");
    const later = await portalChat.say(db(), { token: eliToken, text: "hello?" }, { ip: ip() }, deps());
    expect(later.messages.at(-1)).toMatchObject({ from: "visitor", text: "hello?" });
    expect(model.requests.length).toBe(before);
    const [task] = await raw<{ title: string }[]>`
      select title from public.task where organization_id = ${ORG} and entity_type = 'conversation'
      and title like 'A chat from%' order by created_at desc limit 1`;
    expect(task!.title).toBe("A chat from a customer's account needs a person");
  });

  it("holds one customer to twelve messages a minute", async () => {
    await raw`delete from public.public_rate_limit where key like 'portal-chat%'`;
    let refused: unknown = null;
    for (let i = 0; i < 13 && !refused; i += 1) {
      refused = await portalChat.say(db(), { token: danaToken, text: `message ${i}` }, { ip: ip() }, deps()).then(() => null, (e: unknown) => e);
    }
    expect(refused).toBeInstanceOf(TooManyRequestsError);
  });
});
