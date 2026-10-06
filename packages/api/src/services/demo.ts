import { createHash } from "node:crypto";
import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID } from "@opentradesos/core";
import { ConflictError, NotFoundError, inTenant } from "./context";
import { createUser } from "./organizations";
import { codeFor } from "./referrals";
import { ensureChannels } from "./acquisition";

/**
 * THE PUBLIC DEMO
 *
 * One shared sample company that anybody can click around in, the way a
 * QuickBooks "test drive" works: no signup, no form, and nothing anybody does
 * is kept. docs/self-hosting/demo.md is the page for whoever runs it.
 *
 * Three facts make it safe, and none of them is a hidden button:
 *
 *   * The company names a demo user (`organization.demo_user_id`), and every
 *     session of that user resolves READ ONLY in SQL, whatever its membership
 *     says (`app.resolve_session`). Read only means the `readonly` preset,
 *     only `...:read` permissions, the dispatcher refusing every non GET
 *     route, and a READ ONLY Postgres transaction under all of it.
 *   * The company's portal links open and act on nothing, its public booking
 *     page and forms store nothing, and the worker finds no work for it, so
 *     no text, email, webhook or accounting push ever leaves it.
 *   * `/demo` will only ever sign somebody into a company that has been set
 *     up this way, so pointing DEMO_ORGANIZATION_ID at a real company by
 *     mistake is a 404 rather than a public window into it.
 *
 * Everything here runs with the deployment's own connection, not inside a
 * tenant: making a company the demo is a deployment level decision, like
 * suspending one, and the trigger guarding the operator's columns refuses it
 * to any tenant.
 */

/** How long a visitor's session lasts. Long enough to look around, short enough to not matter. */
export const DEMO_SESSION_HOURS = 2;
/** Sessions handed to one address within the window below. */
export const DEMO_SESSIONS_PER_ADDRESS = 20;
export const DEMO_WINDOW_MINUTES = 60;

/**
 * The demo user's address. `.invalid` is reserved (RFC 2606), so nothing is
 * ever delivered to it and nobody can own it, and the company id in it means
 * a deployment with two demo companies over time never reuses one.
 */
export const demoEmail = (organizationId: string) => `demo+${organizationId}@demo.invalid`;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value: string | undefined | null): value is string => !!value && UUID.test(value);

export type DemoSessionOutcome = "created" | "limited" | "not_demo";

/**
 * Hand a visitor a session as the demo user, or say why not.
 *
 * The address is hashed before it reaches the database, so the rate limit
 * keeps no addresses. An unknown address (no proxy header) counts as one
 * shared address, which is the conservative way round.
 */
export async function createDemoSession(db: Database, input: {
  organizationId: string;
  tokenHash: string;
  ip: string | undefined;
  now?: Date;
}): Promise<DemoSessionOutcome> {
  if (!isUuid(input.organizationId)) return "not_demo";
  const ipHash = createHash("sha256").update(`opentradesos:demo:${input.ip ?? "unknown"}`).digest("hex");
  const expiresAt = new Date((input.now ?? new Date()).getTime() + DEMO_SESSION_HOURS * 3600_000);
  const [row] = await db.execute<{ outcome: DemoSessionOutcome }>(sql`
    select app.create_demo_session(
      ${input.organizationId}::uuid, ${input.tokenHash}, ${ipHash},
      ${expiresAt.toISOString()}::timestamptz, ${DEMO_SESSIONS_PER_ADDRESS}::integer,
      ${`${DEMO_WINDOW_MINUTES} minutes`}::interval
    ) as outcome`);
  return row?.outcome ?? "not_demo";
}

export interface DemoSetup {
  organizationId: string;
  organizationName: string;
  userId: string;
  /** False when everything was already in place and nothing was written. */
  changed: boolean;
}

/**
 * Make a company the demo: a dedicated user, a `readonly` membership, and the
 * company naming that user. Idempotent, and it deletes nothing.
 *
 * Refuses a demo user address that already belongs to somebody who can sign
 * in or who belongs to another company, because "the demo user" must be a
 * user nobody else has ever held.
 */
