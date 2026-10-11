import { and, asc, eq } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import {
  audit, guardedRead, guardedWrite, NotFoundError, type ServiceContext,
} from "./context";
import { connectionFor, READ_BUDGET_EXHAUSTED, resolveProvider } from "./accounting";
import type { AccountingProvider } from "../accounting/provider";

/**
 * M14. WHICH CLASS OR TRACKING OPTION EACH BRANCH IS IN THE BOOKS
 *
 * Every posting here carries the branch of the job or invoice it came from,
 * and a journal line carries its own. The books can be read by branch only
 * if they are told, and each has its own word for it: QuickBooks a class,
 * Xero an option of a tracking category. This is the table that says which,
 * chosen by a person from the list the books themselves hold.
 *
 * Optional. A branch nobody has mapped sends nothing extra, as before, and a
 * document in it is not held back for want of a mapping, unlike an account:
 * a missing account means money with nowhere to land, and a missing class
 * means a report over there that cannot be cut by that branch, which is what
 * the company had already.
 *
 * Nothing is matched by name. A class called "Round Rock" and a branch called
 * "Round Rock" are probably the same thing, and "probably" is a mapping
 * nobody chose.
 */

export interface BranchMappingInput {
  businessUnitId: string;
  externalId: string;
  externalName: string;
  /** The Xero tracking category the option is in. Leave out for a QuickBooks class. */
  groupId?: string | undefined;
  groupName?: string | undefined;
}

export interface BranchMappingView {
  businessUnitId: string;
  branchName: string;
  externalId: string;
  externalName: string;
  groupId: string | null;
  groupName: string | null;
}

/** Every branch that is mapped, with its own name beside what the books call it. */
export async function listBranchMappings(ctx: ServiceContext): Promise<BranchMappingView[]> {
  return guardedRead(ctx, "accounting:sync", async (tx) => {
    const connection = await connectionFor(tx, ctx.actor.organizationId);
    return tx.select({
      businessUnitId: schema.accountingBranchMapping.businessUnitId,
      branchName: schema.businessUnit.name,
      externalId: schema.accountingBranchMapping.externalId,
      externalName: schema.accountingBranchMapping.externalName,
      groupId: schema.accountingBranchMapping.externalGroupId,
      groupName: schema.accountingBranchMapping.externalGroupName,
    }).from(schema.accountingBranchMapping)
      .innerJoin(schema.businessUnit, eq(schema.businessUnit.id, schema.accountingBranchMapping.businessUnitId))
      .where(eq(schema.accountingBranchMapping.connectionId, connection.id))
      .orderBy(asc(schema.businessUnit.name));
  });
}

/**
 * Point one branch at a class or tracking option, replacing what it pointed
 * at. Audited, because it changes where every document sent from then on is
 * reported over there.
 *
 * A retired branch can be mapped: its old postings still carry it, and a
 * journal reversed today puts the reversal in it. Another company's branch
 * cannot, and reads as not found, because a foreign key is not row level
 * security and the id is checked against this company's own.
 */
export async function setBranchMapping(ctx: ServiceContext, input: BranchMappingInput): Promise<BranchMappingView> {
  return guardedWrite(ctx, "accounting:sync", async (tx) => {
    const connection = await connectionFor(tx, ctx.actor.organizationId);
    const [unit] = await tx.select({ id: schema.businessUnit.id, name: schema.businessUnit.name })
      .from(schema.businessUnit).where(and(
        eq(schema.businessUnit.id, input.businessUnitId),
        eq(schema.businessUnit.organizationId, ctx.actor.organizationId),
      )).limit(1);
    if (!unit) throw new NotFoundError("Branch");

    const [before] = await tx.select().from(schema.accountingBranchMapping).where(and(
      eq(schema.accountingBranchMapping.connectionId, connection.id),
      eq(schema.accountingBranchMapping.businessUnitId, unit.id),
    )).limit(1);

    const chosen = {
      externalId: input.externalId.trim(),
      externalName: input.externalName.trim(),
      externalGroupId: input.groupId?.trim() || null,
      externalGroupName: input.groupName?.trim() || null,
    };
    const [row] = await tx.insert(schema.accountingBranchMapping).values({
      organizationId: ctx.actor.organizationId,
      connectionId: connection.id,
      businessUnitId: unit.id,
      ...chosen,
    }).onConflictDoUpdate({
      target: [schema.accountingBranchMapping.connectionId, schema.accountingBranchMapping.businessUnitId],
      set: { ...chosen, updatedAt: new Date() },
    }).returning();

    await audit(tx, ctx, "accounting.branch_mapped", "accounting_branch_mapping", row!.id, before ?? null, row!);
    return {
      businessUnitId: unit.id,
      branchName: unit.name,
      externalId: row!.externalId,
      externalName: row!.externalName,
      groupId: row!.externalGroupId,
      groupName: row!.externalGroupName,
    };
  });
}

/**
 * Stop sending a branch. Documents sent before keep the class they went with;
 * from the next pass on, the branch's documents go without one.
 */
export async function removeBranchMapping(ctx: ServiceContext, input: { businessUnitId: string }) {
  return guardedWrite(ctx, "accounting:sync", async (tx) => {
    const connection = await connectionFor(tx, ctx.actor.organizationId);
    const [row] = await tx.delete(schema.accountingBranchMapping).where(and(
      eq(schema.accountingBranchMapping.connectionId, connection.id),
      eq(schema.accountingBranchMapping.businessUnitId, input.businessUnitId),
    )).returning();
    if (!row) throw new NotFoundError("Branch mapping");
    await audit(tx, ctx, "accounting.branch_unmapped", "accounting_branch_mapping", row.id, row, null);
    return { businessUnitId: input.businessUnitId, removed: true as const };
  });
}

/**
 * What the books offer to map a branch onto. A metered read on QuickBooks,
 * made outside the permission's transaction for the reason
 * `listRemoteAccounts` gives, and only when a person asks. A book with no
 * such list answers with none and says so.
 */
export async function listRemoteBranchOptions(ctx: ServiceContext, deps: { provider: AccountingProvider }) {
  await guardedRead(ctx, "accounting:sync", (tx) => connectionFor(tx, ctx.actor.organizationId));
  const read = deps.provider.branchOptions?.bind(deps.provider);
  if (!read) {
    return {
      options: [], blocked: null, retryAfterSeconds: null,
      error: `${deps.provider.name} has no classes or tracking categories this product can send a branch as.`,
    };
  }
  const result = await read();
  if (!result.ok) {
    return {
      options: [],
      blocked: result.budgetExhausted ? READ_BUDGET_EXHAUSTED : null,
      error: result.budgetExhausted ? null : `${result.code}: ${result.message}`,
      retryAfterSeconds: result.retryAfterSeconds,
    };
  }
  return { options: result.value, blocked: null, error: null, retryAfterSeconds: null };
}

export const handlers = {
  listAccountingBranchOptions: async (ctx: ServiceContext) => {
    const { provider } = await resolveProvider(ctx);
    return listRemoteBranchOptions(ctx, { provider });
  },
  listAccountingBranchMappings: async (ctx: ServiceContext) => ({ mappings: await listBranchMappings(ctx) }),
  setAccountingBranchMapping: (ctx: ServiceContext, input: BranchMappingInput) => setBranchMapping(ctx, input),
  removeAccountingBranchMapping: (ctx: ServiceContext, input: { businessUnitId: string }) => removeBranchMapping(ctx, input),
} as const;
