import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";

/**
 * Integration tests against a real Postgres.
 *
 * These exist because the interesting failures in this layer are not type
 * errors. Row level security, SECURITY DEFINER boundaries and trigger
 * behaviour are all invisible to the compiler and all of them are the kind of
 * mistake that ships quietly.
 *
 * Skipped automatically when DATABASE_URL is unset, so a contributor without a
 * database still gets a green suite.
 */
const url = process.env.DATABASE_URL;
const run = url ? describe : describe.skip;

let sql: postgres.Sql;
const ORG_A = "aaaa1111-1111-1111-1111-111111111111";
const ORG_B = "bbbb2222-2222-2222-2222-222222222222";

beforeAll(async () => {
  if (!url) return;
  sql = postgres(url, { max: 1, onnotice: () => {} });
  await sql`delete from public.session`;
  await sql`delete from public.credential`;
  await sql`delete from public.membership`;
  await sql`delete from public.customer`;
  await sql`delete from public."user"`;
  await sql`delete from public.organization`;
  await sql`insert into public.organization (id, name, slug) values
    (${ORG_A}, 'Acme HVAC', 'acme-test'), (${ORG_B}, 'Beta Plumbing', 'beta-test')`;
});

afterAll(async () => { if (sql) await sql.end(); });

run("session resolution", () => {
  it("resolves a valid session into a user, org and role", async () => {
    const [user] = await sql`insert into public."user" (email, name)
      values ('owner@acme.test', 'Acme Owner') returning id`;
    await sql`insert into public.membership (organization_id, user_id, role)
      values (${ORG_A}, ${user!.id}, 'owner')`;

    const token = randomBytes(32).toString("base64url");
    const hash = createHash("sha256").update(token).digest("hex");
    await sql`select app.create_session(${user!.id}::uuid, ${hash}, ${ORG_A}::uuid,
      ${new Date(Date.now() + 864e5).toISOString()}::timestamptz)`;

    const rows = await sql`select * from app.resolve_session(${hash})`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.email).toBe("owner@acme.test");
    expect(rows[0]!.organization_id).toBe(ORG_A);
    expect(rows[0]!.role).toBe("owner");
  });

  it("returns nothing for an unknown token", async () => {
    const rows = await sql`select * from app.resolve_session('not-a-real-hash')`;
    expect(rows).toHaveLength(0);
  });

  it("returns nothing for an expired session", async () => {
    const [user] = await sql`insert into public."user" (email) values ('expired@acme.test') returning id`;
    await sql`insert into public.membership (organization_id, user_id, role)
      values (${ORG_A}, ${user!.id}, 'technician')`;
    const hash = createHash("sha256").update("expired").digest("hex");
    await sql`insert into public.session (user_id, token_hash, active_organization_id, expires_at)
      values (${user!.id}, ${hash}, ${ORG_A}, now() - interval '1 hour')`;

    expect(await sql`select * from app.resolve_session(${hash})`).toHaveLength(0);
  });

  it("stops resolving the moment a session is revoked", async () => {
    const [user] = await sql`insert into public."user" (email) values ('revoked@acme.test') returning id`;
    await sql`insert into public.membership (organization_id, user_id, role)
      values (${ORG_A}, ${user!.id}, 'technician')`;
    const hash = createHash("sha256").update("revoke-me").digest("hex");
    await sql`select app.create_session(${user!.id}::uuid, ${hash}, ${ORG_A}::uuid,
      ${new Date(Date.now() + 864e5).toISOString()}::timestamptz)`;

    expect(await sql`select * from app.resolve_session(${hash})`).toHaveLength(1);
    await sql`select app.revoke_session(${hash})`;
    // This is the whole reason sessions are a table rather than a stateless
    // token: an owner firing a technician needs them out before they reach
    // the truck, not whenever a token happens to expire.
    expect(await sql`select * from app.resolve_session(${hash})`).toHaveLength(0);
  });

  it("stops resolving when the membership is deactivated", async () => {
    const [user] = await sql`insert into public."user" (email) values ('offboard@acme.test') returning id`;
    await sql`insert into public.membership (organization_id, user_id, role)
      values (${ORG_A}, ${user!.id}, 'technician')`;
    const hash = createHash("sha256").update("offboard").digest("hex");
    await sql`select app.create_session(${user!.id}::uuid, ${hash}, ${ORG_A}::uuid,
      ${new Date(Date.now() + 864e5).toISOString()}::timestamptz)`;

    expect(await sql`select * from app.resolve_session(${hash})`).toHaveLength(1);
    await sql`update public.membership set active = false where user_id = ${user!.id}`;
    expect(await sql`select * from app.resolve_session(${hash})`).toHaveLength(0);
  });
});

