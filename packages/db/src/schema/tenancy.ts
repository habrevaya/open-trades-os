import { pgTable, pgEnum, uuid, text, boolean, jsonb, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";

/**
 * TENANCY SPINE
 *
 * `organization` is the tenant root. Every single tenant-scoped table below
 * carries organization_id and is covered by a row level security policy.
 * Retrofitting tenancy is the most common way a project like this dies, so it
 * is in the first migration.
 *
 * business_unit  = a P&L rollup (Service, Install, Commercial). Reporting axis.
 * location       = a physical branch or warehouse. Inventory and dispatch axis.
 * These are deliberately separate: a three-branch HVAC shop has 3 locations and
 * 2 business units, and conflating them makes job costing unusable later.
 */

/**
 * THE LAYER ABOVE THE TENANT
 *
 * `organization` stays the tenant root and row level security does not change.
 * What was missing is the layer above it, and it is the single most expensive
 * thing on the list to retrofit, because RLS design is foundational.
 *
 * Franchise systems and private equity roll-ups are the same requirement in
 * different clothes: several organizations under one owner, who needs defined,
 * auditable, granular read access to aggregates across them, plus real
 * cross-organization transactions (royalties, referral fees, shared services
 * allocations).
 *
 * The rule that keeps this safe: a network grant NEVER widens the RLS policy.
 * Cross-organization reads go through an explicit grant checked in the
 * application and recorded in the audit log, against a named aggregate, never
 * by relaxing the tenant boundary. The boundary stays absolute.
 */
export const networkKind = pgEnum("network_kind", ["franchise", "holding", "cooperative"]);

export const network = pgTable("network", {
  id: pk(),
  kind: networkKind("kind").notNull().default("holding"),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  /** The organization that operates the network itself, if it operates at all. */
  operatorOrganizationId: uuid("operator_organization_id"),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => ({ slugIdx: uniqueIndex("network_slug_idx").on(t.slug) }));

export const organization = pgTable("organization", {
  id: pk(),
  name: text("name").notNull(),
  slug: text("slug").notNull(),
  legalName: text("legal_name"),
  ein: text("ein"),
  timezone: text("timezone").notNull().default("America/Chicago"),
  currency: text("currency").notNull().default("USD"),
  logoUrl: text("logo_url"),
  brandColor: text("brand_color"),
  /** Trade pack applied at setup. Drives seeded price book, checklists, KPIs. */
  primaryTrade: text("primary_trade"),
  setupCompletedAt: timestamp("setup_completed_at", { withTimezone: true }),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  /** Set when this organization belongs to a franchise or holding network. */
  networkId: uuid("network_id").references(() => network.id, { onDelete: "set null" }),
  /** The franchisee's territory or the acquired brand's identifier. */
  networkMemberCode: text("network_member_code"),
  ...timestamps,
}, (t) => ({
  slugIdx: uniqueIndex("organization_slug_idx").on(t.slug),
  networkIdx: index("organization_network_idx").on(t.networkId),
}));

/**
 * An explicit, auditable grant of one named aggregate from one organization to
 * a network. Never a blanket read. The grantee sees the aggregate, not the
 * underlying rows, unless a separate grant says otherwise.
 */
export const networkGrant = pgTable("network_grant", {
  id: pk(),
  networkId: uuid("network_id").notNull().references(() => network.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** "revenue_summary", "job_counts", "kpi_scorecard", "gl_summary". */
  aggregate: text("aggregate").notNull(),
  grantedByUserId: uuid("granted_by_user_id"),
  grantedAt: timestamp("granted_at", { withTimezone: true }).notNull().defaultNow(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  uniq: uniqueIndex("network_grant_uniq_idx").on(t.networkId, t.organizationId, t.aggregate),
}));

export const businessUnit = pgTable("business_unit", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  code: text("code"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("business_unit_org_idx").on(t.organizationId) }));

export const location = pgTable("location", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  addressLine1: text("address_line1"),
  addressLine2: text("address_line2"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  country: text("country").notNull().default("US"),
  timezone: text("timezone"),
  isWarehouse: boolean("is_warehouse").notNull().default(false),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("location_org_idx").on(t.organizationId) }));

/** Platform-level identity. A person can belong to several organizations. */
export const user = pgTable("user", {
  id: pk(),
  email: text("email").notNull(),
  emailVerifiedAt: timestamp("email_verified_at", { withTimezone: true }),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  phone: text("phone"),
  ...timestamps,
}, (t) => ({ emailIdx: uniqueIndex("user_email_idx").on(t.email) }));

/**
 * Mirrors the role presets in @opentradesos/core access/roles.ts, which are
 * the authority. A role is a named set of permissions and nothing more, so a
 * change here without a change there is a bug.
 *
 * back office = office_manager, finance = accountant, field = technician and
 * crew_lead.
 */
export const memberRole = pgEnum("member_role", [
  "owner",
  "admin",
  "office_manager",
  "dispatcher",
  "csr",
  "technician",
  "crew_lead",
  "accountant",
  "readonly",
]);

/**
 * Membership is the join that RLS reads. `current_org_id()` in the policies
 * resolves through this table, so a leak here is a cross-tenant data leak.
 * It gets its own pgTAP tests.
 */
export const membership = pgTable("membership", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  role: memberRole("role").notNull().default("technician"),
  /**
   * Overrides on top of the preset. Grants add, revocations remove, and
   * revocation always beats a grant so taking access away is never ambiguous.
   * Resolved by permissionsFor() in @opentradesos/core.
   */
  grants: jsonb("grants").$type<string[]>().notNull().default([]),
  revocations: jsonb("revocations").$type<string[]>().notNull().default([]),
  /**
   * Narrows WHICH records, within the tenant boundary that row level security
   * already guarantees unconditionally. Scope is a privacy control inside one
   * company; RLS is the cross tenant control. Two mechanisms on purpose, so the
   * catastrophic one stays simple.
   */
  scopeOverrides: jsonb("scope_overrides").$type<Record<string, string>>().notNull().default({}),
  businessUnitId: uuid("business_unit_id").references(() => businessUnit.id, { onDelete: "set null" }),
  locationId: uuid("location_id").references(() => location.id, { onDelete: "set null" }),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  uniq: uniqueIndex("membership_org_user_idx").on(t.organizationId, t.userId),
  userIdx: index("membership_user_idx").on(t.userId),
}));

/** Technician-specific profile. Separate from membership so office staff rows stay clean. */
export const technician = pgTable("technician", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  membershipId: uuid("membership_id").notNull().references(() => membership.id, { onDelete: "cascade" }),
  displayName: text("display_name").notNull(),
  color: text("color"),
  /** Skills and licenses gate dispatch assignment in the scheduling engine. */
  skills: jsonb("skills").$type<string[]>().notNull().default([]),
  licenses: jsonb("licenses").$type<Array<{ type: string; number: string; expiresOn: string }>>().notNull().default([]),
  homeLocationId: uuid("home_location_id").references(() => location.id, { onDelete: "set null" }),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("technician_org_idx").on(t.organizationId) }));
