import { pgTable, pgEnum, uuid, text, boolean, jsonb, integer, index, uniqueIndex, timestamp, date } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps, money } from "./_shared";
import { organization, user, technician } from "./tenancy";
import { customer, property } from "./crm";
import { job } from "./work";
import { marketingChannel, acquisitionCampaign } from "./acquisition";

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
  /** Speech to text, for call recordings and voicemails. */
  "transcription",
  /** A mail house that prints and posts postcards and letters. */
  "direct_mail",
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

/**
 * DRIVE TIMES, ASKED ONCE
 *
 * The road network's answer for one pair of points, kept so the optimiser,
 * the rebalance and a customer refreshing their tracking link do not ask the
 * routing provider the same question every time. Keyed on the two points
 * rounded to about eleven metres (`geo.coordinateKey`) and on the provider,
 * so connecting a different one is not answered from another's cache.
 *
 * `expires_at` is the provider's: a self hosted OSRM's answers are kept for
 * weeks because roads change slowly, a commercial one's only as long as its
 * terms allow. An expired pair is asked again; the worker deletes the rest.
 */
export const travelTime = pgTable("travel_time", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  provider: text("provider").notNull(),
  originKey: text("origin_key").notNull(),
  destinationKey: text("destination_key").notNull(),
  minutes: integer("minutes").notNull(),
  meters: integer("meters"),
  computedAt: timestamp("computed_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (t) => ({
  pairIdx: uniqueIndex("travel_time_pair_idx").on(t.organizationId, t.provider, t.originKey, t.destinationKey),
  expiresIdx: index("travel_time_expires_idx").on(t.expiresAt),
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
  /**
   * Why a pass stopped short WITHOUT failing.
   *
   * The only value today is `read_budget_exhausted`, and it exists because of
   * the metering note at the top of this file: Intuit charges for reads and
   * refuses the overage with a 429 instead of billing it. A pass that hits
   * that ceiling has not failed. It has run out of reads until the window
   * rolls, it will resume from the same cursor, and nobody needs to do
   * anything.
   *
   * Writing that into `error` instead would be cheaper by one column and
   * wrong in the direction that costs money: an operator's failed-sync list
   * would fill up with a condition that clears by waiting, and the one row in
   * it that is a real credential failure would be indistinguishable from the
   * noise. A condition that resolves on its own and a condition that needs a
   * person are different facts and they get different columns.
   */
  blockedReason: text("blocked_reason"),
  ...timestamps,
}, (t) => ({ connIdx: index("sync_run_connection_idx").on(t.connectionId, t.startedAt) }));

/**
 * ACCOUNTING BRIDGE STATE
 *
 * Three tables, and between them they are the answer to the metering problem
 * stated at the top of this file. The sync must be able to answer "have I
 * already sent this, and where did it land" WITHOUT asking QuickBooks,
 * because asking is the metered operation and the one that gets refused.
 * Every one of these is a local cache that exists so a read does not happen.
 */

/** What kind of thing a link points at. Closed, because a link to a kind the
 *  sync cannot push is a row nothing will ever resolve. */
