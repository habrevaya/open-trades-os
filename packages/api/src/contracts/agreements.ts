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
 * one. Booking, delivering, billing and cancelling are on the screens and not
 * here yet, which the module doc says.
 */

export const AgreementPlanView = z.object({
  id: Uuid,
  name: z.string(),
  code: z.string().nullable(),
  price: MoneyString,
  billingFrequency: z.string(),
  termMonths: z.number().int(),
  includedVisitsPerTerm: z.number().int(),
  autoRenews: z.boolean(),
  renewalNoticeDays: z.number().int(),
  /** A fraction: 0.15 is fifteen per cent off eligible work for members. */
  discountRate: RateString.nullable(),
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
  billingFrequency: z.string(),
  autoRenews: z.boolean(),
  renewalCount: z.number().int(),
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
    billingFrequency: z.enum(["monthly", "quarterly", "semiannual", "annual", "one_time"]),
    termMonths: z.number().int().min(1).max(120),
    includedVisitsPerTerm: z.number().int().min(0).max(52),
    visitAnchorMonths: z.array(z.number().int().min(1).max(12)).max(12).optional(),
    discountRate: RateString.optional(),
    autoRenews: z.boolean().optional(),
    renewalNoticeDays: z.number().int().min(0).max(365).optional(),
  }),
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
  }),
});

export const agreementRoutes = {
  createAgreementPlan, sellAgreement, renewAgreement, listAgreementRenewals, getMemberPricing,
} as const;
