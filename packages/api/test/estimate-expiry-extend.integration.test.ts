import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { time, type Actor } from "@opentradesos/core";
import * as estimates from "../src/services/estimates";
import * as expiry from "../src/services/estimate-expiry";
import * as portal from "../src/services/portal";
import { SHAPES } from "../src/services/workflow-dwell";
import { stopUnless } from "../src/services/workflow-steps";
import { ConflictError, NotFoundError, inTenant, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, fixtureId, testDb } from "./helpers";

/**
 * GIVING THE CUSTOMER LONGER TO ANSWER AN ESTIMATE (M07)
 *
 * The office moves a sent or expired estimate's "Good until" date later, with
 * a reason. The refusals first: earlier, past, too far, decided, a draft, no
 * date, no reason, another company's, somebody who may not write estimates.
 * Then what it does: nothing priced changes, an expired one is open again,
 * the link it was sent with works again, and the follow up does not start
 * again by itself.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("expiry-extend:org");
const USER = fixtureId("expiry-extend:user");
const OTHER_ORG = fixtureId("expiry-extend:other-org");
const OTHER_USER = fixtureId("expiry-extend:other-user");
const ZONE = "America/Chicago";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[], org = ORG, user = USER): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let customerId = "";
let propertyId = "";

const today = () => time.dateIn(new Date(), ZONE);
const plus = (days: number) => time.addDays(today(), days);

/** An estimate sent by link, good until a date, then put where the test needs it. */
async function sentEstimate(expiresOn: string | null, opts: { status?: string; viewed?: boolean } = {}) {
  const written = await estimates.create(owner(), {
    customerId, propertyId, title: "Water heater",
    ...(expiresOn ? { expiresOn } : {}),
    options: [{
      name: "Replace", isRecommended: true,
      lines: [{ name: "Heater", quantity: "1", unitPrice: "1450.00", unitCost: "700.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }],
    }],
  } as Parameters<typeof estimates.create>[1]);
  const sent = await estimates.send(owner(), { id: written.id, channel: "link", expiresInDays: 3 } as Parameters<typeof estimates.send>[1]);
  const token = sent.approvalUrl!.split("/e/")[1]!;
  await raw`update public.estimate set sent_at = now() - interval '20 days',
    viewed_at = ${opts.viewed ? new Date(Date.now() - 19 * 864e5) : null},
    status = ${opts.status ?? "sent"}::estimate_status where id = ${written.id}`;
  return { id: written.id, token };
}

const row = async (id: string) => (await raw<{
  status: string; expires_on: string | null; expiry_extended_at: Date | null; sent_at: Date | null;
}[]>`select status, expires_on::text, expiry_extended_at, sent_at from public.estimate where id = ${id}`)[0]!;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Longer Plumbing", slug: "expiry-extend-plumbing" });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Somebody Else", slug: "expiry-extend-other" });
  await raw`update public.organization set timezone = ${ZONE} where id = ${ORG}`;
  const [c] = await raw`insert into public.customer (organization_id, name, email)
    values (${ORG}, 'Rosa Longer', 'rosa@example.test') returning id`;
  customerId = c!.id;
  const [p] = await raw`insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '8 Longer Rd', 'Austin', 'TX', '78704') returning id`;
  propertyId = p!.id;
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await resetOrg(raw, OTHER_ORG);
  await raw.end();
});

run("what cannot be given longer", () => {
  it("refuses an earlier or the same date, a day already gone and a day more than a year out", async () => {
    const { id } = await sentEstimate(plus(3));
    await expect(expiry.extend(owner(), { id, expiresOn: plus(2), reason: "Asked" })).rejects.toThrow(/Choose a day after/);
    await expect(expiry.extend(owner(), { id, expiresOn: plus(3), reason: "Asked" })).rejects.toThrow(/Choose a day after/);
    await expect(expiry.extend(owner(), { id, expiresOn: plus(400), reason: "Asked" })).rejects.toThrow(/within a year/);
    const old = await sentEstimate(plus(-30), { status: "expired" });
    await expect(expiry.extend(owner(), { id: old.id, expiresOn: plus(-1), reason: "Asked" })).rejects.toThrow(/from today on/);
    expect((await row(id)).expires_on).toBe(plus(3));
  });

  it("refuses a draft, an estimate the customer answered, one with no date, and no reason", async () => {
    const draft = await estimates.create(owner(), {
      customerId, propertyId, title: "Draft", expiresOn: plus(2),
      options: [{ name: "One", isRecommended: true, lines: [{ name: "Part", quantity: "1", unitPrice: "10.00", discountAmount: "0", taxable: false, isOptional: false, isSelected: false }] }],
    } as Parameters<typeof estimates.create>[1]);
    await expect(expiry.extend(owner(), { id: draft.id, expiresOn: plus(10), reason: "Asked" })).rejects.toThrow(/not been sent/);

    for (const status of ["approved", "declined", "converted"]) {
      const { id } = await sentEstimate(plus(-2), { status });
      await expect(expiry.extend(owner(), { id, expiresOn: plus(10), reason: "Asked" })).rejects.toThrow(/has answered/);
      expect((await row(id)).status).toBe(status);
    }

    const none = await sentEstimate(null);
    await expect(expiry.extend(owner(), { id: none.id, expiresOn: plus(10), reason: "Asked" })).rejects.toThrow(/no end date/);

    const quiet = await sentEstimate(plus(2));
    await expect(expiry.extend(owner(), { id: quiet.id, expiresOn: plus(10), reason: "   " })).rejects.toThrow(ConflictError);
  });

  it("is estimate:write's, and another company's estimate is not found", async () => {
    const { id } = await sentEstimate(plus(2));
    await expect(expiry.extend(as(["dispatcher"]), { id, expiresOn: plus(10), reason: "Asked" })).rejects.toThrow();
    await expect(expiry.extend(as(["owner"], OTHER_ORG, OTHER_USER), { id, expiresOn: plus(10), reason: "Asked" }))
      .rejects.toThrow(NotFoundError);
    expect((await row(id)).expires_on).toBe(plus(2));
  });
});

