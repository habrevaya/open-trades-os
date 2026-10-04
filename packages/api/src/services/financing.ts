import { randomUUID } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { financing as fin, money as m, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, inTenant,
  ConflictError, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";
import * as billing from "./billing";
import { sendTransactional } from "./comms-send";
import * as email from "./email";
import { peek, inGrant, requireScope } from "./portal";
import {
  createFinancingProvider, FinancingNotConfiguredError,
  type ApplicationState, type FinancingProvider, type WebhookRequest,
} from "../financing/provider";
/**
 * The adapters, registered here rather than by each page that shows a monthly
 * figure: "as low as" is worked out on the invoice, the estimate and both
 * customer pages, and a page that forgot the import would show no financing
 * with nothing to say why.
 */
import "../financing/index";

/**
 * CONSUMER FINANCING
 *
 * A customer who can pay a twelve thousand dollar replacement over five years
 * says yes to it; one who has to find twelve thousand dollars this month
 * says they will think about it. This is the path from the first to the
 * money: an "as low as" figure on the estimate and the invoice, a link the
 * customer applies on, the lender's decision on the document, and the
 * lender's payment on the invoice.
 *
 * THE MONEY TAKES THE PATH ALL MONEY TAKES. When the lender funds a loan the
 * payment is recorded by `billing.pay`, method `financing`, with the lender's
 * fee as the payment's fee, so it allocates to the invoice, moves the job,
 * emits `payment.received`, posts cash net of the fee and the fee to
 * processing fees (6100) as an expense, and is audited, exactly as a card
 * payment does. A second settlement path would be one that drifts from the
 * first, and the first is the one with the tests.
 *
 * NOTHING IS BELIEVED FROM A WEBHOOK ALONE. A delivery is verified, then the
 * application it names is read back from the lender, and the lender's answer
 * is what is applied, through `financing.advance` in core, which refuses to
 * move an application backwards. So a delivery that is late, repeated or out
 * of order is harmless, and a funding is recorded once because the payment is
 * keyed on the application rather than on the delivery.
 *
 * NO CREDIT DATA. The customer applies on the lender's page. What is kept is
 * the status, the approved amount and the offer chosen.
 */

/* ------------------------------------------------------------ connection */

export interface Connection {
  id: string;
  organizationId: string;
  provider: string;
  credentialRef: string;
  webhookSecretRef: string | null;
  settings: Record<string, unknown>;
}

function readConnection(row: typeof schema.integrationConnection.$inferSelect): Connection {
  const settings = (row.settings ?? {}) as Record<string, unknown>;
  const hook = settings["webhookSecretRef"];
  return {
    id: row.id,
    organizationId: row.organizationId,
    provider: row.provider,
    credentialRef: row.credentialRef ?? "",
    webhookSecretRef: typeof hook === "string" && hook !== "" ? hook : null,
    settings,
  };
}

/** The company's financing connection, or null when it has none on. */
export async function connectionWithin(tx: Database, organizationId: string): Promise<Connection | null> {
  const [row] = await tx.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.organizationId, organizationId),
      eq(schema.integrationConnection.capability, "financing"),
      eq(schema.integrationConnection.status, "connected"),
      isNull(schema.integrationConnection.deletedAt),
    ))
    .orderBy(asc(schema.integrationConnection.createdAt))
    .limit(1);
  return row ? readConnection(row) : null;
}

/**
 * By id, before any tenant exists: the webhook route's id is what establishes
 * the company, so nothing about the request is trusted until the signature
 * has been checked against this connection's secret.
 */
export async function connectionById(db: Database, connectionId: string): Promise<Connection | null> {
  if (!/^[0-9a-f-]{36}$/i.test(connectionId)) return null;
  const [row] = await db.select().from(schema.integrationConnection)
    .where(and(
      eq(schema.integrationConnection.id, connectionId),
      eq(schema.integrationConnection.capability, "financing"),
      eq(schema.integrationConnection.status, "connected"),
      isNull(schema.integrationConnection.deletedAt),
    )).limit(1);
  return row ? readConnection(row) : null;
}

export type ReadSecret = (ref: string) => Promise<string>;

/** The secret named by a reference, from the environment, refused in words when it is not there. */
export const secretFromEnvironment: ReadSecret = async (ref: string) => {
  const value = process.env[ref];
  if (!value) {
    throw new ConflictError(
      `No financing credential in the environment under "${ref}". The connection names it and nothing is set there.`,
    );
  }
  return value;
};

export interface FinancingDeps {
  readSecret: ReadSecret;
  /** Injected so a test never reaches a lender. */
  provider?: FinancingProvider | undefined;
}

export const DEFAULT_DEPS: FinancingDeps = { readSecret: secretFromEnvironment };

async function providerFor(connection: Connection, deps: FinancingDeps): Promise<FinancingProvider> {
  if (deps.provider) return deps.provider;
  return createFinancingProvider(connection.provider, connection.settings, await deps.readSecret(connection.credentialRef));
}

/**
 * The lender's plans, with no secret read: working out "as low as" on a page
 * view must not need the API token, and the plans are the connection's own
 * settings.
 */
function termsFor(connection: Connection, deps: FinancingDeps): fin.FinancingTerms {
  const provider = deps.provider ?? createFinancingProvider(connection.provider, connection.settings, "");
  return provider.terms();
}

/**
 * Where the lender should send this application's status changes: the
 * deployment's own address, which is what every webhook here is signed over.
 * Null without one, and then the lender uses the endpoint set in its own
 * dashboard, which the settings screen shows.
 */
function callbackFor(connectionId: string, env: Record<string, string | undefined> = process.env): string | null {
  const base = env["PUBLIC_URL"] || env["AUTH_URL"];
  return base ? `${base.replace(/\/+$/, "")}/api/webhooks/financing/${connectionId}` : null;
}

/* ------------------------------------------------------------ the offer */

export interface OfferView {
  lender: string;
  monthly: string;
  months: number;
  aprPercent: string;
  /** The full sentence, with "subject to approval" in it. Never show `monthly` without it. */
  sentence: string;
  short: string;
}

