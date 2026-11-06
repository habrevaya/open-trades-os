import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { randomBytes } from "node:crypto";
import type { Actor } from "@opentradesos/core";
import * as voice from "../src/services/voice";
import * as businessHours from "../src/services/business-hours";
import * as menuHours from "../src/services/menu-hours";
import * as phoneMenus from "../src/services/phone-menus";
import * as holidays from "../src/services/holidays";
import { twilioSignature } from "../src/comms/twilio";
import { createTwilioVoice } from "../src/voice/twilio";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * M18. A PHONE MENU WITH HOURS OF ITS OWN
 *
 * Menu Hours Co keeps the office open Monday to Friday, eight to five, and
 * its Houston branch opens Tuesday to Saturday mornings. The main number's
 * menu answers at every hour; pressing 2 reaches the Sales menu. Sales keeps
 * shorter hours than the office: outside them a caller who presses 2 goes
 * where the Sales menu's after hours setting says, and the call says why.
 * The Sales menu can follow the number (as every menu did before), the
 * company, a branch with its seasons, or a week and days off of its own.
 *
 * Calls arrive through the carrier's signed webhook against a fake carrier;
 * nothing reaches Twilio.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("menu-hours:org");
const USER = fixtureId("menu-hours:user");
const SLUG = "menu-hours-co";
const AUTH = "a-twilio-auth-token-for-menu-hours";
const TOKEN = "m".repeat(20) + randomBytes(12).toString("hex");
const BASE = "https://ots.test";
const MAIN = "+15125557100";
const SALES_LINE = "+15125557101";
const OFFICE = "+15125557102";
const SALES_DESK = "+15125557103";
const AFTER = "+15125557104";

/** America/Chicago in January is six hours behind UTC. */
const MONDAY_TEN = new Date("2027-01-11T16:00:00Z");
const MONDAY_ONE = new Date("2027-01-11T19:00:00Z");
const MONDAY_SIX_PM = new Date("2027-01-12T00:00:00Z");
const SATURDAY_NINE = new Date("2027-01-09T15:00:00Z");

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db() });
const keyed = (key: string): ServiceContext => ({ ...owner(), idempotencyKey: `${key}-${randomBytes(4).toString("hex")}` });

const transport = async (): Promise<Response> => Response.json({ message: "unexpected" }, { status: 400 });
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

const gatherQuery = (twiml: string): string => {
  const match = /<Gather action="([^"]+)"/.exec(twiml);
  if (!match) throw new Error(`No Gather in ${twiml}`);
  const action = match[1]!.replace(/&amp;/g, "&");
  return action.slice(action.indexOf("?"));
};

async function whyOf(sid: string): Promise<string> {
  const [call] = await raw<{ routed_because: string }[]>`select routed_because from public.call where provider_call_id = ${`twilio:${sid}`}`;
  return call?.routed_because ?? "";
}

/** A different caller each time, so two calls at one moment are never read as one call sent twice. */
let callers = 0;
const caller = () => `+1512555${String(1000 + (callers += 1)).slice(-4)}`;

/** A call to the main number, pressing 2 for Sales: what the caller hears next, and why. */
async function pressSales(now: Date): Promise<{ twiml: string; why: string }> {
  const sid = `CA${randomBytes(8).toString("hex")}`;
  const answered = await webhook("incoming", { CallSid: sid, From: caller(), To: MAIN }, "", now);
  const pressed = await webhook("menu", { CallSid: sid, Digits: "2" }, gatherQuery(answered.twiml!), now);
  return { twiml: pressed.twiml ?? "", why: await whyOf(sid) };
}

/** A call straight to the Sales line, which the Sales menu answers. */
async function ringSalesLine(now: Date): Promise<{ twiml: string; why: string }> {
  const sid = `CA${randomBytes(8).toString("hex")}`;
  const answered = await webhook("incoming", { CallSid: sid, From: caller(), To: SALES_LINE }, "", now);
  return { twiml: answered.twiml ?? "", why: await whyOf(sid) };
}

