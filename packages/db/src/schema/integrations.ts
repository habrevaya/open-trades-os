import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { pk, timestamps, money } from "./_shared";
import { organization, user } from "./tenancy";
import { customer, property } from "./crm";
import { job } from "./work";

/**
 * INTEGRATIONS
 *
 * Not a list of integrations. A framework: a capability has an interface, and
 * any number of providers implement it. A self hoster picks a provider per
 * capability and supplies their own credentials.
 *
 * This matters more here than in most products because the research turned up
 * several places where the obvious default is wrong:
 *
 *   maps       Google's Service Specific Terms cap latitude and longitude
 *              caching at 30 consecutive days and bar using geocoding content
 *              with a non-Google map. An FSM stores a property's coordinates
 *              permanently. So the default is MapLibre for rendering plus
 *              Mapbox PERMANENT geocoding cached in our own Postgres, with
 *              Google available but opt in.
 *
 *   accounting Intuit's 2026 metering charges for READS, not writes, and
 *              blocks overage with a 429 rather than billing it. A polling
 *              sync hits a wall it cannot pay through, so the QBO provider is
 *              change-data-capture based with aggressive local caching.
 *
 *   payments   Stripe deprecated Standard, Express and Custom for new
 *              platforms in favour of Accounts v2 configurations. For bring
 *              your own self hosting the answer is no Connect at all, just an
 *              operator supplied restricted key, which is Stripe's own
 *              guidance because it keeps a platform secret off untrusted
 *              infrastructure.
 */

export const capability = pgEnum("capability", [
  "payments", "telephony", "messaging", "email", "accounting", "maps", "routing",
  "storage", "calendar", "payroll", "financing", "tax", "ai_model", "reviews",
  "ads", "analytics", "lead_source",
]);

export const connectionStatus = pgEnum("connection_status", [
  "pending", "connected", "needs_reauth", "error", "disconnected",
]);

export const integrationConnection = pgTable("integration_connection", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  capability: capability("capability").notNull(),
  /** The provider package implementing the interface: "stripe", "twilio", "resend". */
  provider: text("provider").notNull(),
  status: connectionStatus("status").notNull().default("pending"),
  /** Display only. The account name shown so an admin recognizes what is connected. */
  accountLabel: text("account_label"),
  /**
   * Reference into the secret store, never the secret itself. Supabase Vault,
   * a SECURITY DEFINER encrypt/decrypt pair, or an external KMS. Refresh
   * tokens never reach the frontend under any circumstance.
   */
  credentialRef: text("credential_ref"),
  scopes: jsonb("scopes").$type<string[]>().notNull().default([]),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
  lastError: text("last_error"),
  ...timestamps,
}, (t) => ({
  uniq: uniqueIndex("integration_connection_uniq_idx").on(t.organizationId, t.capability, t.provider),
  statusIdx: index("integration_connection_status_idx").on(t.status, t.expiresAt),
}));

export const syncDirection = pgEnum("sync_direction", ["inbound", "outbound", "bidirectional"]);

export const syncRun = pgTable("sync_run", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => integrationConnection.id, { onDelete: "cascade" }),
  direction: syncDirection("direction").notNull(),
  entityType: text("entity_type"),
  /**
   * Durable change-data-capture cursor. Both QuickBooks and ServiceTitan
   * expose one, and using it rather than a timestamp scan is the difference
   * between a sync that fits in the rate budget and one that does not.
   */
  cursor: text("cursor"),
  recordsRead: integer("records_read").notNull().default(0),
  recordsWritten: integer("records_written").notNull().default(0),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  error: text("error"),
  ...timestamps,
}, (t) => ({ connIdx: index("sync_run_connection_idx").on(t.connectionId, t.startedAt) }));

/**
 * LEAD SOURCE CONNECTORS
 *
 * A second interface, separate from the capability providers above. A lead
 * source takes work from a marketplace or platform and drops it into the CRM
 * and dispatch board as a normal job, then reports completion and reconciles
 * payout back.
 *
 * The shape is identical for every source: authenticate, receive an offer,
 * accept or decline against REAL capacity, materialize customer, property and
 * job, sync status both directions, reconcile the payout. Angi, Thumbtack,
 * Networx, home warranty networks, manufacturer dealer programs and Neighbrium
 * all fit it.
 *
 * The interface is deliberately generic so no source is a special case in the
 * codebase. If a connector needs something the interface lacks, the interface
 * is wrong, not the connector.
 */
export const leadOfferStatus = pgEnum("lead_offer_status", [
  "offered", "accepted", "declined", "expired", "withdrawn", "completed", "cancelled",
]);

