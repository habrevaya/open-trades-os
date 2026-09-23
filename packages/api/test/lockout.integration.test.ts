import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { testDb, fixtureId } from "./helpers";

/**
 * THE BRUTE FORCE LOCKOUT THAT DID NOT EXIST
 *
 * `credential.failed_attempts` and `credential.locked_until` were columns
 * nothing ever wrote. `app.credential_for_login` went out of its way to
 * return `locked_until` so the sign in path could refuse on it, and it was
 * always null, so the branch was dead and the message "This account is
 * temporarily locked" asserted a control that did not exist.
 *
 * There was no rate limiting on that form of any kind. An attacker could
 * guess passwords against it indefinitely, and the code read as though they
 * could not, which is the most expensive way to be wrong about a security
 * property: a reviewer reads it and ticks it off.
 *
 * These tests drive the SQL functions directly. The sign in action that calls
 * them is a Next.js server action, and testing the mechanism where a test can
 * reach it is the same argument `authenticate` was moved into this package
 * for: code only the framework can reach is code no test reaches either.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const USER = fixtureId("lockout:user");
const EMAIL = "locked@lockout.test";

let raw: postgres.Sql;
const db = () => testDb(url!);

const credential = () => raw<{ failed_attempts: number; locked_until: Date | null }[]>`
  select failed_attempts, locked_until from public.credential where user_id = ${USER}`;

const fail = (email = EMAIL) =>
  db().execute(sql`select app.record_failed_login(${email}, 5, 15)`);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await raw`delete from public.credential where user_id = ${USER}`;
  await raw`delete from public."user" where id = ${USER} or email = ${EMAIL}`;
  await raw`insert into public."user" (id, email) values (${USER}, ${EMAIL})`;
  await raw`insert into public.credential (user_id, password_hash) values (${USER}, 'scrypt$x')`;
});

afterAll(async () => {
  if (raw) {
    await raw`delete from public.credential where user_id = ${USER}`;
    await raw`delete from public."user" where id = ${USER}`;
    await raw.end();
  }
});

beforeEach(async () => {
  if (!url) return;
  await raw`update public.credential set failed_attempts = 0, locked_until = null
            where user_id = ${USER}`;
});

run("a wrong password is counted", () => {
  it("counts each failure", async () => {
    // THE ASSERTION THE OLD CODE FAILED. The column was never written, so
    // this was zero no matter how many times anybody guessed.
    await fail();
    expect((await credential())[0]!.failed_attempts).toBe(1);
    await fail();
    expect((await credential())[0]!.failed_attempts).toBe(2);
  });

  it("does not lock before the threshold is crossed", async () => {
    for (let i = 0; i < 4; i++) await fail();
    const [row] = await credential();
    expect(row!.failed_attempts).toBe(4);
    // Four wrong passwords is a person with a password manager, not an attack.
    expect(row!.locked_until).toBeNull();
  });

  it("locks on the fifth", async () => {
    for (let i = 0; i < 5; i++) await fail();
    const [row] = await credential();
    expect(row!.locked_until).not.toBeNull();
    expect(row!.locked_until!.getTime()).toBeGreaterThan(Date.now());
  });

  it("pushes the lock out on every further attempt", async () => {
    /**
     * The property that makes a lockout worth having. An attacker who keeps
     * hammering the form keeps extending their own lock rather than waiting
     * fifteen minutes and resuming.
     */
    for (let i = 0; i < 5; i++) await fail();
    const first = (await credential())[0]!.locked_until!;

    await new Promise((r) => setTimeout(r, 1100));
    await fail();
    const second = (await credential())[0]!.locked_until!;

    expect(second.getTime()).toBeGreaterThan(first.getTime());
  });

  it("matches the address without caring about case", async () => {
    await fail(EMAIL.toUpperCase());
    expect((await credential())[0]!.failed_attempts).toBe(1);
  });

  it("does nothing at all for an address nobody has", async () => {
    /**
     * An unknown email must not be a different code path, or the form becomes
     * an oracle for which of a company's customers use this product.
     */
    await fail("nobody@lockout.test");
    expect((await credential())[0]!.failed_attempts).toBe(0);
  });
});

run("a correct password clears the count", () => {
  it("resets attempts and the lock", async () => {
    for (let i = 0; i < 5; i++) await fail();
    await db().execute(sql`select app.clear_failed_logins(${USER}::uuid)`);

    const [row] = await credential();
    expect(row!.failed_attempts).toBe(0);
    expect(row!.locked_until).toBeNull();
  });

  it("does not touch a credential that was already clean", async () => {
    // Guarded so a successful sign in is not a write on every request.
    const before = await raw<{ updated_at: Date }[]>`
      select updated_at from public.credential where user_id = ${USER}`;
    await new Promise((r) => setTimeout(r, 20));
    await db().execute(sql`select app.clear_failed_logins(${USER}::uuid)`);
    const after = await raw<{ updated_at: Date }[]>`
      select updated_at from public.credential where user_id = ${USER}`;

    expect(after[0]!.updated_at.getTime()).toBe(before[0]!.updated_at.getTime());
  });
});
