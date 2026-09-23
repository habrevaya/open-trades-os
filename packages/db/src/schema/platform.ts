import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp, customType } from "drizzle-orm/pg-core";
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

/**
 * A COMPANY'S LOGO AND FAVICON, AS BYTES IN THE DATABASE
 *
 * Not a storage key, deliberately, and this is the one place in the schema
 * that holds a file directly.
 *
 * A contractor self hosting this should not have to stand up an object store
 * to put their own logo on their own invoice. That is the single most basic
 * thing anybody does with a product like this, and making it the first thing
 * that requires S3, a bucket policy and a signed URL is how a self hosted
 * product becomes one nobody actually self hosts.
 *
 * The bytes are small and capped in core: half a megabyte for a logo, sixty
 * four kilobytes for a favicon. Photographs and documents do NOT belong here
 * and keep using `attachment`, which holds a key rather than a file.
 *
 * One row per kind per organization, so setting a logo replaces the logo
 * rather than adding a second one nothing chooses between.
 */
export const brandAsset = pgTable("brand_asset", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** `logo` or `favicon`. */
  kind: text("kind").notNull(),
  /**
   * Decided from the BYTES rather than from what the upload claimed, because
   * the claimed type is a string the client chose and this is served back
   * from the application's own origin.
   */
  contentType: text("content_type").notNull(),
  bytes: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("bytes").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  kindIdx: uniqueIndex("brand_asset_kind_idx").on(t.organizationId, t.kind),
}));

/**
 * THE BYTES BEHIND EVERY ATTACHMENT
 *
 * `attachment` holds a storage key and nothing wrote one, because there was
 * no store to put a file in. This is that store, and it is Postgres for the
 * same reason the brand assets are: a contractor self hosting this should be
 * able to attach a photograph to a job without first standing up an object
 * store, a bucket policy and a signed URL. Making photographs the feature
 * that requires S3 is how a self hosted product becomes one nobody self
 * hosts.
 *
 * It is NOT a claim that Postgres is where a large deployment should keep
 * its files. `services/files.ts` reads and writes through one pair of
 * functions so a deployment that wants an object store can be given one; as
 * of this table, that other implementation does not exist, and this comment
 * says so rather than describing a plan as a capability.
 *
 * CONTENT ADDRESSED. The key is derived from the SHA-256 of the bytes, so
 * the same photograph attached to a job, a report and an invoice is one row
 * with three references, and a phone retrying an upload over a metered
 * connection writes to the key it already occupies.
 *
 * `references` is not a foreign key count and is not authoritative: it is
 * maintained by the service and used only to decide when nothing points here
 * any more. Deleting is a separate decision from decrementing.
 */
export const storedFile = pgTable("stored_file", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** The content addressed path. Unique per organization by construction. */
  storageKey: text("storage_key").notNull(),
  /** Decided from the BYTES. Never what the upload claimed. */
  contentType: text("content_type").notNull(),
  sha256: text("sha256").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  bytes: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("bytes").notNull(),
  references: integer("references").notNull().default(0),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  keyIdx: uniqueIndex("stored_file_key_idx").on(t.organizationId, t.storageKey),
  hashIdx: index("stored_file_hash_idx").on(t.organizationId, t.sha256),
}));

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

/**
 * A DASHBOARD SOMEBODY ASSEMBLED
 *
 * Tiles, and nothing else. A tile POINTS AT A REPORT rather than carrying a
 * definition of its own: either a saved report by id, or one of the reports
 * that ship with the product by slug. That is the property worth protecting.
 * A tile holding its own copy of a definition is a tile that keeps showing
 * last quarter's version of a number after somebody corrected the report,
 * and the person reading it has no way to know which of the two is right.
 *
 * It also means this table stores no query and no definition, so the remote
 * code execution argument above does not need making twice: the worst thing
 * in here is a uuid pointing at a row that is itself validated.
 *
 * Layout only, deliberately: which report, what shape, how wide, in what
 * order. There is no filter, no date range and no override, because every
 * one of those is a way for the tile and the report to disagree.
 */
export const dashboard = pgTable("dashboard", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  /**
   * `{ key, kind, width, reportId?, builtIn?, title?, caption? }[]`, in the
   * order they are drawn. An array rather than rows in a child table because
   * the order IS the data: reordering a dashboard is one write of the whole
   * list, and a sort column on a child table is the thing that ends up with
   * two tiles claiming position three.
   */
  tiles: jsonb("tiles").$type<Record<string, unknown>[]>().notNull().default([]),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  nameIdx: uniqueIndex("dashboard_name_idx").on(t.organizationId, t.name)
    .where(sql`${t.deletedAt} is null`),
}));
