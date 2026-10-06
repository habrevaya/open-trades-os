import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";

/**
 * M12. THE DOCUMENTS A PROJECT RUNS ON.
 *
 * Change orders, the schedule, applications for payment, and notices and
 * waivers. Each is a page somebody signs, certifies, follows or files, and
 * each is reachable here exactly as the office screens reach it.
 *
 * THE PERMISSIONS FOLLOW THE LINES THE PRESETS ALREADY DRAW. A change order
 * is a quote for work that was not in the first one, so pricing, sending and
 * recording a customer's answer are the estimate's permissions; logging that
 * the customer asked is `job:write`, like the rest of the project's
 * structure. The schedule is structure. An application for payment and the
 * waivers against payments are money, so they are `invoice:read` and
 * `invoice:write`, which the dispatcher preset very deliberately does not
 * hold.
 */

const IsoDate = z.string().date();

const ChangeOrderStatus = z.enum(["requested", "priced", "sent", "approved", "declined", "void"]);

export const ChangeOrder = z.object({
  id: Uuid,
  projectId: Uuid,
  number: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  requestedBy: z.string().nullable(),
  reason: z.string().nullable(),
  status: ChangeOrderStatus,
  projectPhaseId: Uuid.nullable(),
  phaseName: z.string().nullable(),
  /** Days added to the programme, or taken off. Printed on the change order, not applied to the schedule. */
  scheduleDays: z.number().int().nullable(),
  /** Negative for a credit. */
  amount: MoneyString,
  /** Null for a caller without job.cost:read, and when a line's cost is unknown. */
  cost: MoneyString.nullable(),
  sentAt: z.string().datetime().nullable(),
  decidedAt: z.string().datetime().nullable(),
  /** portal when the customer signed through the link, office when somebody recorded it. */
  decidedVia: z.string().nullable(),
  signerName: z.string().nullable(),
  declineReason: z.string().nullable(),
  /** The contract either side of agreeing it. The change order log prints these. */
  contractValueBefore: MoneyString.nullable(),
  contractValueAfter: MoneyString.nullable(),
  voidReason: z.string().nullable(),
  createdAt: z.string().datetime(),
  lines: z.array(z.object({
    id: Uuid,
    name: z.string(),
    description: z.string().nullable(),
    quantity: MoneyString,
    unitPrice: MoneyString,
    lineTotal: MoneyString,
    /** price_book, rate_card or manual. */
    priceSource: z.string(),
    priceBookItemId: Uuid.nullable(),
    unitCost: MoneyString.nullable(),
  })),
});

export const listChangeOrders = defineRoute({
  method: "get",
  path: "/v1/projects/{projectId}/change-orders",
  summary: "The change order log",
  description: "Every change order on the project in the order they were raised, with the contract before and after each one that was agreed.",
  module: "M12",
  permissions: ["job:read"],
  input: z.object({ projectId: Uuid }),
  output: z.object({ changeOrders: z.array(ChangeOrder) }),
});

export const requestChangeOrder = defineRoute({
  method: "post",
  path: "/v1/projects/{projectId}/change-orders",
  summary: "Log a change the customer asked for",
  description: "Nothing is priced yet, which is a real state: asked for on site on Tuesday, priced in the office on Thursday. Numbered per project.",
  module: "M12",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    projectId: Uuid,
    title: z.string().min(1).max(200),
    description: z.string().max(5000).nullable().optional(),
    requestedBy: z.string().max(200).nullable().optional(),
    reason: z.string().max(2000).nullable().optional(),
    /** The phase the work lands on. A credit has to name one. */
    phaseId: Uuid.nullable().optional(),
    scheduleDays: z.number().int().min(-3650).max(3650).nullable().optional(),
  }),
  output: ChangeOrder,
});

export const getChangeOrder = defineRoute({
  method: "get",
  path: "/v1/project-change-orders/{id}",
  summary: "One change order, with its lines",
  module: "M12",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: ChangeOrder,
});

export const updateChangeOrder = defineRoute({
  method: "patch",
  path: "/v1/project-change-orders/{id}",
  summary: "Change what a change order says, before it is sent",
  description: "Refused once the customer has the link: their signature covers a hash of the page as sent. Withdraw it and raise another.",
  module: "M12",
  permissions: ["estimate:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    title: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    requestedBy: z.string().max(200).nullable().optional(),
    reason: z.string().max(2000).nullable().optional(),
    phaseId: Uuid.nullable().optional(),
    scheduleDays: z.number().int().min(-3650).max(3650).nullable().optional(),
  }),
  output: ChangeOrder,
});

