import {
  DESTINATION_KINDS,
  type RoutingDestination, type RoutingTable,
} from "../telephony/index.js";
import { instantOfLocal as instantAt, isZone, wallTimeExists } from "../time/index.js";
import { clientAddress } from "./softphone.js";

/**
 * PHONE MENUS, RING GROUPS AND THE ON CALL WEEK
 *
 * The three things a company sets up so that its own number answers like an
 * office rather than like a mobile in somebody's pocket: "press 1 for
 * service, 2 for billing", a group of phones that ring together or one after
 * another, and whose phone is on when the office is shut.
 *
 * `telephony` already models where a call goes (a ring group, a menu, the on
 * call rota, voicemail, a forward) and why. Until now nothing built those
 * destinations: a tracking number could only forward. This file is what a
 * menu, a group and a rota ARE, checked when somebody saves them, because
 * that is when a person is there to read the refusal. At two in the morning
 * the only person present is a customer with no heat.
 *
 * Everything is pure. The names come in as a `Directory` the caller read from
 * the database, so a menu that points at a deleted ring group is refused here
 * by a test with a literal rather than discovered by a caller hearing silence.
 */

/* ------------------------------------------------------------ destinations */

/** Every key a caller can press on a phone's keypad, in the order printed on it. */
export const MENU_KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0", "*", "#"] as const;
export type MenuKey = (typeof MENU_KEYS)[number];

/** The company wide rota, as opposed to one branch's. */
export const COMPANY_ROTA = "company";

/**
 * The names behind the ids a destination holds.
 *
 * Read by the caller and handed in, for two reasons: a destination is checked
 * against what exists (a menu pointing at a ring group somebody deleted rings
 * nothing), and the sentence on the call screen names things the way the
 * owner typed them.
 */
export interface Directory {
  menus: ReadonlyMap<string, string>;
  ringGroups: ReadonlyMap<string, string>;
  /** People at the company, with the phone number on their account. */
  people: ReadonlyMap<string, { name: string; phone: string | null }>;
  /** Branches that can have a rota of their own. The company wide one is always there. */
  rotas: ReadonlyMap<string, string>;
  /** Waiting lines, by id, with their names. */
  queues: ReadonlyMap<string, string>;
  /**
   * Whether the phone assistant is switched on with somebody to act as. A
   * menu may only send callers to it while it is; switched off afterwards,
   * its calls go to voicemail with the reason written on the call.
   */
  assistant: boolean;
}

export const emptyDirectory = (): Directory => ({
  menus: new Map(), ringGroups: new Map(), people: new Map(), rotas: new Map(), queues: new Map(), assistant: false,
});

export type Check = { ok: true } | { ok: false; reason: string };

const E164 = /^\+[1-9]\d{7,14}$/;

/**
 * Whether one destination can be used, in a sentence when it cannot.
 *
 * `where` names the place in the menu the destination sits ("option 2
 * (Billing)"), because an owner with eight options needs to know which one
 * to fix.
 *
 * A waiting line and the phone assistant are checked like everything else:
 * a line somebody deleted, or an assistant that is switched off, would save a
 * menu whose option rings into nothing.
 */
export function destinationProblem(to: RoutingDestination, directory: Directory, where: string): string | null {
  if (!DESTINATION_KINDS.includes(to.kind)) {
    return `${capital(where)} sends calls to "${String(to.kind)}", which is not something a call can go to.`;
  }
  switch (to.kind) {
    case "queue":
      return directory.queues.has(to.id) ? null : `${capital(where)} sends calls to a waiting line that no longer exists.`;
    case "agent":
      return directory.assistant
        ? null
        : `${capital(where)} sends calls to the phone assistant, which is switched off. Turn it on under Settings, AI agents first, or choose somewhere else.`;
    case "forward":
      return E164.test(to.e164)
        ? null
        : `${capital(where)} rings "${to.e164}", which is not a number a phone can dial. Write it in full, like +15125550147.`;
    case "person": {
      const person = directory.people.get(to.userId);
      if (!person) return `${capital(where)} rings somebody who is no longer at the company. Choose someone else.`;
      if (!person.phone) {
        return `${capital(where)} rings ${person.name}, who has no phone number on their account, so it would ring nothing. Add their number first.`;
      }
      return null;
    }
    case "ring_group":
      return directory.ringGroups.has(to.id) ? null : `${capital(where)} rings a ring group that no longer exists.`;
    case "ivr":
      return directory.menus.has(to.menu) ? null : `${capital(where)} goes to a menu that no longer exists.`;
    case "on_call_rota":
      return to.id === COMPANY_ROTA || directory.rotas.has(to.id)
        ? null
        : `${capital(where)} rings the on call rota of a branch that no longer exists.`;
    case "voicemail":
      return null;
  }
}

