import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";

const DateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "A date is YYYY-MM-DD");
/** As a person types it: "8.25" for eight and a quarter per cent. */
const Percent = z.string().max(12);

export const TaxRateView = z.object({
  id: Uuid,
  name: z.string(),
  retired: z.boolean(),
  /** The company's usual rate, charged where no customer or address names one. */
  isDefault: z.boolean(),
  /** The percentage in force today. Null for a rate that starts later, or a retired one. */
  current: z.object({ rate: RateString, percent: z.string(), effectiveFrom: DateString }).nullable(),
  versions: z.array(z.object({
    id: Uuid,
    rate: RateString,
    percent: z.string(),
    effectiveFrom: DateString,
    note: z.string().nullable(),
    state: z.enum(["past", "current", "scheduled"]),
  })),
  customers: z.number().int(),
  addresses: z.number().int(),
});

export const TaxSettings = z.object({
  today: DateString,
  /** False when the company has said it charges no sales tax at all. */
  chargesTax: z.boolean(),
  /** Whether anybody has said. Until then tax is charged only where a customer or address names a rate. */
  answered: z.boolean(),
  defaultTaxRateId: Uuid.nullable(),
  rates: z.array(TaxRateView),
});

export const listTaxRates = defineRoute({
  method: "get",
  path: "/v1/tax-rates",
  summary: "The sales tax rates the company charges",
  description:
    "Every rate the company has written down, with each percentage and the day it started, which one is in force today, and which is the usual one. These are the company's own rates: nothing here looks a rate up from an address.",
  module: "M13",
  permissions: ["settings:read"],
  input: z.object({}),
  output: TaxSettings,
});

export const createTaxRate = defineRoute({
  method: "post",
  path: "/v1/tax-rates",
  summary: "Add a sales tax rate",
  description:
    "A name and a percentage from a day (today when left off). The first rate a company adds becomes its usual rate, as does any sent with `makeDefault`. A second rate in use with the same name is refused; sending the same name and percentage again returns what is there.",
  module: "M13",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(100),
    percent: Percent,
    effectiveFrom: DateString.optional(),
    makeDefault: z.boolean().optional(),
  }),
  output: TaxSettings,
});

export const addTaxRateVersion = defineRoute({
  method: "post",
  path: "/v1/tax-rates/{id}/versions",
  summary: "Change a rate's percentage from a day",
  description:
    "The rate's new percentage starts on `effectiveFrom`. Documents already written keep what they charged; a draft issued on or after the day is checked against it. A second, different percentage on the same day is refused; the same one sent again returns what is there.",
  module: "M13",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid, percent: Percent, effectiveFrom: DateString, note: z.string().max(500).optional() }),
  output: TaxSettings,
});

export const retireTaxRate = defineRoute({
  method: "post",
  path: "/v1/tax-rates/{id}/retire",
  summary: "Stop using a rate",
  description:
    "Takes the rate off every list from now on. Lines that charged it keep naming it, and customers and addresses that named it are charged the usual rate. The usual rate cannot be retired until another is the usual one. Retiring a retired rate changes nothing.",
  module: "M13",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: TaxSettings,
});

export const updateTaxSettings = defineRoute({
  method: "patch",
  path: "/v1/tax-settings",
  summary: "Say whether the company charges sales tax, and its usual rate",
  description:
    "`chargesTax: false` charges no sales tax on anything raised from now on, whatever rates are named. `defaultTaxRateId` is the rate charged where no customer or address names one; null for none. A field left out keeps what it had.",
  module: "M13",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    chargesTax: z.boolean().optional(),
    defaultTaxRateId: Uuid.nullable().optional(),
  }),
  output: TaxSettings,
});

export const getSalesTaxReport = defineRoute({
  method: "get",
  path: "/v1/reports/sales-tax",
  summary: "Sales tax collected by rate, for filing",
  description:
    "Read from the ledger: every invoice, void and credit note's entries on sales tax payable between `from` and `to` (days in the company's calendar), grouped by the rate each entry records, with the sales it was charged on. Voids and credits count against the period they happened in. `otherMovements` is everything else on the account in the period (a payment to the state journalled by hand), so the rows and it add up to the account's movement.",
  module: "M13",
  permissions: ["report.financial:read"],
  input: z.object({ from: DateString, to: DateString }),
  output: z.object({
    from: DateString,
    to: DateString,
    rows: z.array(z.object({
      taxRateId: Uuid.nullable(),
      name: z.string(),
      rate: RateString.nullable(),
      percent: z.string().nullable(),
      taxableSales: MoneyString,
      taxCollected: MoneyString,
    })),
    totalCollected: MoneyString,
    otherMovements: MoneyString,
    accountMovement: MoneyString,
  }),
});

export const taxRoutes = {
  listTaxRates, createTaxRate, addTaxRateVersion, retireTaxRate, updateTaxSettings, getSalesTaxReport,
};