/**
 * "As low as" for an amount, or null.
 *
 * Null with no connection, when the company switched the figure off, when the
 * amount is outside what the lender finances, or when no plans were entered.
 * In the last case the apply link may still be offered; only the number is
 * withheld, because a number with no plan behind it is invented.
 */
export function offerFor(connection: Connection | null, amount: m.Money, deps: FinancingDeps = DEFAULT_DEPS): OfferView | null {
  if (!connection) return null;
  if (connection.settings["showMonthly"] === false) return null;
  const offer = fin.asLowAs(amount, termsFor(connection, deps));
  if (!offer) return null;
  return {
    lender: offer.lender,
    monthly: m.toString(offer.monthly),
    months: offer.plan.months,
    aprPercent: offer.plan.aprPercent,
    sentence: fin.offerSentence(offer),
    short: fin.offerShort(offer),
  };
}

/** Whether the lender would look at this amount: the apply button's question. */
function applicable(connection: Connection | null, amount: m.Money, deps: FinancingDeps): boolean {
  return connection !== null && fin.inRange(amount, termsFor(connection, deps));
}

/* ------------------------------------------------------- applications */

export interface ApplicationView {
  id: string;
  provider: string;
  status: fin.ApplicationStatus;
  statusLabel: string;
  customerId: string;
  customerName: string | null;
  invoiceId: string | null;
  invoiceNumber: number | null;
  estimateId: string | null;
  estimateNumber: number | null;
  amount: string;
  approvedAmount: string | null;
  chosenOffer: { months: number; aprPercent: string; monthlyPayment: string | null } | null;
  fundedAmount: string | null;
  feeAmount: string | null;
  fundedAt: string | null;
  paymentId: string | null;
  applicationUrl: string;
  sentVia: string;
  sentTo: string | null;
  attention: string | null;
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}

type Row = typeof schema.financingApplication.$inferSelect;

async function views(tx: Database, rows: Row[]): Promise<ApplicationView[]> {
  if (rows.length === 0) return [];
  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const invoiceIds = [...new Set(rows.map((r) => r.invoiceId).filter((x): x is string => !!x))];
  const estimateIds = [...new Set(rows.map((r) => r.estimateId).filter((x): x is string => !!x))];
  const [people, invoices, estimates] = await Promise.all([
    tx.select({ id: schema.customer.id, name: schema.customer.name }).from(schema.customer)
      .where(inArray(schema.customer.id, customerIds)),
    invoiceIds.length ? tx.select({ id: schema.invoice.id, number: schema.invoice.number }).from(schema.invoice)
      .where(inArray(schema.invoice.id, invoiceIds)) : Promise.resolve([]),
    estimateIds.length ? tx.select({ id: schema.estimate.id, number: schema.estimate.number }).from(schema.estimate)
      .where(inArray(schema.estimate.id, estimateIds)) : Promise.resolve([]),
  ]);
  const name = new Map(people.map((p) => [p.id, p.name]));
  const invoiceNumber = new Map(invoices.map((i) => [i.id, i.number]));
  const estimateNumber = new Map(estimates.map((e) => [e.id, e.number]));
  return rows.map((r) => ({
    id: r.id,
    provider: r.provider,
    status: r.status,
    statusLabel: fin.STATUS_LABEL[r.status],
    customerId: r.customerId,
    customerName: name.get(r.customerId) ?? null,
    invoiceId: r.invoiceId,
    invoiceNumber: r.invoiceId ? invoiceNumber.get(r.invoiceId) ?? null : null,
    estimateId: r.estimateId,
    estimateNumber: r.estimateId ? estimateNumber.get(r.estimateId) ?? null : null,
    amount: r.amount,
    approvedAmount: r.approvedAmount,
    chosenOffer: r.chosenOffer ?? null,
    fundedAmount: r.fundedAmount,
    feeAmount: r.feeAmount,
    fundedAt: r.fundedAt?.toISOString() ?? null,
    paymentId: r.paymentId,
    applicationUrl: r.applicationUrl,
    sentVia: r.sentVia,
    sentTo: r.sentTo,
    attention: r.attention,
    expiresAt: r.expiresAt?.toISOString() ?? null,
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  }));
}

/** What a subject (one invoice or one estimate) is, for the purposes of a loan. */
interface Subject {
  kind: "invoice" | "estimate";
  id: string;
  optionId: string | null;
  customerId: string;
  number: number;
  amount: m.Money;
  currency: string;
}

async function invoiceSubject(tx: Database, invoiceId: string): Promise<Subject> {
  const [row] = await tx.select().from(schema.invoice)
    .where(and(eq(schema.invoice.id, invoiceId), isNull(schema.invoice.deletedAt))).limit(1);
  if (!row) throw new NotFoundError("Invoice");
  if (row.status !== "open" && row.status !== "partially_paid") {
    throw new ConflictError(
      row.status === "draft"
        ? `Invoice ${row.number} is a draft. Issue it before offering financing on it.`
        : `Invoice ${row.number} is ${row.status.replace("_", " ")} and has nothing to finance.`,
    );
  }
  const balance = m.money(row.balance, row.currency);
  if (!m.isPositive(balance)) throw new ConflictError(`Invoice ${row.number} has nothing outstanding.`);
  return {
    kind: "invoice", id: row.id, optionId: null,
    /** Whoever pays the invoice is who borrows for it. */
    customerId: row.payerCustomerId ?? row.customerId,
    number: row.number, amount: balance, currency: row.currency,
  };
}

