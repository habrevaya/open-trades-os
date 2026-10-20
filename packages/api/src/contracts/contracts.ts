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

const EscalatedPrice = z.object({
  before: MoneyString,
  after: MoneyString,
  /** The rate it rises by, "0" for a price kept as it is or one risen by an amount. */
  rate: RateString,
  /** The fixed amount it rises by, present only when the rise is one. */
  amount: MoneyString.optional(),
  /** Which rise that is, in words: "Year 3", "Every year, Plumbing hourly rates", "The contract's yearly rate". */
  because: z.string(),
});

/** One of the contract's rises beyond its own yearly rate. */
const ContractRise = z.object({
  id: Uuid,
  /** The year of the contract it opens (2 is the first anniversary), or null for every year. */
  contractYear: z.number().int().nullable(),
  rateCardId: Uuid.nullable(),
  rateCardName: z.string().nullable(),
  /** The trade whose hourly rates it applies to, or null for every price. */
  jobTypeId: Uuid.nullable(),
  jobTypeName: z.string().nullable(),
  /** A fraction; "0" on a rise by an amount. */
  rate: RateString,
  /** A fixed amount added to each price it covers, when the rise is one; null for a per cent. */
  amount: MoneyString.nullable(),
  /** True for a rise of the contract's fixed fee alone, by the period it is billed for. */
  fee: z.boolean(),
});

export const previewContractEscalation = defineRoute({
  method: "get",
  path: "/v1/contracts/{contractId}/escalation",
  summary: "What the contract's next annual escalation would do to its cards",
  description:
    "The next anniversary of the contract's start (a year after the last one applied) on which anything rises, the year of the contract it opens, and every price on every card in force the day before it, before and after rising, to the cent, half up, with the rate (or the fixed `amount`, for a rise by an amount) and which rise it is in words. Each price rises by the most specific of the contract's rises that applies to it (the trade on that card, then the trade, then the card, then the year, a rise for that year before one for every year) and failing those by the contract's yearly rate; a price nothing applies to is kept. `rises` lists every rise the contract carries, and `key` is what applying has to be told. `ready` says whether it can be applied today: from sixty days before the anniversary, and any time after. `problem` says why not in words: no rate, no start date, the contract ending first, no card in force, or a card already loaded from that day. `drafts` are the cards the worker prepared for the anniversary thirty days ahead, when it has: never in force, and replaced by the cards applying writes. `fee` is the contract's fixed fee before and after, when its billing schedule rises with the escalation (off unless the schedule says so): the fee in force the day before the anniversary, risen by the fee's own rise (a per cent, or an amount a period) or failing that the year's per cent for every card and every trade or the contract's yearly rate, never by a rise naming one card or trade and never by an amount written for every price. A contract whose fee rises needs no card in force. `feeDraft` is the fee as the worker's draft prepared it. Nothing is written.",
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
    drafts: z.array(z.object({ rateCardId: Uuid, name: z.string(), preparedAt: z.string().datetime() })).optional(),
    /** The fixed fee as the worker's draft prepared it for the anniversary, when it has. */
    feeDraft: z.object({ amount: MoneyString, preparedAt: z.string().datetime() }).nullable().optional(),
    /**
     * The contract's fixed fee before and after, when its schedule rises with
     * the escalation and still bills from the anniversary; null otherwise.
     */
    fee: EscalatedPrice.extend({ per: z.string() }).nullable(),
    rises: z.array(ContractRise),
    key: z.string().nullable(),
  }),
});

