import { AGENTS, type AgentKind } from "./catalogue.js";

/**
 * HOW A COMPANY HAS SET UP EACH AGENT
 *
 * One row per agent per company, read through `normaliseSettings` so a value
 * written by an older version, typed into the API by hand, or never written at
 * all comes back as something the agent can act on. Every field has a default
 * and every default is the cautious one: off, proposing rather than acting,
 * and small limits.
 */

export type AgentMode = "propose" | "auto";

export interface AgentLimits {
  /** Model calls this agent may make in one calendar day, in the company's zone. */
  runsPerDay: number;
  /** The most one answer may cost, in tokens. The spend ceiling is built on this number. */
  maxOutputTokens: number;
  /** Chat only: turns the agent takes in one conversation before a person takes over. */
  messagesPerChat: number;
}

export interface FaqEntry { question: string; answer: string }

export interface ChatConfig {
  /** The first thing the widget says, after the disclosure. */
  greeting: string;
  faq: FaqEntry[];
  /** Price book items whose price the agent may say out loud. Nothing else is quoted. */
  publicPriceItemIds: string[];
  /** Where it answers. The widget and texts are separate decisions. */
  web: boolean;
  text: boolean;
}

export interface IntakeConfig {
  texts: boolean;
  emails: boolean;
  calls: boolean;
  forms: boolean;
}

export interface CollectionsStep {
  /** Days past the due date this step starts. */
  afterDays: number;
  /** How it should sound at this step, in the company's own words. */
  tone: string;
  channel: "email" | "text";
}

export interface CollectionsConfig { steps: CollectionsStep[] }

/**
 * The phone assistant's own settings. What it says after the disclosure, its
 * questions and answers and the prices it may say are the `chat` ones on its
 * own row, because they are the same kind of thing said a different way.
 */
export interface VoiceConfig {
  /**
   * The ring group a caller is put through to when they ask for a person or
   * the assistant is unsure. Null puts them through to voicemail.
   */
  transferRingGroupId: string | null;
}

export interface AgentSettings {
  enabled: boolean;
  mode: AgentMode;
  /** How the agent should sound, in the company's own words. */
  tone: string;
  /**
   * The person the agent runs as when nobody started it: an inbound text at
   * nine at night, a website visitor, the daily collections pass. Null means it
   * does not run on its own at all. A run a person starts runs as them.
   */
  runAsUserId: string | null;
  /** Which connected model provider and model. Null takes the only one connected. */
  provider: string | null;
  model: string | null;
  limits: AgentLimits;
  chat: ChatConfig;
  intake: IntakeConfig;
  collections: CollectionsConfig;
  voice: VoiceConfig;
}

export const DEFAULT_TONE = "Friendly, plain and brief. No jargon.";

/** The agents that only ever run when a person asks, as that person. */
export const ASKED_ONLY: readonly AgentKind[] = ["estimate", "dispatch", "field"];

export const DEFAULT_STEPS: readonly CollectionsStep[] = [
  { afterDays: 3, tone: "A friendly nudge. They have probably just forgotten.", channel: "email" },
  { afterDays: 14, tone: "Polite and clear that it is now overdue.", channel: "email" },
  { afterDays: 30, tone: "Firm. Say the office will call if it is not settled.", channel: "email" },
];

export function defaultSettings(kind: AgentKind): AgentSettings {
  return {
    enabled: false,
    mode: "propose",
    tone: DEFAULT_TONE,
    runAsUserId: null,
    provider: null,
    model: null,
    limits: {
      /**
       * A call takes a run for every time the caller speaks, so the phone
       * assistant's day is counted in turns rather than in calls.
       */
      runsPerDay: kind === "chat" || kind === "voice" ? 500 : kind === "field" ? 300 : 100,
      /** A spoken answer is a sentence or two; a long one is a caller waiting in silence for it. */
      maxOutputTokens: kind === "dispatch" || kind === "estimate" ? 4000 : kind === "voice" ? 600 : 1500,
      messagesPerChat: 20,
    },
    chat: {
      greeting: kind === "voice" ? "How can I help you today?" : "Hi! How can we help?",
      faq: [], publicPriceItemIds: [], web: true, text: false,
    },
    intake: { texts: true, emails: true, calls: true, forms: true },
    collections: { steps: DEFAULT_STEPS.map((step) => ({ ...step })) },
    voice: { transferRingGroupId: null },
  };
}

