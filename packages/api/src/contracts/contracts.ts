import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";

/**
 * COMMERCIAL CONTRACTS AND RATE CARDS
 *
 * The schema names the problem these solve: "our price book is not the price
 * authority in five segments. A rate card is a price authority that is not
 * ours: a client contract, a warranty network schedule, a manufacturer
 * labour allowance, an insurance price list."
 *
 * Every one of those tables existed with no writer and no reader, so a
 * company doing commercial work priced every job off their own book, which
 * is the one thing the agreement says they may not do, and found out when
 * the client rejected the invoice.
 *
 * COST TRACKING STAYS OURS IN EVERY CASE. The price comes from somebody
 * else's card and the cost from our own records, so the margin is still true
 * on work we did not price. A system that took the card's price as both
 * would report every contract job at zero margin.
 */

export const PriceAuthority = z.enum([
  "contract", "warranty_network", "manufacturer_allowance", "insurance", "brand",
]);

export const SlaTerm = z.object({
  kind: z.enum(["respond", "arrive", "complete"]),
  minutes: z.number().int().min(1).max(525600),
  /** Only for jobs of this priority. Omit for every job. */
  priority: z.enum(["normal", "high", "emergency"]).optional(),
});

/** The terms a contract can state beyond its name and dates, shared by creating and changing one. */
const ContractTerms = {
  notToExceedAction: z.enum(["hold", "warn"]).optional(),
  slaTerms: z.array(SlaTerm).max(20).optional(),
  invoiceWithinDays: z.number().int().min(1).max(3650).nullable().optional(),
  claimWithinDays: z.number().int().min(1).max(3650).nullable().optional(),
  invoiceFormat: z.enum(["csv", "xml"]).nullable().optional(),
};

export const ServiceContract = z.object({
  id: Uuid,
  customerId: Uuid,
  customerName: z.string(),
  name: z.string(),
  contractNumber: z.string().nullable(),
  startsOn: z.string().date().nullable(),
  endsOn: z.string().date().nullable(),
  autoRenews: z.boolean(),
  /** Annual uplift, so year three billing is not a manual exercise. */
  escalationRate: RateString.nullable(),
  /** The ceiling before a per site override. */
  defaultNotToExceed: MoneyString.nullable(),
  /** Their PO covering the term, required on every invoice by many clients. */
  purchaseOrderNumber: z.string().nullable(),
  coveredScope: z.string().nullable(),
  /** What happens over the limit: `hold` refuses the invoice, `warn` lets it through and says so. */
  notToExceedAction: z.enum(["hold", "warn"]),
  /** The clocks the client holds us to, in minutes from when the work arrived. */
  slaTerms: z.array(SlaTerm),
  invoiceWithinDays: z.number().int().nullable(),
  claimWithinDays: z.number().int().nullable(),
  /** The file their accounts payable takes, when it names one. */
  invoiceFormat: z.enum(["csv", "xml"]).nullable(),
  active: z.boolean(),
});

export const listContracts = defineRoute({
  method: "get",
  path: "/v1/contracts",
  summary: "Commercial contracts",
  module: "M31",
  permissions: ["contract:read"],
  input: z.object({ customerId: Uuid.optional() }),
  output: z.object({ contracts: z.array(ServiceContract) }),
});

export const createContract = defineRoute({
  method: "post",
  path: "/v1/contracts",
  summary: "Set up a commercial contract",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({
    customerId: Uuid,
    name: z.string().min(1).max(200),
    contractNumber: z.string().max(100).nullable().optional(),
    startsOn: z.string().date().nullable().optional(),
    endsOn: z.string().date().nullable().optional(),
    autoRenews: z.boolean().optional(),
    escalationRate: RateString.nullable().optional(),
    defaultNotToExceed: MoneyString.nullable().optional(),
    purchaseOrderNumber: z.string().max(100).nullable().optional(),
    coveredScope: z.string().max(4000).nullable().optional(),
    ...ContractTerms,
  }),
  output: z.object({ id: Uuid, name: z.string() }),
});

export const updateContract = defineRoute({
  method: "patch",
  path: "/v1/contracts/{id}",
  summary: "Change a contract's terms",
  description:
    "Only the fields sent change. A change to the clocks moves the deadlines on the jobs running under the contract the next time they are reconciled, which the worker does on every pass.",
  module: "M31",
  permissions: ["contract:write"],
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    contractNumber: z.string().max(100).nullable().optional(),
    startsOn: z.string().date().nullable().optional(),
    endsOn: z.string().date().nullable().optional(),
    autoRenews: z.boolean().optional(),
    defaultNotToExceed: MoneyString.nullable().optional(),
    purchaseOrderNumber: z.string().max(100).nullable().optional(),
    coveredScope: z.string().max(4000).nullable().optional(),
    active: z.boolean().optional(),
    ...ContractTerms,
  }),
  output: ServiceContract,
});

