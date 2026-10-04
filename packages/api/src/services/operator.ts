import { asc, eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import { ConflictError, NotFoundError } from "./context";
import { createOrganization, createUser, isUniqueViolation } from "./organizations";
import { applyTradePack } from "./trade-pack";
import { installStarters } from "./workflows";
import * as setupTokens from "./setup-tokens";

/**
 * THE OPERATOR
 *
 * Whoever runs a deployment that holds more than one company: a hosted
 * service, or a firm that runs the software for several contractors it keeps
 * the books for. They need five things no tenant may do, and nothing else:
 * create a company, read its status, count what it has used, suspend it and
 * resume it. docs/self-hosting/operator-api.md is the reader's version.
 *
 * WHAT THIS IS NOT. It is not an administrator who can read a company's
 * customers. Every function here touches the organization row, a count, or
 * the rows that make a new company exist, and none of them returns a single
 * customer, job or invoice. An operator who wants to see inside a company asks
 * to be made a member of it, and the company's own audit log shows that they
 * were.
 *
 * HOW IT CROSSES THE TENANT BOUNDARY, which is the part that matters. The same
 * way the worker does. Each call opens its own transaction and drops to
 * `platform_operator`, a role the request path never holds, which is a member
 * of `authenticated` so every row level security policy applies to it exactly
 * as it applies to a person. The two questions that genuinely span tenants,
 * "which company has this reference" and "does this address already have an
 * account", go through SECURITY DEFINER functions that return an id and a
 * boolean and are executable by this role alone. Everything else happens
 * inside the one company the call named, with the tenant context set to it.
 *
 * Everything is transaction scoped: `set local role`, `set_config(..., true)`.
 * Nothing here sets session state, takes a session level lock or listens, so
 * it is safe behind a transaction pooler where consecutive transactions on
 * one connection belong to different callers.
 */

export const OPERATOR_ROLE = "platform_operator";

/** Named on every audit line an operator call writes. */
export const OPERATOR_AGENT_ID = "operator";

/**
 * The actor for the one service call an operator makes on a company's
 * behalf: seeding the trade pack. It holds exactly the permission that needs
 * and nothing else, and it names the operator so the company's own audit log
 * says who seeded its price book.
 */
export function operatorActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: ["settings:write"],
    agentId: OPERATOR_AGENT_ID,
  };
}

export interface OperatorMeta {
  ip?: string | undefined;
  userAgent?: string | undefined;
}

export type OrganizationStatus = "active" | "suspended";

export interface OrganizationStatusView {
  organizationId: string;
  name: string;
  status: OrganizationStatus;
  createdAt: string;
}

export interface CreatedOrganization {
  organizationId: string;
  ownerUserId: string;
  ownerSetupUrl: string;
  created: boolean;
}

export interface UsageView {
  organizationId: string;
  since: string;
  activeUsers: number;
  technicians: number;
  jobsCreated: number;
  invoicesCreated: number;
  messagesSent: number;
  storageBytes: number;
}

/**
 * One transaction as the operator, inside one company's tenant context, or
 * inside none when `organizationId` is empty: that is the state before a
 * company exists, and a null tenant context matches no rows at all.
 */
async function asOperator<T>(
  db: Database,
  organizationId: string,
  fn: (tx: Database) => Promise<T>,
): Promise<T> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    await enterOperator(tx, organizationId);
    return fn(tx);
  });
}

async function enterOperator(tx: Database, organizationId: string): Promise<void> {
  await tx.execute(sql.raw(`set local role ${OPERATOR_ROLE}`));
  await tx.execute(sql`select set_config('app.organization_id', ${organizationId}, true)`);
  await tx.execute(sql`select set_config('app.user_id', ${SYSTEM_USER_ID}, true)`);
}

/**
 * The audit line, written into the company it is about.
 *
 * Every operator call writes one, reads included. "When did the people who
 * host us last look at our usage, and when did they suspend us" is a question
 * a company is entitled to answer from its own records, and the answer has to
 * be there before anybody thinks to ask.
 */