run("secrets are not reachable by the application role", () => {
  it("denies the app role any row from credential or session", async () => {
    await sql`grant usage on schema public, app to authenticated`;
    await sql`grant select, insert, update, delete on all tables in schema public to authenticated`;

    await sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('app.organization_id', ${ORG_A}, true)`;
      const creds = await tx`select count(*)::int as n from public.credential`;
      const sessions = await tx`select count(*)::int as n from public.session`;
      expect(creds[0]!.n).toBe(0);
      expect(sessions[0]!.n).toBe(0);
    });
  });
});

run("tenant isolation", () => {
  it("shows a tenant only its own rows, and nothing without context", async () => {
    await sql`insert into public.customer (organization_id, name) values
      (${ORG_A}, 'Acme Customer'), (${ORG_B}, 'Beta Customer')`;

    await sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('app.organization_id', ${ORG_A}, true)`;
      const rows = await tx`select name from public.customer`;
      expect(rows.map((r) => r.name)).toEqual(["Acme Customer"]);
    });

    // An unset context must return nothing, never everything. Failing closed
    // is the difference between a bug and a breach.
    await sql.begin(async (tx) => {
      await tx`set local role authenticated`;
      await tx`select set_config('app.organization_id', '', true)`;
      const rows = await tx`select count(*)::int as n from public.customer`;
      expect(rows[0]!.n).toBe(0);
    });
  });

  it("refuses a write into another tenant", async () => {
    await expect(
      sql.begin(async (tx) => {
        await tx`set local role authenticated`;
        await tx`select set_config('app.organization_id', ${ORG_A}, true)`;
        await tx`insert into public.customer (organization_id, name) values (${ORG_B}, 'Smuggled')`;
      }),
    ).rejects.toThrow(/row-level security/i);
  });
});

run("the ledger cannot be rewritten", () => {
  const TX = "cccc3333-3333-3333-3333-333333333333";

  it("accepts a balanced transaction", async () => {
    await sql`insert into public.ledger_entry
      (organization_id, transaction_id, direction, account_code, amount, source_type, source_id) values
      (${ORG_A}, ${TX}, 'debit',  '1200', 100.0000, 'invoice', ${TX}),
      (${ORG_A}, ${TX}, 'credit', '4000', 100.0000, 'invoice', ${TX})`;
    const rows = await sql`select count(*)::int as n from public.ledger_entry where transaction_id = ${TX}`;
    expect(rows[0]!.n).toBe(2);
  });

  it("rejects an unbalanced transaction at commit", async () => {
    await expect(
      sql`insert into public.ledger_entry
        (organization_id, transaction_id, direction, account_code, amount, source_type, source_id)
        values (${ORG_A}, gen_random_uuid(), 'debit', '1200', 50.0000, 'invoice', ${TX})`,
    ).rejects.toThrow(/does not balance/i);
  });

  it("refuses an update and a delete", async () => {
    await expect(
      sql`update public.ledger_entry set amount = 999 where transaction_id = ${TX}`,
    ).rejects.toThrow(/append only/i);
    await expect(
      sql`delete from public.ledger_entry where transaction_id = ${TX}`,
    ).rejects.toThrow(/append only/i);
  });
});
