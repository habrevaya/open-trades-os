import {
  STEP_PERMISSIONS, checkBranches, checkSettingsProblem, explainBranch, flattenPlan, isCheck, type PlanNode,
} from "./index.js";

/**
 * RECOMMENDED AUTOMATIONS
 *
 * Two automations nearly every trades company wants and, until these, had to
 * build for themselves on a canvas: chase the estimate nobody answered, and
 * ask for a review once the job is paid. Both are the most valuable things a
 * small office forgets to do, and both were possible and unbuilt in almost
 * every company that tried the product.
 *
 * A TEMPLATE IS A STARTING DEFINITION AND NOTHING ELSE. Installing one writes
 * an ordinary workflow, published through the same check every hand built one
 * goes through, with the same permission rule and the same versions, and the
 * company edits it on the same canvas. There is no hidden logic: what runs is
 * what the canvas shows, and a company that wants a different wording, an
 * extra wait or no email at all changes the workflow, not the template.
 *
 * Here rather than in the service because the screen draws the parameters and
 * the server builds the definition, and both have to agree on what a template
 * is. The same argument as `flattenPlan`.
 */

export interface TemplateParameter {
  key: string;
  label: string;
  /** One sentence beside the box, in a trades owner's words. */
  help: string;
  kind: "number" | "platform" | "choice";
  /** For a number: the default, and the inclusive bounds. */
  default?: number;
  min?: number;
  max?: number;
  /** For a choice: what can be picked, and which is picked unless somebody picks another. */
  options?: { value: string; label: string }[];
  defaultChoice?: string;
}

/**
 * HOW A REVIEW ASK REACHES THE CUSTOMER
 *
 * By text, by email, or by text first and then email: the email only when the
 * text could not be sent (no number, or a number that has not agreed to texts),
 * never both. Asking the same person twice about one job is the thing this
 * module's one request per job exists to prevent, and a second message because
 * the first one worked would be that.
 */
export type ReviewAskChannel = "sms" | "email" | "sms_then_email";

export const REVIEW_ASK_CHANNELS: readonly { value: ReviewAskChannel; label: string }[] = [
  { value: "sms", label: "By text" },
  { value: "email", label: "By email" },
  { value: "sms_then_email", label: "By text, and by email if the text cannot be sent" },
];

export const DEFAULT_REVIEW_ASK_CHANNEL: ReviewAskChannel = "sms";

export const isReviewAskChannel = (value: unknown): value is ReviewAskChannel =>
  REVIEW_ASK_CHANNELS.some((c) => c.value === value);

/**
 * What the ask says, in each channel. The company's to change on the canvas;
 * the same words are what the worker sends for a request somebody queued by hand
 * when no automation says otherwise. `{{ review.url }}` is the review site the
 * request was made for, and a placeholder that resolves to nothing becomes an
 * empty string rather than braces in a customer's message.
 */
export const REVIEW_ASK_WORDING = {
  sms: "Hi {{ customer.name }}, thank you for choosing {{ organization.name }}. If you "
    + "have a minute, a review helps a local business like ours more than anything: "
    + "{{ review.url }}",
  emailSubject: "How did we do, {{ customer.name }}?",
  emailBody: "Hi {{ customer.name }},\n\nThank you for choosing {{ organization.name }}. If you have a "
    + "minute, a review helps a local business like ours more than anything. You can leave one here:\n\n"
    + "{{ review.url }}\n\nIf anything was not right, just reply to this email and we will sort it out.\n\n"
    + "{{ organization.name }}",
} as const;

/** The configuration of the send step for a channel. One place, so the install and the worker say the same thing. */
export function reviewAskConfig(channel: ReviewAskChannel): Record<string, unknown> {
  if (channel === "email") {
    return { channel, subject: REVIEW_ASK_WORDING.emailSubject, body: REVIEW_ASK_WORDING.emailBody };
  }
  if (channel === "sms_then_email") {
    return {
      channel, body: REVIEW_ASK_WORDING.sms,
      subject: REVIEW_ASK_WORDING.emailSubject, emailBody: REVIEW_ASK_WORDING.emailBody,
    };
  }
  return { channel: "sms", body: REVIEW_ASK_WORDING.sms };
}

