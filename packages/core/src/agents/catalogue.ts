import type { Permission } from "../access/permissions.js";
import { permissionsFor, type Actor } from "../access/index.js";
import { check, type JsonSchema } from "./schema.js";

/**
 * THE AGENTS, AND EVERYTHING EACH ONE MAY DO
 *
 * Five agents, each a narrow job with a short list of actions. An action is
 * offered to the model as a tool, and it is the ONLY way the model can affect
 * anything: an answer in words is shown to a person or thrown away, and an
 * answer that is a tool call is checked here before anything reads it.
 *
 * WHY A SHORT LIST AND NOT THE WHOLE API. The connected model could be
 * offered the MCP catalogue, filtered by permission, and `runAiCompletion`
 * does exactly that for a caller who runs their own loop. An agent the
 * company switches on and leaves running is a different thing: it runs at
 * nine at night with nobody watching, on text a stranger typed. The catalogue
 * below is what each agent's job needs and nothing else, every action's
 * result is a PROPOSAL until a person or the company's own "act on its own"
 * setting turns it into a change, and every change is made by the ordinary
 * service, under the ordinary permission check, as the person the agent runs
 * as. There is no second gate here to forget something.
 *
 * WHAT AN ACTION NEEDS IS A PERMISSION THE PERSON ALREADY HAS. `permissions`
 * on an action is what applying it takes, and it is the same list the route
 * that applies it declares (the API package's tests hold the two together).
 * An action whose permissions the agent's person does not hold is not offered
 * to the model at all, and a model that asks for it anyway is refused and the
 * refusal is logged. So the worst an agent can do is what that person could do
 * by hand.
 */

export type AgentKind = "intake" | "chat" | "estimate" | "collections" | "dispatch";

export const AGENT_KINDS: readonly AgentKind[] = ["intake", "chat", "estimate", "collections", "dispatch"];

export const isAgentKind = (value: string): value is AgentKind =>
  (AGENT_KINDS as readonly string[]).includes(value);

export interface AgentAction {
  /** The tool name the model sees. Lower case, no prefix: these never meet the MCP namespace. */
  name: string;
  description: string;
  /** What applying it takes. Not offered to an agent whose person lacks any of these. */
  permissions: readonly Permission[];
  /**
   * Whether applying it moves money or a customer's schedule. These wait for a
   * person unless the company turned on "act on its own" for the agent, and on
   * an agent where `autoAllowed` is false they wait for a person always.
   */
  consequential: boolean;
  inputSchema: JsonSchema;
}

export interface AgentDefinition {
  kind: AgentKind;
  /** What an owner sees on the settings screen. */
  label: string;
  description: string;
  /**
   * What the agent's person needs simply to read what the agent reads. An
   * agent configured to run as somebody without these does not run at all.
   */
  basePermissions: readonly Permission[];
  actions: readonly AgentAction[];
  /**
   * Whether a company may let this agent act without a person. False for the
   * dispatch copilot: putting people on a day is a decision the brief keeps
   * with a person, and a setting that could turn that off is a setting
   * somebody turns off to save a click.
   */
  autoAllowed: boolean;
}

/* ----------------------------------------------------------------- shapes */

const text = (maxLength: number, description: string, minLength = 1): JsonSchema =>
  ({ type: "string", minLength, maxLength, description });

const id = (description: string): JsonSchema => ({ type: "string", minLength: 1, maxLength: 64, description });

const DATE: JsonSchema = {
  type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$", description: "A calendar day, YYYY-MM-DD.",
};

const ADDRESS: JsonSchema = {
  type: "object",
  description: "Where the work is. Only what the customer said; leave out what they did not.",
  properties: {
    line1: text(200, "Street address."),
    line2: text(200, "Unit, suite or apartment."),
    city: text(100, "City."),
    state: text(50, "State, as written."),
    postalCode: text(20, "Postal code."),
  },
  required: ["line1", "city", "state", "postalCode"],
};

/* ------------------------------------------------------------ the agents */

