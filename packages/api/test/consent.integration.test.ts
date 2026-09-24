import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as consent from "../src/services/consent";
import * as commsInbound from "../src/services/comms-inbound";
import { sendability } from "../src/services/comms-send";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * CONSENT, WHICH NOTHING COULD RECORD
 *
 * `communication_consent` was read in three places and written in none.
 * `canSend` requires a granted row for anything marketing and implies
 * nothing there, so every marketing message this product could send was
 * refused with `no_consent`, permanently, and the marketing module built on
 * top of it could not deliver one.
 *
 * Nobody noticed because transactional messages are implied by the work
 * itself and kept going out. The on my way text arrived. The campaign
 * silently did not.
 *
 * The quieter half: a revocation is a consent row too. With no writer,
 * "stop texting me about offers" said to a dispatcher on the phone had
 * nowhere to go, and the system's own record would say nothing was ever
 * withdrawn.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("cs:org");
const USER = fixtureId("cs:user");
const OUR_NUMBER = "+15125559971";
const THEIRS = "+15125550301";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Consent Co", slug: "consent-co" });
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
    values (${ORG}, ${OUR_NUMBER}, 'main', true)`;
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await raw`delete from public.communication_consent where organization_id = ${ORG}`;
  await raw`delete from public.suppression where organization_id = ${ORG}`;
  await raw`delete from public.message where organization_id = ${ORG}`;
  await raw`delete from public.conversation where organization_id = ${ORG}`;
});

const GRANT = {
  address: THEIRS, channel: "sms" as const, purpose: "marketing" as const,
  method: "web_form" as const,
  proofText: "Yes, text me about seasonal tune-up offers.",
  proofReference: "https://example.test/book?step=3",
};

run("recording it", () => {
  it("turns a marketing send from refused into allowed", async () => {
    /**
     * The whole finding in one test. Before the grant exists there is no way
     * for this to be anything but no_consent, whatever the company does.
     */
    const before = await consent.marketable(owner(), { address: THEIRS });
    expect(before).toMatchObject({ allowed: false, reason: "no_consent" });

    await consent.grant(owner(), GRANT);

    const after = await consent.marketable(owner(), { address: THEIRS });
    expect(after.allowed).toBe(true);
  });

  it("leaves transactional sending alone, which was always implied", async () => {
    /**
     * The reason nobody noticed. The on my way text went out the whole time,
     * because work in flight implies its own messages, so the symptom was a
     * silent campaign rather than a broken product.
     */
    const decision = await sendability(db(), ORG, THEIRS);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe("transactional_implied");
  });

  it("refuses a grant with no proof on it", async () => {
    await expect(consent.grant(owner(), {
      address: THEIRS, channel: "sms", purpose: "marketing", method: "verbal",
    })).rejects.toBeInstanceOf(ConflictError);
  });

  it("takes a revocation with no proof, because a stop needs no defending", async () => {
    await consent.grant(owner(), GRANT);
    await expect(consent.revoke(owner(), {
      address: THEIRS, channel: "sms", purpose: "marketing", method: "verbal",
    })).resolves.toBeTruthy();
  });

  it("refuses a capture method this product does not know", async () => {
    await expect(consent.grant(owner(), { ...GRANT, method: "telepathy" as never }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses a row with no address", async () => {
    await expect(consent.grant(owner(), { ...GRANT, address: "   " }))
      .rejects.toBeInstanceOf(ConflictError);
  });

  it("refuses to record consent for a role that cannot send", async () => {
    await expect(consent.grant(as(["accountant"]), GRANT))
      .rejects.toBeInstanceOf(PermissionError);
  });
});

run("superseding rather than editing", () => {
  it("keeps the old row and marks it replaced", async () => {
    await consent.grant(owner(), GRANT);
    await consent.revoke(owner(), {
      address: THEIRS, channel: "sms", purpose: "marketing", method: "verbal",
      proofText: "Asked us to stop on the phone.",
    });

    const rows = await consent.history(owner(), { address: THEIRS });
    expect(rows).toHaveLength(2);

    /**
     * A consent row is evidence and evidence is not edited. The history has
     * to read as what was true when, because the question anybody asks of it
     * is about a message that already went out.
     */
    const current = rows.filter((r) => r.current);
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ state: "revoked" });

    const replaced = rows.find((r) => !r.current);
    expect(replaced).toMatchObject({ state: "granted" });
    expect(replaced!.supersededAt).not.toBeNull();
    /** And the wording survives, which is the part that is actually proof. */
    expect(replaced!.proofText).toBe(GRANT.proofText);
  });

  it("stops the sending it used to allow", async () => {
    await consent.grant(owner(), GRANT);
    expect((await consent.marketable(owner(), { address: THEIRS })).allowed).toBe(true);

    await consent.revoke(owner(), {
      address: THEIRS, channel: "sms", purpose: "marketing", method: "verbal",
    });

    expect(await consent.marketable(owner(), { address: THEIRS }))
      .toMatchObject({ allowed: false, reason: "consent_revoked" });
  });

  it("leaves a different purpose alone", async () => {
    await consent.grant(owner(), GRANT);
    await consent.revoke(owner(), {
      address: THEIRS, channel: "sms", purpose: "transactional", method: "verbal",
    });

    /**
     * Marketing and transactional are separate promises. Revoking one and
     * silently clearing the other is how a customer who asked to stop
     * receiving offers stops being told a technician is outside.
     */
    const rows = await consent.history(owner(), { address: THEIRS });
    const marketing = rows.find((r) => r.purpose === "marketing" && r.current);
    expect(marketing).toMatchObject({ state: "granted" });
  });

  it("never leaves two current rows for the same promise", async () => {
    await consent.grant(owner(), GRANT);
    await consent.grant(owner(), { ...GRANT, proofText: "Asked again at the door." });
    await consent.revoke(owner(), {
      address: THEIRS, channel: "sms", purpose: "marketing", method: "verbal",
    });
    await consent.grant(owner(), { ...GRANT, proofText: "Changed their mind." });

    /**
     * `canSend` takes the current row. Two of them and the answer depends on
     * which one the index happened to return, which is a permission decision
     * settled by a race.
     */
    const [count] = await raw<{ n: number }[]>`
      select count(*)::int as n from public.communication_consent
      where organization_id = ${ORG} and address = ${THEIRS}
        and purpose = 'marketing' and superseded_at is null`;
    expect(count!.n).toBe(1);
  });
});

run("a customer who texts STOP", () => {
  const stop = () => commsInbound.store(db(), ORG, {
    from: THEIRS, to: OUR_NUMBER, body: "STOP", media: [],
    providerMessageId: `SM-stop-${Date.now()}`,
  });

  it("records the withdrawal, not only the suppression", async () => {
    await consent.grant(owner(), GRANT);
    await stop();

    /**
     * The suppression is what stops the sending and on its own is enough to
     * stop it. What it is not is an answer to "did this person consent": the
     * web form grant stayed the current row forever after a STOP, so the
     * record said yes while the customer had plainly said no.
     */
    const rows = await consent.history(owner(), { address: THEIRS });
    const current = rows.filter((r) => r.current && r.purpose === "marketing");
    expect(current).toHaveLength(1);
    expect(current[0]).toMatchObject({ state: "revoked", method: "sms_reply" });
    /** The message they actually sent, kept as the proof. */
    expect(current[0]!.proofText).toBe("STOP");
  });

  it("does not cancel the job, so transactional stays as the suppression decides", async () => {
    await stop();
    /**
     * Written for marketing only. A STOP is a carrier level opt out and the
     * suppression covers every purpose absolutely, which is where that
     * belongs; recording a transactional revocation on top would say the
     * customer withdrew something they never granted.
     */
    const rows = await consent.history(owner(), { address: THEIRS });
    expect(rows.filter((r) => r.purpose === "transactional")).toHaveLength(0);

    const decision = await sendability(db(), ORG, THEIRS);
    expect(decision).toMatchObject({ allowed: false, reason: "suppressed" });
  });

  it("is suppressed for marketing too, before consent is even consulted", async () => {
    await consent.grant(owner(), GRANT);
    await stop();
    expect(await consent.marketable(owner(), { address: THEIRS }))
      .toMatchObject({ allowed: false, reason: "suppressed" });
  });
});
