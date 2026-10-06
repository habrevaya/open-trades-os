import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, Address, MoneyString, RateString, PageRequest, pageOf, Timestamps, ExternalRef, ExternalLookup } from "./common";
import { FieldFilters } from "./custom-fields";

export const CustomerType = z.enum(["residential", "commercial"]);

export const Customer = z.object({
  id: Uuid,
  type: CustomerType,
  name: z.string(),
  email: z.string().email().nullable(),
  phone: z.string().nullable(),
  billingAddress: Address.partial().nullable(),
  /** A key from the lead source catalogue, for the screens that show one word. */
  leadSource: z.string().nullable(),
  /** `manual` when somebody chose it, `derived` when the attribution filled it, `imported` from a migration. */
  leadSourceOrigin: z.string().nullable().optional(),
  /** The company's own channel and tracking campaign behind the source. */
  channelId: Uuid.nullable().optional(),
  acquisitionCampaignId: Uuid.nullable().optional(),
  paymentTermsDays: z.number().int(),
  taxExempt: z.boolean(),
  /** The exemption certificate's number, as the customer gave it. */
  taxExemptCertificate: z.string().nullable().optional(),
  /** The last day the certificate covers. After it the customer is taxed like anybody else. */
  taxExemptExpiresOn: z.string().date().nullable().optional(),
  /** The company's sales tax rate this customer is charged where their address names none (`/v1/tax-rates`). */
  taxRateId: Uuid.nullable().optional(),
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
  externalRef: ExternalRef.nullable(),
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
  /**
   * Where they came from. A catalogue key or anything its alias list places
   * ("Google Ads" arrives as `google_ads`), a channel from the company's
   * list, or a tracking campaign, which implies its channel. A word nothing
   * can place is refused, except on a record carrying `externalRef`, which
   * keeps what its old system said.
   */
  leadSource: z.string().max(100).optional(),
  channelId: Uuid.optional(),
  campaignId: Uuid.optional(),
  paymentTermsDays: z.number().int().min(0).max(365).default(0),
  /**
   * Exempt from sales tax. Nothing is charged while the certificate is in
   * force; record its number and the last day it covers, because a sale
   * billed exempt on a lapsed certificate is tax the company still owes.
   */
  taxExempt: z.boolean().default(false),
  taxExemptCertificate: z.string().max(100).optional(),
  taxExemptExpiresOn: z.string().date().optional(),
  /** One of the company's sales tax rates, charged where the address names none. Left off for the usual rate. */
  taxRateId: Uuid.optional(),
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
    /**
     * The address's own custom fields, held to the property definitions as a
     * property created on its own is. Without this a required property field
     * was skipped by every customer created with an address.
     */
    customFields: z.record(z.unknown()).optional(),
  }).optional(),
  /** Where this came from in another system. See `ExternalRef`. */
  externalRef: ExternalRef.optional(),
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
    /** One tag. Kept for callers that already send it; the same as `tags` with one entry. */
    tag: z.string().max(40).optional(),
    /**
     * Customers carrying these tags, compared without case. `tagMatch` says
     * whether a customer needs any of them (the default) or every one.
     */
    tags: z.array(z.string().max(40)).max(20).optional(),
    tagMatch: z.enum(["any", "all"]).optional(),
    /** Customers one branch has done work for. */
    businessUnitId: Uuid.optional(),
    /**
     * Customers whose custom field `fieldKey` holds `fieldValue`. The key has
     * to be a field the company has declared on customers. A yes or no field
     * matches `true` or `false`; a field with several choices matches a
     * customer holding that choice among theirs.
     */
    fieldKey: z.string().max(64).optional(),
    fieldValue: z.string().max(200).optional(),
    /** Several fields at once, each `key:value`, every one of which has to hold. */
    fields: FieldFilters,
    includeInactive: z.boolean().default(false),
    /** Find by where it came from. See `ExternalRef`. */
    ...ExternalLookup,
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
  input: CustomerCreate.partial().omit({ property: true, externalRef: true }).extend({
    id: Uuid,
    email: z.string().email().nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    leadSource: z.string().max(100).nullable().optional(),
    channelId: Uuid.nullable().optional(),
    campaignId: Uuid.nullable().optional(),
    taxExemptCertificate: z.string().max(100).nullable().optional(),
    taxExemptExpiresOn: z.string().date().nullable().optional(),
    taxRateId: Uuid.nullable().optional(),
  }).merge(CustomerStanding),
  output: Customer,
});