async function estimateSubject(tx: Database, estimateId: string, optionId: string | null | undefined): Promise<Subject> {
  const [row] = await tx.select().from(schema.estimate)
    .where(eq(schema.estimate.id, estimateId)).limit(1);
  if (!row) throw new NotFoundError("Estimate");
  if (row.status === "declined" || row.status === "expired" || row.status === "draft") {
    throw new ConflictError(`Estimate ${row.number} is ${row.status}, so there is nothing to finance on it.`);
  }
  const options = await tx.select().from(schema.estimateOption)
    .where(eq(schema.estimateOption.estimateId, estimateId))
    .orderBy(asc(schema.estimateOption.sortOrder));
  /**
   * The option asked for, or the one the customer chose, or the only one.
   * With several and no choice yet the question has no single amount, and
   * asking it with the largest would put a bigger loan in front of the
   * customer than the work they may pick.
   */
  const wanted = optionId ?? row.selectedOptionId ?? (options.length === 1 ? options[0]!.id : null);
  if (!wanted) {
    throw new UnprocessableError("Choose which option to finance", [{
      path: "optionId", message: "This estimate has more than one option. Say which one the customer wants to finance.",
    }]);
  }
  const option = options.find((o) => o.id === wanted);
  if (!option) throw new NotFoundError("Estimate option");
  return {
    kind: "estimate", id: row.id, optionId: option.id, customerId: row.customerId,
    number: row.number, amount: m.money(option.total, row.currency), currency: row.currency,
  };
}

/** Cents for the lender, from money's scale of four, without a float. */
const minorOf = (amount: m.Money): number => Number(m.round(amount).amount / 100n);
const fromMinor = (minor: number, currency: string): m.Money => ({ amount: BigInt(minor) * 100n, currency });

/**
 * A live application for this subject and amount, reused rather than a second
 * one opened: a customer who presses "Apply" twice, or is texted the link
 * after opening it from the portal, should land on the application they
 * already started, not start a new credit check.
 */
async function liveFor(tx: Database, subject: Subject): Promise<Row | null> {
  const [row] = await tx.select().from(schema.financingApplication)
    .where(and(
      subject.kind === "invoice"
        ? eq(schema.financingApplication.invoiceId, subject.id)
        : eq(schema.financingApplication.estimateId, subject.id),
      inArray(schema.financingApplication.status, [...fin.LIVE_STATUSES]),
      eq(schema.financingApplication.amount, m.toString(subject.amount)),
      subject.optionId
        ? eq(schema.financingApplication.estimateOptionId, subject.optionId)
        : sql`true`,
    ))
    .orderBy(desc(schema.financingApplication.createdAt))
    .limit(1);
  if (!row) return null;
  /** A link the lender said has run out is not reused, even if no event has arrived to say so. */
  if (row.expiresAt && row.expiresAt.getTime() <= Date.now()) return null;
  return row;
}

/**
 * Open an application with the lender, or find the live one, inside the
 * caller's transaction. The subject's row is locked first, so two presses at
 * once wait for each other and the second finds the first's application.
 */
async function openWithin(
  tx: Database, ctx: ServiceContext, subject: Subject,
  via: { sentVia: string; sentTo: string | null }, deps: FinancingDeps,
): Promise<{ row: Row; reused: boolean }> {
  const connection = await connectionWithin(tx, ctx.actor.organizationId);
  if (!connection) {
    throw new ConflictError("Financing is not set up. Connect a lender under Settings, Integrations first.");
  }
  if (subject.kind === "invoice") {
    await tx.select({ id: schema.invoice.id }).from(schema.invoice).where(eq(schema.invoice.id, subject.id)).for("update");
  } else {
    await tx.select({ id: schema.estimate.id }).from(schema.estimate).where(eq(schema.estimate.id, subject.id)).for("update");
  }

  const existing = await liveFor(tx, subject);
  if (existing) return { row: existing, reused: true };

  if (!applicable(connection, subject.amount, deps)) {
    const terms = termsFor(connection, deps);
    throw new ConflictError(
      `${terms.lender} finances ${terms.minAmount ? `from $${terms.minAmount}` : "any amount"}`
      + `${terms.maxAmount ? ` up to $${terms.maxAmount}` : ""}, and this is ${m.format(subject.amount)}.`,
    );
  }

  const [person] = await tx.select({ name: schema.customer.name, email: schema.customer.email, phone: schema.customer.phone })
    .from(schema.customer).where(eq(schema.customer.id, subject.customerId)).limit(1);
  const words = (person?.name ?? "").trim().split(/\s+/).filter(Boolean);
  const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
    .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);

  const id = randomUUID();
  const provider = await providerFor(connection, deps);
  const created = await provider.createApplication({
    amountMinor: minorOf(subject.amount),
    currency: subject.currency,
    reference: id,
    idempotencyKey: ctx.idempotencyKey ? `financing:${ctx.idempotencyKey}` : `financing:${id}`,
    purpose: `${org?.name ?? "Work"}: ${subject.kind === "invoice" ? "invoice" : "estimate"} ${subject.number}`,
    customer: {
      firstName: words.length > 1 ? words.slice(0, -1).join(" ") : words[0] ?? null,
      lastName: words.length > 1 ? words[words.length - 1]! : null,
      phone: person?.phone ?? null,
      email: person?.email ?? null,
    },
    callbackUrl: callbackFor(connection.id),
  });
  if (!created.ok) {
    throw new ConflictError(`${termsFor(connection, deps).lender} did not open the application: ${created.message}`);
  }

  const [row] = await tx.insert(schema.financingApplication).values({
    id,
    organizationId: ctx.actor.organizationId,
    connectionId: connection.id,
    provider: connection.provider,
    customerId: subject.customerId,
    invoiceId: subject.kind === "invoice" ? subject.id : null,
    estimateId: subject.kind === "estimate" ? subject.id : null,
    estimateOptionId: subject.optionId,
    status: created.value.status,
    currency: subject.currency,
    amount: m.toString(subject.amount),
    externalId: created.value.externalId,
    applicationUrl: created.value.applicationUrl,
    sentVia: via.sentVia,
    sentTo: via.sentTo,
    expiresAt: created.value.expiresAt,
    createdByUserId: ctx.actor.userId.includes(":") || ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
  }).returning();

  await audit(tx, ctx, "financing.application_opened", "financing_application", row!.id, null, {
    provider: connection.provider, subject: subject.kind, subjectId: subject.id, amount: row!.amount, sentVia: via.sentVia,
  });
  return { row: row!, reused: false };
}