export const accountingEntityKind = pgEnum("accounting_entity_kind", [
  "customer", "invoice", "payment", "credit_memo",
  /**
   * Money returned against a payment AFTER that payment reached the books.
   * The entity id is the refund's ledger transaction, because a refund has
   * no row of its own: it is a `refund` posting against the payment. A
   * refund made before the payment's first push is netted into the payment
   * instead, and recorded here as linked with no document of its own, so it
   * is never sent twice.
   */
  "refund",
  /**
   * A credit note this company issued, as a QuickBooks CreditMemo or a Xero
   * ACCRECCREDIT. Its own kind rather than `credit_memo`, which is the
   * document a void or a write off of an INVOICE becomes and is keyed by the
   * invoice's id: a credit note has its own id and its own number sequence,
   * and one kind for both would make "is this credit note in the books" and
   * "is this invoice's write off in the books" the same row.
   */
  "credit_note",
  /**
   * A credit note put against an invoice over there: a zero payment linking
   * the two in QuickBooks, an Allocation in Xero. The entity id is the
   * `credit_note_application` row, or the credit note's own id for the one
   * settlement a void makes, which no application row can share.
   */
  "credit_note_application",
  /**
   * An issued credit note taken back. It goes as an invoice for the same
   * lines, dated the day of the void and settled against the credit note,
   * rather than as either book's own void: see `pushOutbound` for why. The
   * entity id is the credit note's id.
   */
  "credit_note_void",
  /**
   * Credit on a credit note paid out to the customer as money: a Xero payment
   * against the credit note out of the bank, a QuickBooks cheque from the bank
   * to the customer's receivable. The entity id is the `credit_note_payout`.
   */
  "credit_note_refund",
  /**
   * A manual journal, as a QuickBooks JournalEntry or a Xero manual journal.
   * The entity id is the `journal_entry` row; a reversal is a journal of its
   * own and goes as one.
   */
  "journal",
]);

/**
 * `pending` is the state that makes this table load bearing rather than
 * decorative. It is written BEFORE the HTTP call and it means "a push for
 * this entity is in flight or died in flight", which is exactly the case a
 * naive "look it up afterwards" design cannot tell apart from "never sent".
 */
export const accountingLinkState = pgEnum("accounting_link_state", [
  "pending", "linked", "failed",
  /**
   * The document reached the books and somebody removed it there.
   *
   * A distinct state rather than `failed`, because the two need opposite
   * treatment. A failed push is offered again on the next pass; a document a
   * bookkeeper deleted on purpose must NOT be, or the sync spends every tick
   * arguing with the person whose books these are. Getting it back is a
   * deliberate act through the retry surface.
   */
  "deleted",
]);

/**
 * OUR ENTITY ID, AND THE ONE THE ACCOUNTING SYSTEM GAVE IT.
 *
 * A table rather than a jsonb bag on the entity, for three reasons that all
 * bite in production:
 *
 *   1. The UNIQUE index on (connection, kind, entity) is the idempotency
 *      guard itself. Two workers racing on the same invoice both try to
 *      insert; Postgres lets exactly one in, and the loser skips rather than
 *      creating a second invoice in the customer's books. A jsonb field
 *      updated after the fact cannot do that, because the check and the write
 *      are two statements with a window between them.
 *   2. A company can disconnect QuickBooks and connect Xero. The ids are
 *      scoped to the CONNECTION, so the Xero pass starts empty instead of
 *      inheriting QuickBooks ids that name nothing in Xero.
 *   3. "Which invoices have not reached the books" is a query with an index
 *      behind it rather than a scan of every invoice's jsonb.
 */
