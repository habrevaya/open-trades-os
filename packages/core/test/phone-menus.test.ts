import { describe, it, expect } from "vitest";
import {
  checkMenu, chooseOption, menuPrompt, menuHoursTable, describeIn, checkRingGroup, ringPlan, weeklyRota,
  twiml, whisperText, MENU_ATTEMPTS, COMPANY_ROTA,
  type Directory, type PhoneMenu, type RingGroup,
} from "../src/voice/index.js";
import { hoursAt, route, type BusinessHours } from "../src/telephony/index.js";

/**
 * PHONE MENUS, RING GROUPS AND THE ON CALL WEEK
 *
 * The routing decisions a caller lives through: which option a key reaches,
 * what happens to somebody who presses nothing, who rings when the group is
 * called, and who has the phone the week the clocks change. Each is a case a
 * real company has rung its own number at night to find out.
 */

const OWNER = "11111111-1111-4111-8111-111111111111";
const TECH = "22222222-2222-4222-8222-222222222222";
const NO_PHONE = "33333333-3333-4333-8333-333333333333";
const SERVICE = "44444444-4444-4444-8444-444444444444";
const MAIN = "55555555-5555-4555-8555-555555555555";
const BILLING = "66666666-6666-4666-8666-666666666666";

const directory: Directory = {
  menus: new Map([[MAIN, "Main"], [BILLING, "Billing"]]),
  ringGroups: new Map([[SERVICE, "Service team"]]),
  people: new Map([
    [OWNER, { name: "Dana Owner", phone: "+15125550101" }],
    [TECH, { name: "Sam Tech", phone: "+15125550102" }],
    [NO_PHONE, { name: "Pat Office", phone: null }],
  ]),
  rotas: new Map(),
  queues: new Map([["77777777-7777-4777-8777-777777777777", "Service line"]]),
  assistant: false,
};

const menu = (overrides: Partial<PhoneMenu> = {}): PhoneMenu => ({
  id: MAIN,
  name: "Main",
  greeting: "Thanks for calling Smith Heating and Air.",
  options: [
    { key: "1", label: "Service", to: { kind: "ring_group", id: SERVICE } },
    { key: "2", label: "Billing", to: { kind: "person", userId: OWNER } },
  ],
  noInputTo: { kind: "voicemail", box: "main" },
  afterHoursTo: { kind: "on_call_rota", id: COMPANY_ROTA },
  timeoutSeconds: 6,
  ...overrides,
});

describe("saving a menu", () => {
  it("accepts a menu whose every option rings something real", () => {
    expect(checkMenu(menu(), directory)).toEqual({ ok: true });
  });

  it("refuses two options on one key, because a caller could only reach one of them", () => {
    const verdict = checkMenu(menu({
      options: [
        { key: "1", label: "Service", to: { kind: "voicemail", box: "main" } },
        { key: "1", label: "Billing", to: { kind: "voicemail", box: "main" } },
      ],
    }), directory);
    expect(verdict).toMatchObject({ ok: false });
    expect(!verdict.ok && verdict.reason).toContain("Two options use 1");
  });

  it("refuses an option that rings a person with no phone, naming them", () => {
    const verdict = checkMenu(menu({
      options: [{ key: "3", label: "Office", to: { kind: "person", userId: NO_PHONE } }],
    }), directory);
    expect(!verdict.ok && verdict.reason).toContain("Pat Office, who has no phone number");
  });

  it("refuses a destination that has been deleted, rather than ringing nothing", () => {
    const verdict = checkMenu(menu({
      options: [{ key: "1", label: "Service", to: { kind: "ring_group", id: "gone" } }],
    }), directory);
    expect(!verdict.ok && verdict.reason).toContain("ring group that no longer exists");
  });

  it("refuses a waiting line that no longer exists, and takes one that does", () => {
    const gone = checkMenu(menu({ noInputTo: { kind: "queue", id: "q" } }), directory);
    expect(!gone.ok && gone.reason).toContain("waiting line that no longer exists");
    expect(checkMenu(menu({ noInputTo: { kind: "queue", id: "77777777-7777-4777-8777-777777777777" } }), directory).ok)
      .toBe(true);
  });

  it("refuses the phone assistant while it is switched off, and takes it once it is on", () => {
    const off = checkMenu(menu({ afterHoursTo: { kind: "agent" } }), directory);
    expect(!off.ok && off.reason).toContain("phone assistant, which is switched off");
    expect(checkMenu(menu({ afterHoursTo: { kind: "agent" } }), { ...directory, assistant: true }).ok).toBe(true);
    expect(describeIn(directory)({ kind: "agent" })).toBe("the phone assistant");
  });

  it("refuses sending a caller who presses nothing back to the same menu forever", () => {
    const verdict = checkMenu(menu({ noInputTo: { kind: "ivr", menu: MAIN } }), directory);
    expect(!verdict.ok && verdict.reason).toContain("forever");
  });

  it("refuses a forward to a number nobody can dial", () => {
    const verdict = checkMenu(menu({
      options: [{ key: "9", label: "Answering service", to: { kind: "forward", e164: "555-0100" } }],
    }), directory);
    expect(!verdict.ok && verdict.reason).toContain("not a number a phone can dial");
  });

  it("refuses a key that is not on a phone, and a timeout nobody could press within", () => {
    expect(checkMenu(menu({ options: [{ key: "A", label: "X", to: { kind: "voicemail", box: "main" } }] }), directory).ok)
      .toBe(false);
    expect(checkMenu(menu({ timeoutSeconds: 1 }), directory).ok).toBe(false);
  });
});

