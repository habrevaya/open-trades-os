import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * THE AGENTS
 *
 * Six agents on the M27 seam, each acting as a named person and never with
 * more than that person may do, each PROPOSING rather than committing anything
 * that moves money or a customer's schedule unless the company set it to act
 * on its own, and each writing down what it proposed and what became of it.
 *
 * Every route that applies a proposal declares the permission the underlying
 * action takes, which is the same list the agent's action carries in
 * `core/agents`, and applies it through the ordinary service a person's click
 * would call. Nothing here is a second way to make a booking, an estimate, a
 * text or an assignment.
 *
 * All of these live under `/v1/ai/`, which `services/ai.ts` never offers to a
 * model as a tool: an agent cannot drive an agent.
 */

const AgentKind = z.enum(["intake", "chat", "voice", "estimate", "collections", "dispatch"]);
const Status = z.enum(["proposed", "applied", "dismissed", "failed", "superseded"]);

const Draft = z.object({
  id: Uuid,
  agent: AgentKind,
  /** The action the model answered with, such as `propose_booking`. */
  action: z.string(),
  status: Status,
  sourceKind: z.string(),
  sourceId: z.string(),
  summary: z.string(),
  /** What a person approves: the model's answer after every check against the company's records. */
  draft: z.record(z.unknown()),
  appliedAutomatically: z.boolean(),
  /** What applying it made, as ids. */
  outcome: z.record(z.unknown()).nullable(),
  /** Why it failed or was dismissed, in words. */
  note: z.string().nullable(),
  runAsUserId: Uuid.nullable(),
  startedByUserId: Uuid.nullable(),
  decidedByUserId: Uuid.nullable(),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
});

const Drafts = z.object({ drafts: z.array(Draft) });

const ListInput = {
  status: z.array(Status).optional(),
  limit: z.number().int().min(1).max(200).default(50),
};

const Dismiss = z.object({ id: Uuid, reason: z.string().max(1000).optional() });

/* ------------------------------------------------------------- settings */

const Settings = z.object({
  enabled: z.boolean(),
  mode: z.enum(["propose", "auto"]),
  tone: z.string().max(300),
  runAsUserId: Uuid.nullable(),
  provider: z.string().max(50).nullable(),
  model: z.string().max(200).nullable(),
  limits: z.object({
    runsPerDay: z.number().int(),
    maxOutputTokens: z.number().int(),
    messagesPerChat: z.number().int(),
  }),
  chat: z.object({
    greeting: z.string().max(300),
    faq: z.array(z.object({ question: z.string().max(300), answer: z.string().max(1500) })).max(50),
    publicPriceItemIds: z.array(Uuid).max(200),
    web: z.boolean(),
    text: z.boolean(),
  }),
  intake: z.object({ texts: z.boolean(), emails: z.boolean(), calls: z.boolean(), forms: z.boolean() }),
  collections: z.object({
    steps: z.array(z.object({
      afterDays: z.number().int(),
      tone: z.string().max(200),
      channel: z.enum(["email", "text"]),
    })).max(6),
  }),
  /**
   * The phone assistant's: the ring group it puts callers through to, or
   * null for voicemail. Its greeting, questions and answers and published
   * prices are the `chat` ones on its own settings. Optional on the way in,
   * for a caller written before the phone assistant existed.
   */
  voice: z.object({ transferRingGroupId: Uuid.nullable() }).default({ transferRingGroupId: null }),
});

export const listAgents = defineRoute({
  method: "get",
  path: "/v1/ai/agents",
  summary: "The AI agents and how each is set up",
  description:
    "Each agent's settings, the person it acts as when nobody started it, and what it may actually do as that person: the actions whose permissions they hold. Reading this is `integration:read`, like reading the bill; changing it is `agent:configure`.",
  module: "M27",
  permissions: ["integration:read"],
  input: z.object({}),
  output: z.object({
    agents: z.array(z.object({
      agent: AgentKind,
      label: z.string(),
      description: z.string(),
      autoAllowed: z.boolean(),
      settings: Settings,
      runAs: z.object({
        userId: Uuid,
        name: z.string().nullable(),
        active: z.boolean(),
        actions: z.array(z.string()),
        missing: z.array(z.string()),
      }).nullable(),
      actions: z.array(z.object({
        name: z.string(), description: z.string(),
        permissions: z.array(z.string()), consequential: z.boolean(),
      })),
      runsToday: z.number().int(),
    })),
  }),
});