export const addContractSite = defineRoute({
  method: "post",
  path: "/v1/contracts/{contractId}/sites",
  summary: "Put a property on a contract, with its own ceiling",
  description:
    "A limit per SITE rather than only per contract, because that is how facilities clients write them: a thousand at the distribution centre and two hundred at the retail unit, under one agreement. A single contract level ceiling would have somebody approving work at the wrong limit.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({
    contractId: Uuid,
    propertyId: Uuid,
    siteNumber: z.string().max(100).nullable().optional(),
    notToExceed: MoneyString.nullable().optional(),
  }),
  output: z.object({
    id: Uuid, propertyId: Uuid, notToExceed: MoneyString.nullable(),
  }),
});

export const createRateCard = defineRoute({
  method: "post",
  path: "/v1/rate-cards",
  summary: "A price authority that is not ours",
  description:
    "A contract card with no contract is refused: there would be no customer it applies to, so it would never be found when a price is resolved.",
  module: "M31",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(200),
    contractId: Uuid.nullable().optional(),
    authority: PriceAuthority.optional(),
    effectiveFrom: z.string().date().nullable().optional(),
    effectiveTo: z.string().date().nullable().optional(),
  }),
  output: z.object({ id: Uuid, name: z.string(), authority: z.string() }),
});

export const RateCardLine = z.object({
  /** Their code, which rarely matches ours. */
  externalCode: z.string().max(100).nullable().optional(),
  /** Our item, when somebody has mapped it. Matched before the code. */
  priceBookItemId: Uuid.nullable().optional(),
  description: z.string().min(1).max(500),
  unit: z.string().max(50).nullable().optional(),
  price: MoneyString,
  /** Allowance schedules pay a fixed time, not the time actually taken. */
  allowedMinutes: z.number().int().min(0).max(10080).nullable().optional(),
});

export const setRateCardLines = defineRoute({
  method: "put",
  path: "/v1/rate-cards/{rateCardId}/lines",
  summary: "Load a card's prices",
  description:
    "Replaces rather than appends, because a rate card arrives as a document: the client sends next year's schedule as one spreadsheet, and merging it into last year's leaves every line they DELETED still priced and still quotable. A line mapping to neither their code nor one of our items is refused, since nothing could ever match it.",
  module: "M31",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    rateCardId: Uuid,
    lines: z.array(RateCardLine).max(5000),
  }),
  output: z.object({
    rateCardId: Uuid,
    accepted: z.number().int(),
    refused: z.array(z.object({ row: z.number().int(), reason: z.string() })),
  }),
});

export const listRateCardLines = defineRoute({
  method: "get",
  path: "/v1/rate-cards/{rateCardId}/lines",
  summary: "What a card prices",
  module: "M31",
  permissions: ["pricebook:read"],
  input: z.object({ rateCardId: Uuid }),
  output: z.object({
    lines: z.array(RateCardLine.extend({ id: Uuid })),
  }),
});

export const resolveContractPrice = defineRoute({
  method: "get",
  path: "/v1/contracts/price",
  summary: "What may we charge this customer for this item",
  description:
    "NOT COVERED IS A REFUSAL, NEVER A FALLBACK. An item that is not on the client's card comes back as not covered rather than as our list price, because falling back is what makes a contract job invoice at list and get rejected. The two uncovered cases are told apart: no card applies, where our price book is the right answer, and a card applies and this is not on it, where somebody has to ring the client before doing the work.",
  module: "M31",
  permissions: ["pricebook:read"],
  input: z.object({
    customerId: Uuid,
    priceBookItemId: Uuid.optional(),
    externalCode: z.string().max(100).optional(),
    on: z.string().date().optional(),
  }),
  output: z.object({
    covered: z.boolean(),
    price: MoneyString.optional(),
    rateCardId: Uuid.optional(),
    rateCardName: z.string().optional(),
    authority: z.string().optional(),
    contractId: Uuid.nullable().optional(),
    allowedMinutes: z.number().int().nullable().optional(),
    description: z.string().optional(),
    reason: z.string().optional(),
    /** True when a card applies and this item is simply not on it. */
    cardApplies: z.boolean().optional(),
  }),
});

