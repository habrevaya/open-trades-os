import { and, desc, eq, isNull, or } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { membership, money as m } from "@opentradesos/core";
import { ConflictError, InvalidGrantError, NotFoundError } from "./context";
import * as payments from "./payments";
import { consume, inGrant, peek, requireScope, type ResolvedGrant } from "./portal";
import { payerContext, processorConnected, type PortalPaymentStart } from "./invoice-delivery";
import { buildStatement } from "./statements";
import * as tips from "./tips";
import { accountExtras, customerPhotoBytes, type AccountExtras } from "./portal-blocks";
import { pendingFor as pendingBookingsFor } from "./portal-booking";
import { exclusionNamesWithin, percentOf } from "./agreements";

/**
 * THE TWO PORTAL LINKS THAT HAD NO PAGE
 *
 * `/c/{token}`, the customer-wide link, could be minted through the API and
 * opened nothing. `/pay/{id}`, handed back when a customer approved an
 * estimate that asked for a deposit, opened nothing either, and was a bare
 * deposit id in a URL rather than a capability.
 *
 * Both now resolve the way `/i/{token}` does (`invoice-delivery.ts`): the
 * token is peeked to read and consumed to act, everything after runs inside
 * the grant's own tenant boundary, the subject comes from the grant and
 * never from the request, and a charge goes through `payments.intent` with
 * the amount read from the database rather than from a browser.
 */

const usd = (value: string) => m.money(value, "USD");

/** The customer a customer-scope grant reaches. That scope has no subject id. */
function requireCustomer(grant: ResolvedGrant): string {
  if (grant.scope !== "customer" || !grant.customerId) throw new InvalidGrantError();
  return grant.customerId;
}

const payableStatus = (status: string) => status === "open" || status === "partially_paid";

export interface PortalAccount {
  organizationName: string;
  customerName: string;
  /** The homes and buildings this customer has with the company, service address first. */
  properties: { id: string; line1: string; line2: string | null; city: string; state: string; postalCode: string }[];
  /**
   * Work done and under way, newest first, cancelled left out. A job is
   * what a customer remembers ("the water heater in March"), where a visit
   * is one trip of it.
   */
  jobs: { id: string; number: number; summary: string; status: string; completedAt: string | null }[];
  visits: {
    id: string;
    jobNumber: number;
    summary: string;
    status: string;
    windowStart: string | null;
    windowEnd: string | null;
    technicianName: string | null;
  }[];
  invoices: {
    id: string;
    number: number;
    status: string;
    issuedOn: string | null;
    dueOn: string | null;
    currency: string;
    total: string;
    balance: string;
    payable: boolean;
    /** A bank payment for it is on its way, so it is not offered for payment again. */
    bankPaymentPending: boolean;
    /** What the pay control offers as a tip on this one, when the company takes them. */
    tipping: tips.TipOffer;
  }[];
  estimates: { id: string; number: number; title: string | null; status: string; sentAt: string | null }[];
  agreements: {
    id: string; planName: string; status: string; startedOn: string; endsOn: string | null;
    /** "15%" when the agreement carries a discount, for the member to read. */
    discount: string | null;
    /** What the discount leaves out, by name, so the member is not surprised on an invoice. */
    notDiscounted: string[];
  }[];
  deposits: { id: string; status: string; amountRequested: string; amountReceived: string; currency: string }[];
  /** Whether a pay button would lead anywhere. */
  onlinePaymentAvailable: boolean;
  /** Visits they asked for from their account that the office has not booked yet. */
  requested: { id: string; serviceName: string; requestedDate: string; windowName: string | null; technicianName: string | null }[];
  /** Bank payments on their way, and the ones that failed in the last month and why. */
  bankPayments: (Omit<payments.BankPaymentView, "invoiceIds"> & { invoiceNumbers: number[] })[];
  /**
   * The work itself: service history with what the office shared, reports,
   * equipment, readings and the blocks the company's trade pack lays out.
   */
  extras: AccountExtras;
}

/**
 * Everything this customer has with the company, from one link.
 *
 * Built field by field like every other portal read. No cost, no margin, no
 * internal note, no other customer: each query is filtered to the customer
 * the grant names, inside row level security for the company it names.
 * Drafts are left out, because a draft invoice or estimate is the office's
 * work in progress and not something the customer has been sent.
 */
