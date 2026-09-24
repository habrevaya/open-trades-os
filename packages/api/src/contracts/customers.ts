import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, Address, MoneyString, RateString, PageRequest, pageOf, Timestamps } from "./common";

export const CustomerType = z.enum(["residential", "commercial"]);

export const Customer = z.object({
  id: Uuid,
  type: CustomerType,
  name: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  billingAddress: Address.partial().nullable(),
  leadSource: z.string().nullable(),
  paymentTermsDays: z.number().int(),
  taxExempt: z.boolean(),
  doNotService: z.boolean(),
  doNotServiceReason: z.string().nullable(),
  tags: z.array(z.string()),
  customFields: z.record(z.unknown()),
  /**
   * Only present when the caller holds customer.financials:read. Field
   * redaction happens once at the API boundary rather than in the UI, because
   * hiding a number in the UI means it already crossed the wire.
   *
   * `balance` is COMPUTED from the open invoices on every read, never stored.
   * A stored balance is a number two writers race to update, and the one
   * that loses leaves a customer owing money the system thinks they paid.
   *
   * `creditLimit` used to be published here and there was no column for it,
   * no service that set one and nothing that enforced one. A generated
   * client had a field that was always undefined. It is removed rather than
   * given a column, because a credit limit that is stored and not enforced
   * is worse than none: it reads on a screen as a control that is operating.
   */
  balance: MoneyString.optional(),
  discountRate: MoneyString.nullable().optional(),
}).merge(Timestamps);

/**
 * The fields a create does not take and an update does.
 *
 * Kept apart deliberately. Marking somebody as not to be serviced is a
 * decision about a relationship that exists; it is not a thing anybody sets
 * while typing in a new customer, and offering it on the create form invites
 * it to be set by accident on the day somebody is added.
 */
export const CustomerStanding = z.object({
  doNotService: z.boolean().optional(),
  /**
   * Required by the service when the flag goes on. A customer nobody may
   * work for, with no reason recorded, is a decision the next person cannot
   * evaluate and will not overturn.
   */
  doNotServiceReason: z.string().max(1000).nullable().optional(),
  /**
   * Writable only by a caller holding customer.financials:write. A standing
   * discount is a price change on every future invoice.
   */
  discountRate: RateString.nullable().optional(),
});

export const CustomerCreate = z.object({
  type: CustomerType.default("residential"),
  name: z.string().min(1).max(200),
  email: z.string().email().optional(),
  phone: z.string().max(40).optional(),
  billingAddress: Address.optional(),
  leadSource: z.string().max(100).optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
  taxExempt: z.boolean().default(false),
  tags: z.array(z.string()).default([]),
  customFields: z.record(z.unknown()).default({}),
  /**
   * Create the first property in the same call. Almost every real customer
   * creation has an address attached, and making it two calls guarantees
   * orphaned customers whenever the second one fails.
   */
  property: z.object({
    nickname: z.string().max(100).optional(),
    address: Address,
    accessNotes: z.string().max(2000).optional(),
  }).optional(),
});

export const listCustomers = defineRoute({
  method: "get",
  path: "/v1/customers",
  summary: "List customers",
  module: "M03",
  permissions: ["customer:read"],
  input: PageRequest.extend({
    /** Trigram search across name, email and phone. */
    q: z.string().max(200).optional(),
    type: CustomerType.optional(),
    tag: z.string().optional(),
    includeInactive: z.boolean().default(false),
  }),
  output: pageOf(Customer),
});

export const getCustomer = defineRoute({
  method: "get",
  path: "/v1/customers/{id}",
  summary: "Get a customer",
  module: "M03",
  permissions: ["customer:read"],
  input: z.object({ id: Uuid }),
  output: Customer,
});

export const createCustomer = defineRoute({
  method: "post",
  path: "/v1/customers",
  summary: "Create a customer",
  description: "Optionally creates the customer's first property in the same transaction.",
  module: "M03",
  permissions: ["customer:write"],
  idempotent: true,
  input: CustomerCreate,
  output: Customer,
});

export const updateCustomer = defineRoute({
  method: "patch",
  path: "/v1/customers/{id}",
  summary: "Update a customer",
  module: "M03",
  permissions: ["customer:write"],
  /**
   * Nullable on every field that is nullable on the row, which `.partial()`
   * alone does not give: `.optional()` means "leave it" and a caller also
   * needs "clear it". Without this a customer whose email is wrong can have
   * it replaced and never removed.
   */
  input: CustomerCreate.partial().omit({ property: true }).extend({
    id: Uuid,
    email: z.string().email().nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    leadSource: z.string().max(100).nullable().optional(),
  }).merge(CustomerStanding),
  output: Customer,
});

export const customerRoutes = {
  listCustomers, getCustomer, createCustomer, updateCustomer,
} as const;
