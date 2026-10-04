import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";

/**
 * MEMBERSHIPS AND SERVICE AGREEMENTS, ON THE API
 *
 * The book had a service and screens and no routes, so a migration could load
 * a company's whole history except the plans its members are on, and nothing
 * outside the browser could renew one. These are the routes the renewal work
 * needed and the two it cannot be tested without: defining a plan and selling
 * one. The rest of the book followed: editing and retiring a plan, reading the
 * book, and booking, delivering, skipping, billing and cancelling, each the
 * same call the screens make.
 */

const Frequency = z.enum(["monthly", "quarterly", "semiannual", "annual", "one_time"]);

export const AgreementPlanView = z.object({
  id: Uuid,
  name: z.string(),
  code: z.string().nullable(),
  description: z.string().nullable(),
  price: MoneyString,
  billingFrequency: z.string(),
  termMonths: z.number().int(),
  includedVisitsPerTerm: z.number().int(),
  /** Seasonal plans pin their visits to these months, 1 for January. */
  visitAnchorMonths: z.array(z.number().int()),
  /** The day of an anchor month a visit falls on. Null for the day the agreement was sold. */
  visitAnchorDay: z.number().int().nullable(),
  autoRenews: z.boolean(),
  renewalNoticeDays: z.number().int(),
  /** A fraction: 0.15 is fifteen per cent off eligible work for members. Frozen on each agreement at sale. */
  discountRate: RateString.nullable(),
  /** Members' unassigned work goes to the top of the dispatch board. */
  priorityDispatch: z.boolean(),
  /** The price book item marked as the diagnostic fee is taken off in full for members. */
  waivesDiagnosticFee: z.boolean(),
  /** The price book item marked as the after hours rate is taken off in full for members. */
  waivesAfterHoursRate: z.boolean(),
  /** What else a member gets, in the company's words, for the screen and the sale. */
  benefits: z.array(z.string()),
  active: z.boolean(),
});

export const AgreementView = z.object({
  id: Uuid,
  planId: Uuid,
  customerId: Uuid,
  propertyId: Uuid.nullable(),
  status: z.string(),
  startedOn: z.string().date(),
  /** The first day without cover. A term sold on 15 January ends on 15 January. */
  endsOn: z.string().date().nullable(),
  /** Frozen at sale, and kept on renewal unless a new one is given. */
  price: MoneyString,
  /** The member discount, frozen at sale like the price. Null when the plan had none. */
  discountRate: RateString.nullable(),
  billingFrequency: z.string(),
  autoRenews: z.boolean(),
  renewalCount: z.number().int(),
  cancelledOn: z.string().date().nullable(),
  cancellationReason: z.string().nullable(),
  visitsIncludedThisTerm: z.number().int(),
  visitsDeliveredThisTerm: z.number().int(),
});

/** One visit an agreement owes, from the moment it was sold. */
export const AgreementVisitView = z.object({
  id: Uuid,
  sequence: z.number().int(),
  term: z.number().int(),
  dueOn: z.string().date(),
  /** Set once booked. Null and not delivered or skipped is what the owed list is. */
  jobId: Uuid.nullable(),
  deliveredOn: z.string().date().nullable(),
  skippedOn: z.string().date().nullable(),
  skipReason: z.string().nullable(),
  /** This visit's slice of the term price, earned when it is delivered. */
  recognitionAmount: MoneyString.nullable(),
});

export const AgreementInstalmentView = z.object({
  id: Uuid,
  sequence: z.number().int(),
  term: z.number().int(),
  dueOn: z.string().date(),
  amount: MoneyString,
  status: z.string(),
  invoiceId: Uuid.nullable(),
});