export const leadSourceConnector = pgTable("lead_source_connector", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").references(() => integrationConnection.id, { onDelete: "set null" }),
  /** "angi", "thumbtack", "neighbrium", "ahs", "carrier-dealer". */
  source: text("source").notNull(),
  displayName: text("display_name").notNull(),
  /** Decline automatically when accepting would breach capacity. */
  autoAcceptEnabled: boolean("auto_accept_enabled").notNull().default(false),
  autoAcceptRules: jsonb("auto_accept_rules").$type<{
    jobTypes?: string[];
    territories?: string[];
    minValue?: string;
    maxDriveMinutes?: number;
    requireOpenCapacity?: boolean;
  }>().notNull().default({}),
  /**
   * The secret in the webhook URL, identifying this connector and therefore
   * the tenant.
   *
   * Not the company slug and not the connector id. A slug is printed on
   * their website and an id turns up in an export, and either would let
   * somebody aim a forged lead at a company they chose. A forged lead is a
   * job on a dispatch board and a van driving to an address that never
   * asked for one.
   */
  webhookToken: text("webhook_token"),
  /** What the source takes. Feeds true margin on marketplace work. */
  commissionRate: money("commission_rate"),
  leadFee: money("lead_fee"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({
  orgIdx: index("lead_source_connector_org_idx").on(t.organizationId, t.source),
  /** The lookup every inbound lead does, and it has to be unique across tenants. */
  tokenIdx: uniqueIndex("lead_source_connector_token_idx").on(t.webhookToken),
}));

export const leadOffer = pgTable("lead_offer", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectorId: uuid("connector_id").notNull().references(() => leadSourceConnector.id, { onDelete: "cascade" }),
  /** The source's own id for this offer. Makes acceptance idempotent. */
  externalId: text("external_id").notNull(),
  status: leadOfferStatus("status").notNull().default("offered"),

  /** Raw offer as received, before we decide anything. */
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
  serviceRequested: text("service_requested"),
  addressLine1: text("address_line1"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  estimatedValue: money("estimated_value"),
  /** Offers usually expire fast. Speed to lead is the whole game. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),

  /** Set once accepted and materialized. */
  customerId: uuid("customer_id").references(() => customer.id, { onDelete: "set null" }),
  propertyId: uuid("property_id").references(() => property.id, { onDelete: "set null" }),
  jobId: uuid("job_id").references(() => job.id, { onDelete: "set null" }),

  decidedAt: timestamp("decided_at", { withTimezone: true }),
  decidedBy: text("decided_by"),
  declineReason: text("decline_reason"),

  /** Payout reconciliation, which is the part marketplaces are worst at. */
  payoutExpected: money("payout_expected"),
  payoutReceived: money("payout_received"),
  payoutReconciledAt: timestamp("payout_reconciled_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  uniq: uniqueIndex("lead_offer_external_idx").on(t.connectorId, t.externalId),
  openIdx: index("lead_offer_open_idx").on(t.organizationId, t.status, t.expiresAt),
  /** Unreconciled payouts on completed work. The report an owner wants monthly. */
  payoutIdx: index("lead_offer_payout_idx").on(t.organizationId, t.payoutReconciledAt),
}));

// ---------------------------------------------------------------------------
// Connected applications
// ---------------------------------------------------------------------------

export const connectedAppStatus = pgEnum("connected_app_status", [
  /** Requested, not yet approved by somebody who can approve it. */
  "pending",
  "active",
  /** Turned off, permanently. A reinstall is a new row with a new grant. */
  "revoked",
]);

/**
 * A third party that may act against this company's instance.
 *
 * The thing this must never become is a list of API keys with no provenance.
 * "Which integration is reading my customer list" is the question an operator
 * asks, and a bare key cannot answer it: the row records who the app is, what
 * it asked for, who approved it, and when.
 *
 * The permissions and scopes are stored HERE rather than on the token, so
 * changing what an app may do does not require reissuing a credential, and so
 * two tokens belonging to one app cannot drift apart into different powers.
 *
 * The rule that makes this safe is the same one that governs custom roles:
 * YOU CANNOT GRANT WHAT YOU DO NOT HOLD. Installing is checked with
 * `canDefineRole` rather than a second implementation, because two versions of
 * "may you grant this" disagree eventually and the disagreement is silent.
 */
export const connectedApp = pgTable("connected_app", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** What the operator sees in the list. The app's own name for itself. */
  name: text("name").notNull(),
  publisher: text("publisher"),
  description: text("description"),
  /** Where an operator goes to find out what this is. */
  homepageUrl: text("homepage_url"),
  status: connectedAppStatus("status").notNull().default("pending"),
  /** Permission keys from the catalogue in @opentradesos/core. */
  permissions: jsonb("permissions").$type<string[]>().notNull().default([]),
  /** Per resource scope, same shape and meaning as on a membership. */
  scopes: jsonb("scopes").$type<Record<string, string>>().notNull().default({}),
  requestedByUserId: uuid("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /**
   * Who approved it, and therefore whose authority it borrowed. Kept for the
   * question that follows an incident: not "what could this app do" but "who
   * decided it could".
   */
  approvedByUserId: uuid("approved_by_user_id").references(() => user.id, { onDelete: "set null" }),
  approvedAt: timestamp("approved_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => user.id, { onDelete: "set null" }),
  revokedReason: text("revoked_reason"),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("connected_app_org_idx").on(t.organizationId, t.status),
}));

/**
 * A credential for an app. Several, because rotation without downtime needs
 * two valid at once.
 *
 * Only the hash is stored. The token is shown once, at creation, and cannot
 * be recovered: a credential a support engineer can read out of a table is a
 * credential the company does not really control.
 *
 * `expiresAt` is NOT NULL on purpose. A partner integration holding a
 * permanent credential is a permanent liability on both sides, and an expiry
 * that has to be opted into is one nobody sets.
 */
export const appToken = pgTable("app_token", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  appId: uuid("app_id").notNull().references(() => connectedApp.id, { onDelete: "cascade" }),
  /** SHA-256 of the token. The raw value is never stored. */
  tokenHash: text("token_hash").notNull(),
  /** So an operator rotating can tell which one is which. */
  label: text("label"),
  /** The last four characters, for the same reason. Not enough to use. */
  hint: text("hint"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  hashIdx: uniqueIndex("app_token_hash_idx").on(t.tokenHash),
  appIdx: index("app_token_app_idx").on(t.appId),
}));
