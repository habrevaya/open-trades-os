import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp, customType, check } from "drizzle-orm/pg-core";
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
  /**
   * The contact who held that grant, when it was a contact signed in as the
   * customer rather than the customer themselves. The grant says which
   * account was used; this says which person used it, which is the question
   * a landlord asks when the tenant's partner paid the wrong invoice.
   */
  actorContactId: uuid("actor_contact_id"),
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
  /**
   * THE SECRET BEFORE THE LAST ROTATION, WHILE THE OVERLAP LASTS.
   *
   * Rotating a secret the receiver still verifies with breaks every delivery
   * the moment it happens, because the receiver is updated by a different
   * person on a different day. So for an overlap the operator chose, every
   * delivery is signed with both, and a receiver holding either accepts it.
   * After `previous_secret_expires_at` the old one signs nothing, and the next
   * rotation overwrites it.
   */
  previousSecretRef: text("previous_secret_ref"),
  previousSecretExpiresAt: timestamp("previous_secret_expires_at", { withTimezone: true }),
  /** When the current secret was made, by registration or by rotation. */
  secretRotatedAt: timestamp("secret_rotated_at", { withTimezone: true }),
  events: jsonb("events").$type<string[]>().notNull().default([]),
  active: boolean("active").notNull().default(true),
  lastDeliveryAt: timestamp("last_delivery_at", { withTimezone: true }),
  failureCount: integer("failure_count").notNull().default(0),
  ...timestamps,
}, (t) => ({ orgIdx: index("webhook_endpoint_org_idx").on(t.organizationId) }));

/**
 * A REPLAY SOMEBODY ASKED FOR: one event again, or everything from a point.
 *
 * A row rather than a loop run inside the request, because a range can be
 * thousands of events and each one is a request to somebody else's server
 * with a ten second timeout. The request records what to send and the worker
 * sends it, in order, beside the endpoint's ordinary deliveries and without
 * moving the endpoint's own position: a replay is a second copy of history,
 * and the live stream carries on from where it was.
 *
 * `through_sequence` is fixed when the replay is asked for. A replay of
 * "everything since Tuesday" that kept reading as new events arrived would
 * never finish, and would send each new event twice: once live and once
 * here.
 */
export const webhookReplayStatus = pgEnum("webhook_replay_status", [
  "pending",
  /** Everything in the range went and was answered with a 2xx. */
  "done",
  /** The receiver kept refusing and the replay stopped trying. See `last_error`. */
  "failed",
  /**
   * Somebody stopped it before it finished. What had already gone stays
   * gone, and `position` says how far it got.
   */
  "cancelled",
]);

export const webhookReplay = pgTable("webhook_replay", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").notNull().references(() => webhookEndpoint.id, { onDelete: "cascade" }),
  /** Set when one event was asked for rather than a range. */
  eventId: uuid("event_id"),
  /** The first sequence to send again, inclusive. */
  fromSequence: integer("from_sequence").notNull(),
  /** The last, inclusive, fixed when the replay was asked for. */
  throughSequence: integer("through_sequence").notNull(),
  /** The last sequence this replay has sent and had answered. Starts one before `from`. */
  position: integer("position").notNull(),
  status: webhookReplayStatus("status").notNull().default("pending"),
  /** Consecutive refusals, with the same backoff and limit as live delivery. */
  failureCount: integer("failure_count").notNull().default(0),
  lastAttemptAt: timestamp("last_attempt_at", { withTimezone: true }),
  lastError: text("last_error"),
  requestedByUserId: uuid("requested_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Who stopped it, when somebody did. */
  cancelledByUserId: uuid("cancelled_by_user_id").references(() => user.id, { onDelete: "set null" }),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  /** The worker's question every pass: what is still pending for this endpoint. */
  pendingIdx: index("webhook_replay_pending_idx").on(t.organizationId, t.endpointId, t.status),
}));

/**
 * EVERY DELIVERY ATTEMPT, AND WHAT THE RECEIVER SAID.
 *
 * The endpoint row carries a failure count and the time of the last attempt,
 * which says THAT a receiver is failing and never WHY. An integrator
 * debugging theirs needs the status it answered, the first part of the body
 * it sent back and how long it took, per attempt, and until this table they
 * were reading their own logs for it.
 *
 * BOUNDED, twice. The body is an excerpt (`EXCERPT_LIMIT` in core's webhook
 * delivery rules), because a receiver answering with an HTML error page of a
 * megabyte on every retry would otherwise grow this table by a megabyte a
 * minute. And the rows themselves are pruned per endpoint by count and by age
 * on every pass, so a busy endpoint cannot grow the log without bound.
 *
 * No foreign key to `domain_event`: the event id and sequence are copied
 * because a delivery is a fact about what was sent, and the name is copied so
 * the history reads without a join into the busiest table in the database.
 */