export const applyContractEscalation = defineRoute({
  method: "post",
  path: "/v1/contracts/{contractId}/escalation",
  summary: "Apply the annual escalation the preview showed",
  description:
    "Writes a new version of every card in force the day before the anniversary, each price, hourly rate and trip charge risen as the preview shows (markups are fractions of cost and are kept), in force from the anniversary, and ends the old card the day before, so work before the anniversary keeps last year's prices. A rise naming a card moves to the new version. Any draft cards the worker prepared for the anniversary are removed, and the office task it raised is closed. When the preview shows the fixed fee rising, the fee as risen becomes the fee for every period starting on or after the anniversary; a period already billed keeps its invoice, and `billedAtOldFee` counts those from the anniversary, whose difference `GET /v1/contracts/{contractId}/billing` then offers. Refused unless `anniversary` and `key` are the ones the preview shows now (on a contract whose rise is its one yearly rate and whose fee does not rise, `rate` does instead), and before the preview says it is ready. A retry for an anniversary already applied answers with the cards and the fee it made.",
  module: "M31",
  permissions: ["pricebook:write"],
  idempotent: true,
  input: z.object({
    contractId: Uuid,
    anniversary: z.string().date(),
    /** The yearly rate the preview showed, on a contract with no rises of its own that year. */
    rate: RateString.optional(),
    /** The preview's `key`, which every contract's preview carries and one whose rises differ needs. */
    key: z.string().max(64).optional(),
  }),
  output: z.object({
    contractId: Uuid,
    anniversary: z.string().date(),
    /** The contract's own yearly rate, null when only its rises say what rises. */
    rate: RateString.nullable(),
    cards: z.array(z.object({
      fromRateCardId: Uuid, rateCardId: Uuid, name: z.string(), effectiveFrom: z.string().date(),
    })),
    /** The fixed fee from the anniversary, when it rose with the cards. */
    fee: z.object({
      from: z.string().date(), amount: MoneyString, previousAmount: MoneyString, rate: RateString,
      /** The amount it rose by a period, present only when its rise was an amount; the rate is then "0". */
      riseAmount: MoneyString.optional(),
    }).nullable(),
    /** Periods from the anniversary already billed at the old fee: the contract's billing offers each one's difference. */
    billedAtOldFee: z.number().int(),
  }),
});

export const listContractRises = defineRoute({
  method: "get",
  path: "/v1/contracts/{contractId}/escalation/rises",
  summary: "The contract's rises that differ by year, by card or by trade",
  description:
    "Each rise beyond the contract's own yearly rate: the year of the contract it opens (or every year), the card it applies to (or every card) and the trade whose hourly rates it applies to (or every price), or the fixed fee alone, with the rate or the fixed amount. A rise naming a card follows the card to each new version written when a rise is applied.",
  module: "M31",
  permissions: ["contract:read"],
  input: z.object({ contractId: Uuid }),
  output: z.array(ContractRise),
});

export const setContractRises = defineRoute({
  method: "put",
  path: "/v1/contracts/{contractId}/escalation/rises",
  summary: "Say how the contract's rises differ by year, by card or by trade",
  description:
    "Replaces the contract's rises with these. Each is a rate (0.04 for four per cent; nothing is allowed, for a card fixed for the term) or a fixed `amount` added to each price it covers (2.00 an hour on an hourly rate, each on a listed price, a visit on a trip charge), never both, for a year of the contract from 2 or every year, for one of the contract's cards or every card, and for one trade's hourly rates or every price. With `fee` it is a rise of the contract's fixed fee alone (by a per cent, or an amount a period), and names no card or trade. Two rows saying the same year, card and trade are refused in words, as is a card that is not this contract's. Nothing rises because of this: the preview shows the change and a person applies it, and drafts the worker already prepared are prepared again.",
  module: "M31",
  permissions: ["contract:write"],
  input: z.object({
    contractId: Uuid,
    rises: z.array(z.object({
      contractYear: z.number().int().min(2).max(99).nullable().optional(),
      rateCardId: Uuid.nullable().optional(),
      jobTypeId: Uuid.nullable().optional(),
      /** A fraction. Left off (or "0") on a rise by an amount. */
      rate: RateString.optional(),
      /** A fixed amount added to each price it covers, instead of a per cent. */
      amount: MoneyString.nullable().optional(),
      /** A rise of the contract's fixed fee alone. */
      fee: z.boolean().optional(),
    })).max(50),
  }),
  output: z.array(ContractRise),
});

/* ------------------------------------------------ billed on a schedule */

const BillingFrequency = z.enum(["monthly", "quarterly", "yearly"]);
/** In advance, each period on its first day; in arrears, the day after its last, for the period just gone. */
const BillingTiming = z.enum(["advance", "arrears"]);

