import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, Address, MoneyString, PageRequest, pageOf, Timestamps } from "./common";

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
   */
  balance: MoneyString.optional(),
  creditLimit: MoneyString.nullable().optional(),
  discountRate: MoneyString.nullable().optional(),
}).merge(Timestamps);

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
  input: CustomerCreate.partial().omit({ property: true }).extend({ id: Uuid }),
  output: Customer,
});

export const customerRoutes = {
  listCustomers, getCustomer, createCustomer, updateCustomer,
} as const;