describe("what a caller hears", () => {
  it("reads the options from the options, in keypad order, after the greeting", () => {
    const said = menuPrompt(menu({
      options: [
        { key: "#", label: "Repeat", to: { kind: "ivr", menu: MAIN } },
        { key: "2", label: "Billing", to: { kind: "voicemail", box: "main" } },
        { key: "1", label: "Service", to: { kind: "voicemail", box: "main" } },
      ],
    }));
    expect(said).toBe(
      "Thanks for calling Smith Heating and Air. For Service, press 1. For Billing, press 2. For Repeat, press pound.",
    );
  });

  it("escapes a greeting with markup in it, so it cannot become an instruction to the carrier", () => {
    const xml = twiml([{ verb: "say", text: menuPrompt(menu({ greeting: "Hi <Hangup/>" })) }]);
    expect(xml).not.toContain("<Hangup/>");
  });

  it("whispers the option the caller chose to whoever answers", () => {
    expect(whisperText({ recording: false, choice: "Billing" })).toBe("Billing call.");
    expect(whisperText({ recording: true, choice: "Billing", channelName: "Google Ads" }))
      .toBe("Billing call. Call from Google Ads. This call is being recorded.");
    expect(whisperText({ recording: false })).toBe("Call from a tracking number.");
  });
});

describe("choosing an option", () => {
  it("sends a key that matches to its option, and says what was pressed", () => {
    const choice = chooseOption(menu(), "2", 1);
    expect(choice).toMatchObject({ kind: "option", option: { label: "Billing" } });
    expect(choice.why).toBe("Pressed 2 for Billing in the Main menu.");
  });

  it("reads the menu again after a wrong key, saying so first", () => {
    const choice = chooseOption(menu(), "7", 1);
    expect(choice).toMatchObject({ kind: "again", attempt: 2, say: "Sorry, 7 is not one of the options." });
  });

  it("reads the menu again to somebody who pressed nothing, without scolding them", () => {
    expect(chooseOption(menu(), undefined, 1)).toMatchObject({ kind: "again", attempt: 2, say: null });
  });

  it("stops reading after the last attempt and goes where the owner said", () => {
    const choice = chooseOption(menu(), "", MENU_ATTEMPTS);
    expect(choice).toMatchObject({ kind: "gave_up", to: { kind: "voicemail" } });
    expect(choice.why).toContain(`${MENU_ATTEMPTS} times`);
  });
});

