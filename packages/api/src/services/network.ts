import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";

/**
 * A ROLL UP ACROSS COMPANIES, AND THE CONSENT THAT MAKES ONE LEGITIMATE
 *
 * `network` and `network_grant` have been in this schema since the first
 * migration with no reader and no writer anywhere. They describe a franchise or
 * a holding group: several organizations, each a real tenant with its own
 * customers, under one operator entitled to a consolidated view.
 *
 * Row level security is FORCED on every table carrying `organization_id`, which
 * is the property this whole product rests on. A roll up is by definition a read
 * across that boundary, so it happens in exactly one place, a security definer
 * function in `sql/after.sql`, and this file is what calls it.
 *
 * THE THREE RULES, and they are the feature rather than its implementation:
 *
 *   THE MEMBER GRANTS, PER AGGREGATE. Not the operator, and not per network. A
 *   franchisor entitled to revenue under the franchise agreement is not
 *   therefore entitled to the general ledger, and the member decides which is
 *   which. The grant is written by the member's own session, so there is no
 *   shape of call in which an operator grants on a member's behalf.
 *
 *   AGGREGATES ONLY, NEVER ROWS. The roll up returns (organization, period,
 *   metric, value). There is no path through it to a customer name, an address,
 *   a job description or an invoice number, and that is a property of the SQL
 *   function body rather than of a convention: every branch of it is a GROUP BY.
 *
 *   A REVOCATION TAKES EFFECT IMMEDIATELY. Checked on every call, cached
 *   nowhere.
 *
 * WHO PUTS A COMPANY IN A NETWORK: the operator API, not this. An organization
 * must not be able to put another into its network, because joining is what
 * creates the relationship a member is then asked to consent to. See
 * `services/operator.ts`.
 */

/**
 * The aggregates a member can share. A closed set, named in the schema comment
 * on `network_grant` and served by `app.network_rollup`.
 *
 * Each one is a different answer to "what is this operator entitled to", and
 * they are deliberately coarse. There is no `customer_list` and there will not
 * be one: a franchisor who wants a franchisee's customers is asking for the
 * asset the franchisee owns, and no consent dialogue in a piece of software
 * makes that a feature.
 */
export const AGGREGATES = [
  /** Jobs completed per month. The cheapest signal that a member is working. */
  "job_counts",
  /** Invoiced and collected per month. Whether the work stopped or the money did. */
  "revenue_summary",
  /** The above plus invoice counts, so an average ticket can be worked out. */
  "kpi_scorecard",
  /** Ledger totals by account CLASS, never by account code. */
  "gl_summary",
] as const;

export type Aggregate = (typeof AGGREGATES)[number];

const isAggregate = (value: string): value is Aggregate =>
  (AGGREGATES as readonly string[]).includes(value);

/**
 * What each one means, in the member's words rather than ours.
 *
 * On the screen where somebody ticks a box that lets another company see their
 * numbers, the label is the whole decision. "gl_summary" is not a label.
 */
export const DESCRIPTIONS: Record<Aggregate, string> = {
  job_counts: "How many jobs you completed each month. No customers, no addresses, no amounts.",
  revenue_summary:
    "What you invoiced and what you collected each month, as totals. No invoices, no customers.",
  kpi_scorecard:
    "The revenue summary plus how many invoices you raised, so an average ticket can be worked "
    + "out. Still totals only.",
  gl_summary:
    "Your ledger totals by account class each month: revenue, expense, asset, liability, equity. "
    + "Never a single account and never a transaction.",
};

/* ----------------------------------------------------- the member's own view */

export interface MembershipView {
  networkId: string | null;
  networkName: string | null;
  networkKind: string | null;
  memberCode: string | null;
  /** True when this organization is the one operating the network. */
  isOperator: boolean;
  sharing: { aggregate: Aggregate; description: string; grantedAt: string | null }[];
  /** The ones not shared, so the screen is a list of choices rather than of facts. */
  notSharing: { aggregate: Aggregate; description: string }[];
}

/**
 * What network this company is in, and what it has agreed to share.
 *
 * Reads `network` through row level security rather than through the definer
 * function, deliberately: the policy on that table already says a session sees
 * the network its own organization belongs to, and going round it here would
 * mean two answers to the same question.
 */
