import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * THE WORDS, AND WHO THE CARRIERS THINK YOU ARE
 *
 * Two tables that have been in the schema since the first migration with
 * nothing ever written to them, and they are the two halves of being able to
 * text a customer at all.
 *
 * TEMPLATES are the wording. Until now every message this product sends was a
 * string literal in a service: the arrival notice built by a function no
 * operator can reach, and a workflow step carrying its body inside the
 * automation that sends it. A company's texts are its voice to somebody
 * standing in their driveway, and the wording is the first thing they want to
 * change. Needing a developer to change it means it never changes.
 *
 * REGISTRATION is permission. In the United States a business cannot send
 * application-to-person SMS until a carrier has vetted the business and
 * approved the use case. Unregistered traffic is not rejected loudly, it is
 * filtered silently and counts against the sender, so the texts stop arriving
 * and nobody is told.
 *
 * NOTHING HERE SUBMITS A REGISTRATION. An operator registers in their
 * carrier's own portal, which is where the process actually lives, and
 * records here what they submitted and what came back. That is said plainly
 * because a status of "submitted" beside a button could reasonably be read as
 * this software having submitted something.
 */

export const MessageChannel = z.enum(["sms", "mms", "voice", "email", "webchat"]);
export const MessagePurpose = z.enum(["transactional", "marketing"]);
export const RegistrationStatus = z.enum([
  "not_started", "submitted", "pending_review", "approved", "rejected", "suspended",
]);

export const MessageTemplate = z.object({
  id: Uuid,
  /** The stable name a workflow step and a service refer to it by. */
  code: z.string(),
  name: z.string(),
  channel: z.string(),
  purpose: z.string(),
  subject: z.string().nullable(),
  body: z.string(),
  variables: z.array(z.string()),
  active: z.boolean(),
});

const Body = z.string().min(1).max(4000);
const Code = z.string().min(1).max(64);

export const defineMessageTemplate = defineRoute({
  method: "post",
  path: "/v1/message-templates",
  summary: "Write the wording a customer will read",
  description:
    "Refuses a body using a placeholder it does not declare. An undeclared placeholder is not an error when the message is sent: it resolves to nothing, the customer reads a sentence with a hole in it, and nothing anywhere reports it. Definition time is the only moment somebody who can fix it is looking.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    code: Code,
    name: z.string().min(1).max(200),
    channel: MessageChannel,
    purpose: MessagePurpose.optional(),
    /** Required on email, refused on anything with no subject line. */
    subject: z.string().max(300).nullable().optional(),
    body: Body,
    variables: z.array(z.string().min(1).max(100)).max(50).optional(),
    active: z.boolean().optional(),
  }),
  output: MessageTemplate,
});

export const listMessageTemplates = defineRoute({
  method: "get",
  path: "/v1/message-templates",
  summary: "Every wording this company has written",
  module: "M18",
  permissions: ["settings:read"],
  input: z.object({ channel: MessageChannel.optional() }),
  output: z.object({ templates: z.array(MessageTemplate) }),
});

export const updateMessageTemplate = defineRoute({
  method: "patch",
  path: "/v1/message-templates/{id}",
  summary: "Change the wording",
  description:
    "The code cannot change: services and workflow steps name it by that string, so renaming would leave every one of them quietly back on its built in wording. Editing a template does not rewrite what was already sent, because a message keeps its own rendered body.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    channel: MessageChannel.optional(),
    purpose: MessagePurpose.optional(),
    subject: z.string().max(300).nullable().optional(),
    body: Body.optional(),
    variables: z.array(z.string().min(1).max(100)).max(50).optional(),
    active: z.boolean().optional(),
  }),
  output: MessageTemplate,
});

export const deleteMessageTemplate = defineRoute({
  method: "delete",
  path: "/v1/message-templates/{id}",
  summary: "Stop using this wording",
  description:
    "The row is kept and stops being used, so anything naming its code falls back to the wording this product ships with rather than failing, and the audit trail for every message sent from it still names something.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const previewMessageTemplate = defineRoute({
  method: "post",
  path: "/v1/message-templates/preview",
  summary: "See what it will actually say",
  description:
    "Names the declared variables the sample had nothing for, rather than refusing. At send time a gap is reported and the message still goes, because the person waiting is a technician in a driveway; here it is the operator who can fix it.",
  module: "M18",
  permissions: ["settings:read"],
  idempotent: true,
  input: z.object({
    code: Code,
    /** Sample values. Anything the template names and this omits comes back in `missing`. */
    scope: z.record(z.unknown()).optional(),
  }),
  output: z.object({
    code: z.string(),
    channel: z.string(),
    purpose: z.string(),
    subject: z.string().nullable(),
    body: z.string(),
    missing: z.array(z.string()),
  }),
});