export const getPropertyCeiling = defineRoute({
  method: "get",
  path: "/v1/contracts/ceiling",
  summary: "The spend limit for work at a property",
  description:
    "The site's own limit wins over the contract default, because that is how facilities clients write them. Null when no contract covers the property, which is not the same as a limit of zero.",
  module: "M31",
  permissions: ["contract:read"],
  input: z.object({ customerId: Uuid, propertyId: Uuid }),
  output: z.object({
    contractId: Uuid.nullable(),
    contractName: z.string().nullable(),
    siteNumber: z.string().nullable(),
    notToExceed: MoneyString.nullable(),
    /** True when the site overrode the contract's default. */
    fromSite: z.boolean().nullable(),
  }),
});

const EscalatedPrice = z.object({ before: MoneyString, after: MoneyString });

export const previewContractEscalation = defineRoute({
  method: "get",
  path: "/v1/contracts/{contractId}/escalation",
  summary: "What the contract's next annual escalation would do to its cards",
  description:
    "The next anniversary of the contract's start (a year after the last one applied), the year of the contract it opens, and every price on every card in force the day before it, before and after rising by the contract's escalation rate, to the cent, half up. `ready` says whether it can be applied today: from sixty days before the anniversary, and any time after. `problem` says why not in words: no rate, no start date, the contract ending first, no card in force, or a card already loaded from that day. Nothing is written.",
  module: "M31",
  permissions: ["pricebook:read"],
  input: z.object({ contractId: Uuid }),
  output: z.object({
    contractId: Uuid,
    rate: RateString.nullable(),
    anniversary: z.string().date().nullable(),
    contractYear: z.number().int().nullable(),
    daysAway: z.number().int().nullable(),
    ready: z.boolean(),
    problem: z.string().nullable(),
    escalatedThrough: z.string().date().nullable(),
    cards: z.array(z.object({
      rateCardId: Uuid,
      name: z.string(),
      effectiveFrom: z.string().date().nullable(),
      effectiveTo: z.string().date().nullable(),
      lines: z.array(EscalatedPrice.extend({ id: Uuid, description: z.string() })),
      labourRates: z.array(EscalatedPrice.extend({ id: Uuid, band: z.string(), jobTypeName: z.string().nullable() })),
      tripCharge: EscalatedPrice.nullable(),
    })),
  }),
});

export const applyContractEscalation = defineRoute({
  method: "post",
  path: "/v1/contracts/{contractId}/escalation",
  summary: "Apply the annual escalation the preview showed",
  description:
    "Writes a new version of every card in force the day before the anniversary, each price, hourly rate and trip charge risen by the rate (markups are fractions of cost and are kept), in force from the anniversary, and ends the old card the day before, so work before the anniversary keeps last year's prices. Refused unless `anniversary` and `rate` are the ones the preview shows now, and before the preview says it is ready. A retry for an anniversary already applied answers with the cards it made.",
  module: "M31",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({ contractId: Uuid, anniversary: z.string().date(), rate: RateString }),
  output: z.object({
    contractId: Uuid,
    anniversary: z.string().date(),
    rate: RateString,
    cards: z.array(z.object({
      fromRateCardId: Uuid, rateCardId: Uuid, name: z.string(), effectiveFrom: z.string().date(),
    })),
  }),
});

/* ------------------------------------------------ billed on a schedule */

const BillingFrequency = z.enum(["monthly", "quarterly", "yearly"]);

const BillingPeriod = z.object({
  start: z.string().date(),
  end: z.string().date(),
  /** The day it is billed: its first day. */
  billOn: z.string().date(),
  amount: MoneyString,
  /** A part period's share of the fee, by day, when the schedule prorates. */
  prorated: z.boolean(),
  days: z.number().int(),
  /** The days of the whole period it is part of. */
  fullDays: z.number().int(),
});

export const ContractBilling = z.object({
  contractId: Uuid,
  schedule: z.object({
    id: Uuid,
    /** The fee for one whole period, before tax. */
    amount: MoneyString,
    frequency: BillingFrequency,
    /** 1 to 28. */
    billingDay: z.number().int(),
    /** The first day billed for, and the day the billing days are counted from. */
    startsOn: z.string().date(),
    prorate: z.boolean(),
    taxable: z.boolean(),
    /** The words on the invoice line. */
    description: z.string(),
    state: z.enum(["active", "paused", "ended"]),
    pausedOn: z.string().date().nullable(),
    endedOn: z.string().date().nullable(),
    /** The last day it bills for: the contract's end or the schedule's own, whichever is first. */
    lastDay: z.string().date().nullable(),
  }).nullable(),
  /** The next period still to come. */
  next: BillingPeriod.nullable(),
  /** Periods owed now and not yet raised, which the worker raises on its next pass. */
  due: z.number().int(),
  periods: z.array(BillingPeriod.extend({
    id: Uuid,
    /** `skipped` for a period whose billing day fell while the schedule was paused. */
    status: z.enum(["invoiced", "skipped"]),
    invoiceId: Uuid.nullable(),
    invoiceNumber: z.number().int().nullable(),
    note: z.string().nullable(),
  })),
  /** Why nothing is being billed, in words, when nothing is. */
  standing: z.string().nullable(),
});