export const addChangeOrderLine = defineRoute({
  method: "post",
  path: "/v1/project-change-orders/{changeOrderId}/lines",
  summary: "Price a line on a change order",
  description:
    "From the price book (the version in force today), from the customer's contract rate card where one covers the item, or typed by hand with a price. An item a rate card applies to and does not cover is refused rather than priced at list: somebody has to agree that price with the client first. A credit is a negative quantity.",
  module: "M12",
  permissions: ["estimate:write"],
  idempotent: true,
  input: z.object({
    changeOrderId: Uuid,
    priceBookItemId: Uuid.nullable().optional(),
    name: z.string().max(200).nullable().optional(),
    description: z.string().max(2000).nullable().optional(),
    quantity: MoneyString.default("1"),
    /** For a line typed by hand only. */
    unitPrice: MoneyString.nullable().optional(),
    unitCost: MoneyString.nullable().optional(),
  }),
  output: ChangeOrder,
});

export const removeChangeOrderLine = defineRoute({
  method: "delete",
  path: "/v1/project-change-orders/{changeOrderId}/lines/{lineId}",
  summary: "Take a line off a change order",
  module: "M12",
  permissions: ["estimate:write"],
  input: z.object({ changeOrderId: Uuid, lineId: Uuid }),
  output: ChangeOrder,
});

export const sendChangeOrder = defineRoute({
  method: "post",
  path: "/v1/project-change-orders/{id}/send",
  summary: "Send a change order to the customer to approve and sign",
  description:
    "Mints an approval link for this change order alone, through the same grant machinery as an estimate's, and emails it when asked. Checked against the project first, so a credit that cannot be agreed is refused before anybody is asked to sign it. Sending again withdraws the earlier link. The link exists in plaintext only in this response, so a replayed request returns null.",
  module: "M12",
  permissions: ["estimate:send", "portal:grant"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    channel: z.enum(["link", "email"]).default("link"),
    expiresInDays: z.number().int().min(1).max(365).default(30),
  }),
  output: z.object({
    id: Uuid,
    status: ChangeOrderStatus,
    url: z.string().url().nullable(),
    emailed: z.boolean(),
    reason: z.string().nullable(),
  }),
});

export const decideChangeOrder = defineRoute({
  method: "post",
  path: "/v1/project-change-orders/{id}/decision",
  summary: "Record the customer's answer, given in person",
  description:
    "Approving folds the amount into the contract value and the phase it names, and the cost into the budget, in the same transaction as the signature record. A credit that would take the contract below what has been billed is refused. Recording the same answer twice changes nothing; recording the opposite one is refused.",
  module: "M12",
  permissions: ["estimate:approve"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    decision: z.enum(["approved", "declined"]),
    signerName: z.string().max(200).nullable().optional(),
    reason: z.string().max(2000).nullable().optional(),
  }),
  output: ChangeOrder,
});

export const withdrawChangeOrder = defineRoute({
  method: "post",
  path: "/v1/project-change-orders/{id}/withdraw",
  summary: "Withdraw a change order nobody has agreed to",
  description: "The reason stays on the log and the link stops working. An agreed change is undone by a credit, so the record shows both.",
  module: "M12",
  permissions: ["estimate:write"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().min(1).max(2000) }),
  output: ChangeOrder,
});

/* ----------------------------------------------------------- the customer */

export const PortalChangeOrder = z.object({
  organizationName: z.string(),
  projectName: z.string(),
  propertyAddress: z.string(),
  customerName: z.string(),
  number: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  reason: z.string().nullable(),
  phaseName: z.string().nullable(),
  scheduleDays: z.number().int().nullable(),
  status: ChangeOrderStatus,
  lines: z.array(z.object({
    name: z.string(),
    description: z.string().nullable(),
    quantity: MoneyString,
    unitPrice: MoneyString,
    lineTotal: MoneyString,
  })),
  amount: MoneyString,
  contractValue: MoneyString.nullable(),
  contractValueAfter: MoneyString.nullable(),
  signerName: z.string().nullable(),
  decidedAt: z.string().datetime().nullable(),
});

