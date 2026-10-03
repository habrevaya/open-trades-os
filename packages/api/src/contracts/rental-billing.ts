import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * A HIRE AFTER THE CAN HAS GONE OUT: collecting it, charging for what the
 * haul turned up, invoicing it, and the facility's scale tickets.
 */

const ChargeKind = z.enum(["contamination", "prohibited_item", "overweight", "overfill", "other"]);

const Charge = z.object({
  id: Uuid,
  rentalId: Uuid,
  kind: ChargeKind,
  description: z.string(),
  priceBookItemId: Uuid.nullable(),
  quantity: z.string(),
  unitPrice: MoneyString,
  amount: MoneyString,
  taxable: z.boolean(),
  note: z.string().nullable(),
  recordedAt: z.string().datetime(),
  invoiceId: Uuid.nullable(),
});

export const scheduleRentalCollections = defineRoute({
  method: "post",
  path: "/v1/rental-collections",
  summary: "Put hires due back on the board as collections",
  description:
    "Every open hire whose included period ends by `through` (tomorrow when left out) gets a collection stop on the day it is due, or today when it is already late, marked as the pickup leg of that hire. A hire that came with a job gets the stop as a visit on that job; one with no job gets a job of its own at the address, of the company's `pickup` job type when it has one. A hire already given a collection is left alone, so running this twice books nothing twice; one whose collection was cancelled is offered again. A standing hire with no included period, and one with nobody recorded at the address, are skipped with the reason.",
  module: "M22",
  permissions: ["asset:write", "job:write"],
  idempotent: true,
  input: z.object({ through: z.string().date().optional() }),
  output: z.object({
    through: z.string(),
    scheduled: z.array(z.object({
      rentalId: Uuid, assetIdentifier: z.string().nullable(), address: z.string().nullable(),
      dueOn: z.string(), collectOn: z.string(), daysLate: z.number().int(),
      jobId: Uuid, jobNumber: z.number().int(), visitId: Uuid,
    })),
    skipped: z.array(z.object({ rentalId: Uuid, assetIdentifier: z.string().nullable(), reason: z.string() })),
  }),
});

export const recordRentalCharge = defineRoute({
  method: "post",
  path: "/v1/rentals/{id}/charges",
  summary: "Charge for what a haul turned up",
  description:
    "Contamination, a prohibited item, an overweight or overfilled can. Priced from a price book fee (`priceBookItemId`, the dumpster pack's FEE-CONTAM, FEE-PROH-TIRE and the rest) at today's price unless another is given and taxed as that fee is, or priced by hand with a description. A charge with no price is refused rather than recorded at nothing. Invoiced with the hire; refused once the hire has been invoiced.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    kind: ChargeKind,
    priceBookItemId: Uuid.nullable().optional(),
    description: z.string().max(300).nullable().optional(),
    quantity: z.string().regex(/^\d+(\.\d{1,4})?$/).optional(),
    unitPrice: MoneyString.nullable().optional(),
    taxable: z.boolean().optional(),
    note: z.string().max(1000).nullable().optional(),
  }),
  output: Charge,
});

export const listRentalCharges = defineRoute({
  method: "get",
  path: "/v1/rental-charges",
  summary: "Charges recorded against hauls",
  module: "M22",
  permissions: ["asset:read"],
  input: z.object({ rentalId: Uuid.optional() }),
  output: z.object({ charges: z.array(Charge) }),
});

export const removeRentalCharge = defineRoute({
  method: "post",
  path: "/v1/rental-charges/{id}/remove",
  summary: "Take back a charge recorded in error",
  description: "Refused once the charge is on an invoice, where a credit note undoes it.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.boolean() }),
});

export const invoiceRental = defineRoute({
  method: "post",
  path: "/v1/rentals/{id}/invoice",
  summary: "Raise a draft invoice from a collected hire",
  description:
    "The rental period when the hire is priced by the day (days inside the included period at the day rate), each meter that went over (extra days at the overage rate, tonnage over the included at the per ton rate), and every charge found on the haul, as a draft to the customer at the address. Refused while the can is on site, refused with the meter's own sentence when a meter went over with no rate, and refused when the hire is already on an invoice that has not been voided. A hire priced by a flat line on its job has no period line here, so it is not billed twice.",
  module: "M22",
  permissions: ["invoice:write", "asset:read"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({
    invoiceId: Uuid,
    invoiceNumber: z.number().int(),
    total: MoneyString,
    lines: z.array(z.object({ name: z.string(), quantity: z.string(), unitPrice: MoneyString, amount: MoneyString })),
  }),
});

const TicketResult = z.object({
  problems: z.array(z.object({ line: z.number().int(), message: z.string() })),
  rows: z.array(z.object({
    line: z.number().int(),
    action: z.enum(["attach", "unchanged", "skip"]),
    ticketNumber: z.string(),
    date: z.string(),
    container: z.string(),
    netTons: z.string(),
    rentalId: Uuid.nullable(),
    why: z.string(),
  })),
  counts: z.object({ attach: z.number().int(), unchanged: z.number().int(), skip: z.number().int() }),
});

const TicketFile = {
  /** The facility's file as text: a header naming the ticket, date, container and weight columns, then a row per ticket. */
  csv: z.string().min(1).max(2_000_000),
};

export const previewScaleTickets = defineRoute({
  method: "post",
  path: "/v1/scale-tickets/preview",
  summary: "What a facility's ticket file would do, with nothing written",
  description:
    "Each ticket matched to the haul that collected or swapped out that can on the ticket's date or the day before. Net tons, net pounds, or gross and tare in pounds are all read. A ticket is skipped with the reason when no haul matches, when the haul already carries another ticket, or when a weight typed on the haul disagrees with the file: nothing typed is ever overwritten. A POST because the file is too large for a query string; it writes nothing.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object(TicketFile),
  output: TicketResult,
});

export const applyScaleTickets = defineRoute({
  method: "post",
  path: "/v1/scale-tickets/apply",
  summary: "Attach a facility's tickets to the hauls they weighed",
  description:
    "Worked out again from the same file inside the write, less any `skipLines`, and only empty fields filled: the ticket number, the weight when none was typed, and the facility, material and diverted tons when the haul has none.",
  module: "M22",
  permissions: ["asset:write"],
  idempotent: true,
  input: z.object({ ...TicketFile, skipLines: z.array(z.number().int().min(1)).max(5000).optional() }),
  output: TicketResult.extend({ attached: z.number().int() }),
});

export const rentalBillingRoutes = {
  scheduleRentalCollections, recordRentalCharge, listRentalCharges, removeRentalCharge,
  invoiceRental, previewScaleTickets, applyScaleTickets,
} as const;