export const webhookDelivery = pgTable("webhook_delivery", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  endpointId: uuid("endpoint_id").notNull().references(() => webhookEndpoint.id, { onDelete: "cascade" }),
  eventId: uuid("event_id").notNull(),
  eventSequence: integer("event_sequence").notNull(),
  eventName: text("event_name").notNull(),
  /** 1 for the first try of this event at this endpoint, counting replays. */
  attempt: integer("attempt").notNull(),
  /** Set when this attempt was a replay rather than the live stream. */
  replayId: uuid("replay_id").references(() => webhookReplay.id, { onDelete: "set null" }),
  requestedAt: timestamp("requested_at", { withTimezone: true }).notNull(),
  durationMs: integer("duration_ms").notNull(),
  /** Null when nothing answered: a timeout, a refused connection, DNS. */
  responseStatus: integer("response_status"),
  responseExcerpt: text("response_excerpt"),
  error: text("error"),
  ok: boolean("ok").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  endpointIdx: index("webhook_delivery_endpoint_idx").on(t.organizationId, t.endpointId, t.requestedAt),
  eventIdx: index("webhook_delivery_event_idx").on(t.organizationId, t.eventId),
}));

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
}, (t) => ({
  orgIdx: index("custom_field_definition_org_idx").on(t.organizationId, t.entityType),
  /**
   * ONE KEY IS ONE FIELD, and enforced here rather than only in the service.
   *
   * The service checks that the key is free before inserting, which is the
   * right error message and the wrong place to rely on. Two `define` calls in
   * separate transactions both read no row, both pass the check and both
   * insert, and the company is left with two definitions over the same stored
   * value: the label, the type and whether it is required are then decided by
   * whichever row a query happens to read first, and no screen anywhere shows
   * that there are two.
   *
   * Partial on `deleted_at is null`, because removing a field is soft and a
   * company that retires `warranty_expires` is entitled to define it again.
   */
  keyIdx: uniqueIndex("custom_field_definition_key_idx")
    .on(t.organizationId, t.entityType, t.key)
    .where(sql`${t.deletedAt} is null`),
}));

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
 * its files. A deployment can keep them in an S3 compatible bucket instead
 * (`FILE_STORAGE=s3`, see `packages/api/src/storage`), and then `bytes` is
 * null and `object_key` says where they went. Both kinds of row are read the
 * same way, through `files.bytesOf`, which is what lets the move from one to
 * the other happen a row at a time while the product is in use: each row
 * says where its own bytes are, and a row moves only once the copy has been
 * read back and its hash checked.
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
  /** The file itself, when it is kept here. Null when it is in object storage. */
  bytes: customType<{ data: Buffer; driverData: Buffer }>({
    dataType: () => "bytea",
  })("bytes"),
  /**
   * `postgres` or `object`. Said on the row rather than inferred from which
   * column is filled, so a reader never has to guess and the check below can
   * hold the two columns to it.
   */
  storedIn: text("stored_in").notNull().default("postgres"),
  /**
   * The object's key in the deployment's bucket, prefix and all. Kept rather
   * than derived, because a deployment that changes its prefix must still find
   * every file it already wrote. Also kept on a deleted row until the worker
   * has deleted the object, which is how a removal survives a crash between
   * the two.
   */
  objectKey: text("object_key"),
  references: integer("references").notNull().default(0),
  uploadedByUserId: uuid("uploaded_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  keyIdx: uniqueIndex("stored_file_key_idx").on(t.organizationId, t.storageKey),
  hashIdx: index("stored_file_hash_idx").on(t.organizationId, t.sha256),
  /** Object stored rows the worker still has to delete from the bucket. */
  objectSweepIdx: index("stored_file_object_sweep_idx").on(t.storedIn, t.deletedAt),
  /**
   * The bytes are in exactly one place. A row in Postgres has its bytes; a
   * row in object storage has a key and no bytes, so nothing can read a stale
   * copy left behind by a move.
   */
  whereCheck: check("stored_file_where", sql`(${t.storedIn} = 'postgres' and ${t.bytes} is not null and ${t.objectKey} is null)
    or (${t.storedIn} = 'object' and ${t.bytes} is null and ${t.objectKey} is not null)`),
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
  /**
   * When somebody in the office chose to show this photograph to the
   * customer, from a link that already lets them see the job. Null is
   * private, which is the default for every photograph: a technician
   * photographs the alarm code taped inside a panel as readily as the
   * finished install. A company can instead show every photograph on its
   * portal, from its portal settings, and then this is not consulted.
   */
  sharedWithCustomerAt: timestamp("shared_with_customer_at", { withTimezone: true }),
  sharedByUserId: uuid("shared_by_user_id").references(() => user.id, { onDelete: "set null" }),
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