export const viewPortalChangeOrder = defineRoute({
  method: "get",
  path: "/v1/portal/change-order",
  summary: "View a change order as the customer",
  description: "No cost, no margin, no price source: built from what the customer is entitled to see. Reading does not spend the link.",
  module: "M12",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: z.string().min(20).max(200) }),
  output: PortalChangeOrder,
});

export const approvePortalChangeOrder = defineRoute({
  method: "post",
  path: "/v1/portal/change-order/approve",
  summary: "Approve and sign a change order",
  description:
    "Spends the link. The signature is recorded with a hash of the change order as sent, the address and the browser, and the contract moves in the same transaction. A change order edited after sending, or one that can no longer be agreed as written, is refused.",
  module: "M12",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({
    token: z.string().min(20).max(200),
    signerName: z.string().min(1).max(200),
    acceptedTerms: z.literal(true),
  }),
  output: PortalChangeOrder,
});

export const declinePortalChangeOrder = defineRoute({
  method: "post",
  path: "/v1/portal/change-order/decline",
  summary: "Decline a change order",
  module: "M12",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({ token: z.string().min(20).max(200), reason: z.string().max(1000).optional() }),
  output: z.object({ ok: z.literal(true) }),
});

/* ------------------------------------------------------------ the schedule */

export const getProjectSchedule = defineRoute({
  method: "get",
  path: "/v1/projects/{projectId}/schedule",
  summary: "The phases on a timeline, with the critical path and who is booked",
  description:
    "Each phase's dates, what it waits for, its float in days and whether it is on the critical path: a day lost there is a day on the finish. Computed against the planned dates. Who is booked is read from the visits on each phase's jobs, so it is the dispatch board's booking and not a second one.",
  module: "M12",
  permissions: ["job:read"],
  input: z.object({ projectId: Uuid }),
  output: z.object({
    projectId: Uuid,
    name: z.string(),
    start: IsoDate.nullable(),
    finish: IsoDate.nullable(),
    targetCompletionOn: IsoDate.nullable(),
    criticalPath: z.array(Uuid),
    statement: z.string(),
    phases: z.array(z.object({
      id: Uuid,
      sequence: z.number().int(),
      name: z.string(),
      status: z.enum(["not_started", "in_progress", "blocked", "complete"]),
      dependsOnPhaseId: Uuid.nullable(),
      startsOn: IsoDate.nullable(),
      endsOn: IsoDate.nullable(),
      durationDays: z.number().int().nullable(),
      floatDays: z.number().int().nullable(),
      critical: z.boolean(),
      overlapsPredecessor: z.boolean(),
      booked: z.object({
        technicians: z.array(z.object({ id: Uuid, name: z.string(), visits: z.number().int() })),
        crews: z.array(z.object({ id: Uuid, name: z.string(), visits: z.number().int() })),
        unassignedVisits: z.number().int(),
      }),
    })),
  }),
});

export const moveProjectPhase = defineRoute({
  method: "post",
  path: "/v1/project-phases/{id}/move",
  summary: "Drag a phase to a new start, and everything waiting for it with it",
  description:
    "Every phase downstream moves by the same number of days and keeps its length. Refused when the new start is on or before the day the phase it waits for ends (the earliest possible start is named), when the phase is complete, or when something after it is complete. The start is absolute, so a retry moves nothing further.",
  module: "M12",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, startsOn: IsoDate }),
  output: z.object({
    shiftDays: z.number().int(),
    moves: z.array(z.object({ id: Uuid, startsOn: IsoDate, endsOn: IsoDate })),
  }),
});

export const setProjectPhaseDates = defineRoute({
  method: "post",
  path: "/v1/project-phases/{id}/dates",
  summary: "Give a phase its own start and end",
  description: "Only this phase. A start on or before the end of the phase it waits for is refused.",
  module: "M12",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, startsOn: IsoDate.nullable(), endsOn: IsoDate.nullable() }),
  output: z.object({ id: Uuid, startsOn: IsoDate.nullable(), endsOn: IsoDate.nullable() }),
});

/* ------------------------------------------------ applications for payment */

const ApplicationStatus = z.enum(["draft", "invoiced"]);

const ApplicationTotals = z.object({
  originalContractSum: MoneyString,
  netChangeOrders: MoneyString,
  contractSumToDate: MoneyString,
  totalCompletedAndStored: MoneyString,
  retainageOnWork: MoneyString,
  retainageOnStored: MoneyString,
  retainageReleased: MoneyString,
  totalRetainage: MoneyString,
  totalEarnedLessRetainage: MoneyString,
  previousCertificates: MoneyString,
  currentPaymentDue: MoneyString,
  balanceToFinish: MoneyString,
});