export function membership(ctx: ServiceContext) {
  return guardedRead(ctx, "settings:read", async (tx): Promise<MembershipView> => {
    const [org] = await tx.select({
      networkId: schema.organization.networkId,
      memberCode: schema.organization.networkMemberCode,
    })
      .from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId))
      .limit(1);

    if (!org?.networkId) {
      return {
        networkId: null, networkName: null, networkKind: null, memberCode: null,
        isOperator: false, sharing: [],
        notSharing: AGGREGATES.map((aggregate) => ({
          aggregate, description: DESCRIPTIONS[aggregate],
        })),
      };
    }

    const [network] = await tx.select({
      id: schema.network.id,
      name: schema.network.name,
      kind: schema.network.kind,
      operatorOrganizationId: schema.network.operatorOrganizationId,
    })
      .from(schema.network)
      .where(eq(schema.network.id, org.networkId))
      .limit(1);

    const grants = await tx.select({
      aggregate: schema.networkGrant.aggregate,
      grantedAt: schema.networkGrant.grantedAt,
    })
      .from(schema.networkGrant)
      .where(and(
        eq(schema.networkGrant.organizationId, ctx.actor.organizationId),
        eq(schema.networkGrant.networkId, org.networkId),
        isNull(schema.networkGrant.revokedAt),
      ));

    const live = new Map(grants
      .filter((row) => isAggregate(row.aggregate))
      .map((row) => [row.aggregate as Aggregate, row.grantedAt]));

    return {
      networkId: org.networkId,
      networkName: network?.name ?? null,
      networkKind: network?.kind ?? null,
      memberCode: org.memberCode,
      isOperator: network?.operatorOrganizationId === ctx.actor.organizationId,
      sharing: AGGREGATES.filter((aggregate) => live.has(aggregate)).map((aggregate) => ({
        aggregate,
        description: DESCRIPTIONS[aggregate],
        grantedAt: live.get(aggregate)?.toISOString() ?? null,
      })),
      notSharing: AGGREGATES.filter((aggregate) => !live.has(aggregate)).map((aggregate) => ({
        aggregate, description: DESCRIPTIONS[aggregate],
      })),
    };
  });
}

async function networkOf(tx: Database, ctx: ServiceContext): Promise<string> {
  const [org] = await tx.select({ networkId: schema.organization.networkId })
    .from(schema.organization)
    .where(eq(schema.organization.id, ctx.actor.organizationId))
    .limit(1);
  if (!org?.networkId) {
    throw new ConflictError(
      "This company is not in a network, so there is nobody to share with. Whoever runs this "
      + "deployment adds a company to a network; it is not something a company does to itself, "
      + "because joining is what creates the relationship you would then be consenting to.",
    );
  }
  return org.networkId;
}

/**
 * Start sharing one aggregate with the network's operator.
 *
 * `settings:write`, which is the owner and the administrator. Letting a wider
 * role turn this on would mean the decision to show another company your
 * revenue could be taken by somebody who does not sign the franchise agreement.
 *
 * Re-granting a live grant is a no-op rather than an error, and that is the
 * right shape for a checkbox: a screen that double-posts must not produce two
 * rows, and the unique index on (network, organization, aggregate) means the
 * second insert would fail rather than duplicate anyway.
 */
export function share(ctx: ServiceContext, input: { aggregate: string }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const networkId = await networkOf(tx, ctx);
    if (!isAggregate(input.aggregate)) {
      throw new ConflictError(
        `"${input.aggregate}" is not something that can be shared. One of: ${AGGREGATES.join(", ")}.`,
      );
    }

    /**
     * `onConflictDoUpdate` on the unique index rather than an insert, because a
     * revoked grant and a never-granted one are the same row: the index is on
     * (network, organization, aggregate) with no predicate, so re-granting after
     * a revocation has to clear `revoked_at` on the row that is already there.
     */
    const [row] = await tx.insert(schema.networkGrant).values({
      networkId,
      organizationId: ctx.actor.organizationId,
      aggregate: input.aggregate,
      grantedByUserId: ctx.actor.userId === NIL ? null : ctx.actor.userId,
      grantedAt: new Date(),
      revokedAt: null,
    }).onConflictDoUpdate({
      target: [
        schema.networkGrant.networkId,
        schema.networkGrant.organizationId,
        schema.networkGrant.aggregate,
      ],
      set: {
        grantedAt: new Date(),
        grantedByUserId: ctx.actor.userId === NIL ? null : ctx.actor.userId,
        revokedAt: null,
        updatedAt: new Date(),
      },
    }).returning();

    await audit(tx, ctx, "network.share", "network_grant", row!.id, null, row);
    return membershipWithin(tx, ctx);
  });
}

const NIL = "00000000-0000-0000-0000-000000000000";