export async function viewAccount(db: Database, input: { token: string }): Promise<PortalAccount> {
  const grant = await peek(db, input.token);
  const customerId = requireCustomer(grant);

  return inGrant(db, grant, async (tx) => {
    const [customer] = await tx.select({ name: schema.customer.name })
      .from(schema.customer)
      .where(and(eq(schema.customer.id, customerId), isNull(schema.customer.deletedAt)))
      .limit(1);
    if (!customer) throw new NotFoundError("Customer");

    const [org] = await tx.select({ name: schema.organization.name })
      .from(schema.organization).where(eq(schema.organization.id, grant.organizationId)).limit(1);

    const visitRows = await tx.select({
      id: schema.visit.id,
      status: schema.visit.status,
      windowStart: schema.visit.windowStart,
      windowEnd: schema.visit.windowEnd,
      jobNumber: schema.job.number,
      jobNumberPrefix: schema.job.numberPrefix,
      summary: schema.job.summary,
      technicianName: schema.technician.displayName,
    })
      .from(schema.visit)
      .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
      .leftJoin(schema.visitAssignment, and(
        eq(schema.visitAssignment.visitId, schema.visit.id),
        eq(schema.visitAssignment.isLead, true),
      ))
      .leftJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
      .where(and(eq(schema.job.customerId, customerId), isNull(schema.job.deletedAt)))
      .orderBy(desc(schema.visit.windowStart))
      .limit(50);

    const invoiceRows = await tx.select({
      id: schema.invoice.id,
      number: schema.invoice.number,
      /** The branch's code it was printed with, which the account prints too. */
      numberPrefix: schema.invoice.numberPrefix,
      status: schema.invoice.status,
      issuedOn: schema.invoice.issuedOn,
      dueOn: schema.invoice.dueOn,
      currency: schema.invoice.currency,
      total: schema.invoice.total,
      balance: schema.invoice.balance,
    })
      .from(schema.invoice)
      .where(and(
        or(eq(schema.invoice.customerId, customerId), eq(schema.invoice.payerCustomerId, customerId)),
        isNull(schema.invoice.deletedAt),
      ))
      .orderBy(desc(schema.invoice.number))
      .limit(100);

    const estimateRows = await tx.select({
      id: schema.estimate.id,
      number: schema.estimate.number,
      title: schema.estimate.title,
      status: schema.estimate.status,
      sentAt: schema.estimate.sentAt,
    })
      .from(schema.estimate)
      .where(eq(schema.estimate.customerId, customerId))
      .orderBy(desc(schema.estimate.number))
      .limit(50);

    const agreementRows = await tx.select({
      id: schema.agreement.id,
      planName: schema.agreementPlan.name,
      status: schema.agreement.status,
      startedOn: schema.agreement.startedOn,
      endsOn: schema.agreement.endsOn,
      discountRate: schema.agreement.discountRate,
      exclusions: schema.agreement.discountExclusions,
    })
      .from(schema.agreement)
      .innerJoin(schema.agreementPlan, eq(schema.agreementPlan.id, schema.agreement.planId))
      .where(eq(schema.agreement.customerId, customerId))
      .orderBy(desc(schema.agreement.startedOn));

    const depositRows = await tx.select({
      id: schema.deposit.id,
      status: schema.deposit.status,
      amountRequested: schema.deposit.amountRequested,
      amountReceived: schema.deposit.amountReceived,
      currency: schema.deposit.currency,
    })
      .from(schema.deposit)
      .where(eq(schema.deposit.customerId, customerId))
      .orderBy(desc(schema.deposit.createdAt));

    const NO_TIP: tips.TipOffer = { available: false, presets: [], for: [] };
    /**
     * An invoice a bank payment is already paying is not offered again. The
     * balance stays on it until the bank says the money arrived, and a second
     * payment in the meantime is a refund somebody has to arrange.
     */
    const bank = await payments.bankPaymentsWithin(tx, { customerId });
    const onItsWay = new Set(bank.filter((b) => b.status === "pending").flatMap((b) => b.invoiceIds));
    const invoices = [];
    for (const i of invoiceRows.filter((row) => row.status !== "draft")) {
      const payable = payableStatus(i.status) && m.isPositive(m.money(i.balance, i.currency)) && !onItsWay.has(i.id);
      invoices.push({
        ...i,
        bankPaymentPending: onItsWay.has(i.id),
        payable,
        tipping: payable ? await tips.offerFor(tx, grant.organizationId, i.id, m.money(i.balance, i.currency)) : NO_TIP,
      });
    }

    const propertyRows = await tx.select({
      id: schema.property.id,
      line1: schema.property.addressLine1,
      line2: schema.property.addressLine2,
      city: schema.property.city,
      state: schema.property.state,
      postalCode: schema.property.postalCode,
    })
      .from(schema.customerProperty)
      .innerJoin(schema.property, eq(schema.property.id, schema.customerProperty.propertyId))
      .where(and(eq(schema.customerProperty.customerId, customerId), isNull(schema.customerProperty.endedOn)))
      .orderBy(desc(schema.customerProperty.isPrimary), schema.property.addressLine1);

    const jobRows = await tx.select({
      id: schema.job.id,
      number: schema.job.number,
      numberPrefix: schema.job.numberPrefix,
      summary: schema.job.summary,
      status: schema.job.status,
      completedAt: schema.job.completedAt,
    })
      .from(schema.job)
      .where(and(eq(schema.job.customerId, customerId), isNull(schema.job.deletedAt)))
      .orderBy(desc(schema.job.number))
      .limit(50);

    return {
      organizationName: org?.name ?? "",
      customerName: customer.name,
      properties: propertyRows,
      jobs: jobRows
        /**
         * A lead or an estimate in progress is not work the customer has
         * had done, and a cancelled job is not one they need to find again.
         */
        .filter((j) => j.status !== "cancelled" && j.status !== "lead" && j.status !== "estimating")
        .map((j) => ({ ...j, completedAt: j.completedAt?.toISOString() ?? null })),
      visits: visitRows.map((v) => ({
        id: v.id,
        jobNumber: v.jobNumber,
        jobNumberPrefix: v.jobNumberPrefix,
        summary: v.summary,
        status: v.status,
        windowStart: v.windowStart?.toISOString() ?? null,
        windowEnd: v.windowEnd?.toISOString() ?? null,
        technicianName: v.technicianName ?? null,
      })),
      invoices,
      estimates: estimateRows
        .filter((e) => e.status !== "draft")
        .map((e) => ({ ...e, sentAt: e.sentAt?.toISOString() ?? null })),
      agreements: await Promise.all(agreementRows.map(async ({ discountRate, exclusions, ...a }) => ({
        ...a,
        discount: membership.usableRate(discountRate) ? percentOf(discountRate) : null,
        notDiscounted: membership.usableRate(discountRate)
          ? await exclusionNamesWithin(tx, membership.readExclusions(exclusions)) : [],
      }))),
      deposits: depositRows,
      onlinePaymentAvailable: invoices.some((i) => i.payable) && await processorConnected(tx),
      bankPayments: bank.map(({ invoiceIds, ...payment }) => ({
        ...payment,
        invoiceNumbers: invoiceIds
          .map((id) => invoiceRows.find((row) => row.id === id)?.number)
          .filter((n): n is number => n !== undefined),
      })),
      extras: await accountExtras(tx, grant.organizationId, customerId),
      requested: await pendingBookingsFor(tx, customerId),
    };
  });
}