async function audit(
  tx: Database, organizationId: string, action: string,
  before: unknown, after: unknown, meta: OperatorMeta,
): Promise<void> {
  await tx.insert(schema.auditLog).values({
    organizationId,
    actorUserId: null,
    actorAgentId: OPERATOR_AGENT_ID,
    action,
    entityType: "organization",
    entityId: organizationId,
    before: (before ?? null) as Record<string, unknown> | null,
    after: (after ?? null) as Record<string, unknown> | null,
    ipAddress: meta.ip ?? null,
    userAgent: meta.userAgent ?? null,
  });
}

async function statusRow(tx: Database, organizationId: string) {
  // No organization filter of our own beyond the id asked for: the policy on
  // `organization` already admits only the row the tenant context names.
  const [row] = await tx.select({
    id: schema.organization.id,
    name: schema.organization.name,
    suspendedAt: schema.organization.suspendedAt,
    suspendedReason: schema.organization.suspendedReason,
    createdAt: schema.organization.createdAt,
  }).from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  if (!row) throw new NotFoundError("Organization");
  return row;
}

const view = (row: Awaited<ReturnType<typeof statusRow>>): OrganizationStatusView => ({
  organizationId: row.id,
  name: row.name,
  status: row.suspendedAt ? "suspended" : "active",
  createdAt: row.createdAt.toISOString(),
});

/* ------------------------------------------------------------- creating */

export interface CreateOrganizationInput {
  name: string;
  timezone: string;
  tradePack?: string | undefined;
  externalRef: string;
  owner: { email: string; name: string };
}

/**
 * Create a company, or hand back the one already made for this reference.
 *
 * IDEMPOTENT ON `externalRef`, and it has to be, because the caller is a
 * control plane that will retry. A retry after a lost response must not make
 * a second company with a second owner and a second bill. The reference is
 * looked up first, and a unique index settles the race where two retries
 * both miss the lookup: the loser's transaction rolls back whole and it reads
 * the winner's ids.
 *
 * What a replay does NOT do is compare the body. A retry carries the same
 * body, and a different body under the same reference is the caller's bug;
 * answering it with the existing company is the only safe guess, because the
 * alternative creates one.
 *
 * THE OWNER gets a link to choose a password, never one chosen for them. An
 * address that already has an account keeps it: they become the owner of the
 * new company and their link is the sign in page, because a link that could
 * set the password of an existing account would be a way to take it over.
 * A replay issues a fresh link and retires the old one, since a caller asking
 * again is usually a caller that lost the first.
 *
 * One transaction for the company, its owner, its trade pack and its first
 * audit line. A company with no owner, or with job types and no price book, is
 * a support ticket resolved by hand in the database.
 */
export async function create(
  db: Database,
  input: CreateOrganizationInput,
  options: { baseUrl: string },
  meta: OperatorMeta = {},
  attempt = 0,
): Promise<CreatedOrganization> {
  const existing = await findByRef(db, input.externalRef);
  if (existing) return replay(db, existing, options, meta);

  try {
    return await asOperator(db, "", async (tx) => {
      const [person] = await tx.execute<{ user_id: string; has_password: boolean }>(
        sql`select * from app.operator_user_by_email(${input.owner.email})`,
      );
      const ownerUserId = person?.user_id
        ?? await createUser(tx, { email: input.owner.email, name: input.owner.name });

      const { organizationId } = await createOrganization(tx, {
        name: input.name,
        timezone: input.timezone,
        externalRef: input.externalRef,
        ownerUserId,
      });

      /**
       * The recommended automations a new company starts with switched on,
       * installed by its owner exactly as sign up installs them, so a company
       * made here and one made on the form start the same. Through the service
       * layer like the trade pack below, so the role is put back after it.
       */
      await installStarters({ actor: { userId: ownerUserId, organizationId, roles: ["owner"] }, db: tx });
      await enterOperator(tx, organizationId);

      if (input.tradePack) {
        /**
         * The same call the setup wizard makes, so an operator's company starts
         * with the same price book a self-signed-up one would choose.
         *
         * It runs in a savepoint inside this transaction, through the ordinary
         * service layer, and that layer drops the role to `authenticated` for
         * what it does. `set local` outlives a released savepoint, so the role
         * is put back afterwards: the setup link below needs a function only
         * the operator may call, and the failure if this line went missing is
         * a permission error on a company that has otherwise been created.
         */
        await applyTradePack({ actor: operatorActor(organizationId), db: tx }, input.tradePack);
        await enterOperator(tx, organizationId);
      }

      const ownerSetupUrl = await setupUrl(tx, ownerUserId, options.baseUrl);

      await audit(tx, organizationId, "operator.organization.created", null, {
        name: input.name,
        timezone: input.timezone,
        tradePack: input.tradePack ?? null,
        externalRef: input.externalRef,
        ownerUserId,
        ownerExisted: Boolean(person),
      }, meta);

      return { organizationId, ownerUserId, ownerSetupUrl, created: true };
    });
  } catch (error) {
    /**
     * Two races, both settled by a unique index and both answered by going
     * round once more. Losing on the reference means a retry of this very
     * call won; losing on the owner's address means somebody else created
     * that person a moment ago, and the second time round they are found and
     * reused. Once, not a loop: a third collision is not a race.
     */
    if (attempt === 0
      && (isUniqueViolation(error, "organization_external_ref_idx")
        || isUniqueViolation(error, "user_email_idx"))) {
      return create(db, input, options, meta, 1);
    }
    throw error;
  }
}