export const accountingEntityLink = pgTable("accounting_entity_link", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => integrationConnection.id, { onDelete: "cascade" }),
  kind: accountingEntityKind("kind").notNull(),
  /** Our id: an invoice id, a payment id, a customer id. */
  entityId: uuid("entity_id").notNull(),
  /**
   * A deterministic marker derived from our entity and written onto the
   * document in the accounting system, in a field that system can be queried
   * on.
   *
   * It is the recovery path for the one window this table cannot close on its
   * own: the claim row is committed, the create succeeds, and the process
   * dies before the response is stored. The next pass finds a `pending` row
   * with no external id and has to decide between "it never went" and "it
   * went and I lost the receipt". Asking by this key answers that in one
   * read, which is a read worth paying for because the alternative is a
   * duplicate invoice in somebody's books.
   */
  idempotencyKey: text("idempotency_key").notNull(),
  state: accountingLinkState("state").notNull().default("pending"),
  /** The accounting system's own id. Null until the push comes back. */
  externalId: text("external_id"),
  /**
   * The provider's optimistic concurrency token, QuickBooks calls it
   * SyncToken. Kept because updating a document there requires the current
   * one, and fetching it is a metered read we already paid for once.
   */
  externalVersion: text("external_version"),
  attempts: integer("attempts").notNull().default(0),
  lastError: text("last_error"),
  pushedAt: timestamp("pushed_at", { withTimezone: true }),
  /**
   * On a payment's link: when the refunds netted into the pushed payment
   * were written down as `refund` links of their own. Null on a payment
   * pushed before refunds were synced, which the sync settles once, from the
   * push time, before it sends any refund for that payment.
   */
  refundsNettedAt: timestamp("refunds_netted_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  /** THE GUARD. One entity, one document, per connection. */
  entityIdx: uniqueIndex("accounting_entity_link_entity_idx").on(t.connectionId, t.kind, t.entityId),
  /**
   * And the other direction, so two of our records cannot both claim one
   * document in the books. Partial, because every row is null here until its
   * push returns and a plain unique index would allow only one such row.
   */
  externalIdx: uniqueIndex("accounting_entity_link_external_idx")
    .on(t.connectionId, t.kind, t.externalId)
    .where(sql`${t.externalId} is not null`),
  /** The work list: what has not landed yet. */
  pendingIdx: index("accounting_entity_link_state_idx").on(t.organizationId, t.state),
}));

/**
 * OUR ACCOUNT CODE, AND WHAT IT IS CALLED OVER THERE.
 *
 * `packages/core/src/ledger` has said since it was written that account codes
 * "are the default rather than the law: a company maps them to their own
 * chart during setup, and the mapping lives in account_mapping". There was no
 * account_mapping. This is it, and the sentence is now true.
 *
 * Why the database and not a config file or an environment variable: a
 * mapping is per company and per connection, it is edited by a bookkeeper
 * rather than by whoever can deploy, and it has to be identical for every
 * worker process in the fleet at the same instant. A file gives none of
 * those, and the failure mode of getting it wrong is not an error: it is
 * twelve months of revenue posted to the wrong account, discovered by an
 * accountant in March.
 *
 * Why not `integration_connection.settings`, which is already jsonb and
 * already there: a unique index cannot be put on a key inside a jsonb
 * document, so two mappings for one account code would be expressible, and
 * "which of our codes are still unmapped" would be a scan with no index.
 *
 * NOTHING IS GUESSED. A posting whose account code has no row here is
 * refused, loudly, with the code named. A default that silently picks an
 * income account is how a bookkeeper's year goes wrong quietly.
 */
export const accountMapping = pgTable("account_mapping", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  connectionId: uuid("connection_id").notNull().references(() => integrationConnection.id, { onDelete: "cascade" }),
  /** Ours: "4000", "2200", "1200". See ACCOUNTS in packages/core/src/ledger. */
  accountCode: text("account_code").notNull(),
  /** Theirs, opaque. We do not parse it and we do not assume it is a number. */
  externalId: text("external_id").notNull(),
  /**
   * What the operator saw when they chose it, frozen at the moment of
   * choosing. Shown on the mapping screen so the screen costs no reads, and
   * kept even when it goes stale: "you mapped this to Sales Income" is a more
   * useful thing to show than a bare id, even if somebody has since renamed
   * the account over there.
   */
  externalName: text("external_name").notNull(),
  /**
   * The provider's own object type behind the id, because it is genuinely not
   * always an account. QuickBooks invoice lines reference an Item, which
   * carries the income account behind it; a journal entry references an
   * Account directly. Storing which kind this id is means the adapter does
   * not have to guess from the shape of the string.
   */
  externalKind: text("external_kind").notNull(),
  ...timestamps,
}, (t) => ({
  codeIdx: uniqueIndex("account_mapping_code_idx").on(t.connectionId, t.accountCode),
  orgIdx: index("account_mapping_org_idx").on(t.organizationId),
}));