export const createAgreementPlan = defineRoute({
  method: "post",
  path: "/v1/agreement-plans",
  summary: "Define a membership plan",
  description:
    "A price, a term, how often it bills, how many visits it includes, whether it renews on its own and how many days' notice a member is owed before it does, and the member discount. A discount is a fraction: 0.15 is fifteen per cent, and a rate typed as 15 is refused rather than guessed at.",
  module: "M08",
  permissions: ["membership:write"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(200),
    code: z.string().max(50).optional(),
    description: z.string().max(2000).optional(),
    price: MoneyString,
    billingFrequency: Frequency,
    termMonths: z.number().int().min(1).max(120),
    includedVisitsPerTerm: z.number().int().min(0).max(52),
    visitAnchorMonths: z.array(z.number().int().min(1).max(12)).max(12).optional(),
    visitAnchorDay: z.number().int().min(1).max(31).optional(),
    discountRate: RateString.optional(),
    priorityDispatch: z.boolean().optional(),
    waivesDiagnosticFee: z.boolean().optional(),
    waivesAfterHoursRate: z.boolean().optional(),
    benefits: z.array(z.string().min(1).max(200)).max(20).optional(),
    autoRenews: z.boolean().optional(),
    renewalNoticeDays: z.number().int().min(0).max(365).optional(),
  }),
  output: AgreementPlanView,
});

export const listAgreementPlans = defineRoute({
  method: "get",
  path: "/v1/agreement-plans",
  summary: "List membership plans",
  description: "The plans on sale, by name. `includeRetired` adds the ones that keep their members and take no new ones.",
  module: "M08",
  permissions: ["membership:read"],
  input: z.object({ includeRetired: z.boolean().default(false) }),
  output: z.object({ plans: z.array(AgreementPlanView) }),
});

export const getAgreementPlan = defineRoute({
  method: "get",
  path: "/v1/agreement-plans/{id}",
  summary: "Get a membership plan",
  description: "With how many members are on it now, which is what tells somebody what an edit reaches.",
  module: "M08",
  permissions: ["membership:read"],
  input: z.object({ id: Uuid }),
  output: AgreementPlanView.extend({ members: z.number().int() }),
});

export const updateAgreementPlan = defineRoute({
  method: "patch",
  path: "/v1/agreement-plans/{id}",
  summary: "Edit a membership plan",
  description:
    "Only the fields sent change. What an edit reaches differs by field, deliberately: the price, the discount and how often it bills are frozen on each agreement at sale, so they reach new sales only; the term and the visits reach new sales and each member's next term when it renews; the perks (priority dispatch, the waived fees, the benefit list) are read from the plan when used, so they reach every member at once. `active: false` retires it, the same as the retire call.",
  module: "M08",
  permissions: ["membership:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    code: z.string().max(50).optional(),
    description: z.string().max(2000).optional(),
    price: MoneyString.optional(),
    billingFrequency: Frequency.optional(),
    termMonths: z.number().int().min(1).max(120).optional(),
    includedVisitsPerTerm: z.number().int().min(0).max(52).optional(),
    visitAnchorMonths: z.array(z.number().int().min(1).max(12)).max(12).optional(),
    visitAnchorDay: z.number().int().min(1).max(31).nullable().optional(),
    /** An empty string or "0" takes the discount off the plan. */
    discountRate: z.string().max(12).optional(),
    priorityDispatch: z.boolean().optional(),
    waivesDiagnosticFee: z.boolean().optional(),
    waivesAfterHoursRate: z.boolean().optional(),
    benefits: z.array(z.string().min(1).max(200)).max(20).optional(),
    autoRenews: z.boolean().optional(),
    renewalNoticeDays: z.number().int().min(0).max(365).optional(),
    active: z.boolean().optional(),
  }),
  output: AgreementPlanView,
});