/* ---------------------------------------------------------- office side */

export interface OfficeFinancing {
  /** A lender is connected. Without one there is nothing to offer and the screen says so. */
  connected: boolean;
  lender: string | null;
  offer: OfferView | null;
  /** Whether the amount is one the lender finances, so the send button means something. */
  applicable: boolean;
  applications: ApplicationView[];
}

/** Financing on one invoice: the offer for its balance and every application on it. */
export async function forInvoice(ctx: ServiceContext, input: { invoiceId: string }, deps: FinancingDeps = DEFAULT_DEPS): Promise<OfficeFinancing> {
  return guardedRead(ctx, "invoice:read", async (tx) => {
    const [invoice] = await tx.select().from(schema.invoice)
      .where(and(eq(schema.invoice.id, input.invoiceId), isNull(schema.invoice.deletedAt))).limit(1);
    if (!invoice) throw new NotFoundError("Invoice");
    const connection = await connectionWithin(tx, ctx.actor.organizationId);
    const balance = m.money(invoice.balance, invoice.currency);
    const open = invoice.status === "open" || invoice.status === "partially_paid";
    const rows = await tx.select().from(schema.financingApplication)
      .where(eq(schema.financingApplication.invoiceId, invoice.id))
      .orderBy(desc(schema.financingApplication.createdAt));
    return {
      connected: connection !== null,
      lender: connection ? termsFor(connection, deps).lender : null,
      offer: open ? offerFor(connection, balance, deps) : null,
      applicable: open && applicable(connection, balance, deps),
      applications: await views(tx, rows),
    };
  });
}

export interface EstimateFinancing extends Omit<OfficeFinancing, "offer" | "applicable"> {
  options: { optionId: string; name: string; total: string; offer: OfferView | null; applicable: boolean }[];
}

/** Financing on one estimate: an offer per option and every application on it. */
export async function forEstimate(ctx: ServiceContext, input: { estimateId: string }, deps: FinancingDeps = DEFAULT_DEPS): Promise<EstimateFinancing> {
  return guardedRead(ctx, "estimate:read", async (tx) => estimateFinancingWithin(tx, ctx.actor.organizationId, input.estimateId, deps));
}

async function estimateFinancingWithin(tx: Database, organizationId: string, estimateId: string, deps: FinancingDeps): Promise<EstimateFinancing> {
  const [estimate] = await tx.select().from(schema.estimate)
    .where(eq(schema.estimate.id, estimateId)).limit(1);
  if (!estimate) throw new NotFoundError("Estimate");
  const connection = await connectionWithin(tx, organizationId);
  const options = await tx.select().from(schema.estimateOption)
    .where(eq(schema.estimateOption.estimateId, estimateId)).orderBy(asc(schema.estimateOption.sortOrder));
  const rows = await tx.select().from(schema.financingApplication)
    .where(eq(schema.financingApplication.estimateId, estimateId))
    .orderBy(desc(schema.financingApplication.createdAt));
  const offerable = !["declined", "expired", "draft"].includes(estimate.status);
  return {
    connected: connection !== null,
    lender: connection ? termsFor(connection, deps).lender : null,
    options: options.map((o) => {
      const total = m.money(o.total, estimate.currency);
      return {
        optionId: o.id, name: o.name, total: o.total,
        offer: offerable ? offerFor(connection, total, deps) : null,
        applicable: offerable && applicable(connection, total, deps),
      };
    }),
    applications: await views(tx, rows),
  };
}

export interface SendResult {
  application: ApplicationView;
  /** True when a live application for the same amount was found and its link used again. */
  reused: boolean;
  /** Whether the text or email was queued; a refusal is an answer, with the reason. */
  delivery: { sent: true; channel: string } | { sent: false; channel: string; reason: string } | null;
}

/**
 * The office opens an application and texts or emails the customer its link,
 * or just takes the link to hand over.
 *
 * `payment:collect`, because financing is a way of being paid: the people who
 * take a card at the door are the people who offer to spread the cost.
 *
 * IDEMPOTENT on the request's key: a retried send finds the application the
 * first one opened and does not text the customer twice.
 */