/** The bounds a setting is held to. Wide enough for any real company, narrow enough to bound a bill. */
export const LIMIT_BOUNDS = {
  runsPerDay: { min: 1, max: 5000 },
  maxOutputTokens: { min: 200, max: 16000 },
  messagesPerChat: { min: 2, max: 100 },
  tone: 300,
  greeting: 300,
  faqEntries: 50,
  faqQuestion: 300,
  faqAnswer: 1500,
  publicPrices: 200,
  steps: 6,
  stepTone: 200,
} as const;

export type SettingsVerdict = { ok: true; settings: AgentSettings } | { ok: false; reason: string };

const obj = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

const bool = (value: unknown, fallback: boolean): boolean => (typeof value === "boolean" ? value : fallback);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Read stored settings, filling every gap with the default.
 *
 * Lenient on purpose: this is the READ path, and an agent that refused to run
 * because a stored value was one character over a limit set after it was
 * saved would be an agent switched off by an upgrade. The write path is
 * `checkSettings`, which refuses.
 */
export function readSettings(kind: AgentKind, raw: unknown): AgentSettings {
  const base = defaultSettings(kind);
  const r = obj(raw);
  const limits = obj(r["limits"]);
  const chat = obj(r["chat"]);
  const intake = obj(r["intake"]);
  const collections = obj(r["collections"]);
  const voice = obj(r["voice"]);
  const clamp = (value: unknown, bounds: { min: number; max: number }, fallback: number) =>
    typeof value === "number" && Number.isInteger(value) ? Math.min(bounds.max, Math.max(bounds.min, value)) : fallback;

  const steps = Array.isArray(collections["steps"])
    ? (collections["steps"] as unknown[]).map(obj).flatMap((step) => {
        const afterDays = step["afterDays"];
        if (typeof afterDays !== "number" || !Number.isInteger(afterDays) || afterDays < 0) return [];
        return [{
          afterDays,
          tone: typeof step["tone"] === "string" ? step["tone"].slice(0, LIMIT_BOUNDS.stepTone) : "",
          channel: step["channel"] === "text" ? "text" as const : "email" as const,
        }];
      }).sort((a, b) => a.afterDays - b.afterDays)
    : base.collections.steps;

  return {
    enabled: bool(r["enabled"], base.enabled),
    /**
     * Auto is only ever read back on an agent that allows it. A row written
     * with auto on the dispatch copilot, by hand or by a version that got this
     * wrong, is read as propose rather than trusted.
     */
    mode: r["mode"] === "auto" && AGENTS[kind].autoAllowed ? "auto" : "propose",
    tone: typeof r["tone"] === "string" && r["tone"].trim() !== "" ? r["tone"].slice(0, LIMIT_BOUNDS.tone) : base.tone,
    runAsUserId: typeof r["runAsUserId"] === "string" && UUID.test(r["runAsUserId"]) ? r["runAsUserId"] : null,
    provider: typeof r["provider"] === "string" && r["provider"] !== "" ? r["provider"] : null,
    model: typeof r["model"] === "string" && r["model"] !== "" ? r["model"] : null,
    limits: {
      runsPerDay: clamp(limits["runsPerDay"], LIMIT_BOUNDS.runsPerDay, base.limits.runsPerDay),
      maxOutputTokens: clamp(limits["maxOutputTokens"], LIMIT_BOUNDS.maxOutputTokens, base.limits.maxOutputTokens),
      messagesPerChat: clamp(limits["messagesPerChat"], LIMIT_BOUNDS.messagesPerChat, base.limits.messagesPerChat),
    },
    chat: {
      greeting: typeof chat["greeting"] === "string" && chat["greeting"].trim() !== ""
        ? chat["greeting"].slice(0, LIMIT_BOUNDS.greeting) : base.chat.greeting,
      faq: Array.isArray(chat["faq"])
        ? (chat["faq"] as unknown[]).map(obj)
            .filter((entry) => typeof entry["question"] === "string" && typeof entry["answer"] === "string")
            .map((entry) => ({ question: String(entry["question"]), answer: String(entry["answer"]) }))
            .slice(0, LIMIT_BOUNDS.faqEntries)
        : [],
      publicPriceItemIds: Array.isArray(chat["publicPriceItemIds"])
        ? (chat["publicPriceItemIds"] as unknown[]).filter((v): v is string => typeof v === "string" && UUID.test(v))
        : [],
      web: bool(chat["web"], base.chat.web),
      text: bool(chat["text"], base.chat.text),
    },
    intake: {
      texts: bool(intake["texts"], base.intake.texts),
      emails: bool(intake["emails"], base.intake.emails),
      calls: bool(intake["calls"], base.intake.calls),
      forms: bool(intake["forms"], base.intake.forms),
    },
    collections: { steps: steps.length > 0 ? steps : base.collections.steps },
    voice: {
      transferRingGroupId: typeof voice["transferRingGroupId"] === "string" && UUID.test(voice["transferRingGroupId"])
        ? voice["transferRingGroupId"] : null,
    },
  };
}