export interface TemplateDefinition {
  name: string;
  description: string;
  /**
   * `event` for something that happened; `dwell` for something about to
   * happen or that has not, which names a shape the dwell sweep owns and
   * how many days.
   */
  triggerKind: "event" | "dwell";
  triggerEvents: string[];
  dwell?: { shape: string; afterDays: number } | undefined;
  steps: PlanNode[];
}

export interface WorkflowTemplate {
  key: string;
  name: string;
  /** What it does, as the recommended list says it. */
  summary: string;
  /** What has to be true in the company for it to do anything, said up front. */
  needs: string;
  parameters: TemplateParameter[];
  /**
   * Installed and switched on, with its defaults, when a company is created.
   *
   * Only for an automation whose worst case is harmless and whose absence is
   * the costly mistake. An unanswered estimate is the commonest way a small
   * office loses work it had already won, and "turn it on" is the step that
   * gets skipped in the first week. It stays an ordinary workflow, switched
   * off or deleted from the same list as any other.
   */
  onForNewCompanies?: boolean;
}

export const TEMPLATES: readonly WorkflowTemplate[] = [
  {
    key: "estimate_follow_up",
    name: "Follow up an estimate that has not been answered",
    summary:
      "Some days after an estimate is sent, if the customer has not approved or declined it, "
      + "text them the link to it, then email it, then put a call in the office queue.",
    needs:
      "A registered texting number for the text and a connected email provider for the email. "
      + "A customer who has not agreed to texts is not texted; the email and the call still happen.",
    parameters: [{
      key: "days",
      label: "Days to wait after sending",
      help: "Three is what most offices use. Less reads as pushy; more and they have hired somebody else.",
      kind: "number", default: 3, min: 1, max: 30,
    }],
    onForNewCompanies: true,
  },
  {
    key: "review_after_paid",
    name: "Ask for a review after a paid job",
    summary:
      "A while after a job's invoice is paid in full, ask the customer for a review, by text, by email, "
      + "or by text first and then email, if your review rules allow it and they have not been asked recently.",
    needs:
      "Your review rules set under Reviews, and the place customers leave reviews declared there with its link. "
      + "The rules decide who is asked and when; this only does the asking.",
    parameters: [
      {
        key: "hours",
        label: "Hours to wait after payment",
        help: "Your review rules can hold it later still, for the evening cut off or a customer asked last month.",
        kind: "number", default: 2, min: 0, max: 168,
      },
      {
        key: "platform",
        label: "Where to send them",
        help: "One of the review sites you have declared, with its link.",
        kind: "platform",
      },
      {
        key: "channel",
        label: "How to ask",
        help: "Text first and then email only sends the email when the text could not go. Nobody is asked twice.",
        kind: "choice",
        options: REVIEW_ASK_CHANNELS.map((c) => ({ ...c })),
        defaultChoice: DEFAULT_REVIEW_ASK_CHANNEL,
      },
    ],
  },
  {
    key: "missed_call_text_back",
    name: "Text back a missed call",
    summary:
      "When a call comes in and nobody answers, wait a couple of minutes, and if nobody has spoken to them "
      + "since, text the caller to say you will ring them back, and put the call back in the office queue.",
    needs:
      "A registered texting number that is not a tracking number. A caller who has replied STOP to you "
      + "is not texted; the call back task is still raised.",
    parameters: [{
      key: "minutes",
      label: "Minutes to wait first",
      help: "Two gives whoever was on the other line a chance to ring them back before a text goes.",
      kind: "number", default: 2, min: 0, max: 60,
    }],
  },
  {
    key: "warranty_call",
    name: "Ring before a warranty runs out",
    summary:
      "Some days before the parts or labour warranty on a unit you keep on file runs out, put a call "
      + "in the office queue to offer a service plan or a replacement while it is still covered.",
    needs:
      "Units on your customers' addresses with their warranty dates filled in. A unit with no dates, "
      + "or one taken off the register, is never called about.",
    parameters: [{
      key: "days",
      label: "Days before the warranty ends",
      help: "Thirty gives time to book a visit before the cover ends. Each end date is called about once.",
      kind: "number", default: 30, min: 1, max: 180,
    }],
  },
];

