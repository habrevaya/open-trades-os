import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as voice from "../src/services/voice";
import * as phoneMenus from "../src/services/phone-menus";
import * as phoneNumbers from "../src/services/phone-numbers";
import * as onCall from "../src/services/on-call";
import { twilioSignature } from "../src/comms/twilio";
import { createTwilioVoice } from "../src/voice/twilio";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * A COMPANY'S OWN NUMBER, ANSWERED LIKE AN OFFICE
 *
 * The owner builds a menu ("press 1 for service, 2 for billing"), a ring
 * group for the service team, sets who answers on which phone and fills the
 * on call rota by the week. Then calls arrive through the carrier's own
 * signed webhook and each step of the menu is walked: the keypress, the
 * group ringing all at once and in turn, a wrong key, silence, after hours
 * to whoever is on call, and nobody on call. Every request carries Twilio's
 * signature, and one that does not is refused.
 *
 * NO TEST HERE REACHES TWILIO. The adapter is the real one with its
 * transport handed in.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("menus:org");
const USER = fixtureId("menus:user");
const SLUG = "phone-menus-co";
const AUTH = "a-twilio-auth-token-for-menus";
const TOKEN = "m".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const MAIN = "+15125558000";
const OWNER_PHONE = "+15125558101";
const SAM_PHONE = "+15125558102";
const LEE_PHONE = "+15125558103";
const ANSWERING = "+15125558199";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (roles: Actor["roles"] = ["owner"]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles }, db: db(),
});

const asked: { method: string; url: string; body: string }[] = [];
const transport = async (to: string, init?: RequestInit): Promise<Response> => {
  const body = init?.body ? String(init.body) : "";
  asked.push({ method: init?.method ?? "GET", url: to, body });
  if (to.includes("/IncomingPhoneNumbers.json?")) {
    const wanted = new URL(to).searchParams.get("PhoneNumber");
    return Response.json({
      incoming_phone_numbers: wanted === MAIN
        ? [{ sid: "PNmain", phone_number: MAIN, voice_url: "https://old.example/voice", status_callback: "" }]
        : [],
    });
  }
  if (to.includes("/IncomingPhoneNumbers/")) return Response.json({ sid: "PNmain" });
  return Response.json({ message: "unexpected" }, { status: 400 });
};
const provider = createTwilioVoice({ accountSid: "ACtest" }, AUTH, transport);
const deps: voice.VoiceDeps = { readSecret: async () => AUTH, provider, publicBase: BASE };

function signed(step: string | null, form: Record<string, string>, query = "") {
  const to = `${BASE}/api/webhooks/voice/${TOKEN}${step ? `/${step}` : ""}${query}`;
  return {
    url: to,
    body: new URLSearchParams(form).toString(),
    headers: { "x-twilio-signature": twilioSignature(AUTH, to, form) },
  };
}

async function webhook(step: voice.Step, form: Record<string, string>, query = "", now = new Date()) {
  const connection = await voice.resolveWebhook(db(), TOKEN, deps);
  if (!connection) throw new Error("the webhook token did not resolve");
  return voice.handle(db(), connection, step, signed(step === "incoming" ? null : step, form, query), deps, now);
}

/** The query string Twilio was told to come back to, out of the TwiML it was given. */
function actionOf(twiml: string, verb: "Gather" | "Dial"): string {
  const match = new RegExp(`<${verb} action="([^"]+)"`).exec(twiml);
  if (!match) throw new Error(`No ${verb} in ${twiml}`);
  const action = match[1]!.replace(/&amp;/g, "&");
  return action.slice(action.indexOf("?") === -1 ? action.length : action.indexOf("?"));
}

async function person(key: string, name: string, technician = false) {
  const userId = fixtureId(`menus:person:${key}`);
  await raw`delete from public."user" where id = ${userId}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${`menus-${key}@test.local`}, ${name})`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, 'technician') returning id`;
  let technicianId: string | null = null;
  if (technician) {
    const [t] = await raw<{ id: string }[]>`
      insert into public.technician (organization_id, membership_id, display_name) values (${ORG}, ${m!.id}, ${name}) returning id`;
    technicianId = t!.id;
  }
  return { userId, technicianId };
}

let sam: { userId: string; technicianId: string | null };
let lee: { userId: string; technicianId: string | null };
let groupId = "";
let menuId = "";
let numberId = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Phone Menus Co", slug: SLUG });
  await raw`update public."user" set name = 'Dana Owner' where id = ${USER}`;
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  /** Monday to Friday, eight to five. */
  for (const day of [1, 2, 3, 4, 5]) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at)
              values (${ORG}, ${day}, '08:00', '17:00')`;
  }
  sam = await person("sam", "Sam Tech", true);
  lee = await person("lee", "Lee Tech", true);
  numberId = (await phoneNumbers.add(owner(), { e164: MAIN, purpose: "main" })).id;
});