export async function send(
  ctx: ServiceContext,
  input: {
    invoiceId?: string | undefined; estimateId?: string | undefined; optionId?: string | undefined;
    channel: "sms" | "email" | "link"; to?: string | undefined;
  },
  deps: FinancingDeps = DEFAULT_DEPS,
): Promise<SendResult> {
  if ((input.invoiceId ? 1 : 0) + (input.estimateId ? 1 : 0) !== 1) {
    throw new UnprocessableError("Name one invoice or one estimate", [{
      path: "invoiceId", message: "Financing is for one invoice or one estimate.",
    }]);
  }
  return guardedWrite(ctx, "payment:collect", async (tx) => {
    if (ctx.idempotencyKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId, response: schema.integrationEvent.responsePayload })
        .from(schema.integrationEvent)
        .where(and(
          eq(schema.integrationEvent.provider, "financing"),
          eq(schema.integrationEvent.idempotencyKey, ctx.idempotencyKey),
          eq(schema.integrationEvent.direction, "outbound"),
        )).limit(1);
      if (seen?.entityId) {
        const [row] = await tx.select().from(schema.financingApplication)
          .where(eq(schema.financingApplication.id, seen.entityId)).limit(1);
        if (row) {
          const [view] = await views(tx, [row]);
          return {
            application: view!,
            reused: true,
            delivery: (seen.response?.["delivery"] ?? null) as SendResult["delivery"],
          };
        }
      }
    }

    const subject = input.invoiceId
      ? await invoiceSubject(tx, input.invoiceId)
      : await estimateSubject(tx, input.estimateId!, input.optionId);

    const [person] = await tx.select({ email: schema.customer.email, phone: schema.customer.phone })
      .from(schema.customer).where(eq(schema.customer.id, subject.customerId)).limit(1);
    const to = input.channel === "link" ? null
      : (input.to?.trim() || (input.channel === "sms" ? person?.phone : person?.email) || null);
    if (input.channel !== "link" && !to) {
      throw new UnprocessableError("Nowhere to send it", [{
        path: "to",
        message: input.channel === "sms"
          ? "This customer has no phone number on file. Type one, or copy the link instead."
          : "This customer has no email address on file. Type one, or copy the link instead.",
      }]);
    }

    const { row, reused } = await openWithin(tx, ctx, subject, {
      sentVia: input.channel === "link" ? "office_link" : input.channel, sentTo: to,
    }, deps);
    if (reused && to) {
      await tx.update(schema.financingApplication)
        .set({ sentVia: input.channel, sentTo: to, updatedAt: new Date() })
        .where(eq(schema.financingApplication.id, row.id));
    }

    let delivery: SendResult["delivery"] = null;
    if (input.channel !== "link" && to) {
      const [org] = await tx.select({ name: schema.organization.name }).from(schema.organization)
        .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
      const company = org?.name ?? "We";
      const what = subject.kind === "invoice" ? `invoice ${subject.number}` : `estimate ${subject.number}`;
      const body = `${company}: you can apply to pay ${what} (${m.format(subject.amount)}) over time with `
        + `${row.provider === "wisetack" ? "Wisetack" : "our financing partner"}. Approval is up to the lender. `
        + `Apply here: ${row.applicationUrl}`;
      if (input.channel === "sms") {
        const outcome = await sendTransactional(tx, {
          organizationId: ctx.actor.organizationId, address: to, body, customerId: subject.customerId,
          sentByUserId: ctx.actor.userId.includes(":") ? null : ctx.actor.userId,
        });
        delivery = outcome.sent ? { sent: true, channel: "sms" } : { sent: false, channel: "sms", reason: outcome.explanation };
      } else {
        /**
         * The send's own authority is `payment:collect`; the transport asks
         * for `message:send` too, so it is added for this send the way an
         * estimate or invoice send adds it, and a revocation still wins.
         */
        const transport: ServiceContext = {
          ...ctx, db: tx, actor: { ...ctx.actor, grants: [...(ctx.actor.grants ?? []), "message:send"] } as Actor,
        };
        const outcome = await email.queueIn(tx, transport, {
          to,
          subject: `Pay ${what} over time`,
          text: `${body}\n\nThe lender decides on the application, and the rate and term you are offered may be different from any figure we have shown.`,
          purpose: "transactional",
          customerId: subject.customerId,
        });
        delivery = outcome.queued ? { sent: true, channel: "email" } : { sent: false, channel: "email", reason: outcome.explanation };
      }
    }

    if (ctx.idempotencyKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: ctx.actor.organizationId,
        direction: "outbound", provider: "financing", eventType: "financing.send",
        idempotencyKey: ctx.idempotencyKey, status: "succeeded",
        entityType: "financing_application", entityId: row.id,
        responsePayload: { delivery }, completedAt: new Date(),
      });
    }

    await audit(tx, ctx, "financing.link_sent", "financing_application", row.id, null, {
      channel: input.channel, to, reused, delivered: delivery?.sent ?? null,
    });
    const [fresh] = await tx.select().from(schema.financingApplication)
      .where(eq(schema.financingApplication.id, row.id)).limit(1);
    const [view] = await views(tx, [fresh!]);
    return { application: view!, reused, delivery };
  });
}

/* --------------------------------------------------------- portal side */

/**
 * The actor a customer's "Apply" press runs as: the one permission opening an
 * application needs, inside the grant's own tenant, exactly as a pay-now
 * press runs (see `invoiceDelivery.payerContext`). The subject comes from the
 * grant, so there is no id in the request to change.
 */
function customerContext(db: Database, grant: { grantId: string; organizationId: string }): ServiceContext {
  const actor = {
    userId: `portal:${grant.grantId}`,
    organizationId: grant.organizationId,
    roles: [],
    grants: ["payment:collect"],
    revocations: [],
  } as unknown as Actor;
  return { actor, db, portalGrantId: grant.grantId };
}

export interface PortalFinancing {
  lender: string;
  offer: OfferView | null;
  /** The application already open for this amount, so the page can say where it stands. */
  application: { status: fin.ApplicationStatus; statusLabel: string; applicationUrl: string | null } | null;
}

function portalApplication(row: Row | undefined): PortalFinancing["application"] {
  if (!row) return null;
  const live = (fin.LIVE_STATUSES as readonly string[]).includes(row.status);
  return { status: row.status, statusLabel: fin.STATUS_LABEL[row.status], applicationUrl: live ? row.applicationUrl : null };
}

/** What the customer's invoice page shows about financing, or null when there is nothing to offer. */
export async function portalInvoice(db: Database, input: { token: string }, deps: FinancingDeps = DEFAULT_DEPS): Promise<PortalFinancing | null> {
  const grant = await peek(db, input.token);
  const invoiceId = requireScope(grant, "invoice");
  return inGrant(db, grant, async (tx) => {
    const connection = await connectionWithin(tx, grant.organizationId);
    if (!connection) return null;
    const [invoice] = await tx.select().from(schema.invoice)
      .where(and(eq(schema.invoice.id, invoiceId), isNull(schema.invoice.deletedAt))).limit(1);
    if (!invoice) return null;
    const [latest] = await tx.select().from(schema.financingApplication)
      .where(eq(schema.financingApplication.invoiceId, invoiceId))
      .orderBy(desc(schema.financingApplication.createdAt)).limit(1);
    const open = invoice.status === "open" || invoice.status === "partially_paid";
    const balance = m.money(invoice.balance, invoice.currency);
    if (!open || !applicable(connection, balance, deps)) {
      return latest?.status === "funded"
        ? { lender: termsFor(connection, deps).lender, offer: null, application: portalApplication(latest) }
        : null;
    }
    return {
      lender: termsFor(connection, deps).lender,
      offer: offerFor(connection, balance, deps),
      application: portalApplication(latest),
    };
  });
}