export const templateByKey = (key: string): WorkflowTemplate | undefined =>
  TEMPLATES.find((t) => t.key === key);

export type TemplateBuild =
  | { ok: true; definition: TemplateDefinition }
  | { ok: false; reason: string };

/**
 * A whole number inside a parameter's bounds, or the reason it is not.
 *
 * Refused rather than clamped. Somebody typing 90 into "days to wait" and
 * getting 30 has an automation that does something they did not ask for and
 * a screen that says they did.
 */
function numberOf(parameter: TemplateParameter, raw: unknown): number | string {
  const given = raw === undefined || raw === null || raw === "" ? parameter.default : Number(raw);
  if (given === undefined || !Number.isInteger(given)) {
    return `${parameter.label} has to be a whole number.`;
  }
  if (parameter.min !== undefined && given < parameter.min) {
    return `${parameter.label} cannot be less than ${parameter.min}.`;
  }
  if (parameter.max !== undefined && given > parameter.max) {
    return `${parameter.label} cannot be more than ${parameter.max}.`;
  }
  return given;
}

/**
 * The workflow a template installs, with the company's own values in it.
 *
 * The copy is plain, short and the company's to change: it is a starting
 * point on the canvas, and a placeholder that resolves to nothing becomes an
 * empty string rather than braces in a customer's text.
 */
export function buildTemplate(key: string, values: Record<string, unknown>): TemplateBuild {
  const template = templateByKey(key);
  if (!template) return { ok: false, reason: `There is no recommended automation called ${key}.` };

  if (key === "estimate_follow_up") {
    const days = numberOf(template.parameters[0]!, values["days"]);
    if (typeof days === "string") return { ok: false, reason: days };

    return {
      ok: true,
      definition: {
        name: template.name,
        description:
          `Installed from the recommended list. ${days} ${days === 1 ? "day" : "days"} after an estimate `
          + "is sent, if it is still waiting for an answer: text the link, email the link, then raise a "
          + "call for the office.",
        triggerKind: "event",
        triggerEvents: ["estimate.sent"],
        steps: [
          /** Both units written, so the canvas shows exactly what will run. */
          { kind: "wait", config: { days, hours: 0 } },
          { kind: "stop_unless", config: { check: "estimate_undecided" } },
          {
            kind: "send_estimate",
            config: {
              channel: "sms",
              body: "Hi {{ customer.name }}, it is {{ organization.name }}. Just checking you saw "
                + "estimate #{{ estimate.number }}. You can read it and approve it here: {{ link }}",
            },
          },
          {
            kind: "send_estimate",
            config: {
              channel: "email",
              subject: "Your estimate from {{ organization.name }}",
              body: "Hi {{ customer.name }},\n\nWe sent you estimate #{{ estimate.number }} a few "
                + "days ago and wanted to make sure it reached you. You can read it, choose an "
                + "option and approve it here:\n\n{{ link }}\n\nIf you have questions, just reply "
                + "to this email.\n\n{{ organization.name }}",
            },
          },
          {
            kind: "create_task",
            config: {
              title: "Ring {{ customer.name }} about estimate #{{ estimate.number }}",
              queue: "office",
              dueInHours: 24,
            },
          },
        ],
      },
    };
  }

  if (key === "review_after_paid") {
    const hours = numberOf(template.parameters[0]!, values["hours"]);
    if (typeof hours === "string") return { ok: false, reason: hours };
    const platform = typeof values["platform"] === "string" ? values["platform"].trim() : "";
    const chosen = values["channel"] === undefined || values["channel"] === null || values["channel"] === ""
      ? DEFAULT_REVIEW_ASK_CHANNEL : values["channel"];
    if (!isReviewAskChannel(chosen)) {
      return { ok: false, reason: "How to ask has to be by text, by email, or by text first and then email." };
    }
    const how = chosen === "sms" ? "by text" : chosen === "email" ? "by email" : "by text, then by email if the text cannot be sent";
    if (platform === "") {
      return {
        ok: false,
        reason: "Choose where to send them. Declare a review site with its link under Reviews first.",
      };
    }

    return {
      ok: true,
      definition: {
        name: template.name,
        description:
          `Installed from the recommended list. ${hours} ${hours === 1 ? "hour" : "hours"} after a job's `
          + `invoice is paid, ask for a review ${how} if your review rules allow it.`,
        triggerKind: "event",
        triggerEvents: ["invoice.paid"],
        steps: [
          { kind: "wait", config: { days: 0, hours } },
          { kind: "request_review", config: { platform } },
          { kind: "send_review_request", config: reviewAskConfig(chosen) },
        ],
      },
    };
  }

  if (key === "missed_call_text_back") {
    const minutes = numberOf(template.parameters[0]!, values["minutes"]);
    if (typeof minutes === "string") return { ok: false, reason: minutes };
    return {
      ok: true,
      definition: {
        name: template.name,
        description:
          `Installed from the recommended list. ${minutes} ${minutes === 1 ? "minute" : "minutes"} after a call `
          + "nobody answered, if nobody has spoken to the caller since: text them, then raise a call back for the office.",
        triggerKind: "event",
        triggerEvents: ["call.missed"],
        steps: [
          /** No wait at all for nought, rather than a wait the engine reads as missing. */
          ...(minutes > 0 ? [{ kind: "wait", config: { minutes } }] : []),
          { kind: "stop_unless", config: { check: "caller_not_reached" } },
          {
            kind: "text_caller",
            config: {
              body: "Hi, this is {{ organization.name }}. Sorry we missed your call. We will ring you back "
                + "shortly, or reply here and tell us what you need.",
            },
          },
          {
            kind: "create_task",
            config: { title: "Ring back {{ from }}, a missed call", queue: "office", dueInHours: 1, priority: "high" },
          },
        ],
      },
    };
  }

  if (key === "warranty_call") {
    const days = numberOf(template.parameters[0]!, values["days"]);
    if (typeof days === "string") return { ok: false, reason: days };
    return {
      ok: true,
      definition: {
        name: template.name,
        description:
          `Installed from the recommended list. ${days} ${days === 1 ? "day" : "days"} before the warranty `
          + "on a unit runs out, raise a call for the office about it.",
        triggerKind: "dwell",
        triggerEvents: [],
        dwell: { shape: "warranty_lapsing", afterDays: days },
        steps: [
          /**
           * About the unit, so the task opens the unit's page with its address
           * and its customer, which is what the person ringing needs in front
           * of them. Two days to make the call, because nobody else is waiting.
           */
          {
            kind: "create_task",
            config: {
              title: "Warranty ends {{ until }}: ring about a plan or a replacement",
              queue: "office",
              dueInHours: 48,
            },
          },
        ],
      },
    };
  }

  return { ok: false, reason: `There is no recommended automation called ${key}.` };
}