/**
 * One photograph from the customer's account, by id: one of theirs, and one
 * the company shows them, or nothing. The same rule the job link applies,
 * over every job they have.
 */
export async function accountPhotoFor(
  db: Database, token: string, attachmentId: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const grant = await peek(db, token);
  const customerId = requireCustomer(grant);
  return inGrant(db, grant, (tx) => customerPhotoBytes(tx, grant.organizationId, customerId, attachmentId));
}

/**
 * Pay one of this customer's invoices from the account link.
 *
 * The invoice id IS from the request here, which is the one difference from
 * `/i/{token}`, so it is checked against the customer the grant names inside
 * the grant's tenant boundary before anything is charged: an id for another
 * customer's invoice is the same not-found as an id that does not exist.
 */
export async function startInvoicePayment(
  db: Database,
  input: { token: string; invoiceId: string; tip?: string | undefined },
  meta?: { ip?: string | undefined } | undefined,
  deps?: payments.PaymentDeps | undefined,
): Promise<PortalPaymentStart> {
  const grant = await consume(db, input.token, meta?.ip);
  const customerId = requireCustomer(grant);

  const invoice = await inGrant(db, grant, async (tx) => {
    const [row] = await tx.select({
      id: schema.invoice.id,
      customerId: schema.invoice.customerId,
      payerCustomerId: schema.invoice.payerCustomerId,
      number: schema.invoice.number,
      status: schema.invoice.status,
      balance: schema.invoice.balance,
      currency: schema.invoice.currency,
    })
      .from(schema.invoice)
      .where(and(
        eq(schema.invoice.id, input.invoiceId),
        or(eq(schema.invoice.customerId, customerId), eq(schema.invoice.payerCustomerId, customerId)),
        isNull(schema.invoice.deletedAt),
      ))
      .limit(1);
    if (!row || row.status === "draft") throw new NotFoundError("Invoice");
    return row;
  });

  if (!payableStatus(invoice.status) || !m.isPositive(m.money(invoice.balance, invoice.currency))) {
    throw new ConflictError(`Invoice ${invoice.number} has nothing outstanding. It may already have been paid.`);
  }

  const result = await payments.intent(payerContext(db, grant), {
    customerId: invoice.payerCustomerId ?? invoice.customerId,
    invoiceIds: [invoice.id],
    description: `Invoice ${invoice.number}`,
    ...(input.tip !== undefined ? { tip: input.tip } : {}),
  }, deps);

  return {
    intentId: result.intentId,
    clientSecret: result.clientSecret,
    publishableKey: result.publishableKey,
    amount: result.amount,
    tip: result.tip,
    currency: result.currency,
  };
}