/** The same for the customer's estimate page, per option. */
export async function portalEstimate(db: Database, input: { token: string }, deps: FinancingDeps = DEFAULT_DEPS): Promise<
  (Omit<PortalFinancing, "offer"> & { options: { optionId: string; name: string; offer: OfferView | null; applicable: boolean }[] }) | null
> {
  const grant = await peek(db, input.token);
  const estimateId = requireScope(grant, "estimate");
  return inGrant(db, grant, async (tx) => {
    const connection = await connectionWithin(tx, grant.organizationId);
    if (!connection) return null;
    const view = await estimateFinancingWithin(tx, grant.organizationId, estimateId, deps);
    if (!view.options.some((o) => o.applicable)) return null;
    const [latest] = await tx.select().from(schema.financingApplication)
      .where(eq(schema.financingApplication.estimateId, estimateId))
      .orderBy(desc(schema.financingApplication.createdAt)).limit(1);
    return {
      lender: view.lender ?? "",
      options: view.options.map((o) => ({ optionId: o.optionId, name: o.name, offer: o.offer, applicable: o.applicable })),
      application: portalApplication(latest),
    };
  });
}

/**
 * The customer presses "Apply for financing" on their invoice or estimate.
 * Returns the lender's page to send them to.
 *
 * `peek`, not `consume`: an estimate link is single use for APPROVING, and
 * applying for a loan is not approving; spending it here would leave a
 * customer who applied first unable to sign.
 */
export async function applyFromLink(
  db: Database, input: { token: string; optionId?: string | undefined }, deps: FinancingDeps = DEFAULT_DEPS,
): Promise<{ url: string }> {
  const grant = await peek(db, input.token);
  if (grant.scope !== "invoice" && grant.scope !== "estimate") throw new NotFoundError("Link");
  const subjectId = requireScope(grant, grant.scope);
  const ctx = customerContext(db, grant);
  return guardedWrite(ctx, "payment:collect", async (tx) => {
    const subject = grant.scope === "invoice"
      ? await invoiceSubject(tx, subjectId)
      : await estimateSubject(tx, subjectId, input.optionId ?? null);
    const { row } = await openWithin(tx, ctx, subject, { sentVia: "portal", sentTo: null }, deps);
    return { url: row.applicationUrl };
  });
}

/* ------------------------------------------------- the lender's answer */

/**
 * The actor a lender's webhook enters a tenant as: what recording the
 * funding as a payment needs, and nothing else.
 */
function lenderActor(organizationId: string, provider: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["payment:collect", "payment:read", "invoice:read"],
    agentId: `financing:${provider}`,
  } as Actor;
}

export interface Applied {
  status: fin.ApplicationStatus;
  changed: boolean;
  paymentId: string | null;
  note: string | null;
}

/**
 * Put what the lender says onto the application, inside the caller's
 * transaction, with the application row locked.
 *
 * WHEN IT BECOMES FUNDED the payment is recorded through `billing.pay`, keyed
 * on the application so a second funding report finds the first payment
 * rather than making another. The amount is what the lender reports paying;
 * when it does not say, the approved amount, and the application is flagged
 * so somebody checks it against the deposit. The fee is the lender's figure
 * or nothing, never a guess, and an unknown fee is flagged the same way.
 *
 * Applied to the invoice when it is still open, up to its balance; anything
 * beyond that, or everything on an estimate's loan, is held on the customer's
 * account as unapplied money, which is a liability until it is applied to the
 * invoice the work becomes. That is what `billing.pay` does with money that
 * names no invoice, so nothing here invents a second rule.
 */
async function applyState(tx: Database, ctx: ServiceContext, current: Row, state: ApplicationState): Promise<Applied> {
  const step = fin.advance(current.status, state.status);
  const currency = current.currency;
  const notes: string[] = [];
  const patch: Partial<typeof schema.financingApplication.$inferInsert> = {
    lastEventAt: new Date(), updatedAt: new Date(),
  };
  if (state.approvedAmountMinor !== null) patch.approvedAmount = m.toString(fromMinor(state.approvedAmountMinor, currency));
  if (state.chosenOffer) {
    patch.chosenOffer = {
      months: state.chosenOffer.months,
      aprPercent: state.chosenOffer.aprPercent,
      monthlyPayment: state.chosenOffer.monthlyPaymentMinor !== null
        ? m.toString(fromMinor(state.chosenOffer.monthlyPaymentMinor, currency)) : null,
    };
  }
  if (state.expiresAt) patch.expiresAt = state.expiresAt;
  if (!step.changed && step.reason && current.status === "funded") patch.attention = step.reason;

  let paymentId = current.paymentId;
  if (step.changed) {
    patch.status = step.status;
    if (step.status === "funded" && !current.paymentId) {
      const fundedMinor = state.fundedAmountMinor ?? state.approvedAmountMinor;
      const amount = fundedMinor !== null ? fromMinor(fundedMinor, currency) : m.money(current.amount, currency);
      if (state.fundedAmountMinor === null) {
        notes.push("The lender did not say how much it paid, so the "
          + `${state.approvedAmountMinor !== null ? "approved" : "requested"} amount was recorded. Check it against the deposit.`);
      }
      const fee = state.feeMinor !== null ? fromMinor(state.feeMinor, currency) : null;
      if (fee === null) notes.push("The lender did not say what fee it kept, so none was booked. Add it when the statement arrives.");

      let allocations: { invoiceId: string; amount: string }[] = [];
      if (current.invoiceId) {
        const [invoice] = await tx.select().from(schema.invoice).where(eq(schema.invoice.id, current.invoiceId)).limit(1);
        const balance = invoice ? m.money(invoice.balance, invoice.currency) : m.zero(currency);
        if (invoice && (invoice.status === "open" || invoice.status === "partially_paid") && m.isPositive(balance)) {
          allocations = [{ invoiceId: invoice.id, amount: m.toString(m.min(amount, balance)) }];
          if (m.compare(amount, balance) > 0) notes.push("The loan was more than the invoice still owed; the rest is held on the customer's account.");
        } else {
          notes.push("The invoice was no longer open when the loan was funded, so the money is held on the customer's account.");
        }
      }

      const paid = await billing.pay({ ...ctx, db: tx, idempotencyKey: `financing-funded:${current.id}` }, {
        customerId: current.customerId,
        method: "financing",
        amount: m.toString(amount),
        tipAmount: "0",
        ...(fee !== null ? { feeAmount: m.toString(fee) } : {}),
        allocations,
        processorPaymentId: current.externalId,
        notes: `Funded by ${current.provider}`,
      });
      /** `billing.pay` writes the card processor's default; this money came from the lender. */
      await tx.update(schema.payment).set({ processor: current.provider, updatedAt: new Date() })
        .where(eq(schema.payment.id, paid.id));
      paymentId = paid.id;
      patch.paymentId = paid.id;
      patch.fundedAmount = m.toString(amount);
      patch.feeAmount = fee !== null ? m.toString(fee) : null;
      patch.fundedAt = state.fundedAt ?? new Date();
    }
  }
  if (notes.length > 0) patch.attention = notes.join(" ");

  const [after] = await tx.update(schema.financingApplication).set(patch)
    .where(eq(schema.financingApplication.id, current.id)).returning();
  if (step.changed) {
    await audit(tx, ctx, "financing.status_changed", "financing_application", current.id,
      { status: current.status }, { status: after!.status, paymentId: after!.paymentId });
  }
  return {
    status: after!.status, changed: step.changed, paymentId,
    note: step.changed ? null : step.reason,
  };
}