/* ------------------------------------------------- from a trade pack */

/**
 * RECOMMENDED AUTOMATIONS A TRADE PACK DECLARES
 *
 * The four above are code, because each needs something from the company
 * the service has to look up (a review site, a number cleared to text). A
 * trade knows automations of its own that need nothing of the kind: ring a
 * new plan member to book their first tune up, chase a permit that has sat
 * at "submitted". Those are DATA in the pack, in the same shape as the four
 * (a key, what it does, what it needs, its number settings, and the
 * workflow it installs), so anybody who has run a shop in the trade can
 * write one without writing TypeScript.
 *
 * Checked when the pack is loaded, by `checkPackAutomation`, against what
 * this build can actually run: steps it knows, events something emits, a
 * question `stop_unless` can ask, branches whose arms add up, and every
 * setting a step names declared with bounds its default sits inside. A pack
 * that fails is a pack that fails to load, which is a build that fails,
 * rather than a company finding out on the day it presses "Turn on".
 *
 * Installing one goes through exactly the path the four do: the same check
 * as a workflow drawn on the canvas, the same permission rule, switched on,
 * labelled with its key so the list knows it is on.
 *
 * A SETTING IS NAMED, NEVER WRITTEN IN. A step's config says
 * `{ "$param": "days" }` where the company's number goes, and building the
 * workflow puts the number there. Only declared settings can be named, and
 * only whole numbers within their bounds can be put in.
 *
 * Event triggers only. The one dwell trigger the four use waits on a shape
 * the service owns, and a pack cannot be checked against it from here.
 */

