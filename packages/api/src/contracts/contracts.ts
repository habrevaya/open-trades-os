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
  }),
  output: z.object({ id: Uuid, name: z.string() }),
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

export const contractRoutes = {
  listContracts, createContract, addContractSite,
  createRateCard, setRateCardLines, listRateCardLines,
  resolveContractPrice, getPropertyCeiling,
} as const;