export function stopSharing(ctx: ServiceContext, input: { aggregate: string }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const networkId = await networkOf(tx, ctx);
    if (!isAggregate(input.aggregate)) {
      throw new ConflictError(
        `"${input.aggregate}" is not something that can be shared. One of: ${AGGREGATES.join(", ")}.`,
      );
    }

    /**
     * REVOKED, NOT DELETED. "They used to see our revenue and stopped letting
     * them in March" is a fact a member may need to prove, and a deleted row
     * proves nothing. It is also what makes re-granting an update rather than an
     * insert.
     */
    const updated = await tx.update(schema.networkGrant)
      .set({ revokedAt: new Date(), updatedAt: new Date() })
      .where(and(
        eq(schema.networkGrant.organizationId, ctx.actor.organizationId),
        eq(schema.networkGrant.networkId, networkId),
        eq(schema.networkGrant.aggregate, input.aggregate),
        isNull(schema.networkGrant.revokedAt),
      ))
      .returning();

    if (updated[0]) {
      await audit(tx, ctx, "network.stop_sharing", "network_grant", updated[0].id, updated[0], null);
    }
    return membershipWithin(tx, ctx);
  });
}

/** The view, inside the caller's transaction, so a write reads back its own change. */
async function membershipWithin(tx: Database, ctx: ServiceContext): Promise<MembershipView> {
  const [org] = await tx.select({
    networkId: schema.organization.networkId,
    memberCode: schema.organization.networkMemberCode,
  })
    .from(schema.organization)
    .where(eq(schema.organization.id, ctx.actor.organizationId))
    .limit(1);

  const networkId = org?.networkId ?? null;
  if (!networkId) {
    return {
      networkId: null, networkName: null, networkKind: null, memberCode: null,
      isOperator: false, sharing: [],
      notSharing: AGGREGATES.map((aggregate) => ({
        aggregate, description: DESCRIPTIONS[aggregate],
      })),
    };
  }

  const [network] = await tx.select({
    name: schema.network.name,
    kind: schema.network.kind,
    operatorOrganizationId: schema.network.operatorOrganizationId,
  })
    .from(schema.network)
    .where(eq(schema.network.id, networkId))
    .limit(1);

  const grants = await tx.select({
    aggregate: schema.networkGrant.aggregate,
    grantedAt: schema.networkGrant.grantedAt,
  })
    .from(schema.networkGrant)
    .where(and(
      eq(schema.networkGrant.organizationId, ctx.actor.organizationId),
      eq(schema.networkGrant.networkId, networkId),
      isNull(schema.networkGrant.revokedAt),
    ));

  const live = new Map(grants
    .filter((row) => isAggregate(row.aggregate))
    .map((row) => [row.aggregate as Aggregate, row.grantedAt]));

  return {
    networkId,
    networkName: network?.name ?? null,
    networkKind: network?.kind ?? null,
    memberCode: org?.memberCode ?? null,
    isOperator: network?.operatorOrganizationId === ctx.actor.organizationId,
    sharing: AGGREGATES.filter((a) => live.has(a)).map((aggregate) => ({
      aggregate,
      description: DESCRIPTIONS[aggregate],
      grantedAt: live.get(aggregate)?.toISOString() ?? null,
    })),
    notSharing: AGGREGATES.filter((a) => !live.has(a)).map((aggregate) => ({
      aggregate, description: DESCRIPTIONS[aggregate],
    })),
  };
}

/* ------------------------------------------------------ the operator's view */

/**
 * Which network this organization operates, or a refusal.
 *
 * Read through row level security, so an organization that is merely a member
 * of the network gets nothing: the policy lets it read the network row, and the
 * operator check below is what separates the franchisor from the franchisee.
 * That separation is the first thing anybody would try to get round.
 */
async function operatedNetwork(tx: Database, ctx: ServiceContext): Promise<string> {
  const [org] = await tx.select({ networkId: schema.organization.networkId })
    .from(schema.organization)
    .where(eq(schema.organization.id, ctx.actor.organizationId))
    .limit(1);
  if (!org?.networkId) throw new NotFoundError("Network");

  const [network] = await tx.select({
    id: schema.network.id,
    operatorOrganizationId: schema.network.operatorOrganizationId,
  })
    .from(schema.network)
    .where(eq(schema.network.id, org.networkId))
    .limit(1);

  if (!network || network.operatorOrganizationId !== ctx.actor.organizationId) {
    /**
     * NOT FOUND RATHER THAN FORBIDDEN. A franchisee asking for the roll up of
     * the network it belongs to is told there is nothing there, rather than told
     * there is something it may not have: the second answer confirms the network
     * is readable by somebody and invites the next attempt.
     */
    throw new NotFoundError("Network");
  }
  return network.id;
}