/**
 * A PERIOD SOMEBODY HAS FILED ON.
 *
 * Once a quarter has been closed and a return filed against it, a sync that
 * pushes a late invoice back into it changes a number that has already been
 * reported to a tax authority. The company then has an amended return and no
 * record of what changed it.
 *
 * So closing is an explicit act by somebody holding `accounting:close`, it
 * names who and when, and the sync refuses to push anything dated on or
 * before the close. The refusal is recorded on the entity link rather than
 * silently skipped, because an invoice that will never reach the books
 * without a human decision is exactly the thing somebody needs to be told
 * about.
 *
 * Reopening is possible and is the same permission, because a period closed
 * by mistake is otherwise a permanent hole that people work around by
 * back-dating documents, which is worse than the mistake.
 */
export const accountingPeriod = pgTable("accounting_period", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** The last day the close covers. Everything on or before it is frozen. */
  periodEnd: date("period_end").notNull(),
  closedAt: timestamp("closed_at", { withTimezone: true }).notNull().defaultNow(),
  closedByUserId: uuid("closed_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Why, in the closer's own words. "Q1 filed 2026-04-12." */
  note: text("note"),
  reopenedAt: timestamp("reopened_at", { withTimezone: true }),
  reopenedByUserId: uuid("reopened_by_user_id").references(() => user.id, { onDelete: "set null" }),
  reopenedReason: text("reopened_reason"),
  ...timestamps,
}, (t) => ({
  periodIdx: uniqueIndex("accounting_period_end_idx").on(t.organizationId, t.periodEnd),
}));

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
  /**
   * The channel every lead from this sender is credited to. `source` above
   * is the sender's own name and is free text, because the senders are not a
   * closed set; this is what the reports group by, chosen from the company's
   * channel list when the connector is set up.
   */
  channelId: uuid("channel_id").references(() => marketingChannel.id, { onDelete: "set null" }),
  /**
   * The tracking campaign under that channel its leads are credited to, when
   * the company buys from this sender under one ("Thumbtack: spring AC"), so
   * a marketplace lead lands on the same funnel row as the campaign's spend.
   */
  acquisitionCampaignId: uuid("acquisition_campaign_id")
    .references(() => acquisitionCampaign.id, { onDelete: "set null" }),
  /**
   * How leads from this sender arrive, which decides how the webhook is
   * verified and read: `webhook` (the signed generic endpoint), `angi`,
   * `thumbtack` and `yelp` (each platform's own post, verified its own way),
   * or `email` (read from a notification email forwarded to the company's
   * lead inbox, where `source` says which platform).
   */
  kind: text("kind").notNull().default("webhook"),
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
  /**
   * WHERE TO FIND EACH FIELD IN WHATEVER SHAPE THIS SENDER USES.
   *
   * Configuration rather than code, which `lead-webhook.ts` has argued since
   * it was written: every sender calls the same five things something
   * different, and a parser per sender is the same file eight times. What was
   * missing was anywhere to put the mapping, so the adapter took a field map
   * nothing ever supplied and fell back to its guesses on every lead.
   *
   * Keys are checked against the field list in `services/lead-connectors.ts`
   * on write. A key nothing here can store is refused rather than saved and
   * ignored, because saved and ignored is how an operator maps a phone number
   * onto a name nobody reads and never finds out.
   */
  fieldMap: jsonb("field_map").$type<Record<string, string>>().notNull().default({}),
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
  /**
   * WHO TO RING, which lived only inside `payload` until now.
   *
   * Every other mapped field had a column and these three did not, so the one
   * question an operator asks of an offer, who is this and how do I reach
   * them, could only be answered by digging through raw jsonb that each
   * sender shapes differently. The list of open offers returned rows with an
   * address and no name on them.
   */
  contactName: text("contact_name"),
  contactEmail: text("contact_email"),
  contactPhone: text("contact_phone"),
  notes: text("notes"),
  serviceRequested: text("service_requested"),
  addressLine1: text("address_line1"),
  city: text("city"),
  state: text("state"),
  postalCode: text("postal_code"),
  estimatedValue: money("estimated_value"),
  /** Offers usually expire fast. Speed to lead is the whole game. */
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  /**
   * What the marketplace charged for this lead, when it says. Written as spend
   * on the day it arrived as well, so a marketplace's cost reaches the funnel
   * without anybody typing it; kept here so the offer can say what it cost.
   */
  charge: money("charge"),
  /** When the customer or the office last wrote on the lead, through the marketplace. */
  lastMessageAt: timestamp("last_message_at", { withTimezone: true }),

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

