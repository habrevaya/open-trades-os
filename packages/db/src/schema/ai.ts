import { pgTable, pgEnum, uuid, text, integer, bigint, boolean, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { pk, timestamps } from "./_shared";
import { organization, user } from "./tenancy";
import { integrationConnection } from "./integrations";
import { conversation } from "./comms";
import { bookingRequest } from "./portal";

/**
 * BRING YOUR OWN MODEL, AND THE BILL THAT COMES WITH IT
 *
 * The `capability` enum next door has carried `ai_model` since the first
 * migration with nothing behind it. These two tables are what make connecting
 * a model key something an owner can turn on without discovering the
 * consequences on a credit card statement.
 *
 * WHY SPEND GETS ITS OWN TABLE RATHER THAN A COUNTER ON THE CONNECTION.
 *
 * A counter answers "how much so far" and nothing else. The questions an
 * operator actually asks when a bill surprises them are "which model", "how
 * many calls", "who was running them" and "when did it start", and every one
 * of those is a row with a timestamp or it is nothing. A counter also cannot
 * be recomputed: if it drifts, there is no record to rebuild it from.
 *
 * WHY COST IS MICRO-DOLLARS AND AN INTEGER.
 *
 * The rest of this schema holds money as numeric(14,4), four decimal places,
 * which is right for invoices and wrong here: a ten token call on a cheap
 * model costs four hundredths of a cent and rounds to zero at four places. A
 * ceiling built on a column where most calls round to nothing is a ceiling
 * that is never reached. Millionths of a dollar are exact for every rate any
 * of these vendors publishes, and integer arithmetic means a month of sums
 * has no rounding in it at all.
 *
 * A NULL COST IS NOT A FREE CALL. It means this deployment does not know what
 * the vendor charges for that model, which is the ordinary case for a vendor
 * whose price list is not in this repository. The service refuses to run a
 * call it cannot price whenever a ceiling is set, because a ceiling enforced
 * against an unknown number is a promise nothing keeps.
 */

/**
 * How a call ended, from the operator's point of view rather than the
 * vendor's.
 *
 * `refused` is the one that earns its place. A call the ceiling stopped did
 * not fail and did not succeed: nothing was sent, nothing was billed, and the
 * person waiting got an error. Recording it as `failed` would put a spend
 * control into the same list as expired keys and vendor outages, which is
 * where an operator looks when something is broken, and nothing here is.
 */
export const aiCallOutcome = pgEnum("ai_call_outcome", ["ok", "failed", "refused"]);

export const aiUsage = pgTable("ai_usage", {
  id: pk(),
  organizationId: uuid("organization_id").notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  /**
   * Which connection, and therefore whose key paid for it. Cascades, because
   * usage recorded against a key that has been removed is usage nobody can
   * reconcile against a bill.
   */
  connectionId: uuid("connection_id").notNull()
    .references(() => integrationConnection.id, { onDelete: "cascade" }),
  /** "anthropic", "openai", "google". Denormalized so a report costs one read. */
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  /**
   * THE CALLER'S RETRY KEY, AND WHY A MODEL CALL NEEDS ONE.
   *
   * Every other POST in this product carries an idempotency key because a
   * client on a truck with bad signal retries. The reasoning is usually about
   * a duplicate record; here it is about money, which makes it stronger
   * rather than weaker: a retried completion is a second answer nobody asked
   * for on a bill the operator is paying per token.
   *
   * A retry is REFUSED rather than replayed, which is unusual and is the only
   * honest option available. Replaying means returning the first answer,
   * which means having stored it, and this module deliberately stores no word
   * of any prompt or response: they routinely carry a customer's address and
   * their invoice. Refusing costs the caller an error they can act on;
   * replaying would cost them a privacy promise.
   */
  idempotencyKey: text("idempotency_key"),
  /**
   * A short label the caller supplies, and the ONLY description of the call
   * stored anywhere.
   *
   * No prompt text and no response text is kept, on purpose. A prompt in this
   * product routinely contains a customer's address, a technician's notes and
   * an invoice, and a usage table is read by people investigating a bill
   * rather than people entitled to that. The label answers "what was this
   * for" without storing a copy of the company's data in a second place.
   */
  purpose: text("purpose").notNull(),
  inputTokens: integer("input_tokens").notNull().default(0),
  outputTokens: integer("output_tokens").notNull().default(0),
  /**
   * What the vendor said it served from its prompt cache, or NULL when it did
   * not say.
   *
   * Null and zero are different answers, the same way a processing fee that
   * has not been reported yet is different from a fee of nothing. Zero means
   * the vendor told us the cache was not used; null means it told us nothing,
   * and writing zero for that would be this table inventing a fact.
   */
  cachedInputTokens: integer("cached_input_tokens"),
  /**
   * Millionths of a dollar, estimated from the rate this deployment holds for
   * the model. NULL when no rate is known.
   *
   * An ESTIMATE, and the column name says so. Cached input tokens are counted
   * at the full input rate because the vendors do not agree on how a cache
   * read is priced and this deployment does not hold three cache price lists.
   * That overstates the cost of a cached call, which is the safe direction for
   * a ceiling and the wrong one for a report, so a report built on this says
   * "estimated" too.
   */
  estimatedCostMicros: bigint("estimated_cost_micros", { mode: "number" }),
  outcome: aiCallOutcome("outcome").notNull(),
  /** The vendor's code, or the reason a ceiling refused. Never a credential. */
  detail: text("detail"),
  /**
   * The person whose authority the call ran under. Null for the system, the
   * same rule the audit log follows, because the nil uuid is not a user row
   * and writing it breaks a foreign key underneath whoever could read it.
   */
  actorUserId: uuid("actor_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Set when an agent was acting, matching `audit_log.actor_agent_id`. */
  agentId: text("agent_id"),
  ...timestamps,
}, (t) => ({
  /**
   * One key, one call, per company. Partial so the many rows with no key are
   * not forced to be distinct from each other, which is the ordinary case:
   * a caller that sends no key is asking for no protection and gets none.
   */
  idemIdx: uniqueIndex("ai_usage_idempotency_idx")
    .on(t.organizationId, t.idempotencyKey)
    .where(sql`${t.idempotencyKey} is not null`),
  /**
   * The query the ceiling runs before every call: what has this company spent
   * since the start of the month. It runs on the hot path, so it is indexed
   * on the two columns it filters and the one it sums.
   */
  spendIdx: index("ai_usage_spend_idx").on(t.organizationId, t.createdAt),
  modelIdx: index("ai_usage_model_idx").on(t.organizationId, t.provider, t.model),
}));

/**
 * THE CEILING.
 *
 * One row per company, and the limit is nullable because "no ceiling" is a
 * position an operator can take and has to be distinguishable from "nobody
 * has set one up yet". Both read as no refusals; only one of them is a
 * decision.
 *
 * There is deliberately NO column for what happens when the ceiling is hit.
 * A setting like that only ever has two values, refuse and warn, and the warn
 * branch is how a runaway loop produces a bill with a log line nobody read
 * beside it. The ceiling refuses. An operator who wants the spend raises the
 * number, which is a decision with a name and a timestamp on it.
 */
export const aiBudget = pgTable("ai_budget", {
  id: pk(),
  organizationId: uuid("organization_id").notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  /**
   * Millionths of a dollar per calendar month, in the company's own timezone.
   * Null means no ceiling.
   *
   * The month is the company's rather than UTC because it is the window the
   * operator means when they say "a hundred dollars a month", and a ceiling
   * that rolls over at six in the evening on the last of the month is one
   * that will be reported as a bug.
   */
  monthlyLimitMicros: bigint("monthly_limit_micros", { mode: "number" }),
  ...timestamps,
}, (t) => ({
  orgIdx: uniqueIndex("ai_budget_org_idx").on(t.organizationId),
}));

/* ================================================================ agents */

/**
 * THE AGENTS THEMSELVES
 *
 * Everything above is the seam: a key, a bill and a ceiling. These four tables
 * are what sits on it, and their shape follows from one rule the module keeps:
 * an agent PROPOSES, a person or the company's own standing choice DECIDES,
 * and both halves are written down. "What did the agent do, and who let it" is
 * the first question an owner asks after turning one on, and it has to be a
 * query rather than a guess.
 */

/** The five agents. `core/agents` holds what each one may do. */
export const aiAgentKind = pgEnum("ai_agent_kind", ["intake", "chat", "estimate", "collections", "dispatch"]);

/**
 * How a company has set up one agent.
 *
 * The settings are one jsonb document rather than columns, read through
 * `agents.readSettings` in core, because they are a form an owner fills in
 * (tone, limits, the chat agent's questions and answers, the collection steps)
 * and every field has a default that core owns. Columns would put a migration
 * between an owner and a new limit; a document read leniently puts a default
 * there instead.
 *
 * `run_as_user_id` is a column of its own, outside the document, because it
 * is the one setting with a foreign key behind it: a person removed from the
 * company must stop being somebody an agent can act as, and a uuid inside a
 * document would go on naming them.
 */
export const aiAgentSetting = pgTable("ai_agent_setting", {
  id: pk(),
  organizationId: uuid("organization_id").notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  agent: aiAgentKind("agent").notNull(),
  runAsUserId: uuid("run_as_user_id").references(() => user.id, { onDelete: "set null" }),
  settings: jsonb("settings").$type<Record<string, unknown>>().notNull().default({}),
  updatedByUserId: uuid("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  agentIdx: uniqueIndex("ai_agent_setting_agent_idx").on(t.organizationId, t.agent),
}));

/**
 * Where a proposal is in its life.
 *
 * `superseded` exists so a person asking for a fresh draft does not leave two
 * open proposals for one message: the old one is closed with a word that says
 * why, rather than dismissed as if somebody had said no to it.
 */
export const aiProposalStatus = pgEnum("ai_proposal_status", [
  "proposed", "applied", "dismissed", "failed", "superseded",
]);

/**
 * Something an agent drafted, and what became of it.
 *
 * `draft` is the model's answer AFTER the guardrails: the tool input checked
 * against its schema and against the company's records (windows that are
 * open, items that are in the price book, technicians the board allows), with
 * whatever the checks resolved added beside it. It is what a person approves,
 * so it is what is stored, rather than the raw answer that might have named a
 * window that had gone.
 *
 * Unlike `ai_usage`, this DOES hold the content, and the difference is the
 * point of each table. Usage is read by whoever reconciles a bill and holds
 * no word of any conversation. A proposal is a piece of work for the office,
 * read by the people who would read the customer's message it came from,
 * under the same permission.
 */
export const aiAgentProposal = pgTable("ai_agent_proposal", {
  id: pk(),
  organizationId: uuid("organization_id").notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  agent: aiAgentKind("agent").notNull(),
  /** The tool the model answered with, such as `propose_booking`. */
  action: text("action").notNull(),
  status: aiProposalStatus("status").notNull().default("proposed"),
  /**
   * What it is about: `conversation`, `call`, `form_submission`, `job`,
   * `invoice`, `schedule_day`. Text rather than a foreign key, because the
   * subjects are six different tables and a day on the board is not a row.
   */
  sourceKind: text("source_kind").notNull(),
  sourceId: text("source_id").notNull(),
  /** One line for a list. */
  summary: text("summary").notNull(),
  draft: jsonb("draft").$type<Record<string, unknown>>().notNull().default({}),
  /** The model call it came from. Null for a proposal no model was asked for. */
  usageId: uuid("usage_id").references(() => aiUsage.id, { onDelete: "set null" }),
  /** Whose authority the agent ran under. */
  runAsUserId: uuid("run_as_user_id").references(() => user.id, { onDelete: "set null" }),
  /** Who pressed the button that started it. Null when nobody did. */
  startedByUserId: uuid("started_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** True when it was applied by the company's standing choice rather than a click. */
  appliedAutomatically: boolean("applied_automatically").notNull().default(false),
  decidedByUserId: uuid("decided_by_user_id").references(() => user.id, { onDelete: "set null" }),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
  /** What applying it made: a job, an estimate, a message. Ids, not copies. */
  outcome: jsonb("outcome").$type<Record<string, unknown>>(),
  /** Why it failed, or why it was dismissed, in words. */
  note: text("note"),
  idempotencyKey: text("idempotency_key"),
  ...timestamps,
}, (t) => ({
  /**
   * ONE OPEN PROPOSAL PER THING PER AGENT. A worker pass and a person pressing
   * "draft" at the same moment would otherwise put two booking drafts for one
   * text on the office's list, and the office would book it twice.
   */
  openIdx: uniqueIndex("ai_agent_proposal_open_idx")
    .on(t.organizationId, t.agent, t.sourceKind, t.sourceId)
    .where(sql`${t.status} = 'proposed'`),
  idemIdx: uniqueIndex("ai_agent_proposal_idempotency_idx")
    .on(t.organizationId, t.idempotencyKey)
    .where(sql`${t.idempotencyKey} is not null`),
  listIdx: index("ai_agent_proposal_list_idx").on(t.organizationId, t.agent, t.status, t.createdAt),
  sourceIdx: index("ai_agent_proposal_source_idx").on(t.organizationId, t.sourceKind, t.sourceId),
}));

/**
 * Everything each agent did, in order: drafted, applied, dismissed, refused,
 * failed, answered, handed over, skipped.
 *
 * Its own table rather than the audit log, because most of what belongs here
 * is not a mutation: a refused tool call changed nothing and is the single
 * most important line an owner can read about an agent, and an answer in a
 * chat is a message rather than a change to a record. The audit log still
 * gets every mutation, with the agent's id on it, through the services that
 * make them.
 */
export const aiAgentActivity = pgTable("ai_agent_activity", {
  id: pk(),
  organizationId: uuid("organization_id").notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  agent: aiAgentKind("agent").notNull(),
  kind: text("kind").notNull(),
  proposalId: uuid("proposal_id").references(() => aiAgentProposal.id, { onDelete: "set null" }),
  /** One sentence. Never a prompt and never a key. */
  detail: text("detail").notNull(),
  /** The person who decided, or whose authority the agent ran under. */
  actorUserId: uuid("actor_user_id").references(() => user.id, { onDelete: "set null" }),
  automatic: boolean("automatic").notNull().default(false),
  ...timestamps,
}, (t) => ({
  listIdx: index("ai_agent_activity_list_idx").on(t.organizationId, t.agent, t.createdAt),
}));

/** Whether the agent is still answering a chat, or a person has it. */
export const aiChatStatus = pgEnum("ai_chat_status", ["open", "handed_off", "closed"]);

/**
 * One chat with the agent, on the website widget or by text.
 *
 * The words themselves are messages on the conversation, in the inbox, where
 * a person taking over reads them and where every other message the company
 * has with that customer already is. This row is what the inbox does not
 * hold: whether the agent may still answer, how many turns it has taken, and
 * the booking request it took.
 *
 * The website's chat is reached with a token the visitor's browser holds, and
 * only its hash is kept, for the reason every other token here is hashed: a
 * copy of this table is not a way into anybody's conversation.
 */
export const aiChatSession = pgTable("ai_chat_session", {
  id: pk(),
  organizationId: uuid("organization_id").notNull()
    .references(() => organization.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull()
    .references(() => conversation.id, { onDelete: "cascade" }),
  /** `web` or `text`. */
  channel: text("channel").notNull(),
  status: aiChatStatus("status").notNull().default("open"),
  tokenHash: text("token_hash"),
  visitorId: text("visitor_id"),
  agentTurns: integer("agent_turns").notNull().default(0),
  bookingRequestId: uuid("booking_request_id").references(() => bookingRequest.id, { onDelete: "set null" }),
  handedOffAt: timestamp("handed_off_at", { withTimezone: true }),
  handoffReason: text("handoff_reason"),
  lastActivityAt: timestamp("last_activity_at", { withTimezone: true }).notNull().defaultNow(),
  ...timestamps,
}, (t) => ({
  tokenIdx: uniqueIndex("ai_chat_session_token_idx").on(t.tokenHash)
    .where(sql`${t.tokenHash} is not null`),
  conversationIdx: uniqueIndex("ai_chat_session_conversation_idx").on(t.conversationId),
}));