export interface PortalDeposit {
  organizationName: string;
  estimateNumber: number | null;
  estimateTitle: string | null;
  status: string;
  currency: string;
  amountRequested: string;
  amountReceived: string;
  outstanding: string;
  payable: boolean;
  onlinePaymentAvailable: boolean;
}

/** The deposit a `/pay/{token}` link names, as the customer may see it. */
export async function viewDeposit(db: Database, input: { token: string }): Promise<PortalDeposit> {
  const grant = await peek(db, input.token);
  const depositId = requireScope(grant, "deposit");

  return inGrant(db, grant, async (tx) => {
    const [row] = await tx.select({
      status: schema.deposit.status,
      currency: schema.deposit.currency,
      amountRequested: schema.deposit.amountRequested,
      amountReceived: schema.deposit.amountReceived,
      estimateNumber: schema.estimate.number,
      estimateTitle: schema.estimate.title,
    })
      .from(schema.deposit)
      .leftJoin(schema.estimate, eq(schema.estimate.id, schema.deposit.estimateId))
      .where(eq(schema.deposit.id, depositId))
      .limit(1);
    if (!row) throw new NotFoundError("Deposit");

    const [org] = await tx.select({ name: schema.organization.name })
      .from(schema.organization).where(eq(schema.organization.id, grant.organizationId)).limit(1);

    const outstanding = m.subtract(usd(row.amountRequested), usd(row.amountReceived));
    const payable = (row.status === "requested" || row.status === "held") && m.isPositive(outstanding);

    return {
      organizationName: org?.name ?? "",
      estimateNumber: row.estimateNumber ?? null,
      estimateTitle: row.estimateTitle ?? null,
      status: row.status,
      currency: row.currency,
      amountRequested: row.amountRequested,
      amountReceived: row.amountReceived,
      outstanding: m.isPositive(outstanding) ? m.toString(outstanding) : "0.00",
      payable,
      onlinePaymentAvailable: payable && await processorConnected(tx),
    };
  });
}

/** Pay the deposit a `/pay/{token}` link names. The amount is what is outstanding on it. */
export async function startDepositPayment(
  db: Database,
  input: { token: string },
  meta?: { ip?: string | undefined } | undefined,
  deps?: payments.PaymentDeps | undefined,
): Promise<PortalPaymentStart> {
  const grant = await consume(db, input.token, meta?.ip);
  const depositId = requireScope(grant, "deposit");

  const deposit = await inGrant(db, grant, async (tx) => {
    const [row] = await tx.select({ customerId: schema.deposit.customerId })
      .from(schema.deposit)
      .where(eq(schema.deposit.id, depositId))
      .limit(1);
    if (!row) throw new NotFoundError("Deposit");
    return row;
  });

  const result = await payments.intent(payerContext(db, grant), {
    customerId: deposit.customerId,
    depositId,
    description: "Deposit",
  }, deps);

  return {
    intentId: result.intentId,
    clientSecret: result.clientSecret,
    publishableKey: result.publishableKey,
    amount: result.amount,
    tip: result.tip,
    currency: result.currency,
  };
}

/**
 * The customer's statement, from their own account link.
 *
 * The same document the office prints, built by the same function, inside the
 * grant's tenant boundary and for the customer the grant names only. A
 * customer asking "what do I owe in total" can answer it themselves.
 */
export async function viewStatement(
  db: Database, input: { token: string; from?: string | undefined; to?: string | undefined },
) {
  const grant = await peek(db, input.token);
  const customerId = requireCustomer(grant);
  return inGrant(db, grant, (tx) => buildStatement(tx, grant.organizationId, customerId, input));
}