/* ------------------------------------------------------------ registration */

export const MessagingCampaign = z.object({
  id: Uuid,
  brandId: Uuid,
  purpose: z.string(),
  useCase: z.string(),
  description: z.string().nullable(),
  /** What the carrier audits a customer's agreement against. */
  optInDescription: z.string().nullable(),
  sampleMessages: z.array(z.string()),
  /** Carrier assigned throughput, so a sender can pace rather than fail. */
  messagesPerSecond: z.number().int().nullable(),
  dailyCap: z.number().int().nullable(),
  status: z.string(),
  statusReason: z.string().nullable(),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
});

export const MessagingBrand = z.object({
  id: Uuid,
  legalName: z.string(),
  displayName: z.string(),
  entityType: z.string().nullable(),
  /** Four digits. The carrier has the whole one, because you gave it to them. */
  taxIdLast4: z.string().nullable(),
  website: z.string().nullable(),
  externalBrandId: z.string().nullable(),
  status: z.string(),
  statusReason: z.string().nullable(),
  submittedAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
});

export const recordMessagingBrand = defineRoute({
  method: "post",
  path: "/v1/messaging/brands",
  summary: "Write down the business the carriers vetted",
  description:
    "A record of a registration performed in the carrier's own portal, not a submission made from here. Records four digits of a tax id and never the whole one: the carrier already has it, and a full one in this row would be in every backup and every support export to answer a question nothing here asks.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    legalName: z.string().min(1).max(300),
    displayName: z.string().min(1).max(300),
    entityType: z.string().max(100).nullable().optional(),
    taxIdLast4: z.string().max(4).nullable().optional(),
    website: z.string().max(500).nullable().optional(),
    externalBrandId: z.string().max(200).nullable().optional(),
  }),
  output: MessagingBrand,
});

export const setMessagingBrandStatus = defineRoute({
  method: "post",
  path: "/v1/messaging/brands/{id}/status",
  summary: "Record what the carrier said",
  description:
    "Refuses a rejection or a suspension with no reason. The one thing an operator needs from a refused registration is what to change, and the carrier's own words are the only source of it; a rejected row with a blank reason gets resubmitted unchanged.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    status: RegistrationStatus,
    reason: z.string().max(2000).nullable().optional(),
    externalBrandId: z.string().max(200).optional(),
  }),
  output: MessagingBrand,
});

export const recordMessagingCampaign = defineRoute({
  method: "post",
  path: "/v1/messaging/campaigns",
  summary: "Write down an approved use case",
  description:
    "One per purpose per brand, which is how transactional and marketing stay separable all the way down to the carrier. The opt in language and the sample messages are required, because they are what an audit compares real traffic against and in eighteen months the form on your website will not be the one you registered.",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    brandId: Uuid,
    purpose: MessagePurpose,
    useCase: z.string().min(1).max(200),
    description: z.string().max(2000).nullable().optional(),
    optInDescription: z.string().min(1).max(4000),
    sampleMessages: z.array(z.string().min(1).max(1000)).min(1).max(20),
  }),
  output: MessagingCampaign,
});

export const setMessagingCampaignStatus = defineRoute({
  method: "post",
  path: "/v1/messaging/campaigns/{id}/status",
  summary: "Record what the carrier said, and the throughput it granted",
  module: "M18",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    status: RegistrationStatus,
    reason: z.string().max(2000).nullable().optional(),
    externalCampaignId: z.string().max(200).optional(),
    messagesPerSecond: z.number().int().min(0).max(10000).optional(),
    dailyCap: z.number().int().min(0).max(10_000_000).optional(),
  }),
  output: MessagingCampaign,
});

export const listMessagingRegistrations = defineRoute({
  method: "get",
  path: "/v1/messaging/registrations",
  summary: "What is registered, and what the carrier said about it",
  module: "M18",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({
    brands: z.array(MessagingBrand.extend({ campaigns: z.array(MessagingCampaign) })),
  }),
});

export const messagingRoutes = {
  defineMessageTemplate, listMessageTemplates, updateMessageTemplate,
  deleteMessageTemplate, previewMessageTemplate,
  recordMessagingBrand, setMessagingBrandStatus,
  recordMessagingCampaign, setMessagingCampaignStatus, listMessagingRegistrations,
} as const;