run("giving the customer longer", () => {
  it("opens an expired estimate again, changes nothing priced, and makes the link it was sent with work again", async () => {
    const { id, token } = await sentEstimate(plus(-5), { status: "expired", viewed: true });
    // The link ran out a few days ago, as a three day link sent three weeks ago would.
    await raw`update public.portal_grant set expires_at = now() - interval '2 days'
      where scope = 'estimate' and subject_id = ${id}`;
    await expect(portal.viewEstimate(db(), { token })).rejects.toThrow();
    const before = await estimates.get(owner(), { id });

    const given = await expiry.extend(owner(), { id, expiresOn: plus(14), reason: "Customer asked to hold the price for two weeks." });
    expect(given).toMatchObject({ id, status: "viewed", expiresOn: plus(14), previousExpiresOn: plus(-5) });
    // Good through the end of the new day where the company is.
    expect(given.linkExpiresAt).toBe(time.daysFrom(plus(14), 1, ZONE).end.toISOString());

    const after = await estimates.get(owner(), { id });
    expect(after.options).toEqual(before.options);
    expect(after.terms).toEqual(before.terms);
    const seen = await portal.viewEstimate(db(), { token });
    expect(seen.number).toBe(before.number);

    const [audited] = await raw<{ before: Record<string, unknown>; after: Record<string, unknown>; actor_user_id: string }[]>`
      select before, after, actor_user_id from public.audit_log where entity_id = ${id} and action = 'estimate.expiry_extended'`;
    expect(audited).toMatchObject({
      actor_user_id: USER,
      before: { expiresOn: plus(-5), status: "expired" },
      after: { expiresOn: plus(14), status: "viewed", reason: "Customer asked to hold the price for two weeks." },
    });

    // The same change again is the one already made; the worker marks it again only once the new date passes.
    expect((await expiry.extend(owner(), { id, expiresOn: plus(14), reason: "Again" })).expiresOn).toBe(plus(14));
    expect(await expiry.expireFor(db(), ORG)).toEqual([]);
    expect((await row(id)).status).toBe("viewed");
  });

  it("goes back to sent for one never opened, and leaves a link that already lasts longer alone", async () => {
    const { id } = await sentEstimate(plus(1));
    await raw`update public.portal_grant set expires_at = now() + interval '60 days'
      where scope = 'estimate' and subject_id = ${id}`;
    const [{ expires_at: was }] = await raw<{ expires_at: Date }[]>`select expires_at from public.portal_grant
      where scope = 'estimate' and subject_id = ${id}`;
    const given = await expiry.extend(owner(), { id, expiresOn: plus(7), reason: "Waiting on their insurer." });
    expect(given.status).toBe("sent");
    expect(given.linkExpiresAt).toBe(was!.toISOString());
  });

  it("says when there is no live link to give them, and never revives a withdrawn one", async () => {
    const { id, token } = await sentEstimate(plus(-1), { status: "expired" });
    await raw`update public.portal_grant set revoked_at = now() where scope = 'estimate' and subject_id = ${id}`;
    const given = await expiry.extend(owner(), { id, expiresOn: plus(7), reason: "Asked by phone." });
    expect(given.linkExpiresAt).toBeNull();
    await expect(portal.viewEstimate(db(), { token })).rejects.toThrow();
  });

  it("does not start the follow up again by itself, until it is sent again", async () => {
    const { id } = await sentEstimate(plus(-3), { status: "expired" });
    await expiry.extend(owner(), { id, expiresOn: plus(10), reason: "Holding the price." });

    const shape = SHAPES.find((s) => s.key === "estimate_unanswered")!;
    /** What the "estimate nobody answered" sweep would pick up, with a cutoff a minute from now. */
    const quiet = async () => inTenant(owner(), (tx) => tx.execute<{ id: string }>(
      sql.raw(shape.sql.replace("$cutoff", `'${new Date(Date.now() + 60_000).toISOString()}'::timestamptz`))));
    expect((await quiet()).map((r) => r.id)).not.toContain(id);

    // A follow up waiting from the first send stops rather than chasing.
    const event = {
      entityType: "estimate", entityId: id, name: "estimate.sent", id: fixtureId("expiry-extend:event"), createdAt: new Date(),
      payload: { estimate: { id, sentAt: (await row(id)).sent_at!.toISOString() } },
    } as unknown as typeof schema.domainEvent.$inferSelect;
    const asked = await inTenant(owner(), (tx) => stopUnless(tx, { check: "estimate_undecided" }, event, 2));
    expect(asked).toMatchObject({ ok: true, output: { held: false, because: expect.stringMatching(/given longer/) } });

    // Sent again, it is the office's choice to chase again.
    await raw`update public.estimate set sent_at = now() where id = ${id}`;
    expect((await quiet()).map((r) => r.id)).toContain(id);
  });
});
