import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * THE LAST TABLE IN THIS SCHEMA THAT NOTHING TOUCHED
 *
 * `external_work_order` was written in the first migrations with no reader and no
 * writer. Its own comment says what it is for and what the hard part is: in five
 * segments the work order is created elsewhere and we mirror it, THE EXTERNAL
 * SYSTEM IS THE SYSTEM OF RECORD, and a local edit that conflicts loses or
 * escalates.
 *
 * There is no Corrigo adapter and no ServiceChannel adapter here, because each is
 * a vendor approval and a contract rather than code, and one written against
 * documentation without a sandbox looks finished and has never run. What is here
 * is the half that does not depend on them: the mirror, the state machine, the
 * conflict rule and the push queue.
 */

export const WorkOrderState = z.enum([
  "offered", "accepted", "rejected", "in_progress", "completed",
  "cancelled_by_client", "reopened", "invoiced", "closed",
]);

const OrderView = z.object({
  id: Uuid,
  sourceSystem: z.string(),
  sourceLabel: z.string(),
  externalId: z.string(),
  externalNumber: z.string().nullable(),
  state: WorkOrderState,
  externalStatus: z.string().nullable(),
  externalIsSystemOfRecord: z.boolean(),
  acceptanceIsIrreversible: z.boolean(),
  acceptsViaInvoiceOnly: z.boolean(),
  jobId: Uuid.nullable(),
  /** Who the order is for, as one of our customers, when the sync or the office said. */
  customerId: Uuid.nullable(),
  clientName: z.string().nullable(),
  /** The client's own codes for the work, as they sent them. */
  clientCodes: z.array(z.object({
    code: z.string(), quantity: z.string().nullable(), description: z.string().nullable(),
  })),
  payload: z.record(z.unknown()),
  lastSyncedAt: z.string().nullable(),
  pendingPush: z.boolean(),
  lastPushError: z.string().nullable(),
  /** Worked out here rather than left to a screen to guess. */
  weMayMoveTo: z.array(WorkOrderState),
});

export const receiveExternalWorkOrder = defineRoute({
  method: "post",
  path: "/v1/external-work-orders",
  summary: "Mirror a work order from a client's system",
  description:
    "IDEMPOTENT ON THEIR OWN KEY, which the unique index on (organization, source system, external id) holds: a network that resends an order is the ordinary case rather than an error, since they retry, replay a queue after an outage, and send the same order to several vendors. A repeat updates their status and their payload and LEAVES OUR STATE ALONE, because an order we accepted and started does not go back to offered because their queue replayed. It always arrives as `offered`: a sync that could create one already accepted would let a middleware bug accept work on a contractor's behalf, and the first anybody would know is a missed appointment. Their status string is kept verbatim and never mapped on the way in.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({
    sourceSystem: z.string().min(1).max(100),
    externalId: z.string().min(1).max(200),
    externalNumber: z.string().max(200).nullable().optional(),
    externalStatus: z.string().max(200).nullable().optional(),
    payload: z.record(z.unknown()).optional(),
    acceptanceIsIrreversible: z.boolean().optional(),
    acceptsViaInvoiceOnly: z.boolean().optional(),
    /** The client the order is for, as one of our customers. Left alone on a resend once a job is on the order. */
    customerId: Uuid.nullable().optional(),
    /** The client's own codes for the work. Replaced on a resend that sends them, never mapped on the way in. */
    codes: z.array(z.object({
      code: z.string().min(1).max(100),
      quantity: z.string().max(20).nullable().optional(),
      description: z.string().max(500).nullable().optional(),
    })).max(50).optional(),
  }),
  output: OrderView,
});

