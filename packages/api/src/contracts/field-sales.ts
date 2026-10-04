import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * SELLING AND CLOSING ON SITE, THE CALLS THAT NEED A SIGNAL
 *
 * Almost everything a technician does to sell and close travels through the
 * field queue (`POST /v1/field/sync`), so it works in a basement. These are
 * the few things that cannot: a lender's application link, which only the
 * lender can make, and the field assistant, which asks a model. Both are
 * asked for there and then or not at all, the way the card link and the
 * on-my-way text are.
 *
 * And the company's how-to notes, which the office writes and the assistant
 * answers from.
 */

/**
 * The lender's application link for the job on this visit, so the customer
 * can apply to spread the cost on their own phone, there and then.
 */
export const visitFinancingLink = defineRoute({
  method: "post",
  path: "/v1/visits/{id}/financing-link",
  summary: "A financing application link for the job on this visit",
  description:
    "For the technician on the visit, or anybody who may send invoices, and only with a lender connected (M13). Opens an application for what is owing on the job's open invoice, or reuses the one already open for that amount, and texts it to the customer's number on file with `text: true`, through the same consent rules as every other text. Refused with a sentence when nothing is owing or no lender is connected. The lender decides; nothing about the customer's credit is kept beyond the status the lender returns.",
  module: "M13",
  permissions: ["payment:collect"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    text: z.boolean().default(false),
  }),
  output: z.object({
    url: z.string(),
    invoiceId: Uuid,
    invoiceNumber: z.number().int(),
    amount: MoneyString,
    lender: z.string(),
    texted: z.boolean(),
    /** Why it was not texted, in words for the person on site. Null when it was, or was not asked. */
    reason: z.string().nullable(),
  }),
});

const FieldAnswer = z.object({
  /** False when the company's records do not answer it, or the answer could not be checked against them. */
  answered: z.boolean(),
  /** The answer, or what the records do not say, in plain words for a phone. */
  text: z.string(),
  /** What it came from, so the technician can see it was the company's own records. */
  sources: z.array(z.object({ kind: z.string(), title: z.string() })),
});

/**
 * A technician's question, answered from the company's own records.
 *
 * Under `/v1/ai/`, which is never offered to a model as a tool, so an agent
 * cannot ask another agent.
 */
export const askFieldAssistant = defineRoute({
  method: "post",
  path: "/v1/ai/field-assistant",
  summary: "Ask the field assistant",
  description:
    "Answers a technician's question in plain words from the company's own records: the equipment at the visit's address and its service history, the notes on this visit and earlier ones there, price book prices, and the company's how-to notes. Every kind of record is given to the model only when the person asking may read it, and never a cost. The answer must cite what it came from and may state only prices those records state; one that does not is not shown. Runs as the person asking, within the company's spend ceiling and the assistant's runs a day, and is written in the agents' log. A retry with the same idempotency key answers again from the record, without asking the model twice.",
  module: "M27",
  permissions: ["field:sync"],
  idempotent: true,
  input: z.object({
    question: z.string().min(3).max(1000),
    /** The visit they are on, so its equipment, notes and job come with the question. */
    visitId: Uuid.optional(),
  }),
  output: FieldAnswer,
});

const KnowledgeNote = z.object({
  id: Uuid,
  title: z.string(),
  body: z.string(),
  tags: z.array(z.string()),
  updatedAt: z.string().datetime(),
  updatedByName: z.string().nullable(),
});

export const listKnowledgeNotes = defineRoute({
  method: "get",
  path: "/v1/knowledge-notes",
  summary: "The company's how-to notes",
  description: "Newest change first. Readable by anybody who reads jobs, because the people who need them are the people doing the work.",
  module: "M27",
  permissions: ["job:read"],
  input: z.object({}),
  output: z.object({ notes: z.array(KnowledgeNote) }),
});

const NoteInput = z.object({
  title: z.string().trim().min(3).max(200),
  body: z.string().trim().min(3).max(10000),
  /** Words a technician might ask with that are not in the title: a brand, a model, a nickname. */
  tags: z.array(z.string().trim().min(1).max(40)).max(20).default([]),
});

export const createKnowledgeNote = defineRoute({
  method: "post",
  path: "/v1/knowledge-notes",
  summary: "Write a how-to note",
  module: "M27",
  permissions: ["knowledge:write"],
  idempotent: true,
  input: NoteInput,
  output: KnowledgeNote,
});

export const updateKnowledgeNote = defineRoute({
  method: "patch",
  path: "/v1/knowledge-notes/{id}",
  summary: "Change a how-to note",
  module: "M27",
  permissions: ["knowledge:write"],
  input: NoteInput.partial().extend({ id: Uuid }),
  output: KnowledgeNote,
});

export const removeKnowledgeNote = defineRoute({
  method: "delete",
  path: "/v1/knowledge-notes/{id}",
  summary: "Stop answering from a how-to note",
  description: "Taken out of use rather than erased, so an answer given from it earlier can still be traced to what it said.",
  module: "M27",
  permissions: ["knowledge:write"],
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.boolean() }),
});

export const fieldSalesRoutes = {
  visitFinancingLink, askFieldAssistant,
  listKnowledgeNotes, createKnowledgeNote, updateKnowledgeNote, removeKnowledgeNote,
} as const;
