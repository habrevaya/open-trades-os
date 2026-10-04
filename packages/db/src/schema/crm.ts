import { pgTable, pgEnum, uuid, text, boolean, jsonb, index, uniqueIndex, date, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, sourceRef, sourceRefIndex, money, geocodeColumns } from "./_shared";
import { organization, user } from "./tenancy";
import { marketingChannel, acquisitionCampaign } from "./acquisition";

/**
 * CRM SPINE
 *
 * The single most important modeling decision in this file:
 * `customer` and `property` are SEPARATE tables with a many-to-many join.
 *
 * A property changes owners. A customer owns several properties. A landlord
 * has forty. A property manager bills for properties they do not own. Every
 * incumbent that collapsed these two into one "customer with an address"
 * regrets it, and it is the number one source of dirty data we will inherit
 * during migrations.
 *
 * `equipment` hangs off the PROPERTY, not the customer. The serial number and
 * warranty follow the furnace, not the person who happened to own the house in
 * 2019. This is what makes ten-year service history actually worth something.
 */

export const customerType = pgEnum("customer_type", ["residential", "commercial"]);

export const customer = pgTable("customer", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  type: customerType("type").notNull().default("residential"),
  /** Company name for commercial, or the household display name for residential. */
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  /** Billing address. The SERVICE address lives on property, deliberately. */
  billingAddressLine1: text("billing_address_line1"),
  billingAddressLine2: text("billing_address_line2"),
  billingCity: text("billing_city"),
  billingState: text("billing_state"),
  billingPostalCode: text("billing_postal_code"),
  billingCountry: text("billing_country").notNull().default("US"),
  /**
   * The catalogue key this customer is credited to, for the screens that show
   * one word. The full story is the touches in `marketing_touch`; this is a
   * denormalisation of it, and `lead_source_origin` says whose answer it is.
   */
  leadSource: text("lead_source"),
  /**
   * `manual` when somebody chose it on a form, `derived` when the attribution
   * filled it in from the touches, `imported` when it arrived with a
   * migration. Kept because "the CSR said Google" and "the tracking number
   * said Google" are different evidence, and a report that cannot tell them
   * apart cannot say how much of itself is a guess.
   */
  leadSourceOrigin: text("lead_source_origin"),
  /** The company's own channel and campaign behind `lead_source`, when one is known. */
  channelId: uuid("channel_id").references(() => marketingChannel.id, { onDelete: "set null" }),
  acquisitionCampaignId: uuid("acquisition_campaign_id")
    .references(() => acquisitionCampaign.id, { onDelete: "set null" }),
  /** Net terms in days. 0 means due on receipt. */
  paymentTermsDays: text("payment_terms_days").notNull().default("0"),
  taxExempt: boolean("tax_exempt").notNull().default(false),
  taxExemptCertificate: text("tax_exempt_certificate"),
  /** Org-wide discount applied to this customer, 0.10 for 10 percent. */
  discountRate: money("discount_rate"),
  doNotService: boolean("do_not_service").notNull().default(false),
  doNotServiceReason: text("do_not_service_reason"),
  notes: text("notes"),
  tags: jsonb("tags").$type<string[]>().notNull().default([]),
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
  /**
   * Where this record went when it was merged into another.
   *
   * A merged duplicate is soft deleted and KEPT, rather than removed,
   * because its id is in a link somebody emailed, in an integration that
   * stored it, and in every audit row naming it. Without this column those
   * all resolve to a deleted row, which is the same dead end as having
   * removed it; with it they resolve to an answer.
   *
   * Self referencing and nullable: a live customer has no pointer, and
   * following one twice is how a chain of merges resolves to the record
   * that is actually current.
   */
  mergedIntoId: uuid("merged_into_id"),
  /**
   * The customer who sent them, when somebody did.
   *
   * Written once, from a referral link they arrived through or by the office,
   * and never overwritten by a later link: the neighbour who told them about
   * the company is the referrer, and a second neighbour sharing a link a year
   * later does not take the first one's reward. Set null when the referrer is
   * deleted rather than cascading, because the referred customer is still a
   * customer.
   */
  referredByCustomerId: uuid("referred_by_customer_id")
    .references((): AnyPgColumn => customer.id, { onDelete: "set null" }),
  /**
   * The code in this customer's own shareable link. Minted the first time
   * anybody asks for it rather than at creation, so the thousands of
   * customers nobody will ever ask to refer anyone carry nothing. Short,
   * unambiguous to read aloud, and unique within the company: it is typed
   * into a phone by a neighbour as often as it is clicked.
   */
  referralCode: text("referral_code"),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  sourceRefIdx: sourceRefIndex("customer_source_ref_idx", t),
  referralCodeIdx: uniqueIndex("customer_referral_code_idx").on(t.organizationId, t.referralCode)
    .where(sql`${t.referralCode} is not null`),
  referredByIdx: index("customer_referred_by_idx").on(t.organizationId, t.referredByCustomerId),
  orgIdx: index("customer_org_idx").on(t.organizationId),
  nameIdx: index("customer_name_idx").on(t.organizationId, t.name),
  emailIdx: index("customer_email_idx").on(t.organizationId, t.email),
}));