export const moveExternalWorkOrder = defineRoute({
  method: "post",
  path: "/v1/external-work-orders/{id}/move",
  summary: "Accept, decline or progress an order from our side",
  description:
    "What WE may do, which is deliberately narrower than what they may do. `cancelled_by_client` and `reopened` are refused from this side because neither is ours to declare: a contractor who could mark an order cancelled by the client could make their own missed deadline look like the client's change of mind, and the portal would disagree the moment anybody looked. Accepting is refused on a network that has no accept call, with the instruction to submit the invoice instead. Declining after acceptance is refused where the network makes acceptance final, because a product that lets a dispatcher un-accept has taught them a habit that costs a chargeback. A declined order never carries a job: half of what arrives on a facilities network is declined, and a job on the board nobody is doing is a dispatcher's problem and a margin report's. Every move except back to offered sets the push queue flag.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    to: WorkOrderState,
    jobId: Uuid.nullable().optional(),
    note: z.string().max(1000).optional(),
  }),
  output: OrderView,
});

export const acceptExternalWorkOrderViaInvoice = defineRoute({
  method: "post",
  path: "/v1/external-work-orders/{id}/accept-via-invoice",
  summary: "Take an order on a network that has no accept call",
  description:
    "A manufacturer's dealer network takes a warranty job by receiving the claim, not by accepting a dispatch. Its own operation rather than a flag, because the two are different acts: one says we will do this, the other says we have done it and here is the bill, and a network that only accepts the second is not one where a dispatcher should be clicking Accept. Refused on a network that does have an accept call, because invoicing for work the client was never told we accepted is how a payment gets held.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({ id: Uuid, invoiceId: Uuid }),
  output: OrderView,
});

export const applyExternalWorkOrderRemote = defineRoute({
  method: "post",
  path: "/v1/external-work-orders/{id}/remote",
  summary: "Record what the client's system says, which wins",
  description:
    "THE INVARIANT THE TABLE WAS WRITTEN FOR. A CONTRADICTION IS NOT A MERGE AND IS NOT SILENT: when we were still holding a change they have not seen, theirs replaces it and ours is written down, with a sentence saying what was lost. 'We marked it complete on the 4th and their portal says it was still open on the 11th' is a dispute somebody has to be able to reconstruct, and it is the dispute that decides who pays for the trip. NO STATE VALIDATION ON THE WAY IN, deliberately: their portal has states we have never seen, renames them between releases and skips ours, so a status we cannot place is recorded verbatim with our state left where it was. Refusing an inbound update because its status was unfamiliar is the one failure this table exists to prevent.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** Their state. Anything unmapped is kept verbatim rather than refused. */
    state: z.string().min(1).max(100),
    externalStatus: z.string().max(200).nullable().optional(),
    payload: z.record(z.unknown()).optional(),
  }),
  output: z.object({
    order: OrderView,
    conflict: z.object({ lost: z.string(), note: z.string() }).nullable(),
  }),
});

export const listPendingExternalPushes = defineRoute({
  method: "get",
  path: "/v1/external-work-pushes",
  summary: "What the clients' systems have not been told",
  description:
    "The reader the (organization, pending push) index was built for and which nothing used. A status changed and never pushed is a contractor whose scorecard says they never responded, and the scorecard decides the next dispatch rather than this one. Oldest first, because the oldest unsent status is the one costing the most.",
  module: "M31",
  permissions: ["contract:read"],
  idempotent: true,
  input: z.object({ limit: z.number().int().min(1).max(500).default(100) }),
  output: z.object({ data: z.array(OrderView) }),
});

export const markExternalWorkOrderPushed = defineRoute({
  method: "post",
  path: "/v1/external-work-orders/{id}/pushed",
  summary: "The client's system has been told",
  description:
    "Separate from the move itself, because they are different events with different failure modes: one is a dispatcher deciding something, the other is a network accepting it. Collapsing them would mean a push that failed left the order looking as though nobody had decided anything.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: OrderView,
});

export const markExternalWorkOrderPushFailed = defineRoute({
  method: "post",
  path: "/v1/external-work-orders/{id}/push-failed",
  summary: "The push failed, and the order stays in the queue",
  description:
    "The queue flag is deliberately NOT cleared. A network that was down has to be told when it comes back, and an error that quietly removed the order from the queue would turn a retryable outage into a status the client never hears. A failure with no reason recorded is refused, because it is one nobody can act on while the order retries the same thing.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({ id: Uuid, error: z.string().min(1).max(2000) }),
  output: OrderView,
});