/**
 * How a destination is said on the call screen, in the owner's own names.
 *
 * Passed to `telephony.route` as its describer, so "Where it went" reads
 * "Sent to the Service team ring group" and never prints an id.
 */
export function describeIn(directory: Directory): (to: RoutingDestination) => string {
  return (to) => {
    switch (to.kind) {
      case "person": return directory.people.get(to.userId)?.name ?? "somebody no longer at the company";
      case "ring_group": return `the ${directory.ringGroups.get(to.id) ?? "deleted"} ring group`;
      case "ivr": return `the ${directory.menus.get(to.menu) ?? "deleted"} menu`;
      case "on_call_rota":
        return to.id === COMPANY_ROTA
          ? "whoever is on call"
          : `whoever is on call for ${directory.rotas.get(to.id) ?? "a branch that no longer exists"}`;
      case "voicemail": return "voicemail";
      case "forward": return to.e164;
      case "queue": return `the ${directory.queues.get(to.id) ?? "deleted"} waiting line`;
      case "agent": return "the phone assistant";
      default: return "somewhere this system does not know";
    }
  };
}

const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/* ------------------------------------------------------------------ menus */

export interface MenuOption {
  key: string;
  /** What the option is for, in the owner's words. Read to the caller and whispered to whoever answers. */
  label: string;
  to: RoutingDestination;
  /**
   * Other words or phrases a caller may say for this option when the menu
   * listens for speech: "bill", "payment" for Billing. The label is always
   * listened for; these are on top of it.
   */
  words?: readonly string[] | undefined;
}

export interface PhoneMenu {
  id: string;
  name: string;
  /** Said first. The options are read after it, so it need not list them. */
  greeting: string;
  options: readonly MenuOption[];
  /** Where a caller who presses nothing, or only wrong keys, ends up. */
  noInputTo: RoutingDestination;
  /**
   * Where calls go outside business hours. Null means the menu answers at
   * every hour, which is right for a company whose menu already has an
   * emergency option.
   */
  afterHoursTo: RoutingDestination | null;
  /** How long the caller is given to press something. */
  timeoutSeconds: number;
  /**
   * Whether a caller may say an option as well as press its key. Off unless
   * the owner turns it on: the carrier turns what the caller says into text
   * and charges for it, and a menu with it off works exactly as before.
   */
  speech?: boolean | undefined;
}

/**
 * How many times the menu is read before giving up.
 *
 * Three, not one and not forever. A caller who did not catch the options the
 * first time gets them again; a caller on a rotary phone, or one who simply
 * will not press anything, is not read the menu until they hang up, which is
 * the experience that makes people hate phone menus. After the third time
 * they go where the owner said a caller who presses nothing should go.
 */
export const MENU_ATTEMPTS = 3;

export const MIN_TIMEOUT_SECONDS = 3;
export const MAX_TIMEOUT_SECONDS = 15;
export const MAX_OPTIONS = MENU_KEYS.length;
/** Words listened for per option, beyond its label. A list longer than this is a sign the option is two options. */
export const MAX_OPTION_WORDS = 8;
export const MAX_WORD_LENGTH = 40;
/**
 * How many times a caller who said something no option matches hears the
 * menu again before they go where a caller who presses nothing goes. Once:
 * a caller misheard twice is not going to be understood a third time, and
 * the menu keeps the key presses working all the while.
 */