describe("a menu by business hours", () => {
  const hours: BusinessHours = {
    timeZone: "America/Chicago",
    weekly: {
      sunday: [], monday: [{ openMinute: 480, closeMinute: 1020 }], tuesday: [{ openMinute: 480, closeMinute: 1020 }],
      wednesday: [], thursday: [], friday: [], saturday: [],
    },
    holidays: [],
  };

  it("plays the menu in business hours", () => {
    // Monday 10:00 in Chicago.
    const result = route(menuHoursTable(menu()), {
      dialledNumber: "+15125550100", knownCustomer: false, hasOpenJob: false, emergencySelected: false,
      hours: hoursAt(hours, new Date("2026-10-05T15:00:00Z")),
    }, describeIn(directory));
    expect(result.destination).toEqual({ kind: "ivr", menu: MAIN });
    expect(result.why).toContain("Sent to the Main menu");
  });

  it("sends a call at night to whoever is on call, and says so in words", () => {
    const result = route(menuHoursTable(menu()), {
      dialledNumber: "+15125550100", knownCustomer: false, hasOpenJob: false, emergencySelected: false,
      hours: hoursAt(hours, new Date("2026-10-06T04:00:00Z")),
    }, describeIn(directory));
    expect(result.destination).toEqual({ kind: "on_call_rota", id: COMPANY_ROTA });
    expect(result.why).toContain("whoever is on call");
    expect(result.why).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("answers with the menu at every hour when no after hours destination is set", () => {
    const result = route(menuHoursTable(menu({ afterHoursTo: null })), {
      dialledNumber: "+15125550100", knownCustomer: false, hasOpenJob: false, emergencySelected: false,
      hours: hoursAt(hours, new Date("2026-10-06T04:00:00Z")),
    });
    expect(result.destination).toEqual({ kind: "ivr", menu: MAIN });
  });
});

describe("ring groups", () => {
  const group = (overrides: Partial<RingGroup> = {}): RingGroup => ({
    id: SERVICE, name: "Service team", strategy: "all_at_once", ringSeconds: 20,
    members: [
      { userId: OWNER, label: "Dana Owner" },
      { userId: TECH, label: "Sam Tech" },
      { e164: "+15125550199", label: "Answering service" },
    ],
    noAnswerTo: { kind: "voicemail", box: "main" },
    ...overrides,
  });

  it("rings everybody in one dial when all at once", () => {
    const plan = ringPlan(group(), directory);
    expect(plan.steps).toEqual([{
      numbers: ["+15125550101", "+15125550102", "+15125550199"],
      labels: ["Dana Owner", "Sam Tech", "Answering service"],
    }]);
    const xml = twiml([{ verb: "dial", to: plan.steps[0]!.numbers, action: "a", timeoutSeconds: 20 }]);
    expect(xml.match(/<Number>/g)).toHaveLength(3);
  });

  it("rings one after another, in the order the owner listed", () => {
    const plan = ringPlan(group({ strategy: "in_order" }), directory);
    expect(plan.steps.map((s) => s.numbers[0])).toEqual(["+15125550101", "+15125550102", "+15125550199"]);
  });

  it("skips somebody who has lost their number at call time, and rings the rest", () => {
    const plan = ringPlan(group({ members: [{ userId: NO_PHONE, label: "Pat" }, { userId: TECH, label: "Sam" }] }), directory);
    expect(plan.steps).toHaveLength(1);
    expect(plan.skipped).toEqual([{ label: "Pat Office", why: "has no phone number on their account" }]);
  });

  it("has no steps when nobody can be rung, so the caller goes to the group's fallback", () => {
    expect(ringPlan(group({ members: [{ userId: "gone", label: "Left" }] }), directory).steps).toEqual([]);
  });

  it("refuses a group that rings itself when nobody answers", () => {
    const verdict = checkRingGroup(group({ noAnswerTo: { kind: "ring_group", id: SERVICE } }), directory);
    expect(!verdict.ok && verdict.reason).toContain("forever");
  });

  it("refuses the same person twice and a member who is both a person and a number", () => {
    expect(checkRingGroup(group({ members: [{ userId: TECH, label: "a" }, { userId: TECH, label: "b" }] }), directory).ok)
      .toBe(false);
    expect(checkRingGroup(group({ members: [{ userId: TECH, e164: "+15125550100", label: "a" }] }), directory).ok)
      .toBe(false);
    expect(checkRingGroup(group(), directory)).toEqual({ ok: true });
  });
});

describe("the on call week", () => {
  it("takes people in turn and hands over at the same wall clock time across the clocks going back", () => {
    const rota = weeklyRota({
      technicianIds: ["a", "b"], firstDay: "2026-10-26", handoverMinute: 8 * 60, weeks: 3, timeZone: "America/Chicago",
    });
    if (!rota.ok) throw new Error(rota.reason);
    expect(rota.weeks.map((w) => w.technicianId)).toEqual(["a", "b", "a"]);
    // 08:00 CDT is 13:00Z; after 1 November 08:00 CST is 14:00Z.
    expect(rota.weeks[0]!.startsAt.toISOString()).toBe("2026-10-26T13:00:00.000Z");
    expect(rota.weeks[0]!.endsAt.toISOString()).toBe("2026-11-02T14:00:00.000Z");
    // The weeks touch: nobody is ever without the phone and nobody shares it.
    expect(rota.weeks[1]!.startsAt).toEqual(rota.weeks[0]!.endsAt);
  });

  it("refuses a handover at a time the clocks skip", () => {
    const rota = weeklyRota({
      technicianIds: ["a"], firstDay: "2027-03-07", handoverMinute: 2 * 60 + 30, weeks: 2, timeZone: "America/Chicago",
    });
    expect(!rota.ok && rota.reason).toContain("never happens");
  });

  it("refuses an empty list of people and an unbounded number of weeks", () => {
    expect(weeklyRota({ technicianIds: [], firstDay: "2026-10-05", handoverMinute: 0, weeks: 1, timeZone: "UTC" }).ok)
      .toBe(false);
    expect(weeklyRota({ technicianIds: ["a"], firstDay: "2026-10-05", handoverMinute: 0, weeks: 500, timeZone: "UTC" }).ok)
      .toBe(false);
  });
});