/**
 * A MESSAGE ON A LEAD, THROUGH THE MARKETPLACE THAT SOLD IT
 *
 * Thumbtack and Yelp keep the conversation with the customer on their side,
 * and a reply that does not go back through them does not reach the person
 * at all: the customer's number is often withheld and the platform's relay is
 * the only way to them. So these are not texts or emails and are not kept
 * with them. They are the lead's own thread, in order, each with the
 * platform's id for it so a message posted twice is kept once.
 *
 * An outbound row is written BEFORE the platform is asked, as `sending`, and
 * marked `sent` or `failed` with the platform's words after, so a reply is
 * never sent twice by a double press and never lost by a crash in between.
 */
export const leadOfferMessage = pgTable("lead_offer_message", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  offerId: uuid("offer_id").notNull().references(() => leadOffer.id, { onDelete: "cascade" }),
  /** `inbound` from the customer, `outbound` from the office. */
  direction: text("direction").notNull(),
  body: text("body").notNull(),
  /** The platform's id for the message. Null for an outbound one until the platform names it. */
  externalId: text("external_id"),
  /** `received`, `sending`, `sent` or `failed`. */
  state: text("state").notNull(),
  /** The platform's words when it refused or could not be reached. */
  error: text("error"),
  sentByUserId: uuid("sent_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** When it was written, by the platform's clock for an inbound one. */
  at: timestamp("at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (t) => ({
  threadIdx: index("lead_offer_message_thread_idx").on(t.offerId, t.at),
  externalIdx: uniqueIndex("lead_offer_message_external_idx").on(t.offerId, t.externalId)
    .where(sql`${t.externalId} is not null`),
}));

/**
 * THE COMPANY'S LEAD INBOX: one address the marketplaces' lead emails are
 * forwarded to, `leads+TOKEN@` the company's receiving domain. One per
 * company, with a token that decides the company when an email arrives and
 * is replaced when somebody rotates it.
 */
export const leadInbox = pgTable("lead_inbox", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  token: text("token").notNull(),
  rotatedAt: timestamp("rotated_at", { withTimezone: true }),
  ...timestamps,
}, (t) => ({
  orgIdx: uniqueIndex("lead_inbox_org_idx").on(t.organizationId),
  tokenIdx: uniqueIndex("lead_inbox_token_idx").on(t.token),
}));

/**
 * EVERY EMAIL THE LEAD INBOX RECEIVED, AND WHAT BECAME OF IT
 *
 * Kept whether or not it made a lead. An email this could not read is the one
 * somebody most needs to see: a platform changed its layout, a customer left
 * their number out, or a mailbox sent the confirmation code for the
 * forwarding rule being set up. `excerpt` is the words, cut short, never the
 * HTML, because nothing here renders what a stranger sent.
 */