const BillingPeriod = z.object({
  start: z.string().date(),
  end: z.string().date(),
  /** The day it is billed: its first day in advance, the day after its last in arrears. */
  billOn: z.string().date(),
  amount: MoneyString,
  /** A part period's share of the fee, by day: when the schedule prorates, or in arrears when a pause or an end cut it short. */
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
    timing: BillingTiming,
    /** The first day billed for, and the day the billing days are counted from. */
    startsOn: z.string().date(),
    prorate: z.boolean(),
    taxable: z.boolean(),
    /** The words on the invoice line. */
    description: z.string(),
    /** Whether the fee rises with the contract's annual escalation, applied by a person with the rest of the rise. */
    risesWithEscalation: z.boolean(),
    state: z.enum(["active", "paused", "ended"]),
    pausedOn: z.string().date().nullable(),
    endedOn: z.string().date().nullable(),
    /** The last day it bills for: the contract's end or the schedule's own, whichever is first. */
    lastDay: z.string().date().nullable(),
    /** The fee for a period starting today, after any rise that has taken effect. */
    feeNow: MoneyString,
    /** Each rise of the fee, oldest first: the fee for every period starting on or after `from`. */
    fees: z.array(z.object({
      from: z.string().date(), amount: MoneyString, previousAmount: MoneyString, rate: RateString,
      /** The amount it rose by a period, present only when its rise was an amount. */
      riseAmount: MoneyString.optional(),
    })),
  }).nullable(),
  /** The next period still to come. */
  next: BillingPeriod.nullable(),
  /** Periods owed now and not yet raised, which the worker raises on its next pass. */
  due: z.number().int(),
  periods: z.array(BillingPeriod.extend({
    id: Uuid,
    /** `skipped` for a period whose billing day fell while the schedule was paused, or in arrears the days a pause took. */
    status: z.enum(["invoiced", "skipped"]),
    invoiceId: Uuid.nullable(),
    invoiceNumber: z.number().int().nullable(),
    /** Why it was skipped, or how an invoiced one was worked out, in words. */
    note: z.string().nullable(),
  })),
  /** Why nothing is being billed, in words, when nothing is. */
  standing: z.string().nullable(),
  /**
   * Periods billed at the old fee before a rise from their first day was
   * applied: what each is short, offered until somebody bills it on a draft
   * or waives it, and what they decided.
   */
  differences: z.array(z.object({
    periodId: Uuid,
    start: z.string().date(),
    end: z.string().date(),
    invoiceId: Uuid.nullable(),
    invoiceNumber: z.number().int().nullable(),
    feeFrom: z.string().date(),
    billed: MoneyString,
    risen: MoneyString,
    difference: MoneyString,
    status: z.enum(["offered", "drafted", "waived"]),
    draftInvoiceId: Uuid.nullable(),
    draftInvoiceNumber: z.number().int().nullable(),
  })),
});