afterAll(async () => { if (raw) await raw.end(); });

run("who answers, and the groups they ring in", () => {
  it("keeps the number each person answers on, in the form a phone dials", async () => {
    const set = await phoneMenus.setAnsweringPhone(owner(), { userId: USER, e164: "(512) 555-8101" });
    expect(set.phone).toBe(OWNER_PHONE);
    await phoneMenus.setAnsweringPhone(owner(), { userId: sam.userId, e164: SAM_PHONE });
    await phoneMenus.setAnsweringPhone(owner(), { userId: lee.userId, e164: LEE_PHONE });
    const people = await phoneMenus.listPeople(owner());
    expect(people.find((p) => p.userId === USER)).toMatchObject({ name: "Dana Owner", phone: OWNER_PHONE });
  });

  it("refuses a number nobody can dial", async () => {
    await expect(phoneMenus.setAnsweringPhone(owner(), { userId: sam.userId, e164: "call me" }))
      .rejects.toThrow(ConflictError);
  });

  it("refuses a dispatcher changing where the company's calls go", async () => {
    await expect(phoneMenus.saveRingGroup(owner(["dispatcher"]), {
      name: "x", strategy: "all_at_once", members: [{ userId: sam.userId }], noAnswerTo: { kind: "voicemail", box: "main" },
    })).rejects.toThrow();
  });

  it("makes a ring group of people and an answering service, labelled by name", async () => {
    const group = await phoneMenus.saveRingGroup(owner(), {
      name: "Service team", strategy: "in_order", ringSeconds: 15,
      members: [{ userId: sam.userId }, { userId: lee.userId }, { e164: ANSWERING, label: "Answering service" }],
      noAnswerTo: { kind: "voicemail", box: "main" },
    });
    groupId = group.id;
    expect(group.members.map((m) => m.label)).toEqual(["Sam Tech", "Lee Tech", "Answering service"]);
  });
});

run("building a menu", () => {
  it("builds a menu whose options ring a group, a person and voicemail, and reads them back as the caller hears them", async () => {
    const menu = await phoneMenus.saveMenu(owner(), {
      name: "Main", greeting: "Thanks for calling Phone Menus Co.",
      options: [
        { key: "1", label: "Service", to: { kind: "ring_group", id: groupId } },
        { key: "2", label: "Billing", to: { kind: "person", userId: USER } },
        { key: "9", label: "Leave a message", to: { kind: "voicemail", box: "main" } },
      ],
      noInputTo: { kind: "voicemail", box: "main" },
      afterHoursTo: { kind: "on_call_rota", id: "company" },
    });
    menuId = menu.id;
    expect(menu.prompt).toBe(
      "Thanks for calling Phone Menus Co. For Service, press 1. For Billing, press 2. For Leave a message, press 9.",
    );
  });

  it("refuses an option ringing somebody with no number, naming the option", async () => {
    const nobody = await person("nobody", "Pat Office");
    await expect(phoneMenus.saveMenu(owner(), {
      name: "Broken", greeting: "Hi.",
      options: [{ key: "3", label: "Office", to: { kind: "person", userId: nobody.userId } }],
      noInputTo: { kind: "voicemail", box: "main" },
    })).rejects.toThrow(/Option 3 \(Office\) rings Pat Office, who has no phone number/);
  });

  it("puts the menu on the company's number, which it already has at Twilio, pointing only its calls here", async () => {
    asked.length = 0;
    const answered = await voice.answerHere(owner(), { id: numberId }, deps);
    expect(answered).toMatchObject({ routedHere: true, adopted: true });
    const pointed = asked.find((a) => a.method === "POST")!;
    const form = new URLSearchParams(pointed.body);
    expect(form.get("VoiceUrl")).toBe(`${BASE}/api/webhooks/voice/${TOKEN}`);
    expect(form.get("SmsUrl")).toBeNull();
    const [row] = await raw<{ previous_voice_url: string }[]>`select previous_voice_url from public.phone_number where id = ${numberId}`;
    expect(row!.previous_voice_url).toBe("https://old.example/voice");

    const routed = await phoneNumbers.update(owner(), { id: numberId, menuId, whisper: true });
    expect(routed.menuId).toBe(menuId);
  });

  it("refuses a number Twilio does not hold, saying it is with another carrier", async () => {
    const other = await phoneNumbers.add(owner(), { e164: "+15125558555", purpose: "main" });
    await expect(voice.answerHere(owner(), { id: other.id }, deps)).rejects.toThrow(/does not hold/);
  });

  it("refuses deleting a menu a number still answers with, or a group the menu still rings", async () => {
    await expect(phoneMenus.deleteMenu(owner(), menuId)).rejects.toThrow(/the number \+15125558000/);
    await expect(phoneMenus.deleteRingGroup(owner(), groupId)).rejects.toThrow(/the Main menu/);
  });
});

