import { describe, it, expect } from "vitest";
import {
  checkMenu, chooseOption, chooseSpoken, matchSpoken, menuPrompt, speechHints, normalSpeech, twiml,
  MENU_ATTEMPTS, COMPANY_ROTA,
  type Directory, type PhoneMenu,
} from "../src/voice/index.js";

/**
 * A PHONE MENU THAT LISTENS AS WELL AS COUNTS
 *
 * A caller who says "billing" goes where pressing 2 would take them; one who
 * says "a new furnace" when the menu has Sales and Service gets the menu once
 * more, told why, and then goes where a caller who presses nothing goes. Keys
 * keep working whatever is said, and a menu with listening off is the menu it
 * always was.
 */

const SERVICE = "44444444-4444-4444-8444-444444444444";
const OWNER = "11111111-1111-4111-8111-111111111111";
const MAIN = "55555555-5555-4555-8555-555555555555";

const directory: Directory = {
  menus: new Map([[MAIN, "Main"]]),
  ringGroups: new Map([[SERVICE, "Service team"]]),
  people: new Map([[OWNER, { name: "Dana Owner", phone: "+15125550101" }]]),
  rotas: new Map(),
  queues: new Map(),
  assistant: false,
};

const menu = (overrides: Partial<PhoneMenu> = {}): PhoneMenu => ({
  id: MAIN,
  name: "Main",
  greeting: "Thanks for calling Smith Heating and Air.",
  options: [
    { key: "1", label: "Service", to: { kind: "ring_group", id: SERVICE }, words: ["repair", "no heat", "broken"] },
    { key: "2", label: "Billing questions", to: { kind: "person", userId: OWNER }, words: ["invoice", "pay my bill"] },
    { key: "3", label: "Sales", to: { kind: "voicemail", box: "main" }, words: ["new system", "quote"] },
  ],
  noInputTo: { kind: "voicemail", box: "main" },
  afterHoursTo: { kind: "on_call_rota", id: COMPANY_ROTA },
  timeoutSeconds: 6,
  speech: true,
  ...overrides,
});

describe("what a caller's words match", () => {
  it("matches a label, one of the option's words, and plurals of them", () => {
    expect(matchSpoken(menu(), "Service, please.")).toMatchObject({ kind: "option", option: { key: "1" } });
    expect(matchSpoken(menu(), "I need to pay my bill")).toMatchObject({ kind: "option", option: { key: "2" } });
    expect(matchSpoken(menu(), "It's about my invoices")).toMatchObject({ kind: "option", option: { key: "2" } });
    expect(matchSpoken(menu(), "We have NO HEAT!")).toMatchObject({ kind: "option", option: { key: "1" } });
  });

  it("takes a significant word of a longer label, but never a common one alone", () => {
    expect(matchSpoken(menu(), "billing")).toMatchObject({ kind: "option", option: { key: "2" } });
    expect(matchSpoken(menu(), "I have some questions")).toEqual({ kind: "none" });
  });

  it("hears a number said on its own as that key, and a number inside a sentence as words", () => {
    expect(matchSpoken(menu(), "Three.")).toMatchObject({ kind: "option", option: { key: "3" } });
    expect(matchSpoken(menu(), "press two")).toMatchObject({ kind: "option", option: { key: "2" } });
    expect(matchSpoken(menu(), "option 1")).toMatchObject({ kind: "option", option: { key: "1" } });
    expect(matchSpoken(menu(), "nine")).toEqual({ kind: "none" });
    expect(matchSpoken(menu(), "I have two units that need a repair")).toMatchObject({ kind: "option", option: { key: "1" } });
  });

  it("prefers the longer phrase said in full, and will not guess between two as likely", () => {
    expect(matchSpoken(menu(), "a quote for a new system")).toMatchObject({ kind: "option", option: { key: "3" } });
    expect(matchSpoken(menu(), "repair or a quote")).toMatchObject({ kind: "unclear" });
  });

  it("matches nothing for nothing, or for words no option uses", () => {
    expect(matchSpoken(menu(), "")).toEqual({ kind: "none" });
    expect(matchSpoken(menu(), "?!")).toEqual({ kind: "none" });
    expect(matchSpoken(menu(), "the weather today")).toEqual({ kind: "none" });
    expect(normalSpeech("  Café, RÉPAIR!! ")).toBe("cafe repair");
  });
});