export interface PackAutomationParameter {
  key: string;
  label: string;
  help: string;
  kind: "number";
  default: number;
  min: number;
  max: number;
}

export interface PackAutomation {
  /** `<pack id>.<its own key>`, so two packs cannot claim one key and none can claim a built in one. */
  key: string;
  packId: string;
  name: string;
  summary: string;
  needs: string;
  parameters: PackAutomationParameter[];
  definition: {
    description: string;
    triggerKind: "event";
    triggerEvents: string[];
    steps: PlanNode[];
  };
}

export type PackAutomationCheck =
  | { ok: true; template: PackAutomation }
  | { ok: false; problems: string[] };

const LOCAL_KEY = /^[a-z][a-z0-9_]{0,39}$/;
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
const text = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** Every `{ "$param": ... }` inside a config, however deep. */
function paramRefs(value: unknown, out: string[] = []): string[] {
  if (Array.isArray(value)) { for (const item of value) paramRefs(item, out); return out; }
  if (!isRecord(value)) return out;
  if (Object.prototype.hasOwnProperty.call(value, "$param")) { out.push(String(value["$param"])); return out; }
  for (const inner of Object.values(value)) paramRefs(inner, out);
  return out;
}

/** The same config with each named setting replaced by its number. */
function fillParams(value: unknown, values: Record<string, number>): unknown {
  if (Array.isArray(value)) return value.map((item) => fillParams(item, values));
  if (!isRecord(value)) return value;
  if (Object.prototype.hasOwnProperty.call(value, "$param")) return values[String(value["$param"])];
  return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillParams(v, values)]));
}

function readNodes(raw: unknown, where: string, problems: string[]): PlanNode[] {
  if (!Array.isArray(raw)) { problems.push(`${where} has to be a list of steps.`); return []; }
  return raw.map((node, index) => {
    const at = `${where}, step ${index + 1}`;
    if (!isRecord(node) || typeof node["kind"] !== "string") {
      problems.push(`${at} has no kind.`);
      return { kind: "" };
    }
    const config = node["config"] === undefined ? undefined : node["config"];
    if (config !== undefined && !isRecord(config)) problems.push(`${at}: its config has to be an object.`);
    const out: PlanNode = { kind: node["kind"], ...(isRecord(config) ? { config } : {}) };
    if (node["kind"] === "branch") {
      out.then = readNodes(node["then"] ?? [], `${at}, then`, problems);
      out.otherwise = readNodes(node["otherwise"] ?? [], `${at}, otherwise`, problems);
    }
    return out;
  });
}

/**
 * WHETHER A PACK'S AUTOMATION CAN BE LOADED, AND WHAT IT IS ONCE IT CAN.
 *
 * Every problem at once, each naming the automation, because the person
 * reading them is a pack author with a file open, and a list fixed one line
 * per build is a slow way to write a pack. `subscribable` is the events a
 * workflow may subscribe to, passed in so this module does not reach into
 * the event catalogue's own.
 */