/** Monday 6 October 2026, ten in the morning in Chicago, and the same night at eleven. */
const OPEN = new Date("2026-10-05T15:00:00Z");
const NIGHT = new Date("2026-10-06T04:00:00Z");

run("a call to the menu in business hours", () => {
  const SID = `CA${randomBytes(8).toString("hex")}`;

  it("refuses a menu step the carrier did not sign", async () => {
    const connection = (await voice.resolveWebhook(db(), TOKEN, deps))!;
    const request = signed("menu", { CallSid: SID, Digits: "1" }, `?m=${menuId}&t=1`);
    const forged = await voice.handle(db(), connection, "menu", { ...request, url: request.url.replace("t=1", "t=2") }, deps, OPEN);
    expect(forged.status).toBe(403);
  });

  it("answers with the menu, read in full", async () => {
    const reply = await webhook("incoming", { CallSid: SID, From: "+15125550111", To: MAIN }, "", OPEN);
    expect(reply.twiml).toContain("<Gather");
    expect(reply.twiml).toContain("For Service, press 1.");
    expect(actionOf(reply.twiml!, "Gather")).toBe(`?m=${menuId}&t=1`);
  });

  it("reads it again after a wrong key, saying so", async () => {
    const reply = await webhook("menu", { CallSid: SID, Digits: "7" }, `?m=${menuId}&t=1`, OPEN);
    expect(reply.twiml).toContain("Sorry, 7 is not one of the options.");
    expect(actionOf(reply.twiml!, "Gather")).toBe(`?m=${menuId}&t=2`);
  });

  it("rings the service team one after another on 1, and writes down what was pressed", async () => {
    const reply = await webhook("menu", { CallSid: SID, Digits: "1" }, `?m=${menuId}&t=2`, OPEN);
    expect(reply.twiml).toContain(`<Number url="${BASE}/api/webhooks/voice/${TOKEN}/whisper">${SAM_PHONE}</Number>`);
    expect(reply.twiml).toContain('timeout="15"');
    const [call] = await raw<{ menu_choices: { key: string; label: string }[] }[]>`
      select menu_choices from public.call where provider_call_id = ${`twilio:${SID}`}`;
    expect(call!.menu_choices).toMatchObject([{ key: "1", label: "Service" }]);
    expect((await webhook("whisper", { CallSid: "CA-child", ParentCallSid: SID })).twiml).toContain("Service call.");
  });

  it("rings the next person when the first does not answer, then the answering service", async () => {
    const second = await webhook("dialed", { CallSid: SID, DialCallStatus: "no-answer" }, `?g=${groupId}&i=0&h=1`, OPEN);
    expect(second.twiml).toContain(`>${LEE_PHONE}</Number>`);
    const third = await webhook("dialed", { CallSid: SID, DialCallStatus: "no-answer" }, `?g=${groupId}&i=1&h=1`, OPEN);
    expect(third.twiml).toContain(`>${ANSWERING}</Number>`);
  });

  it("goes to the group's own fallback when nobody picks up, and only then is it a missed call", async () => {
    const before = await raw`select 1 from public.domain_event where name = 'call.missed' and organization_id = ${ORG}`;
    expect(before).toHaveLength(0);
    const last = await webhook("dialed", { CallSid: SID, DialCallStatus: "no-answer" }, `?g=${groupId}&i=2&h=1`, OPEN);
    expect(last.twiml).toContain("<Record");
    const missed = await raw`select 1 from public.domain_event where name = 'call.missed' and organization_id = ${ORG}`;
    expect(missed).toHaveLength(1);
    const [call] = await raw<{ routed_because: string }[]>`
      select routed_because from public.call where provider_call_id = ${`twilio:${SID}`}`;
    expect(call!.routed_because).toContain("Nobody in the Service team ring group picked up.");
  });
});