describe("what a spoken answer does", () => {
  it("goes where the key would, saying what was said", () => {
    const choice = chooseSpoken(menu(), "billing please", 1, 0);
    expect(choice).toMatchObject({ kind: "option", option: { key: "2" } });
    expect(choice.why).toBe('Said "billing please" for Billing questions in the Main menu.');
  });

  it("reads the menu again once after words it cannot match, then goes where a silent caller goes", () => {
    const first = chooseSpoken(menu(), "the weather today", 1, 0);
    expect(first).toEqual({
      kind: "again", attempt: 2, misses: 1, why: 'Said "the weather today", which is not one of the options.',
      say: "Sorry, I did not understand that. Here are the options again.",
    });
    const second = chooseSpoken(menu(), "still the weather", 2, 1);
    expect(second).toMatchObject({ kind: "gave_up", to: { kind: "voicemail" } });
    expect(second.why).toBe('Said "still the weather", which is not one of the options, after hearing the Main menu 2 times.');
  });

  it("says so when the words could be two options, and counts it as a miss", () => {
    expect(chooseSpoken(menu(), "repair or a quote", 1, 0)).toMatchObject({
      kind: "again", misses: 1, say: "Sorry, I did not catch which one you want. Here are the options again.",
      why: 'Said "repair or a quote", which could be Service or Sales.',
    });
  });

  it("gives up on the menu's last reading whatever the misses, and keys still work after a miss", () => {
    expect(chooseSpoken(menu(), "mumble", MENU_ATTEMPTS, 0)).toMatchObject({ kind: "gave_up" });
    expect(chooseOption(menu(), "1", 2)).toMatchObject({ kind: "option", option: { key: "1" } });
  });

  it("writes a long answer down short", () => {
    const choice = chooseSpoken(menu(), `service ${"and more ".repeat(30)}`, 1, 0);
    expect(choice.why.length).toBeLessThan(140);
    expect(choice.why).toContain('..."');
  });
});

describe("the menu a caller hears", () => {
  it("offers saying each option only when the menu listens", () => {
    expect(menuPrompt(menu())).toContain("For Service, press 1 or say Service.");
    expect(menuPrompt(menu({ speech: false }))).toContain("For Service, press 1.");
    expect(menuPrompt(menu({ speech: false }))).not.toContain(" say ");
  });

  it("tells the carrier to listen for every label and word", () => {
    expect(speechHints(menu())).toBe("Service, repair, no heat, broken, Billing questions, invoice, pay my bill, Sales, new system, quote");
  });

  it("asks the carrier to listen for speech and keys in one gather, with the hints escaped", () => {
    const xml = twiml([{
      verb: "gather", action: "https://x/m", numDigits: 1, timeoutSeconds: 6, say: "Hi", speechHints: 'Service, "A&B"',
    }]);
    expect(xml).toContain('input="dtmf speech"');
    expect(xml).toContain('hints="Service, &quot;A&amp;B&quot;"');
    expect(xml).toContain('speechTimeout="auto"');
    expect(xml).toContain('language="en-US"');
    expect(twiml([{ verb: "gather", action: "https://x/m", numDigits: 1, timeoutSeconds: 6, say: "Hi" }])).not.toContain("input=");
  });
});

describe("saving a menu that listens", () => {
  it("accepts words that are words", () => {
    expect(checkMenu(menu(), directory)).toEqual({ ok: true });
  });

  it("refuses a phrase two options listen for, only when the menu listens", () => {
    const shared = menu({
      options: [
        { key: "1", label: "Service", to: { kind: "voicemail", box: "main" }, words: ["repair"] },
        { key: "2", label: "Repairs", to: { kind: "voicemail", box: "main" } },
      ],
    });
    expect(checkMenu(shared, directory)).toEqual({
      ok: false, reason: 'Options 1 and 2 both listen for "repair". A caller saying it could only reach one of them.',
    });
    expect(checkMenu({ ...shared, speech: false }, directory)).toEqual({ ok: true });
  });

  it("refuses a key's name as a word, markup, and too many words", () => {
    const named = menu({ options: [{ key: "1", label: "Service", to: { kind: "voicemail", box: "main" }, words: ["two"] }] });
    expect(checkMenu(named, directory)).toMatchObject({ ok: false, reason: expect.stringContaining("is the name of a key") });
    const markup = menu({ options: [{ key: "1", label: "Service", to: { kind: "voicemail", box: "main" }, words: ["<Hangup/>"] }] });
    expect(checkMenu(markup, directory)).toMatchObject({ ok: false, reason: expect.stringContaining("is not a word a caller can say") });
    const many = menu({ options: [{ key: "1", label: "Service", to: { kind: "voicemail", box: "main" }, words: Array.from({ length: 9 }, (_, i) => `word ${"x".repeat(i + 1)}`) }] });
    expect(checkMenu(many, directory)).toMatchObject({ ok: false, reason: expect.stringContaining("Keep it to 8 or fewer") });
  });
});