export const leadEmail = pgTable("lead_email", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /** The email provider's id for it, which makes a redelivery the same email. */
  providerMessageId: text("provider_message_id").notNull(),
  fromAddress: text("from_address").notNull(),
  subject: text("subject"),
  /** Which marketplace it came from, when that could be told. */
  platform: text("platform"),
  /** `lead`, `message` (the customer wrote again on a lead already here), `duplicate` or `unreadable`. */
  outcome: text("outcome").notNull(),
  /** Why it could not be read, in words. */
  reason: text("reason"),
  offerId: uuid("offer_id").references(() => leadOffer.id, { onDelete: "set null" }),
  excerpt: text("excerpt"),
  receivedAt: timestamp("received_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (t) => ({
  providerIdx: uniqueIndex("lead_email_provider_idx").on(t.organizationId, t.providerMessageId),
  recentIdx: index("lead_email_recent_idx").on(t.organizationId, t.receivedAt),
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
  /**
   * Asked, and told no. Apart from `revoked` because the two are different
   * facts about the past: a revoked app once held a grant and may have used
   * it, a refused one never held anything. An operator reading the list after
   * an incident asks exactly that question.
   */
  "refused",
]);

/**
 * HOW AN APP CAME TO BE ASKED FOR.
 *
 * `operator`  somebody here installed and approved it in one step.
 * `request`   the app asked, through the install URL, and waited.
 * `oauth`     a remote MCP client asked through the authorization flow.
 *
 * Kept because the three end differently. A requested app collects its
 * credential once with the secret it was given when it asked; an OAuth client
 * collects short lived tokens through the token endpoint; an operator's app is
 * handed a token on the screen. A row that cannot say which it is makes every
 * one of those paths guess.
 */