run("a call that rings a person, and one that presses nothing", () => {
  it("rings the owner on 2", async () => {
    const SID = `CA${randomBytes(8).toString("hex")}`;
    await webhook("incoming", { CallSid: SID, From: "+15125550112", To: MAIN }, "", OPEN);
    const reply = await webhook("menu", { CallSid: SID, Digits: "2" }, `?m=${menuId}&t=1`, OPEN);
    expect(reply.twiml).toContain(`>${OWNER_PHONE}</Number>`);
  });

  it("sends a caller who presses nothing three times to voicemail, and says why", async () => {
    const SID = `CA${randomBytes(8).toString("hex")}`;
    await webhook("incoming", { CallSid: SID, From: "+15125550113", To: MAIN }, "", OPEN);
    expect((await webhook("menu", { CallSid: SID }, `?m=${menuId}&t=1`, OPEN)).twiml).toContain("<Gather");
    expect((await webhook("menu", { CallSid: SID }, `?m=${menuId}&t=2`, OPEN)).twiml).toContain("<Gather");
    const third = await webhook("menu", { CallSid: SID }, `?m=${menuId}&t=3`, OPEN);
    expect(third.twiml).toContain("<Record");
    const [call] = await raw<{ routed_because: string }[]>`
      select routed_because from public.call where provider_call_id = ${`twilio:${SID}`}`;
    expect(call!.routed_because).toContain("Pressed nothing after hearing the Main menu 3 times.");
  });
});

run("after hours, to whoever is on call", () => {
  it("fills the rota a week at a time, handing over at eight every Monday", async () => {
    const filled = await onCall.fillWeeks(owner(), {
      technicianIds: [sam.technicianId!, lee.technicianId!], firstDay: "2026-09-28", handoverAt: "08:00", weeks: 3,
    });
    expect(filled.shifts).toHaveLength(3);
    expect(filled.shifts[0]!.startsAt).toBe("2026-09-28T13:00:00.000Z");
    expect(filled.shifts[1]!.technicianId).toBe(lee.technicianId);
  });

  it("refuses a second fill over the same weeks, adding nothing", async () => {
    await expect(onCall.fillWeeks(owner(), {
      technicianIds: [sam.technicianId!], firstDay: "2026-10-12", handoverAt: "08:00", weeks: 2,
    })).rejects.toThrow(/Week 1 collides/);
    const rows = await raw`select 1 from public.on_call_rotation where organization_id = ${ORG}`;
    expect(rows).toHaveLength(3);
  });

  it("rings the technician on call this week at night, not the menu", async () => {
    const SID = `CA${randomBytes(8).toString("hex")}`;
    const reply = await webhook("incoming", { CallSid: SID, From: "+15125550114", To: MAIN }, "", NIGHT);
    // The week of 5 October is the second week: Lee.
    expect(reply.twiml).toContain(`>${LEE_PHONE}</Number>`);
    expect(reply.twiml).not.toContain("<Gather");
    const [call] = await raw<{ routed_because: string }[]>`
      select routed_because from public.call where provider_call_id = ${`twilio:${SID}`}`;
    expect(call!.routed_because).toContain("whoever is on call");
    expect(call!.routed_because).toContain("Lee Tech was on call.");
  });

  it("sends a night call to voicemail when nobody is on call, and says so", async () => {
    const SID = `CA${randomBytes(8).toString("hex")}`;
    const reply = await webhook("incoming", { CallSid: SID, From: "+15125550115", To: MAIN }, "", new Date("2026-12-01T05:00:00Z"));
    expect(reply.twiml).toContain("<Record");
    const [call] = await raw<{ routed_because: string }[]>`
      select routed_because from public.call where provider_call_id = ${`twilio:${SID}`}`;
    expect(call!.routed_because).toContain("Nobody was on call, so it went to voicemail.");
  });
});

run("giving the number back", () => {
  it("never releases a number the company brought with it at the carrier: its calls go back where they were", async () => {
    await phoneNumbers.update(owner(), { id: numberId, menuId: null });
    asked.length = 0;
    await voice.releaseNumber(owner(), { id: numberId }, deps);
    expect(asked.some((a) => a.method === "DELETE")).toBe(false);
    const restore = new URLSearchParams(asked.find((a) => a.method === "POST")!.body);
    expect(restore.get("VoiceUrl")).toBe("https://old.example/voice");
    const [row] = await raw<{ released_at: Date | null; provider_number_id: string | null }[]>`
      select released_at, provider_number_id from public.phone_number where id = ${numberId}`;
    expect(row!.released_at).not.toBeNull();
    expect(row!.provider_number_id).toBeNull();
  });
});