export const SPEECH_RETRIES = 1;

/**
 * Whether a menu can be saved.
 *
 * Two loops are refused because both would trap a caller forever: a caller
 * who presses nothing being sent back to the same menu, and after hours
 * pointing at the same menu (which is not a loop, but makes business hours
 * mean nothing, and is almost always a mistake for "leave it empty").
 */
export function checkMenu(menu: PhoneMenu, directory: Directory): Check {
  const name = menu.name.trim();
  if (name === "" || name.length > 80) {
    return { ok: false, reason: "Give the menu a name of up to 80 characters, so it can be chosen from a list." };
  }
  const greeting = menu.greeting.trim();
  if (greeting === "") {
    return { ok: false, reason: "Write what a caller hears first, such as \"Thanks for calling Smith Heating and Air.\"" };
  }
  if (greeting.length > 600) {
    return { ok: false, reason: "The greeting is over 600 characters. A caller listening to a minute of greeting hangs up before the options." };
  }
  if (!Number.isInteger(menu.timeoutSeconds)
    || menu.timeoutSeconds < MIN_TIMEOUT_SECONDS || menu.timeoutSeconds > MAX_TIMEOUT_SECONDS) {
    return {
      ok: false,
      reason: `Give callers between ${MIN_TIMEOUT_SECONDS} and ${MAX_TIMEOUT_SECONDS} seconds to press a key.`,
    };
  }
  if (menu.options.length === 0) {
    return { ok: false, reason: "A menu needs at least one option. With none it is a greeting, and a number can just ring." };
  }
  if (menu.options.length > MAX_OPTIONS) {
    return { ok: false, reason: `A phone has ${MAX_OPTIONS} keys, so a menu can have at most ${MAX_OPTIONS} options.` };
  }

  const seen = new Set<string>();
  for (const option of menu.options) {
    if (!(MENU_KEYS as readonly string[]).includes(option.key)) {
      return { ok: false, reason: `"${option.key}" is not a key on a phone. Use 0 to 9, star or pound.` };
    }
    if (seen.has(option.key)) {
      return { ok: false, reason: `Two options use ${spokenKey(option.key)}. A caller pressing it could only reach one of them.` };
    }
    seen.add(option.key);
    const label = option.label.trim();
    if (label === "" || label.length > 60) {
      return {
        ok: false,
        reason: `Option ${spokenKey(option.key)} needs a short name, such as "Service" or "Billing". It is read to the caller.`,
      };
    }
    const bad = destinationProblem(option.to, directory, `option ${spokenKey(option.key)} (${label})`);
    if (bad) return { ok: false, reason: bad };
    const words = option.words ?? [];
    if (words.length > MAX_OPTION_WORDS) {
      return { ok: false, reason: `Option ${spokenKey(option.key)} listens for ${words.length} words. Keep it to ${MAX_OPTION_WORDS} or fewer.` };
    }
    for (const word of words) {
      const trimmed = word.trim();
      if (trimmed === "" || trimmed.length > MAX_WORD_LENGTH || !/^[\p{L}\p{N}' -]+$/u.test(trimmed)) {
        return {
          ok: false,
          reason: `"${trimmed}" on option ${spokenKey(option.key)} is not a word a caller can say. Use letters and spaces, up to ${MAX_WORD_LENGTH} characters.`,
        };
      }
      if (keyOfWords(normalSpeech(trimmed))) {
        return {
          ok: false,
          reason: `"${trimmed}" on option ${spokenKey(option.key)} is the name of a key. Saying a number already picks the option on that key.`,
        };
      }
    }
  }

  /** With speech on, a phrase listened for by two options could only ever reach one of them. */
  if (menu.speech) {
    const owner = new Map<string, MenuOption>();
    for (const option of menu.options) {
      for (const phrase of new Set(phrasesOf(option))) {
        const other = owner.get(phrase);
        if (other && other !== option) {
          return {
            ok: false,
            reason: `Options ${spokenKey(other.key)} and ${spokenKey(option.key)} both listen for "${phrase}". A caller saying it could only reach one of them.`,
          };
        }
        owner.set(phrase, option);
      }
    }
  }

  const noInput = destinationProblem(menu.noInputTo, directory, "a caller who presses nothing");
  if (noInput) return { ok: false, reason: noInput };
  if (menu.noInputTo.kind === "ivr" && menu.noInputTo.menu === menu.id) {
    return {
      ok: false,
      reason: "A caller who presses nothing would be sent back to this same menu, forever. Send them to voicemail or a person instead.",
    };
  }

  if (menu.afterHoursTo) {
    const afterHours = destinationProblem(menu.afterHoursTo, directory, "after hours");
    if (afterHours) return { ok: false, reason: afterHours };
    if (menu.afterHoursTo.kind === "ivr" && menu.afterHoursTo.menu === menu.id) {
      return {
        ok: false,
        reason: "After hours goes to this same menu, so business hours would change nothing. Leave after hours empty instead.",
      };
    }
  }

  return { ok: true };
}

/** A key as a caller hears it. "Press star", not "press asterisk". */
export function spokenKey(key: string): string {
  if (key === "*") return "star";
  if (key === "#") return "pound";
  return key;
}

/**
 * What the caller hears: the greeting, then every option.
 *
 * The options are always read, in keypad order, from their labels. An owner
 * who types "press 1 for service" into the greeting and then changes option
 * 1 to billing has a menu that lies; reading the options from the options
 * makes that impossible.
 */
export function menuPrompt(menu: Pick<PhoneMenu, "greeting" | "options" | "speech">): string {
  const ordered = [...menu.options].sort((a, b) =>
    (MENU_KEYS as readonly string[]).indexOf(a.key) - (MENU_KEYS as readonly string[]).indexOf(b.key));
  const options = ordered.map((option) => menu.speech
    ? `For ${option.label.trim()}, press ${spokenKey(option.key)} or say ${option.label.trim()}.`
    : `For ${option.label.trim()}, press ${spokenKey(option.key)}.`);
  return [menu.greeting.trim(), ...options].join(" ");
}

export type MenuChoice =
  | { kind: "option"; option: MenuOption; why: string }
  /**
   * Read the menu again, after `say` when there is something to say first.
   * `misses` is how many spoken answers have not matched so far.
   */
  | { kind: "again"; attempt: number; say: string | null; why: string; misses?: number | undefined }
  | { kind: "gave_up"; to: RoutingDestination; why: string };

/* ----------------------------------------------------------- spoken answers */

/** Lower case words only: what the carrier wrote, without its punctuation. */
export function normalSpeech(text: string): string {
  return text.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ").trim().replace(/\s+/g, " ");
}

/** "Bills" and "bill" are the same answer; "glass" keeps its s. */
const stem = (word: string): string => word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
const stemmed = (text: string): string => text.split(" ").filter(Boolean).map(stem).join(" ");

/** A key, said: "one", "press two", "option 3", "star". */
const KEY_WORDS: Readonly<Record<string, string>> = {
  zero: "0", oh: "0", one: "1", two: "2", three: "3", four: "4", five: "5", six: "6", seven: "7", eight: "8",
  nine: "9", star: "*", pound: "#", hash: "#",
  "0": "0", "1": "1", "2": "2", "3": "3", "4": "4", "5": "5", "6": "6", "7": "7", "8": "8", "9": "9",
};
/** Said around a number without changing it. */
const KEY_FILLER = new Set(["press", "pressing", "option", "number", "please", "um", "uh", "the", "key", "button", "i", "want", "like", "d"]);

/**
 * The key a whole answer names, or null. Only the whole answer: "I have two
 * units" is not a press of 2, while "two" or "press two" is.
 */
function keyOfWords(normal: string): string | null {
  const words = normal.split(" ").filter((w) => w !== "" && !KEY_FILLER.has(w));
  return words.length === 1 ? KEY_WORDS[words[0]!] ?? null : null;
}

/** Common words that say nothing about which option: never matched alone. */
const STOPWORDS = new Set([
  "the", "and", "for", "with", "about", "your", "our", "you", "are", "new", "other", "all", "any", "questions", "question",
  "help", "need", "please", "line", "department", "team", "office",
]);

/** Everything an option listens for, normalised: its label, then its own words. */
function phrasesOf(option: MenuOption): string[] {
  return [option.label, ...(option.words ?? [])].map((p) => stemmed(normalSpeech(p))).filter((p) => p !== "");
}

/** What a spoken answer comes to. */
export type SpokenMatch =
  | { kind: "option"; option: MenuOption }
  /** Words of more than one option, as strongly as each other. */
  | { kind: "unclear"; options: MenuOption[] }
  | { kind: "none" };

/**
 * Which option a caller's words name.
 *
 * A whole answer that is a key ("two", "press star") is that key. Otherwise
 * each option scores by the longest of its phrases (its label, or one of its
 * words) said in full, word for word; failing any, by a single significant
 * word of its label ("billing" for "Billing questions"), which counts for
 * less. The best score wins when one option has it alone. Two options as
 * likely as each other is not a guess this makes: it asks again.
 */
export function matchSpoken(menu: Pick<PhoneMenu, "options">, said: string): SpokenMatch {
  const normal = normalSpeech(said);
  if (normal === "") return { kind: "none" };
  const key = keyOfWords(normal);
  if (key) {
    const option = menu.options.find((o) => o.key === key);
    return option ? { kind: "option", option } : { kind: "none" };
  }
  const heard = ` ${stemmed(normal)} `;
  const scored = menu.options.map((option) => {
    let score = 0;
    for (const phrase of phrasesOf(option)) {
      if (heard.includes(` ${phrase} `)) score = Math.max(score, 10 * phrase.split(" ").length);
    }
    if (score === 0) {
      const significant = stemmed(normalSpeech(option.label)).split(" ")
        .filter((w) => w.length >= 3 && !STOPWORDS.has(w));
      if (significant.some((w) => heard.includes(` ${w} `))) score = 1;
    }
    return { option, score };
  }).filter((s) => s.score > 0);
  if (scored.length === 0) return { kind: "none" };
  const best = Math.max(...scored.map((s) => s.score));
  const top = scored.filter((s) => s.score === best);
  return top.length === 1 ? { kind: "option", option: top[0]!.option } : { kind: "unclear", options: top.map((s) => s.option) };
}

/** What the carrier is told to listen for: every option's label and words, as phrases. */
export function speechHints(menu: Pick<PhoneMenu, "options">): string {
  const phrases = menu.options.flatMap((o) => [o.label, ...(o.words ?? [])].map((p) => p.trim()).filter(Boolean));
  return [...new Set(phrases)].join(", ").slice(0, 2000);
}

/** A caller's words as they are written down: short, and in quotes on the call. */
export const heardAs = (said: string): string => {
  const text = said.trim().replace(/\s+/g, " ");
  return text.length > 80 ? `${text.slice(0, 79)}...` : text;
};

/**
 * What a spoken answer means.
 *
 * Matched: that option, as a key press would. Not matched, or as likely one
 * option as another: the menu once more, saying so, and after `SPEECH_RETRIES`
 * misses (or the menu's last reading) where a caller who presses nothing
 * goes. Nothing a caller says is dropped without an answer, and keys work at
 * every step.
 */
export function chooseSpoken(menu: PhoneMenu, said: string, attempt: number, misses: number): MenuChoice {
  const heard = heardAs(said);
  const match = matchSpoken(menu, said);
  if (match.kind === "option") {
    return {
      kind: "option", option: match.option,
      why: `Said "${heard}" for ${match.option.label.trim()} in the ${menu.name.trim()} menu.`,
    };
  }
  const missed = match.kind === "unclear"
    ? `Said "${heard}", which could be ${match.options.map((o) => o.label.trim()).join(" or ")}.`
    : `Said "${heard}", which is not one of the options.`;
  if (misses < SPEECH_RETRIES && attempt < MENU_ATTEMPTS) {
    return {
      kind: "again", attempt: attempt + 1, misses: misses + 1, why: missed,
      say: match.kind === "unclear"
        ? "Sorry, I did not catch which one you want. Here are the options again."
        : "Sorry, I did not understand that. Here are the options again.",
    };
  }
  return {
    kind: "gave_up", to: menu.noInputTo,
    why: `${missed.replace(/\.$/, "")}, after hearing the ${menu.name.trim()} menu ${attempt} times.`,
  };
}

/**
 * What a keypress means.
 *
 * `attempt` is how many times the menu has been read so far, starting at 1.
 * A wrong key and no key are treated alike once the attempts run out,
 * because both mean the caller cannot get anywhere by pressing, and the
 * owner's answer for that caller is the same.
 */
export function chooseOption(menu: PhoneMenu, digits: string | null | undefined, attempt: number): MenuChoice {
  const pressed = (digits ?? "").trim();
  if (pressed !== "") {
    const option = menu.options.find((candidate) => candidate.key === pressed);
    if (option) {
      return {
        kind: "option", option,
        why: `Pressed ${spokenKey(option.key)} for ${option.label.trim()} in the ${menu.name.trim()} menu.`,
      };
    }
  }

  const wrong = pressed !== "";
  if (attempt < MENU_ATTEMPTS) {
    return {
      kind: "again",
      attempt: attempt + 1,
      say: wrong ? `Sorry, ${spokenKey(pressed)} is not one of the options.` : null,
      why: wrong ? `Pressed ${spokenKey(pressed)}, which is not an option.` : "Pressed nothing.",
    };
  }
  return {
    kind: "gave_up",
    to: menu.noInputTo,
    why: wrong
      ? `Pressed ${spokenKey(pressed)}, which is not an option, after hearing the ${menu.name.trim()} menu ${attempt} times.`
      : `Pressed nothing after hearing the ${menu.name.trim()} menu ${attempt} times.`,
  };
}

/**
 * The routing table a number answered by this menu implies.
 *
 * In business hours the menu; outside them, where the owner said. Built as
 * a table for `telephony.route` rather than an if statement, so the call is
 * routed by the function that writes the sentence saying why.
 */
export function menuHoursTable(menu: Pick<PhoneMenu, "id" | "afterHoursTo">): RoutingTable {
  const toMenu: RoutingDestination = { kind: "ivr", menu: menu.id };
  if (!menu.afterHoursTo) {
    return { rules: [{ id: "always", label: "The menu", all: [], to: toMenu }], fallback: toMenu };
  }
  return {
    rules: [{ id: "open", label: "Open hours", all: [{ kind: "during_business_hours" }], to: toMenu }],
    fallback: menu.afterHoursTo,
  };
}

/* ------------------------------------------------------------ ring groups */

export const RING_STRATEGIES = ["all_at_once", "in_order"] as const;
export type RingStrategy = (typeof RING_STRATEGIES)[number];

export const RING_STRATEGY: Record<RingStrategy, { label: string; meaning: string }> = {
  all_at_once: {
    label: "All at once",
    meaning: "Every phone rings together and the first person to pick up gets the call.",
  },
  in_order: {
    label: "One after another",
    meaning: "The first phone rings, then the next if nobody picks up, down the list.",
  },
};

/**
 * Ten, because the carrier rings at most ten numbers in one dial, and a
 * group larger than that is a call centre rather than an office.
 */
export const MAX_RING_MEMBERS = 10;
export const MIN_RING_SECONDS = 5;
export const MAX_RING_SECONDS = 60;

/** A person at the company, or a number outside it (the answering service, a partner's mobile). */
export interface RingMember {
  userId?: string | null | undefined;
  e164?: string | null | undefined;
  label: string;
}

export interface RingGroup {
  id: string;
  name: string;
  strategy: RingStrategy;
  /** How long each phone rings: the whole group at once, or each person in turn. */
  ringSeconds: number;
  members: readonly RingMember[];
  /** Where the caller goes when nobody in the group picked up. */
  noAnswerTo: RoutingDestination;
}

export function checkRingGroup(group: RingGroup, directory: Directory): Check {
  const name = group.name.trim();
  if (name === "" || name.length > 80) {
    return { ok: false, reason: "Give the ring group a name of up to 80 characters, such as \"Service team\"." };
  }
  if (!RING_STRATEGIES.includes(group.strategy)) {
    return { ok: false, reason: "Choose whether the phones ring all at once or one after another." };
  }
  if (!Number.isInteger(group.ringSeconds)
    || group.ringSeconds < MIN_RING_SECONDS || group.ringSeconds > MAX_RING_SECONDS) {
    return { ok: false, reason: `Ring each phone for between ${MIN_RING_SECONDS} and ${MAX_RING_SECONDS} seconds.` };
  }
  if (group.members.length === 0) {
    return { ok: false, reason: "A ring group needs at least one person or number in it." };
  }
  if (group.members.length > MAX_RING_MEMBERS) {
    return { ok: false, reason: `A ring group can ring at most ${MAX_RING_MEMBERS} phones.` };
  }

  const seen = new Set<string>();
  for (const member of group.members) {
    const hasUser = Boolean(member.userId);
    const hasNumber = Boolean(member.e164);
    if (hasUser === hasNumber) {
      return { ok: false, reason: "Each member of a ring group is either a person at the company or a phone number, not both." };
    }
    const key = hasUser ? `user:${member.userId}` : `number:${member.e164}`;
    if (seen.has(key)) {
      return { ok: false, reason: `${member.label.trim() || "Somebody"} is in the group twice. They would only ring once.` };
    }
    seen.add(key);
    const bad = hasUser
      ? destinationProblem({ kind: "person", userId: member.userId! }, directory, "this ring group")
      : destinationProblem({ kind: "forward", e164: member.e164! }, directory, "this ring group");
    if (bad) return { ok: false, reason: bad };
  }

  const noAnswer = destinationProblem(group.noAnswerTo, directory, "a call nobody in the group picks up");
  if (noAnswer) return { ok: false, reason: noAnswer };
  if (group.noAnswerTo.kind === "ring_group" && group.noAnswerTo.id === group.id) {
    return {
      ok: false,
      reason: "A call nobody picks up would ring this same group again, forever. Send it to voicemail or somebody else instead.",
    };
  }
  return { ok: true };
}

export interface RingStep {
  /** Numbers to dial, and browsers as `client:` addresses, rung together. */
  numbers: string[];
  labels: string[];
}

export interface RingPlan {
  /** One step for all at once, one per phone for one after another. Empty when nobody can be rung. */
  steps: RingStep[];
  /** Members who could not be rung right now, and why. Shown on the call screen. */
  skipped: { label: string; why: string }[];
}

/**
 * Who to ring, in what order, with the group as it stands at the moment of
 * the call.
 *
 * Resolved at call time rather than when the group was saved, because
 * people change phones and leave. A member who has since left or lost their
 * number is skipped with the reason written down, rather than failing the
 * whole group: the rest of the office is still there.
 *
 * A person with the office app open and "Take calls here" on (`online`) is
 * rung in the browser INSTEAD of on their phone. Both at once would ring a
 * person at their desk twice and leave the mobile in their pocket buzzing for
 * a call already answered.
 */
export function ringPlan(group: RingGroup, directory: Directory, online: ReadonlySet<string> = new Set()): RingPlan {
  const reachable: { number: string; label: string }[] = [];
  const skipped: RingPlan["skipped"] = [];

  for (const member of group.members) {
    if (member.userId) {
      const person = directory.people.get(member.userId);
      if (!person) {
        skipped.push({ label: member.label, why: "is no longer at the company" });
        continue;
      }
      if (online.has(member.userId)) {
        reachable.push({ number: clientAddress(member.userId), label: person.name });
        continue;
      }
      if (!person.phone || !E164.test(person.phone)) {
        skipped.push({ label: person.name, why: "has no phone number on their account" });
        continue;
      }
      reachable.push({ number: person.phone, label: person.name });
    } else if (member.e164 && E164.test(member.e164)) {
      reachable.push({ number: member.e164, label: member.label });
    } else {
      skipped.push({ label: member.label, why: "has no number that can be dialled" });
    }
  }

  const unique = reachable.filter((entry, index) =>
    reachable.findIndex((other) => other.number === entry.number) === index);

  if (unique.length === 0) return { steps: [], skipped };
  if (group.strategy === "all_at_once") {
    return { steps: [{ numbers: unique.map((u) => u.number), labels: unique.map((u) => u.label) }], skipped };
  }
  return { steps: unique.map((u) => ({ numbers: [u.number], labels: [u.label] })), skipped };
}

/* --------------------------------------------------------- the on call week */

export interface WeeklyRotaInput {
  /** Who takes each week, in turn. The list repeats when the weeks outrun it. */
  technicianIds: readonly string[];
  /** The first handover day, `YYYY-MM-DD` in the company's zone. */
  firstDay: string;
  /** Minutes past local midnight the phone changes hands, every week. */
  handoverMinute: number;
  weeks: number;
  timeZone: string;
}

export interface RotaWeek {
  technicianId: string;
  startsAt: Date;
  endsAt: Date;
}

export type WeeklyRota = { ok: true; weeks: RotaWeek[] } | { ok: false; reason: string };

export const MAX_ROTA_WEEKS = 52;

const addDays = (date: string, days: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 864e5).toISOString().slice(0, 10);

const clockOf = (minutes: number): string =>
  `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;

/**
 * Who has the phone each week, from a list of people taken in turn.
 *
 * Every handover is the same WALL CLOCK time in the company's zone, so a
 * rota built in October still hands over at eight in the morning in
 * November, after the clocks go back. A rota built as seven times
 * twenty four hours would hand over at seven, and the person going off call
 * would have the phone for an hour nobody expected them to.
 *
 * The weeks touch, end to start, so there is no instant nobody has the
 * phone and no instant two people do: the same half open rule the rota
 * itself refuses overlaps by.
 */
export function weeklyRota(input: WeeklyRotaInput): WeeklyRota {
  const people = input.technicianIds.filter((id) => id.trim() !== "");
  if (people.length === 0) return { ok: false, reason: "Choose who takes the phone, in the order they take it." };
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.firstDay) || Number.isNaN(Date.parse(`${input.firstDay}T00:00:00Z`))) {
    return { ok: false, reason: "Choose the day the first week starts." };
  }
  if (!Number.isInteger(input.weeks) || input.weeks < 1 || input.weeks > MAX_ROTA_WEEKS) {
    return { ok: false, reason: `Fill between 1 and ${MAX_ROTA_WEEKS} weeks at a time.` };
  }
  if (!Number.isInteger(input.handoverMinute) || input.handoverMinute < 0 || input.handoverMinute >= 24 * 60) {
    return { ok: false, reason: "Choose the time of day the phone changes hands." };
  }
  if (!isZone(input.timeZone)) {
    return { ok: false, reason: `"${input.timeZone}" is not a time zone this system knows.` };
  }

  const weeks: RotaWeek[] = [];
  for (let week = 0; week < input.weeks; week += 1) {
    const from = addDays(input.firstDay, week * 7);
    const until = addDays(from, 7);
    for (const day of week === 0 ? [from, until] : [until]) {
      if (!wallTimeExists(day, input.handoverMinute, input.timeZone)) {
        return {
          ok: false,
          reason: `${clockOf(input.handoverMinute)} on ${day} never happens in ${input.timeZone}, because the clocks go forward that night. Hand over at another time.`,
        };
      }
    }
    weeks.push({
      technicianId: people[week % people.length]!,
      startsAt: instantAt(from, input.handoverMinute, input.timeZone),
      endsAt: instantAt(until, input.handoverMinute, input.timeZone),
    });
  }
  return { ok: true, weeks };
}

