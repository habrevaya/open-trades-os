import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { authorization as authz, money as m, parties as partyRoles } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { audit } from "./customers";

/**
 * THE COMMERCIAL ARRANGEMENT
 *
 * The original design encoded a single assumption so deeply it was invisible:
 * ONE customer who owns the property, approves the work, receives the invoice
 * and pays it. That is true for residential service and false for roughly
 * half the market.
 *
 *   commercial FM      a facilities network orders it, a store manager is on
 *                      site, the client approves against a ceiling, and a
 *                      corporate AP portal pays
 *   property mgmt      a manager orders, a tenant is on site, an owner pays
 *   home warranty      a warranty company orders, approves and pays, while
 *                      the homeowner pays only the call fee
 *   restoration        the homeowner requests, an adjuster approves, the
 *                      carrier pays most and the homeowner pays the excess
 *
 * The tables were written in the first migrations and reached by nothing.
 * This is the door, and it opens on the two things that actually decide
 * whether a contractor gets paid: WHO the invoice goes to, and the CEILING
 * they authorised.
 *
 * Residential stays the degenerate case. A job with no parties and no
 * authorisation behaves exactly as it did, which is the test a change like
 * this has to pass.
 */

const usd = (value: string) => m.money(value, "USD");

/**
 * The role vocabulary is declared in core, with what each one means, and
 * imported rather than restated. A second copy of a seven-value list is how
 * a screen ends up offering a role the database will not take.
 */
export type PartyRole = partyRoles.PartyRole;

export interface PartyInput {
  role: PartyRole;
  customerId?: string;
  contactId?: string;
  /** For a party with no record of their own: "ABC Warranty, claim 44812". */
  externalName?: string;
  externalReference?: string;
  sharePercent?: string;
  shareAmount?: string;
  notes?: string;
}

/**
 * Set the whole cast at once.
 *
 * Replaced rather than merged, because the question "who is involved in this
 * job" has one answer and a merge leaves whoever used to be the approver
 * still holding the role.
 */
export async function setParties(
  ctx: ServiceContext,
  input: { jobId: string; parties: PartyInput[] },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
      .where(and(eq(schema.job.id, input.jobId), isNull(schema.job.deletedAt))).limit(1);
    if (!job) throw new NotFoundError("Job");

    for (const party of input.parties) {
      if (!party.customerId && !party.contactId && !party.externalName?.trim()) {
        /**
         * A party with nothing in it is a role nobody holds, which reads on
         * the screen as somebody being responsible and is worse than the
         * role being absent.
         */
        throw new ConflictError(`The ${party.role.replace(/_/g, " ")} needs a name or a record.`);
      }
    }

    const billTo = input.parties.filter((p) => p.role === "bill_to");
    if (billTo.length > 1) {
      // Two bill-to parties is two invoices somebody has to decide between,
      // and a split is a share on each rather than two of the role.
      throw new ConflictError("A job is billed to one party. Use shares to split it.");
    }

    const before = await tx.select().from(schema.jobParty)
      .where(eq(schema.jobParty.jobId, input.jobId));
    await tx.delete(schema.jobParty).where(eq(schema.jobParty.jobId, input.jobId));

    const rows = input.parties.length === 0 ? [] : await tx.insert(schema.jobParty)
      .values(input.parties.map((party) => ({
        organizationId: ctx.actor.organizationId,
        jobId: input.jobId,
        role: party.role,
        customerId: party.customerId ?? null,
        contactId: party.contactId ?? null,
        externalName: party.externalName ?? null,
        externalReference: party.externalReference ?? null,
        sharePercent: party.sharePercent ?? null,
        shareAmount: party.shareAmount ?? null,
        notes: party.notes ?? null,
      })))
      .returning();

    await audit(tx, ctx, "job.parties_set", "job", input.jobId, before, rows);
    return rows;
  });
}

export async function parties(ctx: ServiceContext, input: { jobId: string }) {
  return guardedRead(ctx, "job:read", async (tx) =>
    tx.select({
      party: schema.jobParty,
      customerName: schema.customer.name,
    })
      .from(schema.jobParty)
      .leftJoin(schema.customer, eq(schema.customer.id, schema.jobParty.customerId))
      .where(eq(schema.jobParty.jobId, input.jobId)));
}

/**
 * Who the invoice goes to, inside a caller's transaction.
 *
 * Null when nobody said, which is the residential case and means the job's
 * own customer. Returning the job's customer here instead would make "nobody
 * decided" and "they decided it is the customer" the same answer, and only
 * one of those should refuse an invoice addressed elsewhere.
 */