/**
 * TWO RECORDS SOMEBODY LOOKED AT AND SAID ARE DIFFERENT PEOPLE.
 *
 * The company wide duplicate sweep matches on a shared phone, a shared email
 * or a similar name, and two of those are true of people who are not the
 * same: a landlord and the tenant whose bills she pays share a number, and
 * "John Smith" is two customers in any town of size. Without a memory of the
 * decision the sweep shows the same pair every morning until somebody stops
 * opening it, which is the failure a duplicate list most often dies of.
 *
 * Stored as an ORDERED pair, the smaller id first, so the pair has one row
 * whichever side somebody dismissed it from, and the unique index makes a
 * second press a no op rather than a second row.
 */
export const customerNotDuplicate = pgTable("customer_not_duplicate", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** The smaller of the two ids. */
  customerAId: uuid("customer_a_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  /** The larger. */
  customerBId: uuid("customer_b_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  /** Why, when somebody said. "Landlord and tenant" is the usual one. */
  reason: text("reason"),
  decidedByUserId: uuid("decided_by_user_id").references(() => user.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  pairIdx: uniqueIndex("customer_not_duplicate_pair_idx").on(t.organizationId, t.customerAId, t.customerBId),
  /** The per record matcher asks from either side. */
  bIdx: index("customer_not_duplicate_b_idx").on(t.customerBId),
}));

export const property = pgTable("property", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  nickname: text("nickname"),
  addressLine1: text("address_line1").notNull(),
  addressLine2: text("address_line2"),
  city: text("city").notNull(),
  state: text("state").notNull(),
  postalCode: text("postal_code").notNull(),
  country: text("country").notNull().default("US"),
  /**
   * Where it is, how close, and who said so. Filled by the worker from the
   * company's geocoder, never inline in the request that saved the address,
   * so a slow geocoder never holds up a customer being added; or placed by
   * hand from the property page, which then wins. See `geocodeColumns`.
   */
  ...geocodeColumns(),
  /** Resolved at save time from the service-area territories. Drives dispatch zoning. */
  territoryId: uuid("territory_id"),
  /** Jurisdiction stack for sales tax. Historical rates live on the invoice line. */
  taxJurisdictionId: uuid("tax_jurisdiction_id"),
  squareFeet: text("square_feet"),
  yearBuilt: text("year_built"),
  gateCode: text("gate_code"),
  accessNotes: text("access_notes"),
  /** Safety flags a technician must see before they get out of the truck. */
  hazardNotes: text("hazard_notes"),
  hasDog: boolean("has_dog").notNull().default(false),
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
  ...sourceRef,
  ...timestamps,
}, (t) => ({
  sourceRefIdx: sourceRefIndex("property_source_ref_idx", t),
  orgIdx: index("property_org_idx").on(t.organizationId),
  addrIdx: index("property_addr_idx").on(t.organizationId, t.postalCode, t.addressLine1),
}));

export const customerPropertyRole = pgEnum("customer_property_role", ["owner", "tenant", "manager", "billing"]);

