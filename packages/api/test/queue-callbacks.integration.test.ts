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
 * A WAITING LINE THAT CALLS BACK, SAYS HOW LONG, AND RINGS ONLY THE FREE
 *
 * The owner turns on "press 1 to be called back" and "say how long callers
 * have lately waited" on a line. A caller is told the wait only once enough
 * callers have been answered lately to say; a person already talking to a
 * caller is left out of the round; and a caller who presses 1 hangs up,
 * keeps their place ahead of somebody who joined after them, and is rung
 * back from the company's number by the next person free, who is rung first.
 * A callback nobody can make becomes a task for the office and only then a
 * missed call.
 *
 * NO TEST HERE REACHES TWILIO. The adapter is the real one with its
 * transport handed in, and every carrier request is signed as Twilio signs it.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("callbacks:org");
const OWNER = fixtureId("callbacks:owner");
const SAM = fixtureId("callbacks:sam");
const LEE = fixtureId("callbacks:lee");
const AUTH = "a-twilio-auth-token-for-callbacks";
const TOKEN = "k".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const MAIN = "+15125558000";
const SAM_PHONE = "+15125558102";
const LEE_PHONE = "+15125558103";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: OWNER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });

const placed: URLSearchParams[] = [];
const transport = async (to: string, init?: RequestInit): Promise<Response> => {
  if (to.endsWith("/Calls.json") && init?.method === "POST") {
    placed.push(new URLSearchParams(String(init.body)));
    return Response.json({ sid: `CAleg${randomBytes(4).toString("hex")}` });
  }
  return Response.json({ message: "unexpected" }, { status: 400 });
};
const provider = createTwilioVoice({ accountSid: "ACtest" }, AUTH, transport);
const deps: voice.VoiceDeps = { readSecret: async () => AUTH, provider, publicBase: BASE };

async function webhook(step: voice.Step, form: Record<string, string>, query: string, now: Date) {
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
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`${key.replace(/ /g, ".")}@callbacks.test`}, ${key})`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'csr')`;
}

let lineId = "";
let groupId = "";
/** Each caller a while after the one before, so no two calls look like one call sent twice. */
let clock = Date.parse("2026-10-06T15:00:00Z");
const tick = (seconds: number) => new Date((clock += seconds * 1000));

/** A caller rings, presses 1 for the line, and joins it. */
async function joinLine(from: string) {
  const sid = `CA${randomBytes(8).toString("hex")}`;
  const at = tick(600);
  const answered = await webhook("incoming", { CallSid: sid, From: from, To: MAIN }, "", at);
  const pressed = await webhook("menu", { CallSid: sid, Digits: "1" }, queryOf(attribute(answered.twiml!, "Gather", "action")), at);
  return {
    sid, at,
    wait: queryOf(attribute(pressed.twiml!, "Enqueue", "waitUrl")),
    done: queryOf(attribute(pressed.twiml!, "Enqueue", "action")),
  };
}

async function callRow(sid: string) {
  const [row] = await raw<{ id: string; routed_because: string | null; status: string }[]>`
    select id, routed_because, status from public.call where provider_call_id = ${`twilio:${sid}`}`;
  return row!;
}

async function missedFor(callId: string): Promise<number> {
  const [row] = await raw<{ n: number }[]>`
    select count(*)::int as n from public.domain_event where name = 'call.missed' and entity_id = ${callId}`;
  return row!.n;
}

async function lineSettings(settings: { offerCallback?: boolean; announceWait?: boolean; strategy?: "in_order" | "all_at_once" }) {
  if (settings.strategy) {
    await phoneMenus.saveRingGroup(owner(), {
      id: groupId, name: "Service team", strategy: settings.strategy, ringSeconds: 20,
      members: [{ userId: SAM }, { userId: LEE }], noAnswerTo: { kind: "voicemail", box: "main" },
    });
  }
  await callQueues.saveQueue(owner(), {
    id: lineId, name: "Service line", ringGroupId: groupId, maxWaitSeconds: 600,
    overflowTo: { kind: "voicemail", box: "main" },
    ...(settings.offerCallback !== undefined ? { offerCallback: settings.offerCallback } : {}),
    ...(settings.announceWait !== undefined ? { announceWait: settings.announceWait } : {}),
  });
}