async function findByRef(db: Database, externalRef: string): Promise<string | null> {
  return asOperator(db, "", async (tx) => {
    const [row] = await tx.execute<{ id: string | null }>(
      sql`select app.operator_organization_by_ref(${externalRef}) as id`,
    );
    return row?.id ?? null;
  });
}

async function replay(
  db: Database, organizationId: string, options: { baseUrl: string }, meta: OperatorMeta,
): Promise<CreatedOrganization> {
  return asOperator(db, organizationId, async (tx) => {
    /**
     * The FIRST owner, which is the one this call created. A company that has
     * since added a second owner still answers with the person the operator
     * named, so the caller's record of who it set up stays true.
     */
    const [owner] = await tx.select({ userId: schema.membership.userId })
      .from(schema.membership)
      .where(eq(schema.membership.role, "owner"))
      .orderBy(asc(schema.membership.createdAt))
      .limit(1);
    if (!owner) throw new ConflictError("That company exists and has no owner to hand back.");

    const ownerSetupUrl = await setupUrl(tx, owner.userId, options.baseUrl);
    await audit(tx, organizationId, "operator.organization.create_replayed", null, {
      ownerUserId: owner.userId,
    }, meta);

    return { organizationId, ownerUserId: owner.userId, ownerSetupUrl, created: false };
  });
}

/**
 * A first-password link, or the sign in page for somebody who has a password.
 * The SQL decides which, so the two cannot disagree.
 */
async function setupUrl(tx: Database, userId: string, baseUrl: string): Promise<string> {
  return (await setupTokens.issue(tx, userId, baseUrl)) ?? `${baseUrl}/login`;
}

/* ------------------------------------------------------------- status */

export async function get(
  db: Database, organizationId: string, meta: OperatorMeta = {},
): Promise<OrganizationStatusView> {
  return asOperator(db, organizationId, async (tx) => {
    const row = await statusRow(tx, organizationId);
    await audit(tx, organizationId, "operator.organization.read", null, null, meta);
    return view(row);
  });
}

/**
 * Refuse access, change nothing else.
 *
 * Nothing is deleted and nothing is revoked. Sessions, app tokens and portal
 * links stop resolving because the SQL that resolves them checks this column,
 * and they work again the moment it is cleared, so a suspension for a failed
 * card is undone by the card working rather than by every member signing in
 * again and every partner re-issuing a token.
 *
 * Suspending a suspended company keeps the original time and records the new
 * reason, because "since when" is the question that decides what to do next
 * and a second call must not reset it.
 */