export const Application = z.object({
  id: Uuid,
  projectId: Uuid,
  projectName: z.string(),
  number: z.number().int(),
  periodFrom: IsoDate.nullable(),
  periodTo: IsoDate,
  status: ApplicationStatus,
  retainageRate: RateString,
  storedRetainageRate: RateString,
  retainageReleased: MoneyString,
  notes: z.string().nullable(),
  invoiceId: Uuid.nullable(),
  invoicedAt: z.string().datetime().nullable(),
  lines: z.array(z.object({
    id: Uuid,
    key: z.string(),
    description: z.string(),
    scheduledValue: MoneyString,
    previousWork: MoneyString,
    previousStored: MoneyString,
    workThisPeriod: MoneyString,
    storedNow: MoneyString,
    completedAndStored: MoneyString,
    percentComplete: z.string(),
    balanceToFinish: MoneyString,
    thisPeriod: MoneyString,
  })),
  /** Null while the draft has something wrong with it; `problems` says what. */
  totals: ApplicationTotals.nullable(),
  problems: z.array(z.string()),
});

export const listProjectApplications = defineRoute({
  method: "get",
  path: "/v1/projects/{projectId}/applications",
  summary: "Applications for payment on a project",
  module: "M12",
  permissions: ["invoice:read"],
  input: z.object({ projectId: Uuid }),
  output: z.object({
    applications: z.array(z.object({
      id: Uuid,
      number: z.number().int(),
      periodFrom: IsoDate.nullable(),
      periodTo: IsoDate,
      status: ApplicationStatus,
      currentPaymentDue: MoneyString.nullable(),
      totalRetainage: MoneyString.nullable(),
      invoiceId: Uuid.nullable(),
    })),
  }),
});

export const createProjectApplication = defineRoute({
  method: "post",
  path: "/v1/projects/{projectId}/applications",
  summary: "Start the next application for payment",
  description:
    "Lines come from the schedule of values (phases with a billing value, then agreed change orders that landed on no phase), with the previous figures copied from the last invoiced application. Refused on a project billed by draws, while another application is a draft, and with no contract value. Retainage rates carry over from the last application, or start from the project's.",
  module: "M12",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({
    projectId: Uuid,
    periodTo: IsoDate,
    periodFrom: IsoDate.nullable().optional(),
    retainageRate: RateString.nullable().optional(),
    storedRetainageRate: RateString.nullable().optional(),
  }),
  output: Application,
});

export const getProjectApplication = defineRoute({
  method: "get",
  path: "/v1/project-applications/{id}",
  summary: "One application for payment, worked through",
  description: "A draft follows the schedule of values as it stands, so a change order agreed meanwhile appears on it. An invoiced one is frozen and says what it said.",
  module: "M12",
  permissions: ["invoice:read"],
  input: z.object({ id: Uuid }),
  output: Application,
});

export const updateProjectApplication = defineRoute({
  method: "patch",
  path: "/v1/project-applications/{id}",
  summary: "Fill in a draft application",
  description:
    "Work this period and stored materials per line, or how complete a line is to date as a percentage, from which the work this period is worked out. Saved even when the figures do not yet add up; the response's problems say what is wrong and raising it refuses until nothing is.",
  module: "M12",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    periodFrom: IsoDate.nullable().optional(),
    periodTo: IsoDate.optional(),
    retainageRate: RateString.optional(),
    storedRetainageRate: RateString.optional(),
    retainageReleased: MoneyString.optional(),
    notes: z.string().max(5000).nullable().optional(),
    lines: z.array(z.object({
      id: Uuid,
      workThisPeriod: MoneyString.optional(),
      storedNow: MoneyString.optional(),
      percentComplete: z.string().regex(/^\d{1,3}(\.\d{1,2})?$/).optional(),
    })).max(500).optional(),
  }),
  output: Application,
});

export const deleteProjectApplication = defineRoute({
  method: "delete",
  path: "/v1/project-applications/{id}",
  summary: "Delete a draft application",
  module: "M12",
  permissions: ["invoice:write"],
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, deleted: z.literal(true) }),
});