export const retireAgreementPlan = defineRoute({
  method: "post",
  path: "/v1/agreement-plans/{id}/retire",
  summary: "Retire a membership plan",
  description: "It stops being sold. Everybody on it keeps their price, their term and their visits, because deleting it would orphan them and repricing them would be a rise nobody agreed to. Retiring a retired plan is a no-op.",
  module: "M08",
  permissions: ["membership:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: AgreementPlanView,
});

export const sellAgreement = defineRoute({
  method: "post",
  path: "/v1/agreements",
  summary: "Sell an agreement",
  description:
    "Writes down everything the first term owes in the same transaction: every included visit with its due date and what it is worth, every billing instalment, and the deferred revenue behind each visit.",
  module: "M08",
  permissions: ["membership:write"],
  idempotent: true,
  input: z.object({
    planId: Uuid,
    customerId: Uuid,
    propertyId: Uuid.optional(),
    startedOn: z.string().date().optional(),
    /** A deal somebody actually did, in place of the plan's price. */
    price: MoneyString.optional(),
  }),
  output: AgreementView,
});

export const renewAgreement = defineRoute({
  method: "post",
  path: "/v1/agreements/{id}/renew",
  summary: "Renew an agreement for another term",
  description:
    "The new term starts the day the old one ends, whenever it is renewed, and owes everything a sale owes: its visits, its instalments and its deferred revenue. The price is the agreement's own unless a new one is given, because a renewal that quietly took the plan's new price would be a price rise nobody agreed to. Earlier terms stand: a visit owed last year and never had is still owed. An active or lapsed agreement can be renewed; a cancelled one cannot.",
  module: "M08",
  permissions: ["membership:write"],
  idempotent: true,
  input: z.object({ id: Uuid, price: MoneyString.optional() }),
  output: z.object({
    id: Uuid,
    term: z.number().int(),
    startsOn: z.string().date(),
    endsOn: z.string().date(),
    price: MoneyString,
    visits: z.number().int(),
    instalments: z.number().int(),
  }),
});

export const listAgreementRenewals = defineRoute({
  method: "get",
  path: "/v1/agreement-renewals",
  summary: "Agreements ending soon, and the ones that ended without renewing",
  description:
    "Ending inside the next `withinDays`, soonest first, plus those that ended in the last thirty days and were not renewed. Each says whether it will renew on its own (the plan and the agreement both have to say so) and whether the notice the plan owes has gone, with the reason when it could not.",
  module: "M08",
  permissions: ["membership:read"],
  input: z.object({ withinDays: z.number().int().min(1).max(366).default(30) }),
  output: z.object({
    agreements: z.array(z.object({
      id: Uuid,
      customerId: Uuid,
      customerName: z.string(),
      planName: z.string(),
      status: z.string(),
      endsOn: z.string().date(),
      /** Negative once the end has passed. */
      daysLeft: z.number().int(),
      price: MoneyString,
      billingFrequency: z.string(),
      renewsAutomatically: z.boolean(),
      renewalNoticeSentAt: z.string().datetime().nullable(),
      /** `queued`, or why the notice could not go. */
      renewalNoticeOutcome: z.string().nullable(),
      renewalCount: z.number().int(),
    })),
  }),
});

export const getMemberPricing = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/member-pricing",
  summary: "Whether work for this customer is priced as member work",
  description:
    "The agreement whose plan discount applies to work for this customer today, at this property when one is given, and the rate. The best one when they hold several, never more than one. Estimates and invoices apply it themselves as they are priced; this is for a screen that wants to say so before the save.",
  module: "M08",
  permissions: ["customer:read"],
  input: z.object({ id: Uuid, propertyId: Uuid.optional() }),
  output: z.object({
    applies: z.boolean(),
    agreementId: Uuid.nullable(),
    planName: z.string().nullable(),
    rate: RateString.nullable(),
    percent: z.string().nullable(),
    /** Whether the price book's diagnostic fee and after hours rate come off in full. */
    waivesDiagnosticFee: z.boolean(),
    waivesAfterHoursRate: z.boolean(),
  }),
});

export const listAgreements = defineRoute({
  method: "get",
  path: "/v1/agreements",
  summary: "List agreements",
  description: "The book, newest sale first, with the plan and the customer named.",
  module: "M08",
  permissions: ["membership:read"],
  input: z.object({
    status: z.enum(["pending", "active", "past_due", "paused", "lapsed", "cancelled", "completed"]).optional(),
    customerId: Uuid.optional(),
  }),
  output: z.object({
    agreements: z.array(AgreementView.extend({ planName: z.string(), customerName: z.string() })),
  }),
});

export const getAgreement = defineRoute({
  method: "get",
  path: "/v1/agreements/{id}",
  summary: "Get an agreement, with everything it owes",
  description: "Every visit of every term with whether it was booked, delivered or skipped, every instalment with its invoice, and `unearned`: what has been billed and not yet earned, summed from the rows rather than recomputed from the price.",
  module: "M08",
  permissions: ["membership:read"],
  input: z.object({ id: Uuid }),
  output: AgreementView.extend({
    planName: z.string(),
    customerName: z.string(),
    unearned: MoneyString,
    visits: z.array(AgreementVisitView),
    instalments: z.array(AgreementInstalmentView),
  }),
});

/**
 * At its own path because a literal beside `/v1/agreement-visits/{id}` is
 * ambiguous to the router.
 */