export async function suspend(
  db: Database, organizationId: string, reason: string, meta: OperatorMeta = {},
): Promise<OrganizationStatusView> {
  return asOperator(db, organizationId, async (tx) => {
    const before = await statusRow(tx, organizationId);
    const [after] = await tx.update(schema.organization)
      .set({
        suspendedAt: before.suspendedAt ?? new Date(),
        suspendedReason: reason,
        updatedAt: new Date(),
      })
      .where(eq(schema.organization.id, organizationId))
      .returning({
        id: schema.organization.id,
        name: schema.organization.name,
        suspendedAt: schema.organization.suspendedAt,
        suspendedReason: schema.organization.suspendedReason,
        createdAt: schema.organization.createdAt,
      });
    await audit(tx, organizationId, "operator.organization.suspended",
      { suspendedAt: before.suspendedAt, suspendedReason: before.suspendedReason },
      { suspendedAt: after!.suspendedAt, suspendedReason: after!.suspendedReason }, meta);
    return view(after!);
  });
}

export async function resume(
  db: Database, organizationId: string, meta: OperatorMeta = {},
): Promise<OrganizationStatusView> {
  return asOperator(db, organizationId, async (tx) => {
    const before = await statusRow(tx, organizationId);
    const [after] = await tx.update(schema.organization)
      .set({ suspendedAt: null, suspendedReason: null, updatedAt: new Date() })
      .where(eq(schema.organization.id, organizationId))
      .returning({
        id: schema.organization.id,
        name: schema.organization.name,
        suspendedAt: schema.organization.suspendedAt,
        suspendedReason: schema.organization.suspendedReason,
        createdAt: schema.organization.createdAt,
      });
    await audit(tx, organizationId, "operator.organization.resumed",
      { suspendedAt: before.suspendedAt, suspendedReason: before.suspendedReason },
      { suspendedAt: null, suspendedReason: null }, meta);
    return view(after!);
  });
}

/* ------------------------------------------------------------- usage */

/** When `since` is not given. A month, which is what a bill covers. */
export const DEFAULT_USAGE_DAYS = 30;

/**
 * What a company has used since a moment.
 *
 * Counts, never rows, and every one of them read inside the company's own
 * tenant context, so the only organization filter is the policy's. Two of the
 * seven are not flows over the window and say so below, because a number
 * that looks like "since" and is not is how a bill comes out wrong.
 */
export async function usage(
  db: Database, organizationId: string, since: Date, meta: OperatorMeta = {},
): Promise<UsageView> {
  return asOperator(db, organizationId, async (tx) => {
    await statusRow(tx, organizationId);
    const at = since.toISOString();

    const [counts] = await tx.execute<{
      active_users: number;
      technicians: number;
      jobs_created: number;
      invoices_created: number;
      messages_sent: number;
      storage_bytes: string | number;
    }>(sql`
      select
        -- People who held a live session at any point in the window. Sessions
        -- are readable by their own user only, so this is the one count that
        -- goes through a door.
        app.operator_active_users(${organizationId}::uuid, ${at}::timestamptz) as active_users,
        -- A HEADCOUNT, not a flow: the technicians on the books right now.
        -- "Technicians since last month" is not a number anybody bills on.
        (select count(*)::int from public.technician where active) as technicians,
        (select count(*)::int from public.job where created_at >= ${at}::timestamptz) as jobs_created,
        (select count(*)::int from public.invoice where created_at >= ${at}::timestamptz) as invoices_created,
        -- Handed to a carrier or a mail provider in the window, text and email
        -- alike, since both cost the operator money. Queued and never sent is
        -- not sent.
        (select count(*)::int from public.message
          where direction = 'outbound' and sent_at >= ${at}::timestamptz) as messages_sent,
        -- ALSO NOT A FLOW: the bytes held right now, in the database. Uploads
        -- and brand assets are the two places this product stores bytes of
        -- its own. Anything a deployment keeps in object storage is that
        -- store's to count, and is not visible from here.
        (select coalesce(sum(size_bytes), 0) from public.stored_file)
          + (select coalesce(sum(size_bytes), 0) from public.brand_asset) as storage_bytes
    `);

    const result: UsageView = {
      organizationId,
      since: at,
      activeUsers: Number(counts?.active_users ?? 0),
      technicians: Number(counts?.technicians ?? 0),
      jobsCreated: Number(counts?.jobs_created ?? 0),
      invoicesCreated: Number(counts?.invoices_created ?? 0),
      messagesSent: Number(counts?.messages_sent ?? 0),
      storageBytes: Number(counts?.storage_bytes ?? 0),
    };

    await audit(tx, organizationId, "operator.usage.read", null, { since: at }, meta);
    return result;
  });
}