export interface MemberRow {
  organizationId: string;
  name: string;
  memberCode: string | null;
  suspended: boolean;
  /** What this member has agreed to share. Empty is the common and useful case. */
  aggregates: Aggregate[];
}

/**
 * The roster, including the members sharing nothing.
 *
 * SHOWING THE SILENT ONES IS THE POINT. "We have six franchisees and two have
 * not turned sharing on" is what an operator needs to see, and a roster that
 * listed only the sharing ones would make the missing numbers look like zeros,
 * which is the difference between chasing a franchisee and writing off a market.
 */
export function members(ctx: ServiceContext) {
  return guardedRead(ctx, "report:read", async (tx) => {
    const networkId = await operatedNetwork(tx, ctx);
    const rows = await tx.execute<{
      organization_id: string; name: string; member_code: string | null;
      suspended: boolean; aggregates: string[];
    }>(sql`select * from app.network_members(${networkId})`);

    return {
      networkId,
      data: rows.map((row): MemberRow => ({
        organizationId: row.organization_id,
        name: row.name,
        memberCode: row.member_code,
        suspended: row.suspended,
        aggregates: (row.aggregates ?? []).filter(isAggregate),
      })),
    };
  });
}

export interface RollupRow {
  organizationId: string;
  memberCode: string | null;
  period: string;
  metric: string;
  value: string;
}

/**
 * The consolidated numbers, from the members who agreed to share them.
 *
 * `report:read` rather than a permission of its own, because this is a report
 * and the role that reads reports is the role that should read this one. What
 * narrows it is not the permission, it is being the operator of the network.
 *
 * A MEMBER WHO HAS NOT GRANTED CONTRIBUTES NOTHING, SILENTLY, and the roster
 * above is what makes that visible. Raising an error instead would let an
 * operator lean on a member by making the whole report fail until they consent.
 *
 * Values come back as strings. These are money, and a float that has been
 * through a JSON parser is not money.
 */
export function rollup(ctx: ServiceContext, input: {
  aggregate: string; from: string; to: string;
}) {
  return guardedRead(ctx, "report:read", async (tx) => {
    const networkId = await operatedNetwork(tx, ctx);
    if (!isAggregate(input.aggregate)) {
      throw new ConflictError(
        `"${input.aggregate}" is not an aggregate. One of: ${AGGREGATES.join(", ")}.`,
      );
    }
    if (input.to < input.from) {
      throw new ConflictError("The end of the window is before its start.");
    }

    const rows = await tx.execute<{
      organization_id: string; member_code: string | null;
      period: string; metric: string; value: string;
    }>(sql`
      select * from app.network_rollup(
        ${networkId}, ${input.aggregate}, ${input.from}::date, ${input.to}::date
      )
      order by period, member_code nulls last, metric
    `);

    /**
     * Who is missing from the answer, named. The operator can see from the
     * roster that a member shares nothing, and seeing it on the report itself is
     * what stops a consolidated figure being read as the whole network.
     */
    const contributing = new Set(rows.map((row) => row.organization_id));
    const roster = await tx.execute<{
      organization_id: string; name: string; aggregates: string[];
    }>(sql`select * from app.network_members(${networkId})`);
    const silent = roster
      .filter((member) => !contributing.has(member.organization_id))
      .map((member) => ({
        organizationId: member.organization_id,
        name: member.name,
        sharesThis: (member.aggregates ?? []).includes(input.aggregate),
      }));

    return {
      networkId,
      aggregate: input.aggregate,
      from: input.from,
      to: input.to,
      data: rows.map((row): RollupRow => ({
        organizationId: row.organization_id,
        memberCode: row.member_code,
        period: row.period,
        metric: row.metric,
        value: String(row.value),
      })),
      /**
       * `sharesThis` false means they have not consented. True means they have
       * and had no activity in the window, which is a different fact and a
       * different conversation.
       */
      notContributing: silent,
    };
  });
}

export const handlers = {
  getNetworkMembership: (ctx: ServiceContext, _input: Record<string, never>) => {
    void _input;
    return membership(ctx);
  },
  shareWithNetwork: (ctx: ServiceContext, input: { aggregate: string }) => share(ctx, input),
  stopSharingWithNetwork: (ctx: ServiceContext, input: { aggregate: string }) =>
    stopSharing(ctx, input),
  listNetworkMembers: (ctx: ServiceContext, _input: Record<string, never>) => {
    void _input;
    return members(ctx);
  },
  getNetworkRollup: (ctx: ServiceContext, input: {
    aggregate: string; from: string; to: string;
  }) => rollup(ctx, input),
} as const;