export const AGENTS: Readonly<Record<AgentKind, AgentDefinition>> = {
  intake: {
    kind: "intake",
    label: "Intake",
    description:
      "Reads a text, an email, a web form or a call transcript and drafts a booking: who it is, where, "
      + "what is wrong, how soon, and which of your online booking windows would suit. The office books it "
      + "with one click.",
    basePermissions: ["message:read", "customer:read", "booking:read"],
    autoAllowed: true,
    actions: [
      {
        name: "propose_booking",
        description:
          "Draft a booking from what the customer wrote. Use a customer id only from the candidates you were given. "
          + "Use a service id and windows only from the open windows you were given; offer up to three, best first.",
        permissions: ["booking:decide", "visit:write"],
        consequential: true,
        inputSchema: {
          type: "object",
          properties: {
            customerId: id("The matching customer's id from the candidates, or leave out for somebody new."),
            contactName: text(200, "The person's name as they gave it."),
            phone: text(40, "Their phone number, if given."),
            email: text(200, "Their email address, if given."),
            address: ADDRESS,
            problemSummary: text(600, "What is wrong, in one or two plain sentences an office can read aloud."),
            bookableServiceId: id("The service from the open windows list that fits best."),
            urgency: { type: "string", enum: ["emergency", "soon", "routine"], description: "How soon it needs doing." },
            windows: {
              type: "array",
              maxItems: 3,
              description: "Up to three open windows, best first, from the list you were given.",
              items: {
                type: "object",
                properties: { date: DATE, arrivalWindowId: id("The window's id.") },
                required: ["date", "arrivalWindowId"],
              },
            },
            missing: {
              type: "array",
              maxItems: 6,
              description: "Anything the office still has to ask, such as a missing address.",
              items: text(200, "One thing to ask."),
            },
          },
          required: ["contactName", "problemSummary", "urgency"],
        },
      },
      {
        name: "not_a_booking",
        description: "Use when the message is not asking for work: a thank you, a question about a bill, a wrong number.",
        permissions: [],
        consequential: false,
        inputSchema: {
          type: "object",
          properties: { reason: text(300, "Why this is not a booking, in one sentence.") },
          required: ["reason"],
        },
      },
    ],
  },

  chat: {
    kind: "chat",
    label: "Website and text chat",
    description:
      "Answers customers on your website and by text from the facts you give it: your services, area, hours, "
      + "the prices you choose to publish and your own questions and answers. It can offer real booking windows "
      + "and take a booking request, says it is automated, and hands over to a person when asked or unsure.",
    basePermissions: ["message:read", "message:send"],
    autoAllowed: false,
    actions: [
      {
        name: "reply",
        description: "Answer the customer. Use only the facts you were given. Never state a price that is not in them.",
        permissions: ["message:send"],
        consequential: false,
        inputSchema: {
          type: "object",
          properties: { text: text(1200, "What to say, in plain words.") },
          required: ["text"],
        },
      },
      {
        name: "create_booking_request",
        description:
          "Ask for a booking once the customer has chosen a window and given their name, a phone number or email, "
          + "and the address. It is a request: the office confirms it.",
        permissions: ["message:send"],
        consequential: false,
        inputSchema: {
          type: "object",
          properties: {
            bookableServiceId: id("The service, from the open windows list."),
            date: DATE,
            arrivalWindowId: id("The window's id, from the open windows list."),
            contactName: text(200, "Their name."),
            phone: text(40, "Their phone number."),
            email: text(200, "Their email address."),
            address: ADDRESS,
            notes: text(1000, "What is wrong, in their words."),
            text: text(600, "What to tell the customer now."),
          },
          required: ["bookableServiceId", "date", "arrivalWindowId", "contactName", "address", "text"],
        },
      },
      {
        name: "hand_off",
        description: "Pass the conversation to a person: when asked, when unsure, when upset, or when the facts do not cover it.",
        permissions: [],
        consequential: false,
        inputSchema: {
          type: "object",
          properties: {
            reason: text(300, "Why a person should take it, for the office."),
            text: text(600, "What to tell the customer now."),
          },
          required: ["reason"],
        },
      },
    ],
  },

  estimate: {
    kind: "estimate",
    label: "Estimate drafter",
    description:
      "Reads a job's notes, photo captions, readings and your price book, and drafts good, better and best "
      + "options using only price book items at price book prices. A person edits and sends it.",
    basePermissions: ["job:read", "pricebook:read"],
    autoAllowed: true,
    actions: [
      {
        name: "draft_estimate",
        description:
          "Draft one to three options, cheapest first. Every line must be a price book item id from the list you were "
          + "given. Do not write prices: the price book's price is used.",
        permissions: ["estimate:write"],
        consequential: false,
        inputSchema: {
          type: "object",
          properties: {
            summary: text(600, "What the job needs, in one or two sentences for the office."),
            options: {
              type: "array",
              minItems: 1,
              maxItems: 3,
              items: {
                type: "object",
                properties: {
                  name: text(100, "The option's name, such as Good, Better or Best."),
                  description: text(1000, "What this option does for the customer."),
                  recommended: { type: "boolean", description: "True on the one option you would recommend." },
                  lines: {
                    type: "array",
                    minItems: 1,
                    maxItems: 30,
                    items: {
                      type: "object",
                      properties: {
                        priceBookItemId: id("The item's id from the price book list."),
                        quantity: { type: "number", exclusiveMinimum: 0, maximum: 10000, description: "How many." },
                        reason: text(300, "Why this line, from the notes."),
                      },
                      required: ["priceBookItemId", "quantity"],
                    },
                  },
                },
                required: ["name", "lines"],
              },
            },
          },
          required: ["summary", "options"],
        },
      },
      {
        name: "cannot_estimate",
        description: "Use when the notes do not say enough to price the work, and say what is missing.",
        permissions: [],
        consequential: false,
        inputSchema: {
          type: "object",
          properties: { reason: text(400, "What is missing.") },
          required: ["reason"],
        },
      },
    ],
  },

  collections: {
    kind: "collections",
    label: "Collections",
    description:
      "Drafts reminders for overdue invoices in your tone, at the steps you set, and sends them only through "
      + "your usual consent checks. It proposes each one unless you let it send on its own.",
    basePermissions: ["invoice:read", "customer:read"],
    autoAllowed: true,
    actions: [
      {
        name: "draft_reminder",
        description:
          "Write the reminder. Use the amount owed exactly as given and no other amount. The payment link is added "
          + "for you; do not write one.",
        permissions: ["invoice:send"],
        consequential: true,
        inputSchema: {
          type: "object",
          properties: {
            subject: text(150, "An email subject line."),
            body: text(1200, "The message, in plain words, without a link."),
          },
          required: ["subject", "body"],
        },
      },
    ],
  },

  dispatch: {
    kind: "dispatch",
    label: "Dispatch copilot",
    description:
      "On the board, explains in plain words who should take each open visit, using the board's own route "
      + "optimiser and skills checks. A dispatcher applies it.",
    basePermissions: ["visit:read"],
    autoAllowed: false,
    actions: [
      {
        name: "propose_assignments",
        description:
          "Choose who takes each open visit, only from the candidates you were given, and explain each choice "
          + "in a sentence a dispatcher would say.",
        permissions: ["visit:dispatch"],
        consequential: true,
        inputSchema: {
          type: "object",
          properties: {
            summary: text(1200, "The day's plan in a few plain sentences."),
            assignments: {
              type: "array",
              maxItems: 200,
              items: {
                type: "object",
                properties: {
                  visitId: id("The open visit."),
                  technicianId: id("Who should take it, from that visit's candidates."),
                  why: text(400, "Why, in one sentence."),
                },
                required: ["visitId", "technicianId", "why"],
              },
            },
          },
          required: ["summary", "assignments"],
        },
      },
    ],
  },
};