const SALES_MENU_PROMPT = "Sales. For Quotes, press 1.";
const week = (open: number[], opens: string, closes: string) => [0, 1, 2, 3, 4, 5, 6].map((dayOfWeek) => ({
  dayOfWeek, opensAt: open.includes(dayOfWeek) ? opens : null, closesAt: open.includes(dayOfWeek) ? closes : null, closed: !open.includes(dayOfWeek),
}));
const SALES_WEEK = week([1, 2, 3, 4, 5], "09:00", "12:00");

let houston = "";
let mainMenu = "";
let salesMenu = "";

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Menu Hours Co", slug: SLUG });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, credential_ref, settings)
            values (${ORG}, 'messaging', 'twilio', 'connected', 'TEST_TWILIO_TOKEN',
                    ${raw.json({ accountSid: "ACtest", webhookToken: TOKEN })})`;
  const [h] = await raw<{ id: string }[]>`insert into public.business_unit (organization_id, name) values (${ORG}, 'Houston') returning id`;
  houston = h!.id;
  await businessHours.setWeek(owner(), { days: week([1, 2, 3, 4, 5], "08:00", "17:00") });
  await businessHours.setWeek(owner(), { days: week([2, 3, 4, 5, 6], "07:00", "12:00"), businessUnitId: houston });

  const sales = await phoneMenus.saveMenu(owner(), {
    name: "Sales", greeting: "Sales.",
    options: [{ key: "1", label: "Quotes", to: { kind: "forward", e164: SALES_DESK } }],
    noInputTo: { kind: "voicemail", box: "main" },
    afterHoursTo: { kind: "forward", e164: AFTER },
  });
  salesMenu = sales.id;
  const main = await phoneMenus.saveMenu(owner(), {
    name: "Main", greeting: "Thanks for calling Menu Hours Co.",
    options: [
      { key: "1", label: "Service", to: { kind: "forward", e164: OFFICE } },
      { key: "2", label: "Sales", to: { kind: "ivr", menu: salesMenu } },
    ],
    noInputTo: { kind: "voicemail", box: "main" },
  });
  mainMenu = main.id;
  await raw`insert into public.phone_number (organization_id, e164, purpose, provider_number_id, menu_id)
            values (${ORG}, ${MAIN}, 'main', 'PNmenuhoursmain', ${mainMenu}),
                   (${ORG}, ${SALES_LINE}, 'main', 'PNmenuhourssales', ${salesMenu})`;
});

afterAll(async () => { if (raw) await raw.end(); });

run("a phone menu's own hours", () => {
  it("follows the number until told otherwise, read as it always was from another menu", async () => {
    const view = await menuHours.view(owner(), { id: salesMenu });
    expect(view).toMatchObject({ hoursFrom: "number", hasAfterHours: true, ownWeek: [], ownHolidays: [] });
    expect(view.goesBy).toMatchObject({ source: "follows_number", whose: "The hours of the number each call came in on" });
    expect(view.numbers.map((n) => n.e164)).toEqual([SALES_LINE]);
    expect((await phoneMenus.getMenu(owner(), salesMenu)).hoursFrom).toBe("number");
    /** Six in the evening: the main menu answers at every hour, and Sales follows it. */
    expect((await pressSales(MONDAY_SIX_PM)).twiml).toContain(SALES_MENU_PROMPT);
  });

  it("refuses hours of its own for a menu with nowhere to send a closed call, and the rest in words", async () => {
    await expect(menuHours.setHours(owner(), { id: mainMenu, hoursFrom: "company" }))
      .rejects.toThrow(/Choose where this menu sends calls when it is closed/);
    await expect(menuHours.setHours(owner(), { id: salesMenu, hoursFrom: "own" })).rejects.toThrow(/Say this menu's own hours/);
    await expect(menuHours.setHours(owner(), { id: salesMenu, hoursFrom: "company", days: SALES_WEEK }))
      .rejects.toThrow(/only kept for a menu set to keep its own hours/);
    await expect(menuHours.setHours(owner(), { id: salesMenu, hoursFrom: "branch" })).rejects.toThrow(/Choose the branch/);
    await expect(menuHours.setHours(owner(), { id: salesMenu, hoursFrom: "company", businessUnitId: houston }))
      .rejects.toThrow(/only chosen for a menu set to follow a branch/);
    await expect(menuHours.setHours(owner(), { id: salesMenu, hoursFrom: "branch", businessUnitId: fixtureId("menu-hours:nowhere") }))
      .rejects.toThrow(/Branch/);
    const dispatcher: ServiceContext = { ...owner(), actor: { ...owner().actor, roles: ["dispatcher"] } };
    await expect(menuHours.setHours(dispatcher, { id: salesMenu, hoursFrom: "company" })).rejects.toThrow();
    await expect(menuHours.view({ ...owner(), actor: { ...owner().actor, roles: ["technician"] } }, { id: salesMenu })).rejects.toThrow();
  });

  it("keeps its own week: a caller pressing 2 after Sales has shut goes where Sales sends a closed call, and says why", async () => {
    const own = await menuHours.setHours(owner(), { id: salesMenu, hoursFrom: "own", days: SALES_WEEK });
    expect(own.goesBy).toMatchObject({ source: "menu", whose: "Its own hours" });
    expect(own.ownWeek).toHaveLength(7);
    expect((await phoneMenus.getMenu(owner(), salesMenu)).hoursFrom).toBe("own");

    expect((await pressSales(MONDAY_TEN)).twiml).toContain(SALES_MENU_PROMPT);
    /** One in the afternoon: the office is open, Sales is not. */
    const closed = await pressSales(MONDAY_ONE);
    expect(closed.twiml).toContain(`>${AFTER}</Number>`);
    expect(closed.why).toContain("The Sales menu goes by its own hours.");
    expect(closed.why).toContain(AFTER);

    const [audit] = await raw<{ action: string }[]>`
      select action from public.audit_log where organization_id = ${ORG} and entity_id = ${salesMenu} and action = 'phone_menu.hours_set' limit 1`;
    expect(audit?.action).toBe("phone_menu.hours_set");
  });

  it("goes by its own hours, not the number's, where it answers a number", async () => {
    const closed = await ringSalesLine(MONDAY_ONE);
    expect(closed.twiml).toContain(`>${AFTER}</Number>`);
    expect(closed.why).toContain("The Sales menu goes by its own hours.");
    expect((await ringSalesLine(MONDAY_TEN)).twiml).toContain(SALES_MENU_PROMPT);
  });

  it("refuses clearing after hours while it keeps its own hours", async () => {
    await expect(phoneMenus.saveMenu(owner(), {
      id: salesMenu, name: "Sales", greeting: "Sales.",
      options: [{ key: "1", label: "Quotes", to: { kind: "forward", e164: SALES_DESK } }],
      noInputTo: { kind: "voicemail", box: "main" }, afterHoursTo: null,
    })).rejects.toThrow(/keeps hours of its own, so it needs somewhere for calls to go when it is closed/);
  });

  it("ignores the company's day off while it keeps its own, and is shut by a day off of its own that no other list sees", async () => {
    const party = await holidays.create(keyed("party"), { name: "Shop party", date: "2027-01-11", closed: true });
    try {
      expect((await pressSales(MONDAY_TEN)).twiml).toContain(SALES_MENU_PROMPT);
      const ctx = keyed("own-day");
      const day = await menuHours.addHoliday(ctx, { id: salesMenu, name: "Sales training", date: "2027-01-11", closed: true });
      /** The same request again is the same day off. */
      expect((await menuHours.addHoliday(ctx, { id: salesMenu, name: "Sales training", date: "2027-01-11", closed: true })).id).toBe(day.id);
      await expect(menuHours.addHoliday(keyed("twice"), { id: salesMenu, name: "Twice", date: "2027-01-11", closed: true }))
        .rejects.toThrow(/already on the list/);
      expect((await pressSales(MONDAY_TEN)).twiml).toContain(`>${AFTER}</Number>`);

      expect((await holidays.list(owner())).map((h) => h.name)).toEqual(["Shop party"]);
      expect((await holidays.loadHolidays(db(), ORG, null)).map((h) => h.name)).toEqual(["Shop party"]);
      await expect(holidays.remove(owner(), { id: day.id })).rejects.toThrow(/Holiday/);
      expect((await menuHours.view(owner(), { id: salesMenu })).ownHolidays.map((h) => h.name)).toEqual(["Sales training"]);
      expect(await menuHours.removeHoliday(owner(), { id: salesMenu, holidayId: day.id })).toEqual({ removed: true });
      expect(await menuHours.removeHoliday(owner(), { id: salesMenu, holidayId: day.id })).toEqual({ removed: false });
      expect((await pressSales(MONDAY_TEN)).twiml).toContain(SALES_MENU_PROMPT);

      /** Following the company instead, the company's day off shuts it. */
      await menuHours.setHours(owner(), { id: salesMenu, hoursFrom: "company" });
      const shut = await pressSales(MONDAY_TEN);
      expect(shut.twiml).toContain(`>${AFTER}</Number>`);
      expect(shut.why).toContain("The Sales menu goes by the company's hours.");
    } finally {
      await holidays.remove(owner(), { id: party.id });
    }
  });

  it("follows a branch's hours and the season in force there", async () => {
    const branch = await menuHours.setHours(owner(), { id: salesMenu, hoursFrom: "branch", businessUnitId: houston });
    expect(branch).toMatchObject({ businessUnitId: houston, branchName: "Houston" });
    expect(branch.goesBy.source).toBe("branch");
    /** Houston opens Saturday mornings; the company does not. */
    expect((await pressSales(SATURDAY_NINE)).twiml).toContain(SALES_MENU_PROMPT);

    const season = await businessHours.addSeason(owner(), {
      name: "Houston winter", startsOn: "2027-01-01", endsOn: "2027-02-28", businessUnitId: houston,
      days: week([2, 3, 4, 5], "07:00", "12:00"),
    });
    try {
      const shut = await pressSales(SATURDAY_NINE);
      expect(shut.twiml).toContain(`>${AFTER}</Number>`);
      expect(shut.why).toContain("The Sales menu goes by the season it follows, Houston winter.");
    } finally {
      await businessHours.removeSeason(owner(), { id: season.id });
    }
    expect((await pressSales(SATURDAY_NINE)).twiml).toContain(SALES_MENU_PROMPT);
  });

  it("keeps its own week when switched away, and the company's week never reads it", async () => {
    await menuHours.setHours(owner(), { id: salesMenu, hoursFrom: "number" });
    const view = await menuHours.view(owner(), { id: salesMenu });
    expect(view.ownWeek).toHaveLength(7);
    expect(view.goesBy.source).toBe("follows_number");
    expect((await pressSales(MONDAY_ONE)).twiml).toContain(SALES_MENU_PROMPT);

    const company = (await businessHours.list(owner())).company;
    expect(company.find((d) => d.dayOfWeek === 1)).toMatchObject({ opensAt: "08:00", closesAt: "17:00" });
    expect((await businessHours.loadWeek(db(), ORG, null)).source).toBe("company");
    await businessHours.setWeek(owner(), { days: company });
    expect((await menuHours.view(owner(), { id: salesMenu })).ownWeek).toHaveLength(7);
    expect((await menuHours.setHours(owner(), { id: salesMenu, hoursFrom: "own" })).goesBy.source).toBe("menu");
    await menuHours.setHours(owner(), { id: salesMenu, hoursFrom: "number" });
  });

  it("takes its own week and days off with it when it is deleted", async () => {
    const spare = await phoneMenus.saveMenu(owner(), {
      name: "Spare", greeting: "Spare.", options: [{ key: "1", label: "Office", to: { kind: "forward", e164: OFFICE } }],
      noInputTo: { kind: "voicemail", box: "main" }, afterHoursTo: { kind: "voicemail", box: "main" },
    });
    await menuHours.setHours(owner(), { id: spare.id, hoursFrom: "own", days: SALES_WEEK });
    await menuHours.addHoliday(keyed("spare-day"), { id: spare.id, name: "Spare day", date: "2027-03-01", closed: true });
    await phoneMenus.deleteMenu(owner(), spare.id);
    const [left] = await raw<{ n: number }[]>`
      select (select count(*) from public.business_hours where phone_menu_id = ${spare.id})
           + (select count(*) from public.company_holiday where phone_menu_id = ${spare.id}) as n`;
    expect(Number(left!.n)).toBe(0);
  });
});