/* ---------------------------------------------------------------- networks */

/**
 * A FRANCHISE OR A HOLDING GROUP, WHICH IS A DEPLOYMENT LEVEL FACT
 *
 * `network` and `network_grant` have been in this schema since the first
 * migration with no reader and no writer anywhere. They describe several
 * organizations, each a real tenant with its own customers, under one operator
 * entitled to a roll up: a franchisor with thirty franchisees, a holding group
 * with six acquired brands, a firm keeping the books for a dozen contractors.
 *
 * MEMBERSHIP IS SET HERE AND NOT IN THE PRODUCT, and that is the important
 * decision. An organization must not be able to put another organization into
 * its network: joining is harmless on its own, because nothing is shared until
 * the member grants it, but a franchisor who can add companies to a network
 * can create the thing the member is then asked to consent to, and the consent
 * dialogue would be about a relationship the member never agreed to. Whoever
 * runs the deployment knows which companies are franchisees of which
 * franchisor, because they set them up.
 *
 * What stays inside the product, under the member's own permissions: granting
 * and revoking each aggregate. See `services/network.ts`.
 */

/**
 * Exactly the `network_kind` enum, and no more.
 *
 * A first draft of this list carried `buying_group` and `referral`, neither of
 * which is in the enum, so either would have been accepted by the API and
 * refused by Postgres as an invalid input value for the type. A list of strings
 * that has to agree with a database enum, with nothing making them agree, is
 * how that happens.
 */
export const NETWORK_KINDS = ["franchise", "holding", "cooperative"] as const;
export type NetworkKind = (typeof NETWORK_KINDS)[number];

export interface NetworkInput {
  name: string;
  slug: string;
  kind?: NetworkKind | undefined;
  /**
   * The organization that operates the network, when one does. A buying group
   * with no operating company has none, and nobody can read a roll up of it.
   */
  operatorOrganizationId?: string | null | undefined;
}

export interface NetworkView {
  id: string;
  kind: string;
  name: string;
  slug: string;
  operatorOrganizationId: string | null;
  members: { organizationId: string; name: string; memberCode: string | null }[];
}

/**
 * EVERY READ AND WRITE HERE GOES THROUGH A DEFINER FUNCTION, and it has to.
 *
 * `platform_operator` inherits `authenticated` and is therefore subject to the
 * same row level security policies. That is deliberate rather than an oversight:
 * it means an operator's every crossing of the tenant boundary is a named
 * function in `sql/after.sql` that somebody can read, instead of a role that
 * sees everything.
 *
 * It also means a plain `select` on `organization` outside any tenant context
 * returns nothing, and a plain `insert` into `network` fails the policy's check
 * because the row's id is not yet the caller's network. The first draft of this
 * file did both and every test said "Organization not found", which is exactly
 * what forced RLS is supposed to say.
 */
