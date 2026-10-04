import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp, type AnyPgColumn } from "drizzle-orm/pg-core";
import { pk, timestamps, geocodeColumns } from "./_shared";

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
  /**
   * What whoever runs this deployment calls this company, when somebody does.
   *
   * Written only by the operator API, and the reason it exists is retries. A
   * control plane that creates a company and loses the response has to be
   * able to ask again without making a second one, and the only thing it can
   * ask with is its own identifier. Unique, so two concurrent retries cannot
   * both win, and null for every company that signed itself up.
   *
   * A tenant cannot change it. If one could, it could take another
   * customer's reference and receive that customer's ids on the operator's
   * next retry, so a trigger in sql/after.sql refuses the write from any role
   * that is not the operator.
   */
  externalRef: text("external_ref"),
  /**
   * Set while this company is suspended by whoever runs the deployment.
   *
   * Suspension refuses access and changes nothing else: no row is deleted,
   * nothing is revoked, and resuming puts every session and token back
   * exactly as it was. The refusal lives in the SQL that resolves a session,
   * an app token and a portal link, and in what the worker is allowed to
   * find, so a caller cannot forget to check it. Guarded by the same trigger
   * as `external_ref`.
   */
  suspendedAt: timestamp("suspended_at", { withTimezone: true }),
  /** Why, in the operator's words. Shown to nobody but the operator. */
  suspendedReason: text("suspended_reason"),
  /**
   * A SANDBOX: a practice copy of a company's configuration, set on the copy
   * and naming the company it was copied from.
   *
   * A real tenant rather than a flag on records, so everything row level
   * security already guarantees about two companies is what keeps practice
   * data out of the real one: nothing tried in a sandbox can reach a real
   * customer's record, because no query in the sandbox can see one. See
   * `services/sandbox.ts`.
   */
  sandboxOfOrganizationId: uuid("sandbox_of_organization_id").references((): AnyPgColumn => organization.id, { onDelete: "set null" }),
  /**
   * On the real company, its current sandbox. Kept on this side too because
   * row level security hides the sandbox's own row from the real company,
   * and "open my sandbox" has to find it from here.
   */
  sandboxOrganizationId: uuid("sandbox_organization_id").references((): AnyPgColumn => organization.id, { onDelete: "set null" }),
  /** When the sandbox was thrown away. Its people are signed out of it and it is never opened again. */
  sandboxDiscardedAt: timestamp("sandbox_discarded_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  slugIdx: uniqueIndex("organization_slug_idx").on(t.slug),
  networkIdx: index("organization_network_idx").on(t.networkId),
  externalRefIdx: uniqueIndex("organization_external_ref_idx").on(t.externalRef)
    .where(sql`${t.externalRef} is not null`),
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
  /**
   * Where it is, the same way a property is. A location is where a
   * technician's day starts and ends (`technician.home_location_id`, or the
   * company's first location when somebody has none), so the route optimiser
   * cannot order a day without it. Geocoded by the same worker and pinnable
   * by hand the same way.
   */
  ...geocodeColumns(),
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
 * A role a company defined for itself.
 *
 * The nine presets are starting points, not a taxonomy. A company with four
 * branches wants a branch manager, and one with a warehouse wants somebody
 * who reads inventory and nothing else, and neither is a preset with extras
 * bolted on.
 *
 * What makes this safe to expose is enforced in core, not here:
 * `canDefineRole` refuses a permission the author does not hold and refuses a
 * scope wider than their own. Without it `role:write` is quietly equivalent
 * to every permission in the catalogue, because a role is a container for
 * permissions and anyone who can write one can write `owner` into it.
 *
 * `basedOn` is a record of where the definition started, kept because "which
 * preset was this before somebody edited it" is the first question asked when
 * a role behaves unexpectedly. It has no effect on resolution: a custom role
 * REPLACES the preset rather than adding to it.
 */
export const role = pgTable("role", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  basedOn: memberRole("based_on"),
  /** Permission keys from the catalogue in @opentradesos/core. */
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  /** Per resource scope, same shape and same meaning as on a membership. */
  scopes: jsonb("scopes").$type<Record<string, string>>().notNull().default({}),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  /**
   * Names are how people refer to a role out loud, so two roles called
   * "Branch Manager" in one company is a support call waiting to happen.
   * Scoped to the organization, and only among the live ones, so a deleted
   * role does not hold its name hostage.
   */
  nameIdx: uniqueIndex("role_name_idx").on(t.organizationId, t.name).where(sql`${t.deletedAt} is null`),
}));

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
   * A custom role, when the company defined one. It REPLACES the preset above
   * rather than adding to it, because a company that has defined its own role
   * means that role and not a preset with unexplained extras. `role` stays
   * populated so a membership always has a readable label and so removing the
   * custom role falls back to something sane rather than to nothing.
   */
  roleId: uuid("role_id").references(() => role.id, { onDelete: "set null" }),
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
  /**
   * Who this person answers to, when the company has said.
   *
   * Read by task escalation and nothing else: "tell the assignee's manager"
   * needs somebody to tell, and a role preset is not a person. Nullable,
   * because most companies of four people have never written it down, and
   * an escalation with no manager recorded goes to the owners and says why
   * rather than going nowhere.
   */
  reportsToUserId: uuid("reports_to_user_id").references(() => user.id, { onDelete: "set null" }),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  uniq: uniqueIndex("membership_org_user_idx").on(t.organizationId, t.userId),
  userIdx: index("membership_user_idx").on(t.userId),
}));