export const getExternalWorkOrder = defineRoute({
  method: "get",
  path: "/v1/external-work-orders/{id}",
  summary: "One mirrored work order",
  description:
    "Carries what we may move it to, worked out from the state and the network's own flags rather than left to a screen to guess, so an Accept button is not drawn on a network that has no accept call.",
  module: "M31",
  permissions: ["contract:read"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: OrderView,
});

export const listExternalWorkOrders = defineRoute({
  method: "get",
  path: "/v1/external-work-orders",
  summary: "Mirrored work orders, newest first",
  description: "Filterable by state, by network and by whether a push is owed.",
  module: "M31",
  permissions: ["contract:read"],
  idempotent: true,
  input: z.object({
    state: WorkOrderState.optional(),
    sourceSystem: z.string().max(100).optional(),
    pendingPush: z.boolean().optional(),
    limit: z.number().int().min(1).max(500).default(100),
  }),
  output: z.object({ data: z.array(OrderView) }),
});

export const listExternalWorkSources = defineRoute({
  method: "get",
  path: "/v1/external-work-sources",
  summary: "The networks this is built for, and what to know about each",
  description:
    "A read with no rows behind it, which is the point: a contractor needs to know that a warranty administrator's acceptance is FINAL before they click it rather than after. The defaults each network gets are the ones applied when an order from it first arrives. The list is documentation rather than a gate, so a network this company works that has no profile here is reported separately with the cautious defaults it was given, because a regional warranty administrator nobody here has heard of is as real as Corrigo.",
  module: "M31",
  permissions: ["contract:read"],
  idempotent: true,
  input: z.object({}),
  output: z.object({
    data: z.array(z.object({
      key: z.string(),
      label: z.string(),
      note: z.string(),
      acceptanceIsIrreversible: z.boolean(),
      acceptsViaInvoiceOnly: z.boolean(),
      orders: z.number().int(),
    })),
    unprofiled: z.array(z.object({ key: z.string(), orders: z.number().int() })),
    cautiousDefaults: z.object({
      acceptanceIsIrreversible: z.boolean(),
      acceptsViaInvoiceOnly: z.boolean(),
    }),
  }),
});

/* ------------------------------------------- a client's codes, mapped to ours */

const CodeRow = z.object({
  id: Uuid,
  code: z.string(),
  description: z.string().nullable(),
  jobTypeId: Uuid.nullable(),
  jobTypeName: z.string().nullable(),
  jobTypeActive: z.boolean(),
  priceBookItemId: Uuid.nullable(),
  itemCode: z.string().nullable(),
  itemName: z.string().nullable(),
  /** False when the item is switched off, removed, or has no price today: the code then adds no line. */
  itemSold: z.boolean(),
  quantity: z.string(),
  updatedAt: z.string(),
});

const CodeList = z.object({ customerId: Uuid, clientName: z.string(), data: z.array(CodeRow) });

export const listClientWorkCodes = defineRoute({
  method: "get",
  path: "/v1/customers/{customerId}/work-codes",
  summary: "A client's own work order codes, and what each means here",
  description:
    "One list per client, because two clients' PLB-07 are two different things. Each code maps to a kind of work (a job type), a price book item and how many, or both. A code whose item is no longer sold or whose job type is switched off is still listed, marked, and adds nothing to a proposal.",
  module: "M31",
  permissions: ["contract:read"],
  idempotent: true,
  input: z.object({ customerId: Uuid }),
  output: CodeList,
});

export const setClientWorkCodes = defineRoute({
  method: "put",
  path: "/v1/customers/{customerId}/work-codes",
  summary: "Replace a client's list of codes",
  description:
    "The whole list in one call: a row left out is taken off. Codes are matched without capitals or spaces at the ends. A code twice, a row mapped to nothing, a quantity that is not a number more than nothing, and a job type or item that is not this company's or not in use are each refused in words before anything is written. Audited with the list before and after.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({
    customerId: Uuid,
    codes: z.array(z.object({
      code: z.string().min(1).max(100),
      description: z.string().max(500).nullable().optional(),
      jobTypeId: Uuid.nullable().optional(),
      priceBookItemId: Uuid.nullable().optional(),
      quantity: z.string().max(20).optional(),
    })).max(200),
  }),
  output: CodeList,
});

