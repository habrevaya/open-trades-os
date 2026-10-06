import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as voice from "../src/services/voice";
import * as callQueues from "../src/services/call-queues";
import * as phoneMenus from "../src/services/phone-menus";
import { twilioSignature } from "../src/comms/twilio";
import { createTwilioVoice } from "../src/voice/twilio";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A WAITING LINE
 *
 * The owner makes a line answered by the service team, a menu option sends
 * callers to it, and a caller waits: told their place, the team rung, rung
 * again only once the last round has had its time, put through when somebody
 * picks up, and sent to voicemail once they have waited as long as the line
 * keeps anybody. A caller who hangs up while waiting is a missed call.
 *
 * NO TEST HERE REACHES TWILIO. The adapter is the real one with its
 * transport handed in, and every carrier request is signed as Twilio signs it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("queues:org");
const OWNER = fixtureId("queues:owner");
const SAM = fixtureId("queues:sam");
const LEE = fixtureId("queues:lee");
const SLUG = "call-queues-co";
const AUTH = "a-twilio-auth-token-for-the-line";
const TOKEN = "q".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const MAIN = "+15125555000";
const SAM_PHONE = "+15125555102";
const LEE_PHONE = "+15125555103";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (roles: Actor["roles"] = ["owner"]): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles }, db: db() });

const placed: URLSearchParams[] = [];
const transport = async (to: string, init?: RequestInit): Promise<Response> => {
  if (to.endsWith("/Calls.json") && init?.method === "POST") {
    placed.push(new URLSearchParams(String(init.body)));
    return Response.json({ sid: `CAleg${placed.length}` });
  }
  return Response.json({ message: "unexpected" }, { status: 400 });
};
const provider = createTwilioVoice({ accountSid: "ACtest" }, AUTH, transport);
const deps: voice.VoiceDeps = { readSecret: async () => AUTH, provider, publicBase: BASE };

async function webhook(step: voice.Step, form: Record<string, string>, query = "", now = new Date()) {
  const connection = await voice.resolveWebhook(db(), TOKEN, deps);
  if (!connection) throw new Error("the webhook token did not resolve");
  const to = `${BASE}/api/webhooks/voice/${TOKEN}${step === "incoming" ? "" : `/${step}`}${query}`;
  return voice.handle(db(), connection, step, {
    url: to, body: new URLSearchParams(form).toString(),
    headers: { "x-twilio-signature": twilioSignature(AUTH, to, form) },
  }, deps, now);
}

const attribute = (twiml: string, verb: string, name: string): string => {
  const match = new RegExp(`<${verb}[^>]* ${name}="([^"]+)"`).exec(twiml);
  if (!match) throw new Error(`No ${verb} ${name} in ${twiml}`);
  return match[1]!.replace(/&amp;/g, "&");
};
const queryOf = (address: string) => address.slice(address.indexOf("?"));

async function member(userId: string, key: string) {
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${key}@queues.test`}, ${key})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'csr')`;
}

let groupId = "";
let queueId = "";
let clock = Date.parse("2026-10-05T15:00:00Z");