export const connectedAppSource = pgEnum("connected_app_source", ["operator", "request", "oauth"]);

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
  source: connectedAppSource("source").notNull().default("operator"),
  /**
   * THE REQUEST, WHILE IT IS ONE.
   *
   * Columns on the app rather than a table of their own, because a request
   * and the app it asks to become are one row with one status: two tables
   * would be two places to ask whether this thing is pending, and the day
   * they disagree an app is approved on one screen and waiting on another.
   */
  /** Where the person deciding is sent back to, with the outcome. Https only. */
  redirectUri: text("redirect_uri"),
  /** An opaque value the app chose, echoed back with the outcome so it can match it up. */
  requestState: text("request_state"),
  /** Where the request came from, as the app server saw it. For the person deciding. */
  requestedFrom: text("requested_from"),
  /**
   * A request nobody answers dies rather than waiting forever. An approval
   * three months later is a decision about an app that has probably moved on,
   * made by somebody who has forgotten what it was.
   */
  requestExpiresAt: timestamp("request_expires_at", { withTimezone: true }),
  /**
   * SHA-256 of the secret the app was handed when it asked, and must present
   * to collect its credential. The app's proof that it is the one that asked:
   * the request id travels through a browser and is not a secret.
   */
  claimHash: text("claim_hash"),
  /** When the credential was handed over. Once, and never again. */
  claimedAt: timestamp("claimed_at", { withTimezone: true }),
  refusedAt: timestamp("refused_at", { withTimezone: true }),
  refusedByUserId: uuid("refused_by_user_id").references(() => user.id, { onDelete: "set null" }),
  refusedReason: text("refused_reason"),
  /**
   * The OAuth client this app is, when it arrived through the authorization
   * flow. One app per client per company, so authorizing the same client
   * again changes its grant rather than adding a second app nobody can tell
   * from the first.
   */
  oauthClientId: text("oauth_client_id"),
  ...timestamps,
}, (t) => ({
  orgIdx: index("connected_app_org_idx").on(t.organizationId, t.status),
  oauthIdx: index("connected_app_oauth_idx").on(t.organizationId, t.oauthClientId),
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

// ---------------------------------------------------------------------------
// OAuth for remote MCP clients
// ---------------------------------------------------------------------------

/**
 * A CLIENT THAT REGISTERED ITSELF.
 *
 * Remote MCP clients register before they know which company they will be
 * pointed at, which is why this is the one table in the section with no
 * `organization_id`: a registration is a name and a list of addresses to send
 * a code back to, and nothing about any company. Row level security is on and
 * no policy admits the application role, so it is read and written only
 * through the two functions in `sql/after.sql`, the same posture as the rate
 * limit table.
 *
 * A registration grants nothing. Everything a client can do is decided when a
 * person at a company approves it, and recorded on that company's
 * `connected_app` row.
 */
export const oauthClient = pgTable("oauth_client", {
  /** The `client_id` handed back at registration. Random, and not a secret. */
  clientId: text("client_id").primaryKey(),
  name: text("name").notNull(),
  /** Exact strings. A code is only ever sent to one of these, compared byte for byte. */
  redirectUris: jsonb("redirect_uris").$type<string[]>().notNull(),
  /** Where the registration came from, so an operator can see a burst of them. */
  registeredFrom: text("registered_from"),
  /**
   * How the client proves who it is at the token, revocation and
   * introspection endpoints. `none` for a public client, which has nothing to
   * prove with and is held to PKCE instead; `client_secret_basic` or
   * `client_secret_post` for a confidential one, a client that runs on its
   * maker's own server and can keep a secret there.
   */
  authMethod: text("token_endpoint_auth_method").notNull().default("none"),
  /**
   * SHA-256 of a confidential client's secret. The secret is handed back once,
   * in the registration answer, and never stored: a table that held it would
   * be a list of every assistant's password. Null for a public client.
   */
  secretHash: text("secret_hash"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A ONE TIME CODE, HANDED THROUGH A BROWSER.
 *
 * Lives ten minutes, works once, and is bound to everything the client said
 * when it asked: the address it is sent to, the PKCE challenge only the client
 * can answer, and the grant the person approved. The code travels in a URL
 * and ends up in browser history, which is exactly why possessing it is not
 * enough: the token endpoint wants the verifier behind the challenge too.
 */
export const oauthCode = pgTable("oauth_code", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  appId: uuid("app_id").notNull().references(() => connectedApp.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  /** SHA-256 of the code. The code itself is never stored. */
  codeHash: text("code_hash").notNull(),
  redirectUri: text("redirect_uri").notNull(),
  /** BASE64URL(SHA-256(verifier)). Only S256 is accepted; `plain` is refused at the door. */
  codeChallenge: text("code_challenge").notNull(),
  /** The scope as approved, space separated, echoed in the token response. */
  scope: text("scope").notNull(),
  /** The resource the client named, when it named one. Checked again at the token endpoint. */
  resource: text("resource"),
  approvedByUserId: uuid("approved_by_user_id").references(() => user.id, { onDelete: "set null" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Set on the first exchange. A second exchange revokes what the first produced. */
  usedAt: timestamp("used_at", { withTimezone: true }),
  /** The access token the exchange issued, so a replayed code can kill it. */
  issuedTokenId: uuid("issued_token_id"),
  /** The refresh token family it started, for the same reason. */
  familyId: uuid("family_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  codeIdx: uniqueIndex("oauth_code_hash_idx").on(t.codeHash),
}));

/**
 * A REFRESH TOKEN, ROTATED ON EVERY USE.
 *
 * Every refresh hands back a new one and marks the old one used. A used one
 * presented again means two parties hold the same token, and there is no way
 * to tell which is the client: so the whole family is revoked, and the client
 * that was legitimate asks its person to connect again. That is the cost of
 * noticing a theft, and it is much smaller than not noticing one.
 */
export const oauthRefreshToken = pgTable("oauth_refresh_token", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  appId: uuid("app_id").notNull().references(() => connectedApp.id, { onDelete: "cascade" }),
  clientId: text("client_id").notNull(),
  /** Every token descended from one authorization shares this. */
  familyId: uuid("family_id").notNull(),
  tokenHash: text("token_hash").notNull(),
  scope: text("scope").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  /** The access token issued beside this refresh token, revoked with the family. */
  accessTokenId: uuid("access_token_id"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
  tokenIdx: uniqueIndex("oauth_refresh_token_hash_idx").on(t.tokenHash),
  familyIdx: index("oauth_refresh_token_family_idx").on(t.organizationId, t.familyId),
}));

// ---------------------------------------------------------------------------
// Calendar feeds
// ---------------------------------------------------------------------------

/**
 * WHOSE DAY A FEED SHOWS.
 *
 * Two values and no third, because the third one people reach for, "this
 * business unit" or "this crew", is a filter rather than a subject and it
 * would make the question "what does this URL expose" one you have to read a
 * jsonb column to answer. A feed either shows one technician's work or it
 * shows the company's, and both of those are decidable from this column.
 */
export const calendarFeedScope = pgEnum("calendar_feed_scope", ["technician", "company"]);

/**
 * A SUBSCRIBABLE CALENDAR, AND THE SECRET THAT REACHES IT
 *
 * A row here is a long lived bearer credential. Anybody holding the URL gets
 * the visits it covers, forever, with no second factor and no session: that
 * is what makes a calendar feed work on a phone with no app installed, and
 * it is also the entire risk, so the row is shaped around being able to
 * answer "who has one, over what, and can I turn it off".
 *
 * ONLY THE HASH IS STORED, which is where this differs from
 * `lead_source_connector.webhook_token` beside it, and the difference is
 * deliberate rather than an inconsistency. That token is shown on the
 * connector list screen because an operator has to be able to copy the URL
 * into whoever is sending; it is a receiving endpoint that refuses anything
 * unsigned, so possession of the URL alone buys an attacker nothing. This
 * one is the opposite: possession IS the access, and the URL is pasted into
 * a calendar client once and never needed again. So it is handed over at
 * creation and at rotation, and no read path can recover it, for the same
 * reason `app_token` works that way.
 */
export const calendarFeed = pgTable("calendar_feed", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  scope: calendarFeedScope("scope").notNull(),
  /**
   * Whose work. Null for a company feed, and required for a technician one,
   * which the service enforces: a technician scoped feed with no technician
   * would be a company feed wearing the narrower label.
   *
   * Cascades, because a feed for a technician who no longer exists shows an
   * empty calendar forever and nobody goes looking for it.
   */
  technicianId: uuid("technician_id").references(() => technician.id, { onDelete: "cascade" }),
  /** SHA-256 of the token in the URL. The token itself is never stored. */
  tokenHash: text("token_hash").notNull(),
  /**
   * The last few characters of the token, so somebody holding two feeds can
   * tell which is which before revoking one. Not enough of it to use.
   */
  hint: text("hint").notNull(),
  /** What it is called in the technician's calendar app once subscribed. */
  label: text("label").notNull(),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /**
   * When it stopped working, and who stopped it. A revoked feed is kept
   * rather than deleted: "this URL used to reach our schedule and was turned
   * off on the fourth" is the question somebody asks after a phone is lost,
   * and a deleted row answers it with silence.
   */
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
  revokedByUserId: uuid("revoked_by_user_id").references(() => user.id, { onDelete: "set null" }),
  revokedReason: text("revoked_reason"),
  /**
   * When a client last collected it. The only evidence that a feed is in use
   * at all, which is what makes "revoke the ones nobody fetches" a decision
   * somebody can make rather than a guess.
   */
  lastFetchedAt: timestamp("last_fetched_at", { withTimezone: true }),
  /**
   * What fetched it, trimmed. A calendar feed URL that has leaked usually
   * leaks into something that identifies itself: a second client appearing
   * on a feed that should only ever be collected by one phone is the signal,
   * and without this there is nothing to see it in.
   */
  lastFetchedBy: text("last_fetched_by"),
  ...timestamps,
}, (t) => ({
  /** The lookup every fetch does, and it has to be unique across tenants. */
  tokenIdx: uniqueIndex("calendar_feed_token_idx").on(t.tokenHash),
  orgIdx: index("calendar_feed_org_idx").on(t.organizationId, t.scope),
  technicianIdx: index("calendar_feed_technician_idx").on(t.technicianId),
}));