export const getContractBilling = defineRoute({
  method: "get",
  path: "/v1/contracts/{contractId}/billing",
  summary: "A contract's fixed fee schedule, and every period it has billed",
  description:
    "The schedule (the fee, how often, the billing day, in advance or in arrears, the first day billed, whether a part period is prorated by day and whether the fee is taxed), the next period with what it will be billed, how many periods are owed and not yet raised, and every period billed or skipped, newest first, with its invoice. `differences` lists each period billed at the old fee before a rise from its first day was applied, with what it was billed, what the risen fee makes it and the difference, offered until somebody bills it on a draft invoice or waives it. `schedule` is null on a contract that is not billed on a schedule.",
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
    "Sets the schedule, or changes it. The worker raises each period as an invoice to the contract's customer in the company's calendar, whether or not anybody visited: on the customer's own payment terms, with the contract's purchase order number, posted to revenue on the day it is raised like any invoice. With `timing` `advance` (the default) each period is billed on its billing day, for the period that starts that day; with `arrears` it is billed the day after it ends, for the period just gone. A part period at either end (a contract starting or ending between two billing days) is billed whole unless `prorate` is true, when it is the fee's share by day of the period it is part of; in arrears a period cut short by a pause or an end is always charged by the day for the days that ran, and the invoice line says how many. The billing day is 1 to 28. Changing how often, on which day or in advance or arrears, once anything has been billed, starts the new pattern the day after the last period billed, and the first day cannot move to before then. Saving an ended schedule starts it again. With `risesWithEscalation` (off unless set) the fee rises with the contract's annual escalation: the preview shows it beside the cards, the worker's draft prepares it, and applying the rise writes it as the fee for every period starting on or after the anniversary. A fee typed here that differs from the schedule's replaces any such rise for every period not yet billed.",
  module: "M31",
  permissions: ["contract:write"],
  idempotent: true,
  input: z.object({
    contractId: Uuid,
    /** Whether the fee rises with the contract's annual escalation. Left off, a change keeps what the schedule had. */
    risesWithEscalation: z.boolean().optional(),
    amount: MoneyString,
    frequency: BillingFrequency,
    billingDay: z.number().int().min(1).max(28),
    /** Left off, a new schedule bills in advance and a change keeps what the schedule had. */
    timing: BillingTiming.optional(),
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
    "Nothing is billed while it is paused. In advance, a period whose billing day falls in the pause is written down as skipped when it is resumed, so it is never billed afterwards, and a period already billed is left as it is. In arrears, the part of the running period before today is billed by the day on the next pass, as the part that ran, and no paused day is ever billed. Nothing is credited either way. Pausing one already paused changes nothing.",
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
    "Billing starts again from today. In advance, each period whose billing day fell while it was paused is written down as skipped rather than billed, so a customer is not sent the paused months the morning it is resumed, and a period owed from before the pause is still billed. In arrears, the paused days are written down as skipped, and the period running today is billed at its end for the days from today, by the day. Resuming one not paused changes nothing.",
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
    "Periods up to `lastDay` (today when left off) are still billed, one cut short by it as a part period, and nothing after. In arrears the part period is charged by the day and billed the day after `lastDay`. In advance, an invoice already raised for a period the end cuts short is left as it is: crediting the rest is decided on that invoice. Saving the schedule again starts it again.",
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

const PeriodsPicked = z.object({ contractId: Uuid, periodIds: z.array(Uuid).min(1).max(60) });

export const draftContractFeeDifference = defineRoute({
  method: "post",
  path: "/v1/contracts/{contractId}/billing/differences",
  summary: "Bill what a late rise of the fee left short, on a draft invoice",
  description:
    "For the periods picked, each one offered in `differences` on `GET /v1/contracts/{contractId}/billing`: one draft invoice to the contract's customer, with its PO number, one line per period saying the period, what it was billed and on which invoice, and what the risen fee makes it, taxed as the fee is. A draft: nothing is posted or owed until it is issued, which is the ordinary issue on the invoice. Nothing ever raises this by itself. Refused, in words, for a period not offered, or already on a draft or waived. Deleting the draft offers its periods again.",
  module: "M31",
  permissions: ["invoice:write"],
  idempotent: true,
  input: PeriodsPicked,
  output: z.object({
    contractId: Uuid,
    invoiceId: Uuid,
    invoiceNumber: z.number().int(),
    total: MoneyString,
    periods: z.number().int(),
  }),
});

export const waiveContractFeeDifference = defineRoute({
  method: "post",
  path: "/v1/contracts/{contractId}/billing/differences/waive",
  summary: "Decide not to bill what a late rise of the fee left short",
  description:
    "The periods picked, each one offered in `differences`, written down as waived, so they are not offered again; who decided is on the audit line. Refused, in words, for a period not offered, or already decided.",
  module: "M31",
  permissions: ["invoice:write"],
  idempotent: true,
  input: PeriodsPicked,
  output: ContractBilling,
});

export const contractRoutes = {
  listContracts, createContract, updateContract, addContractSite,
  createRateCard, setRateCardLines, listRateCardLines,
  resolveContractPrice, getPropertyCeiling,
  previewContractEscalation, applyContractEscalation, listContractRises, setContractRises,
  getContractBilling, setContractBilling, pauseContractBilling, resumeContractBilling,
  endContractBilling, raiseContractBilling, draftContractFeeDifference, waiveContractFeeDifference,
} as const;