export function checkPackAutomation(
  packId: string, raw: unknown, subscribable: readonly string[],
): PackAutomationCheck {
  const problems: string[] = [];
  if (!isRecord(raw)) return { ok: false, problems: [`An automation in ${packId} is not an object.`] };
  const localKey = text(raw["key"]);
  const name = text(raw["name"]);
  const label = `${packId} automation "${localKey || name || "with no key"}"`;
  const say = (message: string) => problems.push(`${label}: ${message}`);

  if (!LOCAL_KEY.test(localKey)) say("its key is lowercase letters, digits and underscores, starting with a letter.");
  if (name === "" || name.length > 120) say("it needs a name of up to 120 characters.");
  const summary = text(raw["summary"]);
  const needs = text(raw["needs"]);
  if (summary === "" || summary.length > 500) say("it needs a summary of up to 500 characters.");
  if (needs.length > 500) say("what it needs is longer than 500 characters.");

  const parameters: PackAutomationParameter[] = [];
  const rawParams = raw["parameters"] ?? [];
  if (!Array.isArray(rawParams)) say("its settings have to be a list.");
  for (const p of Array.isArray(rawParams) ? rawParams : []) {
    if (!isRecord(p)) { say("a setting is not an object."); continue; }
    const key = text(p["key"]);
    const kind = p["kind"] ?? "number";
    const [def, min, max] = [p["default"], p["min"], p["max"]];
    if (!LOCAL_KEY.test(key)) { say(`setting "${key}" needs a lowercase key.`); continue; }
    if (parameters.some((q) => q.key === key)) { say(`setting "${key}" is declared twice.`); continue; }
    if (kind !== "number") { say(`setting "${key}" is a ${String(kind)}; a pack's settings are whole numbers.`); continue; }
    if (![def, min, max].every((n) => Number.isInteger(n))) {
      say(`setting "${key}" needs a whole number default, min and max.`); continue;
    }
    if (!((min as number) <= (def as number) && (def as number) <= (max as number))) {
      say(`setting "${key}" has a default outside its own bounds.`); continue;
    }
    if (text(p["label"]) === "") say(`setting "${key}" needs a label.`);
    parameters.push({
      key, kind: "number", label: text(p["label"]), help: text(p["help"]),
      default: def as number, min: min as number, max: max as number,
    });
  }

  const definition = isRecord(raw["definition"]) ? raw["definition"] : null;
  if (!definition) say("it needs a definition: the trigger and the steps it installs.");
  const triggerKind = definition?.["triggerKind"] ?? "event";
  if (triggerKind !== "event") say("a pack's automation starts on an event; waiting on a record is for the built in ones.");
  const triggerEvents = Array.isArray(definition?.["triggerEvents"]) ? (definition["triggerEvents"] as unknown[]).map(String) : [];
  if (triggerEvents.length === 0) say("it needs at least one event to start on.");
  for (const event of triggerEvents) {
    if (!subscribable.includes(event)) say(`nothing emits ${event} for an automation to start on.`);
  }
  const steps = readNodes(definition?.["steps"] ?? [], "the definition", problems);
  const flat = flattenPlan(steps);
  if (flat.length === 0) say("it needs at least one step.");
  for (const [index, step] of flat.entries()) {
    if (!(step.kind in STEP_PERMISSIONS)) say(`step ${index + 1} is ${step.kind || "nothing"}, which this build cannot run.`);
    if (step.kind === "stop_unless") {
      if (!isCheck(step.config?.["check"])) say(`step ${index + 1} asks ${String(step.config?.["check"])}, which this build cannot ask.`);
      const settings = checkSettingsProblem(step.config);
      if (settings) say(`step ${index + 1}: ${settings}`);
    }
    for (const ref of paramRefs(step.config)) {
      if (!parameters.some((p) => p.key === ref)) say(`step ${index + 1} names a setting "${ref}" it does not declare.`);
    }
  }
  const arms = checkBranches(flat);
  if (arms.length > 0) say(explainBranch(arms[0]!));

  const description = text(definition?.["description"]) || summary;
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    template: {
      key: `${packId}.${localKey}`, packId, name, summary, needs, parameters,
      definition: { description, triggerKind: "event", triggerEvents, steps },
    },
  };
}

/**
 * The workflow a pack's automation installs, with the company's numbers in
 * it. Refused, never clamped, outside a setting's bounds, for the reason
 * `numberOf` gives.
 */
export function buildPackTemplate(template: PackAutomation, values: Record<string, unknown>): TemplateBuild {
  const filled: Record<string, number> = {};
  for (const parameter of template.parameters) {
    const given = numberOf(parameter, values[parameter.key]);
    if (typeof given === "string") return { ok: false, reason: given };
    filled[parameter.key] = given;
  }
  const fill = (nodes: readonly PlanNode[]): PlanNode[] => nodes.map((node) => ({
    kind: node.kind,
    ...(node.config ? { config: fillParams(node.config, filled) as Record<string, unknown> } : {}),
    ...(node.then ? { then: fill(node.then) } : {}),
    ...(node.otherwise ? { otherwise: fill(node.otherwise) } : {}),
  }));
  return {
    ok: true,
    definition: {
      name: template.name,
      description: `Installed from the recommended list, from the ${template.packId} trade pack. ${template.definition.description}`,
      triggerKind: "event",
      triggerEvents: [...template.definition.triggerEvents],
      steps: fill(template.definition.steps),
    },
  };
}