/** Nobody left waiting or on a call from the test before. */
async function clearLine() {
  await raw`update public.call set queue_result = coalesce(queue_result, 'hangup'), status = 'completed', ended_at = coalesce(ended_at, now())
            where organization_id = ${ORG} and (queue_result is null or ended_at is null)`;
  await raw`update public.queue_callback set status = 'done', ended_at = now() where organization_id = ${ORG} and status in ('waiting', 'calling')`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Callback Heating", slug: "queue-callbacks-co" });
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
  lineId = (await callQueues.saveQueue(owner(), {
    name: "Service line", ringGroupId: groupId, maxWaitSeconds: 600, overflowTo: { kind: "voicemail", box: "main" },
  })).id;
  const menu = await phoneMenus.saveMenu(owner(), {
    name: "Main", greeting: "Thanks for calling Callback Heating.",
    options: [{ key: "1", label: "Service", to: { kind: "queue", id: lineId } }],
    noInputTo: { kind: "voicemail", box: "main" },
  });
  await raw`update public.phone_number set menu_id = ${menu.id} where organization_id = ${ORG}`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("the line's settings", () => {
  it("keeps both off for a line made before them, and saves them when the owner turns them on", async () => {
    const [before] = await callQueues.listQueues(owner());
    expect(before).toMatchObject({ offerCallback: false, announceWait: false });
    await lineSettings({ offerCallback: true, announceWait: true });
    const [after] = await callQueues.listQueues(owner());
    expect(after).toMatchObject({ offerCallback: true, announceWait: true });
    /** Saved again without them, as an older client would: they stay as they were. */
    await callQueues.saveQueue(owner(), {
      id: lineId, name: "Service line", ringGroupId: groupId, maxWaitSeconds: 600, overflowTo: { kind: "voicemail", box: "main" },
    });
    expect((await callQueues.listQueues(owner()))[0]).toMatchObject({ offerCallback: true, announceWait: true });
  });
});

run("the estimated wait", () => {
  it("says nothing until enough callers have been answered lately, then says it once", async () => {
    await clearLine();
    await lineSettings({ offerCallback: false, announceWait: true });
    const first = await joinLine("+15125558170");
    const quiet = await webhook("queue-wait", { CallSid: first.sid, QueuePosition: "1", QueueTime: "0" }, first.wait, first.at);
    expect(quiet.twiml).toContain("<Say>You are next in line. Thanks for waiting.</Say>");
    expect(quiet.twiml).not.toContain("Most callers");

    /** Six callers answered in the last hour, after 60 to 170 seconds. Three in four within 150. */
    for (const [i, waited] of [60, 90, 100, 120, 150, 170].entries()) {
      await raw`insert into public.call (organization_id, direction, from_e164, to_e164, status, queue_id, queued_at, queue_result, queue_wait_seconds)
                values (${ORG}, 'inbound', ${`+1512555811${i}`}, ${MAIN}, 'completed', ${lineId},
                        ${new Date(clock - (i + 1) * 300_000)}, 'bridged', ${waited})`;
    }
    /** And one from yesterday, which says nothing about now. */
    await raw`insert into public.call (organization_id, direction, from_e164, to_e164, status, queue_id, queued_at, queue_result, queue_wait_seconds)
              values (${ORG}, 'inbound', '+15125558199', ${MAIN}, 'completed', ${lineId}, ${new Date(clock - 86_400_000)}, 'bridged', 1500)`;
    await clearLine();
    const caller = await joinLine("+15125558171");
    const told = await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "0" }, caller.wait, caller.at);
    expect(told.twiml).toContain("<Say>You are next in line. Thanks for waiting. Most callers lately have been answered within about 3 minutes.</Say>");
    const again = await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "40" }, caller.wait, new Date(caller.at.getTime() + 40_000));
    expect(again.twiml).not.toContain("Most callers");
  });
});