export const configureAgent = defineRoute({
  method: "put",
  path: "/v1/ai/agents/{agent}",
  summary: "Turn an agent on or off and set it up",
  description:
    "The whole of one agent's settings. The person it acts as may hold no permission the caller does not, so nobody can hand an agent more access than they have. Auto is refused on the dispatch copilot, the chat agent and the phone assistant, which always leave the decision to a person. Limits out of range are refused rather than clamped.",
  module: "M27",
  permissions: ["agent:configure"],
  idempotent: true,
  input: z.object({ agent: AgentKind, settings: Settings }),
  output: z.object({ agent: AgentKind, settings: Settings }),
});

export const listAgentActivity = defineRoute({
  method: "get",
  path: "/v1/ai/activity",
  summary: "What the agents did, newest first",
  description:
    "Every draft, every decision, every refusal (a model asking for something its person may not do, a price that is not published, an item that is not in the price book), every handover to a person and every run that failed. One sentence each; never a prompt.",
  module: "M27",
  permissions: ["integration:read"],
  input: z.object({ agent: AgentKind.optional(), limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({
    entries: z.array(z.object({
      id: Uuid, agent: AgentKind, kind: z.string(), detail: z.string(),
      proposalId: Uuid.nullable(), automatic: z.boolean(),
      actorUserId: Uuid.nullable(), actorName: z.string().nullable(), at: z.string(),
    })),
  }),
});

/* ---------------------------------------------------------------- intake */

const IntakeSource = z.enum(["conversation", "call", "form_submission"]);

export const listIntakeDrafts = defineRoute({
  method: "get",
  path: "/v1/ai/intake/drafts",
  summary: "Bookings the intake agent drafted",
  module: "M27",
  permissions: ["booking:read"],
  input: z.object({ ...ListInput, sourceKind: IntakeSource.optional(), sourceId: z.string().max(64).optional() }),
  output: Drafts,
});

export const createIntakeDraft = defineRoute({
  method: "post",
  path: "/v1/ai/intake/drafts",
  summary: "Have the intake agent read a thread, a call or a form",
  description:
    "Runs as the caller. Returns the open draft for that source when there is one, without asking the model again; `fresh` closes it and drafts anew. A repeat of the same idempotency key returns the draft it made.",
  module: "M27",
  permissions: ["message:read"],
  idempotent: true,
  input: z.object({ sourceKind: IntakeSource, sourceId: Uuid, fresh: z.boolean().optional() }),
  output: Draft,
});

export const approveIntakeDraft = defineRoute({
  method: "post",
  path: "/v1/ai/intake/drafts/{id}/approve",
  summary: "Book what the intake agent drafted",
  description:
    "Makes the booking request the online booking page would make (the window is re-checked for room), confirms it into a customer, an address and a job the way the office confirms one, and puts a visit in the window. Each step is safe to repeat, so a retry finishes the booking rather than making a second one.",
  module: "M27",
  permissions: ["booking:decide", "visit:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** A different open window than the agent's first choice. Both or neither. */
    date: z.string().date().optional(),
    arrivalWindowId: Uuid.optional(),
    /** Book it for this customer rather than the agent's match. */
    customerId: Uuid.optional(),
  }),
  output: Draft,
});

export const dismissIntakeDraft = defineRoute({
  method: "post",
  path: "/v1/ai/intake/drafts/{id}/dismiss",
  summary: "Say no to a drafted booking",
  module: "M27",
  permissions: ["booking:decide"],
  idempotent: true,
  input: Dismiss,
  output: Draft,
});

export const bookBookingRequest = defineRoute({
  method: "post",
  path: "/v1/ai/intake/requests/{id}/book",
  summary: "Book a request the chat agent or the website took, with its visit",
  description:
    "Confirms the request into a customer, an address and a job the way the office confirms one, and puts a visit in the window the customer chose, so a booking taken in the website chat lands on the board like an intake draft. Safe to repeat.",
  module: "M27",
  permissions: ["booking:decide", "visit:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ bookingRequestId: Uuid, customerId: Uuid, jobId: Uuid, visitId: Uuid.nullable() }),
});

/* -------------------------------------------------------------- estimates */

export const listEstimateDrafts = defineRoute({
  method: "get",
  path: "/v1/ai/estimate-drafts",
  summary: "Estimate options the drafter wrote",
  module: "M27",
  permissions: ["estimate:read"],
  input: z.object({ jobId: Uuid.optional(), limit: z.number().int().min(1).max(200).default(50) }),
  output: Drafts,
});

export const createEstimateDraft = defineRoute({
  method: "post",
  path: "/v1/ai/estimate-drafts",
  summary: "Draft good, better and best options for a job",
  description:
    "From the job's notes, photo captions, readings and equipment, using only price book items: the model picks items and quantities, and every price is the price book's price in force today. A draft naming an item that is not in the book is refused whole. Runs as the caller.",
  module: "M27",
  permissions: ["estimate:write"],
  idempotent: true,
  input: z.object({ jobId: Uuid }),
  output: Draft,
});

export const acceptEstimateDraft = defineRoute({
  method: "post",
  path: "/v1/ai/estimate-drafts/{id}/accept",
  summary: "Turn drafted options into a draft estimate",
  description: "Creates the estimate as a draft, for a person to edit and send from the estimate screen. Nothing is sent.",
  module: "M27",
  permissions: ["estimate:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Draft,
});

export const dismissEstimateDraft = defineRoute({
  method: "post",
  path: "/v1/ai/estimate-drafts/{id}/dismiss",
  summary: "Say no to drafted estimate options",
  module: "M27",
  permissions: ["estimate:write"],
  idempotent: true,
  input: Dismiss,
  output: Draft,
});

/* ------------------------------------------------------------ collections */

export const listCollectionReminders = defineRoute({
  method: "get",
  path: "/v1/ai/collections/reminders",
  summary: "Overdue invoice reminders the collections agent drafted",
  module: "M27",
  permissions: ["invoice:read"],
  input: z.object(ListInput),
  output: Drafts,
});

export const runCollections = defineRoute({
  method: "post",
  path: "/v1/ai/collections/run",
  summary: "Look for overdue invoices due a reminder now",
  description:
    "Drafts the reminders that are due at the company's steps, as the caller. Safe to repeat: a step is only ever drafted once per invoice, so a second run finds nothing new.",
  module: "M27",
  permissions: ["invoice:send"],
  idempotent: true,
  input: z.object({}),
  output: z.object({ drafted: z.number().int(), sent: z.number().int() }),
});

export const sendCollectionReminder = defineRoute({
  method: "post",
  path: "/v1/ai/collections/reminders/{id}/send",
  summary: "Send a drafted reminder, as written or edited",
  description:
    "By email it is the invoice sent again with the reminder above the payment button, through the email consent gate. By text it is the reminder and the invoice's payment link, through the text consent gate, never in quiet hours, and it also needs `message:send`. Sending one already sent returns it.",
  module: "M27",
  permissions: ["invoice:send"],
  idempotent: true,
  input: z.object({ id: Uuid, body: z.string().min(1).max(500).optional() }),
  output: Draft,
});

export const dismissCollectionReminder = defineRoute({
  method: "post",
  path: "/v1/ai/collections/reminders/{id}/dismiss",
  summary: "Say no to a drafted reminder",
  description: "The step counts as taken, so the same reminder is not drafted again tomorrow.",
  module: "M27",
  permissions: ["invoice:send"],
  idempotent: true,
  input: Dismiss,
  output: Draft,
});

/* --------------------------------------------------------------- dispatch */

export const listDispatchPlans = defineRoute({
  method: "get",
  path: "/v1/ai/dispatch/plans",
  summary: "The copilot's plans for a day",
  module: "M27",
  permissions: ["visit:read"],
  input: z.object({ date: z.string().date().optional(), limit: z.number().int().min(1).max(200).default(20) }),
  output: Drafts,
});

export const createDispatchPlan = defineRoute({
  method: "post",
  path: "/v1/ai/dispatch/plans",
  summary: "Ask the copilot who should take the day's open visits",
  description:
    "Hands the model the board's own route optimiser answer and skills and time off checks, and holds its picks to them: anybody the board does not allow is dropped and said. Runs as the caller. A repeat of the same idempotency key returns the plan it made.",
  module: "M27",
  permissions: ["visit:read"],
  idempotent: true,
  input: z.object({ date: z.string().date() }),
  output: Draft,
});

export const applyDispatchPlan = defineRoute({
  method: "post",
  path: "/v1/ai/dispatch/plans/{id}/apply",
  summary: "Apply the copilot's plan, all of it or some",
  description:
    "Each assignment is the board's own, with the qualification check run again now. A visit somebody assigned meanwhile is left alone and said.",
  module: "M27",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: z.object({ id: Uuid, visitIds: z.array(Uuid).max(200).optional() }),
  output: Draft,
});

export const dismissDispatchPlan = defineRoute({
  method: "post",
  path: "/v1/ai/dispatch/plans/{id}/dismiss",
  summary: "Say no to the copilot's plan",
  module: "M27",
  permissions: ["visit:dispatch"],
  idempotent: true,
  input: Dismiss,
  output: Draft,
});

/* ------------------------------------------------------- the chat widget */

const ChatTranscript = z.object({
  status: z.enum(["open", "handed_off", "closed"]),
  bookingTaken: z.boolean(),
  messages: z.array(z.object({
    id: Uuid,
    from: z.enum(["visitor", "assistant", "person"]),
    text: z.string(),
    at: z.string(),
  })),
});

const CompanyKey = z.string().min(1).max(100);
const ChatToken = z.string().min(20).max(200);

export const getChatWidget = defineRoute({
  method: "get",
  path: "/v1/public/chat",
  summary: "Whether the website chat is on, and what it opens with",
  description: "Read by the website snippet before it loads the chat. Says nothing about anybody.",
  module: "M27",
  permissions: [],
  authorization: "public",
  input: z.object({ companyKey: CompanyKey }),
  output: z.object({
    enabled: z.boolean(),
    companyName: z.string(),
    greeting: z.string().nullable(),
    /** Shown before anything the assistant says: that it is automated, and a person can take over. */
    disclosure: z.string(),
  }),
});

export const startChat = defineRoute({
  method: "post",
  path: "/v1/public/chat/sessions",
  summary: "Open a website chat",
  description:
    "Returns the chat's token once; only its hash is kept. Refused while the company's chat is off. Counted per address and per company.",
  module: "M27",
  permissions: [],
  authorization: "public",
  input: z.object({ companyKey: CompanyKey, visitorId: z.string().min(12).max(64).optional() }),
  output: ChatTranscript.extend({ token: z.string() }),
});

export const sayInChat = defineRoute({
  method: "post",
  path: "/v1/public/chat/messages",
  summary: "Say something in a website chat, and get the answer",
  description:
    "The visitor's words go into the company's inbox first. Then the assistant answers from the company's own facts, or a person is asked to: when the visitor asks for one, when the assistant is unsure, would have quoted a price the company has not published, or has reached its limit. A repeat of the same idempotency key is one message and one answer.",
  module: "M27",
  permissions: [],
  authorization: "public",
  idempotent: true,
  input: z.object({ companyKey: CompanyKey, token: ChatToken, text: z.string().min(1).max(2000) }),
  output: ChatTranscript,
});

export const readChat = defineRoute({
  method: "post",
  path: "/v1/public/chat/transcript",
  summary: "Read a website chat",
  description:
    "A POST so the chat's token travels in the body rather than in an address a proxy logs. A read, so a repeat is the same answer. `after` returns only what is newer, which is how the widget sees a person's reply from the inbox.",
  module: "M27",
  permissions: [],
  authorization: "public",
  idempotent: true,
  input: z.object({ companyKey: CompanyKey, token: ChatToken, after: z.string().datetime().optional() }),
  output: ChatTranscript,
});

export const agentRoutes = {
  listAgents, configureAgent, listAgentActivity,
  listIntakeDrafts, createIntakeDraft, approveIntakeDraft, dismissIntakeDraft, bookBookingRequest,
  listEstimateDrafts, createEstimateDraft, acceptEstimateDraft, dismissEstimateDraft,
  listCollectionReminders, runCollections, sendCollectionReminder, dismissCollectionReminder,
  listDispatchPlans, createDispatchPlan, applyDispatchPlan, dismissDispatchPlan,
  getChatWidget, startChat, sayInChat, readChat,
} as const;