export const listOwedAgreementVisits = defineRoute({
  method: "get",
  path: "/v1/owed-agreement-visits",
  summary: "Visits the company owes and has not booked",
  description: "Due on or before `through` (a month from today when left out), on running agreements, not booked, delivered or skipped, soonest first. The list that keeps an agreement book alive.",
  module: "M08",
  permissions: ["membership:read"],
  input: z.object({ through: z.string().date().optional() }),
  output: z.object({
    visits: z.array(AgreementVisitView.extend({
      agreementId: Uuid,
      customerId: Uuid,
      customerName: z.string(),
      propertyId: Uuid.nullable(),
      planName: z.string(),
    })),
  }),
});

export const bookAgreementVisit = defineRoute({
  method: "post",
  path: "/v1/agreement-visits/{id}/book",
  summary: "Book an owed visit as a job",
  description: "Makes a job worth nothing, because the customer has already been billed for this visit under the agreement, and records that the agreement is paying for it. A visit already booked or skipped is refused in words, so two people working the owed list at once cannot both book it.",
  module: "M08",
  permissions: ["membership:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** Needed only when the agreement was sold without an address. */
    propertyId: Uuid.optional(),
  }),
  output: z.object({ agreementVisitId: Uuid, jobId: Uuid, jobNumber: z.number().int() }),
});

export const deliverAgreementVisit = defineRoute({
  method: "post",
  path: "/v1/agreement-visits/{id}/deliver",
  summary: "Mark an included visit delivered",
  description: "Moves the visit's slice of the term price from deferred revenue to revenue, exactly the slice allocated at sale. Delivering twice is refused, because it would recognise the same money twice.",
  module: "M08",
  permissions: ["membership:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    /** The day it was done. Today in the company's calendar when left out. */
    on: z.string().date().optional(),
  }),
  output: z.object({ agreementVisitId: Uuid, recognized: MoneyString }),
});

export const skipAgreementVisit = defineRoute({
  method: "post",
  path: "/v1/agreement-visits/{id}/skip",
  summary: "Record that the member does not want a visit",
  description: "A reason is required. Nothing is recognised: the slice stays deferred, because a skip can be undone and breakage is earned at the end of a term, not on the day somebody declined. A booked visit cannot be skipped until its job is dealt with.",
  module: "M08",
  permissions: ["membership:write"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().min(1).max(500) }),
  output: z.object({
    agreementVisitId: Uuid, skippedOn: z.string().date(), skipReason: z.string(), stillDeferred: MoneyString,
  }),
});

export const unskipAgreementVisit = defineRoute({
  method: "post",
  path: "/v1/agreement-visits/{id}/unskip",
  summary: "Put a skipped visit back on the owed list",
  module: "M08",
  permissions: ["membership:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ agreementVisitId: Uuid, dueOn: z.string().date() }),
});

export const invoiceAgreementInstalment = defineRoute({
  method: "post",
  path: "/v1/agreement-instalments/{id}/invoice",
  summary: "Bill one instalment",
  description: "Raises an open invoice for the instalment whose posting credits deferred revenue rather than revenue, because money billed for visits not yet made is a liability. An instalment already invoiced is refused.",
  module: "M08",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ instalmentId: Uuid, invoiceId: Uuid, number: z.number().int(), total: MoneyString }),
});

export const cancelAgreement = defineRoute({
  method: "post",
  path: "/v1/agreements/{id}/cancel",
  summary: "Cancel an agreement",
  description: "A reason is required, because it is the whole of a win-back campaign. Instalments not yet invoiced are cancelled. Whatever was billed and not earned is released: to revenue when `keepThePrepayment` is true, otherwise back to the customer's account. Leaving it deferred forever is the one answer that is wrong either way.",
  module: "M08",
  permissions: ["membership:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    reason: z.string().min(1).max(1000),
    keepThePrepayment: z.boolean().default(false),
  }),
  output: AgreementView.extend({ released: MoneyString }),
});

export const agreementRoutes = {
  createAgreementPlan, listAgreementPlans, getAgreementPlan, updateAgreementPlan, retireAgreementPlan,
  sellAgreement, listAgreements, getAgreement, renewAgreement, cancelAgreement,
  listOwedAgreementVisits, bookAgreementVisit, deliverAgreementVisit, skipAgreementVisit, unskipAgreementVisit,
  invoiceAgreementInstalment,
  listAgreementRenewals, getMemberPricing,
} as const;