/** Many-to-many, with a role and a validity window so ownership history survives. */
export const customerProperty = pgTable("customer_property", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").notNull().references(() => customer.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").notNull().references(() => property.id, { onDelete: "cascade" }),
  role: customerPropertyRole("role").notNull().default("owner"),
  isPrimary: boolean("is_primary").notNull().default(true),
  startedOn: date("started_on"),
  endedOn: date("ended_on"),
  ...timestamps,
}, (t) => ({
  custIdx: index("customer_property_customer_idx").on(t.customerId),
  propIdx: index("customer_property_property_idx").on(t.propertyId),
}));

export const contact = pgTable("contact", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").references(() => property.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  title: text("title"),
  email: text("email"),
  phone: text("phone"),
  preferredChannel: text("preferred_channel").notNull().default("sms"),
  isPrimary: boolean("is_primary").notNull().default(false),
  /**
   * NEITHER OF THESE GATES ANYTHING, and the comment here used to say the
   * first one did: "absence of this blocks marketing sends". It never has.
   * Nothing reads either column, and sending asks `communication_consent`,
   * which records the channel, the purpose, the wording used and supersedes
   * rather than overwrites.
   *
   * A timestamp on the contact cannot answer the question consent is about,
   * which is what they agreed to and for which purpose: one column cannot
   * hold "yes to appointment reminders, no to offers", and that distinction
   * is the whole of the rule. Left in place because imports carry the field
   * and losing an imported date is worse than holding one nothing consults,
   * but a value here means a migration said so, never that we may send.
   */
  smsConsentAt: timestamp("sms_consent_at", { withTimezone: true }),
  emailOptOutAt: timestamp("email_opt_out_at", { withTimezone: true }),
  /**
   * When the office let this person sign in to the customer's portal with
   * their own email or mobile number. Null is the default and means they
   * cannot: a contact is somebody the office talks to about an account,
   * which is not the same as somebody who may see its bills and pay them,
   * so the office says so person by person. What they reach once signed in
   * is the customer's account, and everything they do there is recorded as
   * them (`audit_log.actor_contact_id`).
   */
  portalAccessAt: timestamp("portal_access_at", { withTimezone: true }),
  ...sourceRef,
  ...timestamps,
}, (t) => ({ orgIdx: index("contact_org_idx").on(t.organizationId) }));

/**
 * Installed equipment. Belongs to the property.
 * This table is why a contractor will not leave once they have five years in it.
 */
export const equipment = pgTable("equipment", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  propertyId: uuid("property_id").notNull().references(() => property.id, { onDelete: "cascade" }),
  /**
   * Assets nest. A riser has valves, a rooftop unit has a compressor, a panel
   * has circuits. Commercial inspection work is unusable without this, and
   * adding it after readings exist is a results-table migration.
   */
  parentEquipmentId: uuid("parent_equipment_id"),
  /** Label the customer and the inspector both use: "RTU-4", "Riser 2". */
  tag: text("tag"),
  category: text("category").notNull(),
  manufacturer: text("manufacturer"),
  model: text("model"),
  serialNumber: text("serial_number"),
  installedOn: date("installed_on"),
  installedByUs: boolean("installed_by_us").notNull().default(false),
  warrantyPartsExpiresOn: date("warranty_parts_expires_on"),
  warrantyLaborExpiresOn: date("warranty_labor_expires_on"),
  location: text("location"),
  attributes: jsonb("attributes").$type<Record<string, unknown>>().notNull().default({}),
  active: boolean("active").notNull().default(true),
  ...sourceRef,
  /**
   * The company's own fields, checked against the definitions in M29 by the
   * service that writes them. See `services/custom-fields.ts`.
   */
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => ({
  propIdx: index("equipment_property_idx").on(t.propertyId),
  serialIdx: index("equipment_serial_idx").on(t.organizationId, t.serialNumber),
  parentIdx: index("equipment_parent_idx").on(t.parentEquipmentId),
  tagIdx: index("equipment_tag_idx").on(t.organizationId, t.propertyId, t.tag),
}));