run("ringing only the people who are free", () => {
  it("leaves somebody already talking to a caller out of the round", async () => {
    await clearLine();
    await lineSettings({ offerCallback: false, announceWait: false, strategy: "all_at_once" });
    /** Sam picked up a caller from the line a minute ago and is still talking. */
    await raw`insert into public.call (organization_id, direction, from_e164, to_e164, status, answered_by_user_id, started_at, answered_at)
              values (${ORG}, 'inbound', '+15125558160', ${MAIN}, 'in_progress', ${SAM}, ${new Date(clock)}, ${new Date(clock)})`;
    const caller = await joinLine("+15125558172");
    placed.length = 0;
    await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "0" }, caller.wait, caller.at);
    expect(placed.map((p) => p.get("To"))).toEqual([LEE_PHONE]);
    expect((await callRow(caller.sid)).routed_because).toContain("Not rung, already on a call: Sam Office.");

    /** Sam's call ends: the next round rings both. */
    await raw`update public.call set status = 'completed', ended_at = now() where organization_id = ${ORG} and answered_by_user_id = ${SAM}`;
    placed.length = 0;
    await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "35" }, caller.wait, new Date(caller.at.getTime() + 35_000));
    expect(placed.map((p) => p.get("To")).sort()).toEqual([LEE_PHONE, SAM_PHONE].sort());
  });

  it("does not count a call nobody reported the end of for more than three hours", async () => {
    await clearLine();
    await raw`insert into public.call (organization_id, direction, from_e164, to_e164, status, answered_by_user_id, started_at)
              values (${ORG}, 'inbound', '+15125558161', ${MAIN}, 'in_progress', ${SAM}, ${new Date(clock - 4 * 3600_000)})`;
    const caller = await joinLine("+15125558173");
    placed.length = 0;
    await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "0" }, caller.wait, caller.at);
    expect(placed.map((p) => p.get("To")).sort()).toEqual([LEE_PHONE, SAM_PHONE].sort());
  });
});