/**
 * Sessions are a table, not a signed stateless token.
 *
 * A stateless JWT cannot be revoked, and in this product revocation is a real
 * requirement rather than a checkbox: an owner firing a technician needs that
 * technician out of the system before they reach the truck, not whenever the
 * token happens to expire. The cost is a lookup per request, which is one
 * indexed read.
 *
 * The session carries the active organization, so a user who belongs to
 * several switches context without re-authenticating, and every request
 * resolves its tenant from here rather than from anything the client sends.
 */
export const session = pgTable("session", {
  id: pk(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  /** SHA-256 of the cookie value. The raw token is never stored. */
  tokenHash: text("token_hash").notNull(),
  activeOrganizationId: uuid("active_organization_id").references(() => organization.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (t) => ({
  tokenIdx: uniqueIndex("session_token_idx").on(t.tokenHash),
  userIdx: index("session_user_idx").on(t.userId, t.expiresAt),
}));

/** Password credentials, separate from the user so SSO users simply have none. */
export const credential = pgTable("credential", {
  id: pk(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  /** scrypt. Never reversible, never logged, never returned. */
  passwordHash: text("password_hash").notNull(),
  passwordChangedAt: timestamp("password_changed_at", { withTimezone: true }).notNull().defaultNow(),
  failedAttempts: integer("failed_attempts").notNull().default(0),
  lockedUntil: timestamp("locked_until", { withTimezone: true }),
  ...timestamps,
}, (t) => ({ userIdx: uniqueIndex("credential_user_idx").on(t.userId) }));

/**
 * A ONE TIME LINK TO SET A FIRST PASSWORD
 *
 * When somebody else creates the company (the operator API, for a hosted
 * deployment or for a firm running several companies), the owner exists
 * before they have chosen a password, and the only safe thing to hand them
 * is a link that lets them choose one. Not a password chosen for them, which
 * then lives in an email and a support ticket forever.
 *
 * The same shape as a session: only the SHA-256 of the token is stored, so a
 * dump of this table opens nothing. Single use, expiring, and only ever
 * redeemable for a user who has NO password yet. That last condition is the
 * important one and it is enforced in the SQL that consumes the token, not
 * here: without it, anybody able to issue a link for an address could take
 * over the existing account behind it.
 *
 * No organization_id, for the reason `credential` has none: it sits above the
 * tenant. Read and written only through SECURITY DEFINER functions, with a
 * deny-all policy for everybody else.
 */
export const setupToken = pgTable("setup_token", {
  id: pk(),
  userId: uuid("user_id").notNull().references(() => user.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  /** Set when a newer link replaced this one, so only the latest one works. */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  tokenIdx: uniqueIndex("setup_token_token_idx").on(t.tokenHash),
  userIdx: index("setup_token_user_idx").on(t.userId),
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
  /**
   * The hours of this person's working day, local time, when they are not
   * the company's. The rebalance plans their day inside these and counts
   * anything past `endsAt` as overtime. Null is the company's day.
   */
  workday: jsonb("workday").$type<{ startsAt: string; endsAt: string } | null>(),
  /**
   * Whether this person's phone shares where they are while they work, when
   * the company shares locations at all. On by default once the company
   * turns sharing on; the office turns it off for somebody, and the person
   * sees which it is on their own phone. Never shared off the clock either
   * way: see `packages/core/src/location`.
   */
  shareLocation: boolean("share_location").notNull().default(true),
  /**
   * The photograph a customer sees on their tracking link, a `stored_file`
   * id. No foreign key, because `stored_file` is declared in a file that
   * imports this one; a photo whose file has gone is simply not shown.
   */
  photoFileId: uuid("photo_file_id"),
  /**
   * The wage classification this person is normally paid at.
   *
   * It is a name rather than a foreign key to `wage_scale`, because a scale
   * is dated: the classification "Journeyman Electrician" outlives the row
   * that says what a journeyman earned in 2025. The entry resolves the row
   * that was in effect on the day it was worked.
   *
   * `timeclock_entry.classification` was already captured at the punch, with
   * a comment about not reconstructing it six weeks later. Nothing supplied
   * it, because the phone had nowhere to read it from, so it was always null
   * and the reconstruction it exists to avoid was the only option available.
   */
  wageClassification: text("wage_classification"),
  /**
   * The mobile number a sign in code for the field app is texted to.
   *
   * On the technician rather than on `user.phone`, because a person can work
   * for two companies and each one decides for itself which number it texts
   * a code to. And set by the office, never by whoever is asking for a code,
   * because a sign in sent to a number the asker chose is not a sign in.
   */
  mobilePhone: text("mobile_phone"),
  active: boolean("active").notNull().default(true),
  /**
   * The company's own fields, checked against the definitions in M29 by the
   * service that writes them. See `services/custom-fields.ts`.
   */
  customFields: jsonb("custom_fields").$type<Record<string, unknown>>().notNull().default({}),
  ...timestamps,
}, (t) => ({ orgIdx: index("technician_org_idx").on(t.organizationId) }));