export const setExternalWorkOrderClient = defineRoute({
  method: "put",
  path: "/v1/external-work-orders/{id}/client",
  summary: "Say which client an order is for",
  description:
    "The codes on an order mean nothing until somebody knows whose they are. Refused once a job is on the order, because the job was made for that customer.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({ id: Uuid, customerId: Uuid }),
  output: OrderView,
});

const CodeReading = z.object({
  code: z.string(),
  description: z.string().nullable(),
  quantity: z.string().nullable(),
  mappingId: z.string().nullable(),
  jobTypeName: z.string().nullable(),
  itemName: z.string().nullable(),
  words: z.string(),
  unmapped: z.boolean(),
});

export const getExternalWorkOrderProposal = defineRoute({
  method: "get",
  path: "/v1/external-work-orders/{id}/proposal",
  summary: "The job an order's codes propose, for the office to confirm",
  description:
    "A read. The client's codes on the order against the client's list: the kind of work when every code that names one names the same one (otherwise none, with a sentence saying which codes said what), a line per mapped item with its quantity times the order's, each priced by the client's card when it has one (matched on our item, then on their code) or by our price book, and every code nothing came of named in words. `refusal` says why the order cannot be taken this way (no client yet, a job already on it, or accepting not allowed from where it stands). `key` is sent back with the confirmation.",
  module: "M31",
  permissions: ["contract:read"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({
    orderId: Uuid,
    customerId: Uuid.nullable(),
    clientName: z.string().nullable(),
    refusal: z.string().nullable(),
    jobTypeId: Uuid.nullable(),
    jobTypeName: z.string().nullable(),
    jobTypeNote: z.string().nullable(),
    codes: z.array(CodeReading),
    lines: z.array(z.object({
      code: z.string(),
      priceBookItemId: Uuid,
      name: z.string(),
      quantity: z.string(),
      ourPrice: z.string(),
      unitPrice: z.string(),
      pricedBy: z.string(),
      note: z.string().nullable(),
      outOfScope: z.boolean(),
    })),
    unmapped: z.array(z.string()),
    places: z.array(z.object({ propertyId: Uuid, label: z.string(), siteNumber: z.string().nullable() })),
    key: z.string(),
  }),
});

export const acceptExternalWorkOrderAsProposed = defineRoute({
  method: "post",
  path: "/v1/external-work-orders/{id}/accept-as-proposed",
  summary: "Accept an order and make its job from the proposal",
  description:
    "Never silently: it carries the proposal's `key`, and a list or codes changed since the proposal was shown is refused, asking for another look. In one transaction it makes the job for the client at one of their addresses with the kind of work the office confirmed (the proposal's, another, or none), a line per mapped item at our price with the client's code on it so their card prices it by that code when it is billed, the codes nothing came of in the job's notes, and accepts the order with the job on it, owing the client a push. Refused, with nothing written, on an order that already has a job or that accepting is not allowed from. Accepting by hand (`/move`) is unchanged. A retry with the same idempotency key answers with the first job.",
  module: "M31",
  permissions: ["contract:write", "job:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    key: z.string().min(1).max(64),
    propertyId: Uuid,
    jobTypeId: Uuid.nullable(),
    summary: z.string().max(300).optional(),
  }),
  output: z.object({ order: OrderView, jobId: Uuid }),
});

export const externalWorkRoutes = {
  listClientWorkCodes,
  setClientWorkCodes,
  setExternalWorkOrderClient,
  getExternalWorkOrderProposal,
  acceptExternalWorkOrderAsProposed,
  receiveExternalWorkOrder,
  moveExternalWorkOrder,
  acceptExternalWorkOrderViaInvoice,
  applyExternalWorkOrderRemote,
  listPendingExternalPushes,
  listExternalWorkSources,
  getExternalWorkOrder,
  listExternalWorkOrders,
  markExternalWorkOrderPushed,
  markExternalWorkOrderPushFailed,
} as const;