export async function billToFor(tx: Database, jobId: string): Promise<{
  customerId: string | null; externalName: string | null;
} | null> {
  const [row] = await tx.select({
    customerId: schema.jobParty.customerId,
    externalName: schema.jobParty.externalName,
  })
    .from(schema.jobParty)
    .where(and(eq(schema.jobParty.jobId, jobId), eq(schema.jobParty.role, "bill_to")))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// The ceiling
// ---------------------------------------------------------------------------

export interface AuthorizationInput {
  jobId: string;
  /** Null is authorised with no stated limit, which is a real answer. */
  amount?: string | null;
  grantedByPartyId?: string;
  grantedByName?: string;
  externalReference?: string;
  expiresAt?: Date;
  scopeNotes?: string;
}

/**
 * Record what a client authorised.
 *
 * One live authorisation per job. A supplement raising the ceiling supersedes
 * the old one rather than sitting beside it, because two live ceilings is two
 * answers to "how much may we bill" and every reader would have to pick.
 */
export async function authorize(ctx: ServiceContext, input: AuthorizationInput) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const [job] = await tx.select({ id: schema.job.id }).from(schema.job)
      .where(and(eq(schema.job.id, input.jobId), isNull(schema.job.deletedAt))).limit(1);
    if (!job) throw new NotFoundError("Job");

    const [current] = await tx.select().from(schema.authorization)
      .where(and(
        eq(schema.authorization.jobId, input.jobId),
        sql`${schema.authorization.state} in ('requested', 'granted', 'exceeded')`,
      ))
      .orderBy(desc(schema.authorization.createdAt))
      .limit(1);

    if (current) {
      await tx.update(schema.authorization)
        .set({ state: "superseded", updatedAt: new Date() })
        .where(eq(schema.authorization.id, current.id));
    }

    const [row] = await tx.insert(schema.authorization).values({
      organizationId: ctx.actor.organizationId,
      jobId: input.jobId,
      state: "granted",
      amount: input.amount ? m.toString(usd(input.amount)) : null,
      /**
       * A supplement carries the old consumption forward. Resetting it would
       * let a client who authorised five hundred, then another five hundred
       * after three hundred was billed, be invoiced thirteen hundred.
       */
      consumedAmount: current?.consumedAmount ?? "0",
      grantedByPartyId: input.grantedByPartyId ?? null,
      grantedByName: input.grantedByName ?? null,
      externalReference: input.externalReference ?? null,
      grantedAt: new Date(),
      expiresAt: input.expiresAt ?? null,
      supersedesId: current?.id ?? null,
      scopeNotes: input.scopeNotes ?? null,
    }).returning();

    await audit(tx, ctx, "authorization.granted", "job", input.jobId, current ?? null, row);
    return row!;
  });
}

export async function deny(ctx: ServiceContext, input: { jobId: string; reason: string }) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const [current] = await tx.select().from(schema.authorization)
      .where(and(
        eq(schema.authorization.jobId, input.jobId),
        sql`${schema.authorization.state} in ('requested', 'granted')`,
      ))
      .orderBy(desc(schema.authorization.createdAt))
      .limit(1);
    if (!current) throw new NotFoundError("Authorization");

    const [row] = await tx.update(schema.authorization)
      .set({ state: "denied", scopeNotes: input.reason, updatedAt: new Date() })
      .where(eq(schema.authorization.id, current.id))
      .returning();

    await audit(tx, ctx, "authorization.denied", "job", input.jobId, current, row);
    return row!;
  });
}

/** The live authorisation on a job, as the shape core's decision expects. */
export async function ceilingFor(
  tx: Database, jobId: string,
): Promise<{ id: string; grantedByName: string | null; terms: authz.Authorization } | null> {
  const [row] = await tx.select().from(schema.authorization)
    .where(and(
      eq(schema.authorization.jobId, jobId),
      sql`${schema.authorization.state} not in ('superseded')`,
    ))
    .orderBy(desc(schema.authorization.createdAt))
    .limit(1);
  if (!row) return null;

  return {
    id: row.id,
    /**
     * Carried out separately from the terms, because it decides nothing. The
     * arithmetic in core is about amounts and dates; who said yes is a fact
     * the screen needs to show back and nothing needs to compute with.
     */
    grantedByName: row.grantedByName,
    terms: {
      state: row.state,
      amount: row.amount ? usd(row.amount) : null,
      consumed: usd(row.consumedAmount),
      expiresAt: row.expiresAt,
      externalReference: row.externalReference,
    },
  };
}

/**
 * Bill an amount against the ceiling, inside a caller's transaction.
 *
 * The consumption is an increment rather than a write of a computed total,
 * so two invoices raised at the same moment cannot both read three hundred
 * and both write six hundred.
 */
export async function consume(
  tx: Database,
  input: { authorizationId: string; terms: authz.Authorization; amount: m.Money },
): Promise<void> {
  await tx.update(schema.authorization).set({
    consumedAmount: sql`${schema.authorization.consumedAmount} + ${m.toString(input.amount)}::numeric`,
    state: authz.stateAfter(input.terms, input.amount),
    updatedAt: new Date(),
  }).where(eq(schema.authorization.id, input.authorizationId));
}

export async function authorizationFor(ctx: ServiceContext, input: { jobId: string }) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const found = await ceilingFor(tx, input.jobId);
    if (!found) return null;
    const left = authz.remaining(found.terms);
    return {
      id: found.id,
      /**
       * Read back because the screen puts it in an editable box. Leaving it
       * out did not lose the name on the way in: it lost it on the way out.
       * Raising the ceiling supersedes rather than updates, so a form that
       * could not show who granted the last one saved a blank over them
       * every time somebody touched the amount.
       */
      grantedByName: found.grantedByName,
      state: found.terms.state,
      amount: found.terms.amount ? m.toString(found.terms.amount) : null,
      consumed: m.toString(found.terms.consumed),
      remaining: left ? m.toString(left) : null,
      expiresAt: found.terms.expiresAt ?? null,
      externalReference: found.terms.externalReference ?? null,
    };
  });
}

/**
 * What is authorised, across the book, and how much of it is used up.
 *
 * The report a commercial shop opens on a Monday: which jobs are about to run
 * out of ceiling, which have none, and which already went over.
 */
export async function ceilings(ctx: ServiceContext) {
  return guardedRead(ctx, "job:read", async (tx) =>
    tx.select({
      authorization: schema.authorization,
      jobNumber: schema.job.number,
      summary: schema.job.summary,
      customerName: schema.customer.name,
    })
      .from(schema.authorization)
      .innerJoin(schema.job, eq(schema.job.id, schema.authorization.jobId))
      .innerJoin(schema.customer, eq(schema.customer.id, schema.job.customerId))
      .where(sql`${schema.authorization.state} in ('requested', 'granted', 'exceeded')`)
      .orderBy(desc(schema.authorization.createdAt)));
}