/* ------------------------------------------------- what may be offered */

type Held = Set<Permission>;

const heldBy = (who: Actor | Held): Held => (who instanceof Set ? who : permissionsFor(who));

/** The permissions this agent's person is missing to run at all. Empty when they may. */
export function missingToRun(kind: AgentKind, who: Actor | Held): Permission[] {
  const held = heldBy(who);
  return AGENTS[kind].basePermissions.filter((p) => !held.has(p));
}

/**
 * What the model is told it may do, for THIS person.
 *
 * Every permission the action needs, not any of them: the same rule the MCP
 * server applies to its own tool list, so an agent and a person driving the
 * API by hand are told about the same things.
 */
export function offeredActions(kind: AgentKind, who: Actor | Held): AgentAction[] {
  const held = heldBy(who);
  return AGENTS[kind].actions.filter((action) => action.permissions.every((p) => held.has(p)));
}

export type CallVerdict =
  | { ok: true; action: AgentAction; input: Record<string, unknown> }
  | {
      ok: false;
      /**
       * `unknown`: no such action on this agent, which is what a model
       * reaching for another agent's tool, or an MCP tool it remembered, looks
       * like. `not_permitted`: the action exists and its person may not apply
       * it. `invalid`: the input does not fit the schema the model was shown.
       */
      refusal: "unknown" | "not_permitted" | "invalid";
      reason: string;
    };

/**
 * Whether a tool call the model made may be read at all.
 *
 * Checked against the person's permissions AGAIN rather than against the list
 * that was offered, and that is deliberate: the list was built a few seconds
 * ago from a membership that can change, and "the model was not told about
 * it" is a statement about the prompt, not a guarantee about the answer. A
 * model can name a tool it was never offered, and this is where that stops.
 */
export function admitCall(
  kind: AgentKind, call: { name: string; input: Record<string, unknown> }, who: Actor | Held,
): CallVerdict {
  const action = AGENTS[kind].actions.find((a) => a.name === call.name);
  if (!action) {
    return {
      ok: false, refusal: "unknown",
      reason: `The model asked to use "${call.name.slice(0, 80)}", which is not something the ${AGENTS[kind].label.toLowerCase()} agent can do.`,
    };
  }
  const held = heldBy(who);
  const missing = action.permissions.filter((p) => !held.has(p));
  if (missing.length > 0) {
    return {
      ok: false, refusal: "not_permitted",
      reason: `The model asked to ${action.name.replace(/_/g, " ")}, which needs ${missing.join(", ")}, and the person this agent runs as does not hold ${missing.length === 1 ? "it" : "them"}.`,
    };
  }
  const checked = check(action.inputSchema, call.input);
  if (!checked.ok) {
    return {
      ok: false, refusal: "invalid",
      reason: `The model's ${action.name.replace(/_/g, " ")} did not fit: ${checked.path.replace(/^\$\.?/, "") || "the answer"} ${checked.reason}.`,
    };
  }
  return { ok: true, action, input: checked.value as Record<string, unknown> };
}
