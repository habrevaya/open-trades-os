import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared";
import { organization, user } from "./tenancy";

/**
 * PLATFORM
 *
 * Audit, integration bookkeeping, webhooks and attachments. Unglamorous and
 * load-bearing: `integration_event` is what makes every external call safe to
 * retry, and `audit_log` is what makes the hosted product sellable to anyone
 * with a compliance checklist.
 */

export const auditLog = pgTable("audit_log", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  actorUserId: uuid("actor_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Set when an AI agent took the action rather than a person. Always attributable. */
  actorAgentId: text("actor_agent_id"),
  /**
   * Set when the customer took the action themselves, through a link rather
   * than an account. There is no user to name, and naming nobody would be
   * worse than naming the grant: "approved by the holder of this link, from
   * this address, at this time" is the whole record of a customer decision.
   */
  actorPortalGrantId: uuid("actor_portal_grant_id"),
  action: text("action").notNull(),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id"),
  before: jsonb("before").$type<Record<string, unknown>>(),
  after: jsonb("after").$type<Record<string, unknown>>(),
  ipAddress: text("ip_address"),
  userAgent: text("user_agent"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  orgIdx: index("audit_log_org_idx").on(t.organizationId, t.createdAt),
  entityIdx: index("audit_log_entity_idx").on(t.entityType, t.entityId),
}));

export const integrationEventStatus = pgEnum("integration_event_status", [
  "pending", "in_flight", "succeeded", "failed", "abandoned",
]);

/**
 * Written BEFORE any outbound call to Stripe, QBO, Twilio or an FSM platform,
 * and before any inbound webhook is processed. The idempotency key makes a
 * retry a no-op instead of a double charge.
 */
export const integrationEvent = pgTable("integration_event", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  direction: text("direction").notNull(),
  provider: text("provider").notNull(),
  eventType: text("event_type").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  status: integrationEventStatus("status").notNull().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  requestPayload: jsonb("request_payload").$type<Record<string, unknown>>(),
  responsePayload: jsonb("response_payload").$type<Record<string, unknown>>(),
  error: text("error"),
  entityType: text("entity_type"),
  entityId: uuid("entity_id"),
  nextAttemptAt: timestamp("next_attempt_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  idemIdx: index("integration_event_idem_idx").on(t.provider, t.idempotencyKey),
  retryIdx: index("integration_event_retry_idx").on(t.status, t.nextAttemptAt),
  orgIdx: index("integration_event_org_idx").on(t.organizationId, t.createdAt),
}));

export const webhookEndpoint = pgTable("webhook_endpoint", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  /** HMAC signing secret. Stored encrypted, never returned to the client. */
  secretRef: text("secret_ref").notNull(),
  events: jsonb("events").$type<string[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
  failureCount: integer("failure_count").notNull().default(0),
  ...timestamps,
}, (t) => ({ orgIdx: index("webhook_endpoint_org_idx").on(t.organizationId) }));

export const customFieldDefinition = pgTable("custom_field_definition", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  key: text("key").notNull(),
  label: text("label").notNull(),
  dataType: text("data_type").notNull().default("text"),
  options: jsonb("options").$type<string[]>().notNull().default([]),
  required: boolean("required").notNull().default(false),
  sortOrder: integer("sort_order").notNull().default(0),
  ...timestamps,
}, (t) => ({ orgIdx: index("custom_field_definition_org_idx").on(t.organizationId, t.entityType) }));

export const attachment = pgTable("attachment", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  entityType: text("entity_type").notNull(),
  entityId: uuid("entity_id").notNull(),
  kind: text("kind").notNull().default("photo"),
  storageKey: text("storage_key").notNull(),
  fileName: text("file_name"),
  contentType: text("content_type"),
  sizeBytes: integer("size_bytes"),
  /** before / after / during, for job photo comparison in proposals and disputes. */
  phase: text("phase"),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({ entityIdx: index("attachment_entity_idx").on(t.organizationId, t.entityType, t.entityId) }));

/**
 * A SAVED REPORT
 *
 * The definition is data, validated against the catalogue in
 * services/report-catalogue.ts before it is stored and again before it is
 * run. Storing SQL here would make this table a remote code execution
 * surface with a friendly name.
 *
 * Checked again at RUN time against whoever is running it, because a saved
 * report is a stored intention rather than a stored permission: an owner
 * saving "revenue by month" must not make it runnable by a dispatcher.
 */
export const report = pgTable("report", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  nameIdx: uniqueIndex("report_name_idx").on(t.organizationId, t.name)
    .where(sql`${t.deletedAt} is null`),
}));