run("being called back instead of waiting", () => {
  let first: Awaited<ReturnType<typeof joinLine>>;
  let second: Awaited<ReturnType<typeof joinLine>>;

  it("offers it during the music, and takes a 1 as the caller asking", async () => {
    await clearLine();
    await lineSettings({ offerCallback: true, announceWait: false, strategy: "in_order" });
    first = await joinLine("+15125558174");
    placed.length = 0;
    const turn = await webhook("queue-wait", { CallSid: first.sid, QueuePosition: "1", QueueTime: "0" }, first.wait, first.at);
    expect(attribute(turn.twiml!, "Gather", "action")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}/queue-callback?q=${lineId}&h=1`);
    expect(turn.twiml).toContain(
      '<Gather action="' + attribute(turn.twiml!, "Gather", "action").replace(/&/g, "&amp;") + '" method="POST" numDigits="1" timeout="1">'
      + "<Say>You are next in line. Thanks for waiting. To be called back instead of waiting, keeping your place in line, press 1.</Say>"
      + "<Play>http://com.twilio.music.classical.s3.amazonaws.com/BusyStrings.mp3</Play></Gather>",
    );
    const action = queryOf(attribute(turn.twiml!, "Gather", "action"));

    const wrong = await webhook("queue-callback", { CallSid: first.sid, Digits: "5", QueueTime: "20" }, action, tick(20));
    expect(wrong.twiml).toContain("Sorry, that is not an option.");

    const asked = await webhook("queue-callback", { CallSid: first.sid, Digits: "1", QueueTime: "25" }, action, tick(5));
    expect(asked.twiml).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Leave/></Response>');
    /** The carrier reports the same press twice: one callback. */
    await webhook("queue-callback", { CallSid: first.sid, Digits: "1", QueueTime: "25" }, action, tick(1));
    const [count] = await raw<{ n: number }[]>`select count(*)::int as n from public.queue_callback where organization_id = ${ORG} and status = 'waiting'`;
    expect(count!.n).toBe(1);
  });

  it("tells the caller they will be called back on their number, and does not count them as missed when they hang up", async () => {
    placed.length = 0;
    const left = await webhook("queue-done", { CallSid: first.sid, QueueResult: "leave", QueueTime: "26" }, first.done, tick(1));
    expect(left.twiml).toContain("<Say>Thanks. We will call you back on 5 1 2, 5 5 5, 8 1 7 4 when it is your turn, so you can hang up now. Goodbye.</Say><Hangup/>");
    await webhook("status", { CallSid: first.sid, CallStatus: "completed", CallDuration: "40" }, "", tick(2));
    const row = await callRow(first.sid);
    expect(await missedFor(row.id)).toBe(0);
    expect(row.routed_because).toContain("Asked to be called back on +15125558174 instead of waiting, after 25 seconds in line.");
    /** Nobody else waiting on the line: the group is rung for the callback, each call reporting back when it ends. */
    expect(placed.length).toBeGreaterThan(0);
    expect(placed[0]!.get("Url")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}/queue-answer?q=${lineId}`);
    expect(placed[0]!.get("StatusCallback")).toMatch(new RegExp(`/queue-leg\\?k=[0-9a-f-]{36}$`));
  });

  it("keeps their place: somebody who joined after them is told they are second, and the next person free calls the first back", async () => {
    second = await joinLine("+15125558175");
    const turn = await webhook("queue-wait", { CallSid: second.sid, QueuePosition: "1", QueueTime: "0" }, second.wait, second.at);
    expect(turn.twiml).toContain("There is one caller ahead of you.");

    const picked = await webhook("queue-answer", { CallSid: "CAsamleg", To: SAM_PHONE }, `?q=${lineId}`, tick(5));
    expect(picked.twiml).toContain("<Say>A Service line caller asked to be called back. Calling them now.</Say>");
    expect(picked.twiml).toContain(`callerId="${MAIN}"`);
    expect(picked.twiml).toContain("<Number>+15125558174</Number>");
    expect(picked.twiml).not.toContain("record=");
    const done = queryOf(attribute(picked.twiml!, "Dial", "action"));

    /** Lee picks up a moment later and is given the caller still on hold. */
    const next = await webhook("queue-answer", { CallSid: "CAleeleg", To: LEE_PHONE }, `?q=${lineId}`, tick(1));
    expect(next.twiml).toContain("A Service line caller is waiting. Putting you through.");

    const answered = await webhook("callback-dialed", { CallSid: "CAsamleg", DialCallStatus: "completed", DialCallDuration: "95" }, done, tick(100));
    expect(answered.twiml).toContain("<Hangup/>");
    const [callback] = await raw<{ status: string; answered_by_user_id: string; callback_call_id: string }[]>`
      select status, answered_by_user_id, callback_call_id from public.queue_callback where organization_id = ${ORG} order by created_at desc limit 1`;
    expect(callback).toMatchObject({ status: "done", answered_by_user_id: SAM });
    const [back] = await raw<{ direction: string; from_e164: string; to_e164: string; placed_by_user_id: string; status: string; duration_seconds: number }[]>`
      select direction, from_e164, to_e164, placed_by_user_id, status, duration_seconds from public.call where id = ${callback!.callback_call_id}`;
    expect(back).toMatchObject({ direction: "outbound", from_e164: MAIN, to_e164: "+15125558174", placed_by_user_id: SAM, status: "completed", duration_seconds: 95 });
    expect((await callRow(first.sid)).routed_because).toContain("Called back by Sam Office, and they picked up.");
  });

  it("tries a caller who does not pick up once more, then makes it a task for the office and a missed call", async () => {
    await clearLine();
    const caller = await joinLine("+15125558176");
    const turn = await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "0" }, caller.wait, caller.at);
    await webhook("queue-callback", { CallSid: caller.sid, Digits: "1", QueueTime: "5" }, queryOf(attribute(turn.twiml!, "Gather", "action")), tick(5));
    await webhook("queue-done", { CallSid: caller.sid, QueueResult: "leave", QueueTime: "5" }, caller.done, tick(1));
    const row = await callRow(caller.sid);

    const ring = async (leg: string) => {
      const picked = await webhook("queue-answer", { CallSid: leg, To: LEE_PHONE }, `?q=${lineId}`, tick(30));
      return webhook("callback-dialed", { CallSid: leg, DialCallStatus: "no-answer", DialCallDuration: "0" },
        queryOf(attribute(picked.twiml!, "Dial", "action")), tick(30));
    };
    const once = await ring("CAtry1");
    expect(once.twiml).toContain("They did not pick up. They will be tried again in 5 minutes.");
    /** Not offered again until the pause is over. */
    const early = await webhook("queue-answer", { CallSid: "CAtooearly", To: SAM_PHONE }, `?q=${lineId}`, tick(10));
    expect(early.twiml).toContain("already been answered");

    tick(300);
    const twice = await ring("CAtry2");
    expect(twice.twiml).toContain("Calling them back is now a task for the office.");
    const [task] = await raw<{ title: string; body: string; priority: string }[]>`
      select title, body, priority from public.task where organization_id = ${ORG} and title = 'Call back +15125558176'`;
    expect(task!.body).toContain("They did not pick up when called back 2 times.");
    expect(task!.priority).toBe("high");
    expect(await missedFor(row.id)).toBe(1);
  });

  it("hands a callback nobody was free to make within the hour to the office", async () => {
    await clearLine();
    const caller = await joinLine("+15125558177");
    const turn = await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "0" }, caller.wait, caller.at);
    await webhook("queue-callback", { CallSid: caller.sid, Digits: "1", QueueTime: "5" }, queryOf(attribute(turn.twiml!, "Gather", "action")), tick(5));
    await webhook("queue-done", { CallSid: caller.sid, QueueResult: "leave", QueueTime: "5" }, caller.done, tick(1));
    await raw`update public.queue_callback set created_at = ${new Date(clock - 2 * 3600_000)} where organization_id = ${ORG} and status = 'waiting'`;
    await voice.sweepCallbacks(db(), ORG, deps, tick(1));
    const [callback] = await raw<{ status: string; outcome: string }[]>`
      select status, outcome from public.queue_callback where call_id = ${(await callRow(caller.sid)).id}`;
    expect(callback).toMatchObject({ status: "given_up" });
    expect(callback!.outcome).toContain("within 60 minutes");
    const [task] = await raw<{ n: number }[]>`select count(*)::int as n from public.task where organization_id = ${ORG} and title = 'Call back +15125558177'`;
    expect(task!.n).toBe(1);
  });

  it("does not offer it to a caller whose number is withheld, who could not be rung back", async () => {
    await clearLine();
    const caller = await joinLine("anonymous");
    const turn = await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "0" }, caller.wait, caller.at);
    expect(turn.twiml).not.toContain("<Gather");
    expect(turn.twiml).not.toContain("press 1");
    const pressed = await webhook("queue-callback", { CallSid: caller.sid, Digits: "1" }, `?q=${lineId}`, tick(5));
    expect(pressed.twiml).not.toContain("<Leave/>");
  });

  it("hands waiting callbacks to the office when their line is deleted", async () => {
    await clearLine();
    const caller = await joinLine("+15125558178");
    const turn = await webhook("queue-wait", { CallSid: caller.sid, QueuePosition: "1", QueueTime: "0" }, caller.wait, caller.at);
    await webhook("queue-callback", { CallSid: caller.sid, Digits: "1", QueueTime: "5" }, queryOf(attribute(turn.twiml!, "Gather", "action")), tick(5));
    await webhook("queue-done", { CallSid: caller.sid, QueueResult: "leave", QueueTime: "5" }, caller.done, tick(1));
    await raw`update public.phone_number set menu_id = null where organization_id = ${ORG}`;
    await raw`delete from public.phone_menu where organization_id = ${ORG}`;
    await callQueues.deleteQueue(owner(), lineId);
    const [task] = await raw<{ body: string }[]>`select body from public.task where organization_id = ${ORG} and title = 'Call back +15125558178'`;
    expect(task!.body).toContain("waiting line was deleted");
  });
});