/**
 * Check settings an owner is saving, and say what is wrong in words.
 *
 * Strict where `readSettings` is lenient: a value out of range is refused
 * rather than clamped, because clamping a limit somebody typed means the
 * screen says one number and the agent obeys another.
 */
export function checkSettings(kind: AgentKind, input: AgentSettings): SettingsVerdict {
  const def = AGENTS[kind];
  if (input.mode === "auto" && !def.autoAllowed) {
    return {
      ok: false,
      reason: `The ${def.label.toLowerCase()} always waits for a person. It cannot be set to act on its own.`,
    };
  }
  if (input.enabled && input.runAsUserId === null && !ASKED_ONLY.includes(kind)) {
    /**
     * Estimates, the copilot and the field assistant only ever run when
     * somebody asks, and then they run as that somebody. The other three run
     * on their own, so they need a person to run as before they can be
     * turned on.
     */
    return { ok: false, reason: "Choose who this agent acts as before turning it on. It never has more access than that person." };
  }
  if (input.tone.length > LIMIT_BOUNDS.tone) return { ok: false, reason: `Keep the tone under ${LIMIT_BOUNDS.tone} characters.` };
  for (const key of ["runsPerDay", "maxOutputTokens", "messagesPerChat"] as const) {
    const value = input.limits[key];
    const bounds = LIMIT_BOUNDS[key];
    if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
      const label = { runsPerDay: "Runs a day", maxOutputTokens: "Longest answer", messagesPerChat: "Turns in one chat" }[key];
      return { ok: false, reason: `${label} has to be a whole number from ${bounds.min} to ${bounds.max}.` };
    }
  }
  if (input.chat.greeting.length > LIMIT_BOUNDS.greeting) return { ok: false, reason: `Keep the greeting under ${LIMIT_BOUNDS.greeting} characters.` };
  if (input.chat.faq.length > LIMIT_BOUNDS.faqEntries) return { ok: false, reason: `At most ${LIMIT_BOUNDS.faqEntries} questions and answers.` };
  for (const entry of input.chat.faq) {
    if (entry.question.trim() === "" || entry.answer.trim() === "") return { ok: false, reason: "Every question needs an answer, and every answer a question." };
    if (entry.question.length > LIMIT_BOUNDS.faqQuestion || entry.answer.length > LIMIT_BOUNDS.faqAnswer) {
      return { ok: false, reason: `Keep questions under ${LIMIT_BOUNDS.faqQuestion} characters and answers under ${LIMIT_BOUNDS.faqAnswer}.` };
    }
  }
  if (input.chat.publicPriceItemIds.length > LIMIT_BOUNDS.publicPrices) {
    return { ok: false, reason: `At most ${LIMIT_BOUNDS.publicPrices} published prices.` };
  }
  if (input.collections.steps.length === 0 || input.collections.steps.length > LIMIT_BOUNDS.steps) {
    return { ok: false, reason: `Collections needs from one to ${LIMIT_BOUNDS.steps} steps.` };
  }
  const days = input.collections.steps.map((step) => step.afterDays);
  if (days.some((d) => !Number.isInteger(d) || d < 0 || d > 365)) {
    return { ok: false, reason: "Each step starts a whole number of days after the due date, up to a year." };
  }
  if (new Set(days).size !== days.length) return { ok: false, reason: "Two steps start on the same day. Give each its own." };
  if (input.collections.steps.some((step) => step.tone.length > LIMIT_BOUNDS.stepTone)) {
    return { ok: false, reason: `Keep each step's tone under ${LIMIT_BOUNDS.stepTone} characters.` };
  }
  if (input.voice.transferRingGroupId !== null && !UUID.test(input.voice.transferRingGroupId)) {
    return { ok: false, reason: "Choose a ring group for the assistant to put callers through to, or voicemail." };
  }
  return {
    ok: true,
    settings: {
      ...input,
      collections: { steps: [...input.collections.steps].sort((a, b) => a.afterDays - b.afterDays) },
    },
  };
}

/**
 * Whether this agent may apply an action without a person.
 *
 * All three, every time: the company turned it on, the company chose auto,
 * and the agent is one a company may let act alone. An action that moves
 * nothing is not asked about, because there is nothing for a person to stop.
 */
export function actsAlone(kind: AgentKind, settings: AgentSettings): boolean {
  return settings.enabled && settings.mode === "auto" && AGENTS[kind].autoAllowed;
}