export const raiseProjectApplication = defineRoute({
  method: "post",
  path: "/v1/project-applications/{id}/raise",
  summary: "Raise the invoice for an application for payment",
  description:
    "One line per schedule of values line that moved this period, net of its share of the retainage held, and a line for retainage released; the lines add up to the payment due to the cent. Created through the billing service under a key derived from the application, so a retry returns the same invoice. The application's figures are then frozen.",
  module: "M12",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({
    applicationId: Uuid,
    invoiceId: Uuid,
    amount: MoneyString,
    created: z.boolean(),
  }),
});

/* -------------------------------------------------- notices and waivers */

const LienRecord = z.object({
  id: Uuid,
  kind: z.enum(["notice", "waiver"]),
  direction: z.enum(["sent", "received"]),
  condition: z.enum(["conditional", "unconditional"]).nullable(),
  scope: z.enum(["progress", "final"]).nullable(),
  title: z.string(),
  partyName: z.string(),
  onDate: IsoDate,
  throughDate: IsoDate.nullable(),
  amount: MoneyString.nullable(),
  invoiceId: Uuid.nullable(),
  invoiceNumber: z.number().int().nullable(),
  notes: z.string().nullable(),
  documents: z.array(z.object({ id: Uuid, fileName: z.string().nullable(), storageKey: z.string() })),
  createdAt: z.string().datetime(),
});

export const listProjectLienRecords = defineRoute({
  method: "get",
  path: "/v1/projects/{projectId}/lien-records",
  summary: "Notices and waivers on a project, with a checklist per payment",
  description:
    "Records only. The checklist says what is and is not on file against each payment the project billed; it does not know any state's lien law, and does not say what should have been sent.",
  module: "M12",
  permissions: ["invoice:read"],
  input: z.object({ projectId: Uuid }),
  output: z.object({
    records: z.array(LienRecord),
    checklist: z.array(z.object({
      invoiceId: Uuid,
      label: z.string(),
      amount: MoneyString,
      billedOn: IsoDate.nullable(),
      paid: z.boolean(),
      conditional: z.array(Uuid),
      unconditional: z.array(Uuid),
      notes: z.array(z.string()),
    })),
    disclaimer: z.string(),
  }),
});

export const recordProjectLienRecord = defineRoute({
  method: "post",
  path: "/v1/projects/{projectId}/lien-records",
  summary: "Record a notice or a waiver",
  description:
    "A waiver says conditional or unconditional, and progress or final; a notice says neither. The payment, when named, must be an invoice this project raised. The scanned paper can come with it, base64, which also needs document:write.",
  module: "M12",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({
    projectId: Uuid,
    kind: z.enum(["notice", "waiver"]),
    direction: z.enum(["sent", "received"]),
    condition: z.enum(["conditional", "unconditional"]).nullable().optional(),
    scope: z.enum(["progress", "final"]).nullable().optional(),
    title: z.string().min(1).max(200),
    partyName: z.string().min(1).max(200),
    onDate: IsoDate,
    throughDate: IsoDate.nullable().optional(),
    amount: MoneyString.nullable().optional(),
    invoiceId: Uuid.nullable().optional(),
    notes: z.string().max(5000).nullable().optional(),
    document: z.object({
      fileName: z.string().min(1).max(255),
      contentType: z.string().max(100).optional(),
      bytes: z.string().min(4).max(28 * 1024 * 1024),
    }).optional(),
  }),
  output: LienRecord,
});

export const deleteProjectLienRecord = defineRoute({
  method: "delete",
  path: "/v1/project-lien-records/{id}",
  summary: "Remove a notice or waiver entered by mistake",
  module: "M12",
  permissions: ["invoice:write"],
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, deleted: z.literal(true) }),
});

export const projectDocumentRoutes = {
  listChangeOrders, requestChangeOrder, getChangeOrder, updateChangeOrder,
  addChangeOrderLine, removeChangeOrderLine, sendChangeOrder, decideChangeOrder, withdrawChangeOrder,
  viewPortalChangeOrder, approvePortalChangeOrder, declinePortalChangeOrder,
  getProjectSchedule, moveProjectPhase, setProjectPhaseDates,
  listProjectApplications, createProjectApplication, getProjectApplication,
  updateProjectApplication, deleteProjectApplication, raiseProjectApplication,
  listProjectLienRecords, recordProjectLienRecord, deleteProjectLienRecord,
} as const;