/** Lock an application and read it, for a status change. */
async function lockApplication(tx: Database, where: ReturnType<typeof eq>): Promise<Row | null> {
  const [row] = await tx.select().from(schema.financingApplication).where(where).limit(1).for("update");
  return row ?? null;
}

/**
 * Ask the lender where an application stands now and record it. For the
 * office, when a webhook went missing or a customer rings to say they were
 * approved.
 */
export async function refresh(ctx: ServiceContext, input: { applicationId: string }, deps: FinancingDeps = DEFAULT_DEPS): Promise<ApplicationView> {
  return guardedWrite(ctx, "payment:collect", async (tx) => {
    const row = await lockApplication(tx, eq(schema.financingApplication.id, input.applicationId));
    if (!row) throw new NotFoundError("Financing application");
    const [connectionRow] = await tx.select().from(schema.integrationConnection)
      .where(eq(schema.integrationConnection.id, row.connectionId)).limit(1);
    if (!connectionRow) throw new FinancingNotConfiguredError(row.provider);
    const provider = await providerFor(readConnection(connectionRow), deps);
    const read = await provider.readApplication(row.externalId);
    if (!read.ok) throw new ConflictError(`The lender could not be asked: ${read.message}`);
    await applyState(tx, ctx, row, read.value);
    const [fresh] = await tx.select().from(schema.financingApplication)
      .where(eq(schema.financingApplication.id, row.id)).limit(1);
    const [view] = await views(tx, [fresh!]);
    return view!;
  });
}

export interface WebhookAnswer {
  status: number;
  body: Record<string, unknown>;
}

/**
 * A delivery from the lender, from the raw request to an answer.
 *
 * The whole path is here rather than in the route so a test can drive every
 * refusal: an unknown connection is 404, one with no signing secret 409, a bad
 * signature 401, a body that is not an event 422. Everything after the
 * signature answers 200, including a duplicate and an application this
 * product never opened, because the lender should stop retrying those, and a
 * failure to reach the lender for the read back answers 503 so it does retry.
 */
export async function receiveWebhook(
  db: Database,
  input: { connectionId: string; request: WebhookRequest },
  deps: FinancingDeps = DEFAULT_DEPS,
): Promise<WebhookAnswer> {
  const connection = await connectionById(db, input.connectionId);
  if (!connection) return { status: 404, body: { error: "Not found" } };
  if (!connection.webhookSecretRef) return { status: 409, body: { error: "No signing secret is set on this connection." } };

  let secret: string;
  try { secret = await deps.readSecret(connection.webhookSecretRef); }
  catch { return { status: 409, body: { error: "The signing secret named on this connection is not set." } }; }

  const provider = await providerFor(connection, deps);
  if (!provider.verify(input.request, secret)) return { status: 401, body: { error: "Bad signature" } };
  const event = provider.parseEvent(input.request);
  if (!event) return { status: 422, body: { error: "That body is not an event this can read." } };

  const ctx: ServiceContext = {
    actor: lenderActor(connection.organizationId, connection.provider),
    db,
    idempotencyKey: event.eventId,
  };

  return inTenant(ctx, async (tx) => {
    const row = await lockApplication(tx, and(
      eq(schema.financingApplication.connectionId, connection.id),
      eq(schema.financingApplication.externalId, event.externalId),
    ) as ReturnType<typeof eq>);

    /** Seen before is answered before anything else, and under the lock, so two copies cannot both pass. */
    const [seen] = await tx.select({ id: schema.integrationEvent.id }).from(schema.integrationEvent)
      .where(and(
        eq(schema.integrationEvent.organizationId, connection.organizationId),
        eq(schema.integrationEvent.provider, connection.provider),
        eq(schema.integrationEvent.idempotencyKey, event.eventId),
        eq(schema.integrationEvent.direction, "inbound"),
      )).limit(1);
    if (seen) return { status: 200, body: { handled: false, note: "already handled", eventId: event.eventId } };

    const record = (status: "succeeded" | "failed", error?: string) => tx.insert(schema.integrationEvent).values({
      organizationId: connection.organizationId, direction: "inbound", provider: connection.provider,
      eventType: event.type, idempotencyKey: event.eventId, status,
      entityType: row ? "financing_application" : null, entityId: row?.id ?? null,
      requestPayload: { externalId: event.externalId, reportedStatus: event.reportedStatus },
      ...(error ? { error } : {}), completedAt: new Date(),
    });

    if (!row) {
      await record("failed", "No application here has that lender id.");
      return { status: 200, body: { handled: false, note: "no matching application", eventId: event.eventId } };
    }

    const read = await provider.readApplication(event.externalId);
    if (!read.ok) {
      /** Not recorded, so the lender's retry tries again once it can be asked. */
      return { status: read.retryable ? 503 : 200, body: { handled: false, note: read.message } };
    }

    const applied = await guardedWrite({ ...ctx, db: tx }, "payment:collect", (inner) => applyState(inner, { ...ctx, db: inner }, row, read.value));
    await record("succeeded");
    return {
      status: 200,
      body: { handled: true, eventId: event.eventId, status: applied.status, changed: applied.changed, paymentId: applied.paymentId },
    };
  });
}