/**
 * REMOVING AND MERGING, WHICH NOTHING COULD REACH
 *
 * `customer:delete` and `customer:merge` were in the permission catalogue from
 * the first commit, both granted to the office manager preset, and
 * `permissions-enforced.test.ts` found that nothing asserted either. The service
 * was written to fix that and it got no routes and no screen, so the permissions
 * were asserted by code nobody could call, which from an owner's side is the same
 * as not being asserted at all: the role list promised a capability and there was
 * no button.
 *
 * What happens without them is not that nothing happens. A company that mis-keys
 * a customer, or takes two leads from the same person through two forms, edits one
 * of the rows into something else. That is how a CRM ends up with a customer
 * called "DO NOT USE" and another called "Smith (real one)", both carrying history
 * that is now attached to a lie.
 */

export const BlockingCount = z.object({ label: z.string(), n: z.number().int() });

export const getCustomerDeletability = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/deletability",
  summary: "Whether this customer can be removed, and what would go with them",
  description:
    "Asked before anybody clicks, because the answer decides which button a screen should show. A delete refused after the click with a list of reasons is a worse version of the same information. `blockedBy` is records of money, which make deleting the wrong answer rather than a risky one; `wouldRemove` is everything else, shown so nobody is surprised.",
  module: "M03",
  permissions: ["customer:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    deletable: z.boolean(),
    blockedBy: z.array(BlockingCount),
    wouldRemove: z.array(BlockingCount),
  }),
});

export const removeCustomer = defineRoute({
  method: "post",
  path: "/v1/customers/{id}/remove",
  summary: "Take a customer off the books",
  description:
    "Soft, and refused outright when money points at them. A hard delete would cascade through the foreign keys and take the invoices with it; a soft delete on a customer with invoices leaves a receivable nobody can explain. Both are worse than refusing, so this refuses and names what is in the way, which is also the case where merging is the right answer. The reason is required: it is the only thing left to read when somebody asks why this record is gone.",
  module: "M03",
  permissions: ["customer:delete"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().min(1).max(500) }),
  output: z.object({ id: Uuid, removed: z.literal(true), reason: z.string() }),
});

export const mergeCustomers = defineRoute({
  method: "post",
  path: "/v1/customers/{keepId}/merge",
  summary: "Join two records that are the same person",
  description:
    "EVERYTHING MOVES, including the money, which is the difference between this and removing: a merge does not discard a history, it re-parents one, so the invoices raised against the duplicate become invoices against the survivor and the balance is right for the first time. The duplicate is soft deleted and keeps a pointer to the survivor, because an id that stops resolving breaks a link somebody emailed, an integration that stored it and every audit row naming it. The response says what moved and which blank fields on the survivor were filled in from the duplicate.",
  module: "M03",
  permissions: ["customer:merge"],
  idempotent: true,
  input: z.object({ keepId: Uuid, mergeId: Uuid, reason: z.string().max(500).optional() }),
  output: z.object({
    keptId: Uuid,
    mergedId: Uuid,
    name: z.string(),
    moved: z.array(BlockingCount),
    filled: z.array(z.string()),
  }),
});

export const getCustomerDuplicates = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/duplicates",
  summary: "The records that look like the same person",
  description:
    "Three signals, strongest first, and each candidate says WHY rather than carrying a score: the same phone number, the same email address, or a similar name by trigram similarity. There is deliberately no single number, because one would have to weigh a shared phone against a name similarity and whatever weighting was chosen would be wrong for somebody. Records already merged away are excluded, so one cannot come back as a candidate for merging again.",
  module: "M03",
  permissions: ["customer:read"],
  input: z.object({ id: Uuid, limit: z.number().int().min(1).max(50).optional() }),
  output: z.object({
    candidates: z.array(z.object({
      id: Uuid,
      name: z.string(),
      phone: z.string().nullable(),
      email: z.string().nullable(),
      because: z.string(),
    })),
  }),
});

export const getCustomerMergedInto = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/merged-into",
  summary: "Where a merged customer went",
  description:
    "The read that makes keeping the duplicate worth anything. Without it the pointer is a column nobody follows and the old id resolving to a soft deleted row is the same dead end as deleting it. Answers null for a customer that was never merged, so a caller can follow it twice and find the record that is actually current.",
  module: "M03",
  permissions: ["customer:read"],
  input: z.object({ id: Uuid }),
  output: z.object({ into: z.object({ id: Uuid, name: z.string() }).nullable() }),
});

export const customerRoutes = {
  listCustomers, getCustomer, createCustomer, updateCustomer,
  getCustomerDeletability, removeCustomer, mergeCustomers, getCustomerMergedInto,
  getCustomerDuplicates,
} as const;