export const getContractBilling = defineRoute({
  method: "get",
  path: "/v1/contracts/{contractId}/billing",
  summary: "A contract's fixed fee schedule, and every period it has billed",
  description:
    "The schedule (the fee, how often, the billing day, the first day billed, whether a part period is prorated by day and whether the fee is taxed), the next period with what it will be billed, how many periods are owed and not yet raised, and every period billed or skipped, newest first, with its invoice. `schedule` is null on a contract that is not billed on a schedule.",
  module: "M31",
  permissions: ["contract:read"],
  input: z.object({ contractId: Uuid }),
  output: ContractBilling,
});

export const setContractBilling = defineRoute({
  method: "put",
  path: "/v1/contracts/{contractId}/billing",
  summary: "Bill a contract a fixed fee every month, quarter or year",
  description:
    "Sets the schedule, or changes it. The worker raises each period as an invoice to the contract's customer on the period's billing day in the company's calendar, in advance, for the period that starts that day, whether or not anybody visited: on the customer's own payment terms, with the contract's purchase order number, posted to revenue like any invoice. A part period at either end (a contract starting or ending between two billing days) is billed whole unless `prorate` is true, when it is the fee's share by day of the period it is part of. The billing day is 1 to 28. Changing how often or on which day it bills, once anything has been billed, starts the new pattern the day after the last period billed, and the first day cannot move to before then. Saving an ended schedule starts it again.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({
    contractId: Uuid,
    amount: MoneyString,
    frequency: BillingFrequency,
    billingDay: z.number().int().min(1).max(28),
    /** The first day billed for. Left off, the contract's start, or today. */
    startsOn: z.string().date().optional(),
    prorate: z.boolean().optional(),
    taxable: z.boolean().optional(),
    description: z.string().min(1).max(200),
  }),
  output: ContractBilling,
});

export const pauseContractBilling = defineRoute({
  method: "post",
  path: "/v1/contracts/{contractId}/billing/pause",
  summary: "Stop a contract's fixed fee until it is resumed",
  description:
    "Nothing is billed while it is paused, and a period whose billing day falls in the pause is written down as skipped when it is resumed, so it is never billed afterwards. Pausing one already paused changes nothing.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({ contractId: Uuid }),
  output: ContractBilling,
});

export const resumeContractBilling = defineRoute({
  method: "post",
  path: "/v1/contracts/{contractId}/billing/resume",
  summary: "Start a paused fixed fee again",
  description:
    "Billing starts again from today. Each period whose billing day fell while it was paused is written down as skipped rather than billed, so a customer is not sent the paused months the morning it is resumed. A period owed from before the pause is still billed. Resuming one not paused changes nothing.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({ contractId: Uuid }),
  output: ContractBilling,
});

export const endContractBilling = defineRoute({
  method: "post",
  path: "/v1/contracts/{contractId}/billing/end",
  summary: "End a contract's fixed fee on a last day",
  description:
    "Periods up to `lastDay` (today when left off) are still billed, one cut short by it as a part period, and nothing after. An invoice already raised for a period the end cuts short is left as it is: crediting the rest is decided on that invoice. Saving the schedule again starts it again.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({ contractId: Uuid, lastDay: z.string().date().optional() }),
  output: ContractBilling,
});

export const raiseContractBilling = defineRoute({
  method: "post",
  path: "/v1/contracts/{contractId}/billing/raise",
  summary: "Raise the contract's owed periods now, rather than on the worker's pass",
  description:
    "Every period whose billing day has come and that is not billed yet, as one invoice each, by the same code and under the same claim on the period as the worker, so nothing the worker billed is billed again. A schedule years behind is caught up twelve periods at a time. Refused, in words, when an invoice cannot be raised, with nothing written.",
  module: "M31",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({ contractId: Uuid }),
  output: z.object({
    raised: z.array(z.object({
      contractId: Uuid,
      periodStart: z.string().date(),
      periodEnd: z.string().date(),
      invoiceId: Uuid,
      invoiceNumber: z.number().int(),
      total: MoneyString,
    })),
    failed: z.array(z.object({ contractId: Uuid, reason: z.string() })),
  }),
});

export const contractRoutes = {
  listContracts, createContract, updateContract, addContractSite,
  createRateCard, setRateCardLines, listRateCardLines,
  resolveContractPrice, getPropertyCeiling,
  previewContractEscalation, applyContractEscalation,
  getContractBilling, setContractBilling, pauseContractBilling, resumeContractBilling,
  endContractBilling, raiseContractBilling,
} as const;
