import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { pk, timestamps, money } from "./_shared";
import { organization } from "./tenancy";
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
  /** What the source takes. Feeds true margin on marketplace work. */
  commissionRate: money("commission_rate"),
  leadFee: money("lead_fee"),
  active: boolean("active").notNull().default(true),
  ...timestamps,
}, (t) => ({ orgIdx: index("lead_source_connector_org_idx").on(t.organizationId, t.source) }));

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