export async function setupDemo(db: Database, organizationId: string): Promise<DemoSetup> {
  if (!isUuid(organizationId)) throw new NotFoundError("Company");

  const setup = await db.transaction(async (raw) => {
    const tx = raw as unknown as Database;
    const [org] = await tx.execute<{ id: string; name: string; demo_user_id: string | null; suspended_at: Date | null }>(
      sql`select id, name, demo_user_id, suspended_at from public.organization where id = ${organizationId}::uuid for update`,
    );
    if (!org) throw new NotFoundError("Company");
    if (org.suspended_at) throw new ConflictError("That company is suspended. Resume it before making it the demo.");

    const email = demoEmail(organizationId);
    let changed = false;

    const [existing] = await tx.execute<{ id: string }>(
      sql`select id from public."user" where email = ${email} limit 1`,
    );
    let userId = existing?.id;
    if (userId) {
      const [other] = await tx.execute<{ n: number }>(sql`
        select (select count(*) from public.credential where user_id = ${userId}::uuid)
             + (select count(*) from public.membership
                 where user_id = ${userId}::uuid and organization_id <> ${organizationId}::uuid) as n`);
      if (Number(other?.n ?? 0) > 0) {
        throw new ConflictError(
          `${email} can sign in or belongs to another company, so it cannot be the demo user.`,
        );
      }
    } else {
      userId = await createUser(tx, { email, name: "Demo visitor" });
      changed = true;
    }

    const [membership] = await tx.execute<{ id: string; role: string; active: boolean; role_id: string | null }>(sql`
      select id, role::text as role, active, role_id from public.membership
       where organization_id = ${organizationId}::uuid and user_id = ${userId}::uuid limit 1`);
    if (!membership) {
      await tx.execute(sql`
        insert into public.membership (organization_id, user_id, role)
        values (${organizationId}::uuid, ${userId}::uuid, 'readonly')`);
      changed = true;
    } else if (membership.role !== "readonly" || !membership.active || membership.role_id) {
      // Put back to exactly what the demo expects. The session is read only
      // whatever this row says; the row is kept honest so a screen listing
      // the company's people does not show the demo visitor as an owner.
      await tx.execute(sql`
        update public.membership
           set role = 'readonly', active = true, role_id = null,
               grants = '[]'::jsonb, revocations = '[]'::jsonb, updated_at = now()
         where id = ${membership.id}::uuid`);
      changed = true;
    }

    if (org.demo_user_id !== userId) {
      await tx.execute(sql`
        update public.organization set demo_user_id = ${userId}::uuid, updated_at = now()
         where id = ${organizationId}::uuid`);
      changed = true;
    }

    return { organizationId, organizationName: org.name, userId, changed };
  });

  /**
   * What the screens otherwise write the first time somebody looks: the
   * company's starting list of marketing channels, and every customer's
   * referral code. Each is a write, and the demo's session is a read only
   * transaction, so without this the first customer a visitor opens is an
   * error page. Done here, by whoever sets the demo up, so the demo itself
   * never has to write.
   */
  const minted = await inTenant(
    { actor: { userId: SYSTEM_USER_ID, organizationId, roles: [] }, db },
    async (tx) => {
      const [channel] = await tx.select({ id: schema.marketingChannel.id }).from(schema.marketingChannel)
        .where(eq(schema.marketingChannel.organizationId, organizationId)).limit(1);
      if (!channel) await ensureChannels(tx, organizationId);
      const without = await tx.select({ id: schema.customer.id }).from(schema.customer)
        .where(and(
          eq(schema.customer.organizationId, organizationId),
          isNull(schema.customer.referralCode),
          isNull(schema.customer.deletedAt),
        ));
      for (const customer of without) await codeFor(tx, organizationId, customer.id);
      return without.length + (channel ? 0 : 1);
    },
  );
  return { ...setup, changed: setup.changed || minted > 0 };
}