/* --------------------------------------------------------- lists and report */

export async function list(
  ctx: ServiceContext,
  input: { status?: fin.ApplicationStatus | undefined; limit?: number | undefined } = {},
): Promise<{ applications: ApplicationView[] }> {
  return guardedRead(ctx, "payment:read", async (tx) => {
    const rows = await tx.select().from(schema.financingApplication)
      .where(and(
        eq(schema.financingApplication.organizationId, ctx.actor.organizationId),
        input.status ? eq(schema.financingApplication.status, input.status) : undefined,
      ))
      .orderBy(desc(schema.financingApplication.createdAt))
      .limit(Math.min(Math.max(input.limit ?? 100, 1), 500));
    return { applications: await views(tx, rows) };
  });
}

export interface FinancingReport {
  from: string | null;
  to: string | null;
  applications: number;
  byStatus: Record<fin.ApplicationStatus, number>;
  /** Approved or funded, over everything the lender has decided. Null before any decision. */
  approvalRate: number | null;
  decided: number;
  fundedCount: number;
  /** Money in from loans, before fees. */
  fundedVolume: string;
  /** What lenders kept, where they said. */
  fees: string;
  /** Funded loans whose fee the lender never reported, which `fees` does not include. */
  feesUnknown: number;
  /** Fees as a share of the volume they were reported on, one decimal place. */
  feePercent: number | null;
  /** Requested on applications still waiting on the customer or the lender. */
  pendingVolume: string;
}

/**
 * Applications, approval rate, funded volume and fees, over applications
 * opened in a window.
 *
 * The approval rate is over DECISIONS, not over applications: a link the
 * customer never opened has not been declined, and counting it would make the
 * lender look stricter than it is. `report.financial:read`, because funded
 * volume and fees are the company's money.
 */
export async function report(
  ctx: ServiceContext, input: { from?: string | undefined; to?: string | undefined } = {},
): Promise<FinancingReport> {
  return guardedRead(ctx, "report.financial:read", async (tx) => {
    const rows = await tx.select({
      status: schema.financingApplication.status,
      amount: schema.financingApplication.amount,
      fundedAmount: schema.financingApplication.fundedAmount,
      feeAmount: schema.financingApplication.feeAmount,
      currency: schema.financingApplication.currency,
    }).from(schema.financingApplication)
      .where(and(
        eq(schema.financingApplication.organizationId, ctx.actor.organizationId),
        input.from ? gte(schema.financingApplication.createdAt, new Date(input.from)) : undefined,
        input.to ? lte(schema.financingApplication.createdAt, new Date(input.to)) : undefined,
      ));
    const byStatus = Object.fromEntries(fin.APPLICATION_STATUSES.map((s) => [s, 0])) as Record<fin.ApplicationStatus, number>;
    let volume = m.zero("USD");
    let fees = m.zero("USD");
    let feeBase = m.zero("USD");
    let pending = m.zero("USD");
    let unknown = 0;
    for (const row of rows) {
      byStatus[row.status] += 1;
      if (row.status === "funded" && row.fundedAmount) {
        const funded = m.money(row.fundedAmount, "USD");
        volume = m.add(volume, funded);
        if (row.feeAmount !== null) {
          fees = m.add(fees, m.money(row.feeAmount, "USD"));
          feeBase = m.add(feeBase, funded);
        } else unknown += 1;
      }
      if ((fin.LIVE_STATUSES as readonly string[]).includes(row.status)) pending = m.add(pending, m.money(row.amount, "USD"));
    }
    const approved = byStatus.approved + byStatus.funded;
    const decided = approved + byStatus.declined;
    return {
      from: input.from ?? null,
      to: input.to ?? null,
      applications: rows.length,
      byStatus,
      decided,
      approvalRate: decided === 0 ? null : Math.round((approved / decided) * 1000) / 10,
      fundedCount: byStatus.funded,
      fundedVolume: m.toString(volume),
      fees: m.toString(fees),
      feesUnknown: unknown,
      feePercent: m.isZero(feeBase) ? null
        : Math.round((Number(m.toString(fees)) / Number(m.toString(feeBase))) * 1000) / 10,
      pendingVolume: m.toString(pending),
    };
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listFinancingApplications: (ctx: ServiceContext, input: { status?: fin.ApplicationStatus | undefined; limit?: number | undefined }) =>
    list(ctx, input),
  getInvoiceFinancing: (ctx: ServiceContext, input: { invoiceId: string }) => forInvoice(ctx, input),
  getEstimateFinancing: (ctx: ServiceContext, input: { estimateId: string }) => forEstimate(ctx, input),
  sendFinancingLink: (ctx: ServiceContext, input: {
    invoiceId?: string | undefined; estimateId?: string | undefined; optionId?: string | undefined;
    channel: "sms" | "email" | "link"; to?: string | undefined;
  }) => send(ctx, input),
  refreshFinancingApplication: (ctx: ServiceContext, input: { id: string }) => refresh(ctx, { applicationId: input.id }),
  getFinancingReport: (ctx: ServiceContext, input: { from?: string | undefined; to?: string | undefined }) => report(ctx, input),
} as const;