export async function createNetwork(
  db: Database,
  input: NetworkInput,
  meta: OperatorMeta = {},
): Promise<NetworkView> {
  return asOperator(db, "", async (tx) => {
    const slug = input.slug.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(slug)) {
      throw new ConflictError(
        `"${input.slug}" is not a slug. Lower case letters, digits and hyphens, starting with a `
        + "letter or a digit.",
      );
    }
    const kind = input.kind ?? "holding";
    if (!(NETWORK_KINDS as readonly string[]).includes(kind)) {
      throw new ConflictError(
        `"${kind}" is not a kind of network. One of: ${NETWORK_KINDS.join(", ")}.`,
      );
    }

    const [existing] = await tx.execute<{ id: string | null }>(
      sql`select app.operator_network_by_slug(${slug}) as id`,
    );
    if (existing?.id) {
      /**
       * A replay rather than a conflict, for the same reason `create` replays on
       * `externalRef`: a control plane that creates a network and loses the
       * response has to be able to ask again, and the only thing it can ask with
       * is the slug it chose.
       */
      return readNetwork(tx, existing.id);
    }

    const [created] = await tx.execute<{ id: string }>(sql`
      select app.operator_create_network(
        ${kind}, ${input.name.trim()}, ${slug}, ${input.operatorOrganizationId ?? null}
      ) as id
    `).catch(noSuchOrganization);

    if (input.operatorOrganizationId) {
      /**
       * INTO THE OPERATOR'S TENANT CONTEXT BEFORE THE AUDIT LINE, because the
       * policy on `audit_log` admits only a row whose organization matches the
       * context, and this transaction opened with no context at all: a network
       * is created from outside every tenant. Without this the whole call fails
       * with "new row violates row-level security policy for audit_log", which
       * is the policy working.
       *
       * The line belongs in the operator company's own log rather than nowhere.
       * "When were we made the operator of a network" is a question that company
       * is entitled to answer from its own records.
       */
      await enterOperator(tx, input.operatorOrganizationId);
      await audit(tx, input.operatorOrganizationId, "operator.network.create", null,
        { networkId: created!.id, slug }, meta);
    }

    return readNetwork(tx, created!.id);
  });
}

/**
 * `no_data_found` from a definer function means the id named nothing.
 *
 * Raised in SQL rather than checked in TypeScript first, because the check and
 * the write have to be in the same statement: a caller that read "it exists"
 * and then wrote would be relying on nothing having deleted it in between, and
 * the function is the only place that can see across tenants to do either.
 */
function noSuchOrganization(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  if (code === "P0002" || code === "02000") throw new NotFoundError("Organization");
  throw error;
}

async function readNetwork(tx: Database, id: string): Promise<NetworkView> {
  const rows = await tx.execute<{
    id: string; kind: string; name: string; slug: string;
    operator_organization_id: string | null;
    member_organization_id: string | null; member_name: string | null; member_code: string | null;
  }>(sql`select * from app.operator_network(${id})`);

  const first = rows[0];
  if (!first) throw new NotFoundError("Network");

  return {
    id: first.id,
    kind: first.kind,
    name: first.name,
    slug: first.slug,
    operatorOrganizationId: first.operator_organization_id,
    /**
     * A left join, so a network with no members yet comes back as one row with
     * nulls in the member columns rather than as nothing at all. Filtering on the
     * id rather than on the name, because a company is allowed to be called "".
     */
    members: rows
      .filter((row) => row.member_organization_id !== null)
      .map((row) => ({
        organizationId: row.member_organization_id!,
        name: row.member_name ?? "",
        memberCode: row.member_code,
      })),
  };
}

export async function getNetwork(
  db: Database, id: string, meta: OperatorMeta = {},
): Promise<NetworkView> {
  void meta;
  return asOperator(db, "", (tx) => readNetwork(tx, id));
}

/**
 * Put a company in a network, or take it out.
 *
 * `networkId: null` removes it, and REVOKES EVERY GRANT ON THE WAY OUT. A
 * franchisee who leaves the franchise has not agreed to keep sharing their
 * revenue with their former franchisor, and a grant row left behind with the
 * membership gone would start sharing again the day somebody put them back in.
 */
export async function setNetworkMembership(
  db: Database,
  organizationId: string,
  input: { networkId: string | null; memberCode?: string | null | undefined },
  meta: OperatorMeta = {},
): Promise<{ organizationId: string; networkId: string | null; memberCode: string | null }> {
  return asOperator(db, organizationId, async (tx) => {
    const before = await statusRow(tx, organizationId);

    const [after] = await tx.execute<{
      network_id: string | null; member_code: string | null;
    }>(sql`
      select * from app.operator_set_membership(
        ${organizationId}, ${input.networkId ?? null}, ${input.memberCode?.trim() || null}
      )
    `).catch(noSuchOrganization);

    await audit(tx, organizationId, "operator.network.membership", { name: before.name },
      { networkId: after?.network_id ?? null, memberCode: after?.member_code ?? null }, meta);

    return {
      organizationId,
      networkId: after?.network_id ?? null,
      memberCode: after?.member_code ?? null,
    };
  });
}