/** A caller rings, presses 1, and joins the line. Returns the call and the step addresses. */
async function joinLine(from: string) {
  const sid = `CA${randomBytes(8).toString("hex")}`;
  const at = new Date((clock += 600_000));
  const answered = await webhook("incoming", { CallSid: sid, From: from, To: MAIN }, "", at);
  const pressed = await webhook("menu", { CallSid: sid, Digits: "1" }, queryOf(attribute(answered.twiml!, "Gather", "action")), at);
  return {
    sid, at, twiml: pressed.twiml!,
    wait: queryOf(attribute(pressed.twiml!, "Enqueue", "waitUrl")),
    done: queryOf(attribute(pressed.twiml!, "Enqueue", "action")),
  };
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Queue Heating", slug: SLUG });
  await member(SAM, "Sam Office");
  await member(LEE, "Lee Office");
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, provider_number_id) values (${ORG}, ${MAIN}, 'main', 'PNmain')`;
  await phoneMenus.setAnsweringPhone(owner(), { userId: SAM, e164: SAM_PHONE });
  await phoneMenus.setAnsweringPhone(owner(), { userId: LEE, e164: LEE_PHONE });
  groupId = (await phoneMenus.saveRingGroup(owner(), {
    name: "Service team", strategy: "in_order", ringSeconds: 20,
    members: [{ userId: SAM }, { userId: LEE }], noAnswerTo: { kind: "voicemail", box: "main" },
  })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("making a waiting line", () => {
  it("refuses a line nobody answers and a wait nobody would sit through", async () => {
    await expect(callQueues.saveQueue(owner(), {
      name: "Service line", ringGroupId: "00000000-0000-4000-8000-000000000000", overflowTo: { kind: "voicemail", box: "main" },
    })).rejects.toThrow(/Choose the ring group/);
    await expect(callQueues.saveQueue(owner(), {
      name: "Service line", ringGroupId: groupId, maxWaitSeconds: 5, overflowTo: { kind: "voicemail", box: "main" },
    })).rejects.toThrow(/between 30 seconds and 30 minutes/);
  });

  it("refuses a dispatcher changing where the company's calls go", async () => {
    await expect(callQueues.saveQueue(owner(["dispatcher"]), {
      name: "Service line", ringGroupId: groupId, overflowTo: { kind: "voicemail", box: "main" },
    })).rejects.toThrow();
  });

  it("makes a line, and a menu option that sends callers to it", async () => {
    const line = await callQueues.saveQueue(owner(), {
      name: "Service line", ringGroupId: groupId, maxWaitSeconds: 120, overflowTo: { kind: "voicemail", box: "main" },
    });
    queueId = line.id;
    expect(line).toMatchObject({ ringGroupName: "Service team", announcePosition: true, holdMusicUrl: null });
    const menu = await phoneMenus.saveMenu(owner(), {
      name: "Main", greeting: "Thanks for calling Queue Heating.",
      options: [{ key: "1", label: "Service", to: { kind: "queue", id: queueId } }],
      noInputTo: { kind: "voicemail", box: "main" },
    });
    expect(menu.options[0]!.to).toEqual({ kind: "queue", id: queueId });
    await raw`update public.phone_number set menu_id = ${menu.id} where organization_id = ${ORG}`;
  });

  it("will not delete a line a menu sends callers to, or the group a line rings", async () => {
    await expect(callQueues.deleteQueue(owner(), queueId)).rejects.toThrow(/from the Main menu/);
    await expect(phoneMenus.deleteRingGroup(owner(), groupId)).rejects.toThrow(/the Service line waiting line/);
  });
});

run("waiting in line", () => {
  it("holds the caller with music and their place, and offers them to each person in turn", async () => {
    const caller = await joinLine("+15125555177");
    expect(caller.twiml).toContain(`>ots-${queueId}</Enqueue>`);

    placed.length = 0;
    const first = await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "0" }, caller.wait, caller.at);
    expect(first.twiml).toContain("<Say>You are next in line. Thanks for waiting.</Say>");
    expect(first.twiml).toContain("<Play>http://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3</Play>");
    expect(placed.map((p) => p.get("To"))).toEqual([SAM_PHONE]);
    expect(placed[0]!.get("From")).toBe(MAIN);
    expect(placed[0]!.get("Url")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}/queue-answer?q=${queueId}`);

    /** Ten seconds later Sam's phone is still ringing: nobody is rung over the top of it. */
    placed.length = 0;
    await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "10" }, caller.wait, new Date(caller.at.getTime() + 10_000));
    expect(placed).toHaveLength(0);

    /** Long enough later, the next person in the group. */
    await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "35" }, caller.wait, new Date(caller.at.getTime() + 35_000));
    expect(placed.map((p) => p.get("To"))).toEqual([LEE_PHONE]);

    /** Lee picks up, and is put through to the caller at the front. */
    const answering = await webhook("queue-answer", { CallSid: "CAleg2", To: LEE_PHONE }, `?q=${queueId}`, caller.at);
    expect(answering.twiml).toContain("<Say>A Service line caller is waiting. Putting you through.</Say>");
    expect(answering.twiml).toContain(`<Dial><Queue url="${BASE}/api/webhooks/voice/${TOKEN}/queue-connect?q=${queueId}&amp;u=${LEE}" method="POST">ots-${queueId}</Queue></Dial>`);
    await webhook("queue-connect", { CallSid: caller.sid }, `?q=${queueId}&u=${LEE}`, caller.at);
    await webhook("queue-done", { CallSid: caller.sid, QueueResult: "bridged", QueueTime: "40" }, caller.done, caller.at);
    const [row] = await raw<{ answered_by_user_id: string; queue_result: string; answered_at: Date | null }[]>`
      select answered_by_user_id, queue_result, answered_at from public.call where provider_call_id = ${`twilio:${caller.sid}`}`;
    expect(row).toMatchObject({ answered_by_user_id: LEE, queue_result: "bridged" });
    expect(row!.answered_at).not.toBeNull();

    /** Sam picks up a moment too late and is told so, rather than put through to nobody. */
    const late = await webhook("queue-answer", { CallSid: "CAleg1", To: SAM_PHONE }, `?q=${queueId}`, caller.at);
    expect(late.twiml).toContain("The caller has already been answered.");
  });

  it("sends a caller on to voicemail once they have waited as long as the line keeps anybody", async () => {
    const caller = await joinLine("+15125555178");
    const over = await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "2", QueueTime: "125" }, caller.wait, caller.at);
    expect(over.twiml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Leave/></Response>');
    const next = await webhook("queue-done", { CallSid: caller.sid, QueueResult: "leave", QueueTime: "125" }, caller.done, caller.at);
    expect(next.twiml).toContain("<Record ");
    const [row] = await raw<{ routed_because: string; queue_result: string }[]>`
      select routed_because, queue_result from public.call where provider_call_id = ${`twilio:${caller.sid}`}`;
    expect(row!.queue_result).toBe("leave");
    expect(row!.routed_because).toContain("Waited 2 minutes 5 seconds in line");
    const [missed] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.domain_event e join public.call c on c.id = e.entity_id
      where e.name = 'call.missed' and c.provider_call_id = ${`twilio:${caller.sid}`}`;
    expect(missed!.n).toBe(1);
  });

  it("counts a caller who hangs up while waiting as a missed call", async () => {
    const caller = await joinLine("+15125555179");
    const gone = await webhook("queue-done", { CallSid: caller.sid, QueueResult: "hangup", QueueTime: "50" }, caller.done, caller.at);
    expect(gone.twiml).toContain("<Hangup/>");
    const [row] = await raw<{ status: string; routed_because: string }[]>`
      select status, routed_because from public.call where provider_call_id = ${`twilio:${caller.sid}`}`;
    expect(row!.status).toBe("abandoned");
    expect(row!.routed_because).toContain("Hung up after waiting 50 seconds in line.");
  });
});
