import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as apps from "../src/services/apps";
import { authenticate } from "../src/http/authenticate";
import { dispatch } from "../src/http/dispatch";
import { AppEscalationError } from "../src/services/apps";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * AN APP ASKS, A PERSON DECIDES, THE APP COLLECTS
 *
 * The consent flow's promises, each of which fails silently if broken: asking
 * grants nothing, the person deciding sees the exact list and cannot approve
 * more than they hold, a refusal hands over nothing, and the credential is
 * handed over once, to the holder of the claim secret, and never again.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("consent:org");
const OWNER = fixtureId("consent:owner");
const MANAGER = fixtureId("consent:manager");
const SLUG = "consent-co";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"]): ServiceContext => ({
  actor: { userId, organizationId: ORG, roles }, db: db(),
});
const owner = () => as(OWNER, ["owner"]);
/** Holds `settings:read` and not `integration:write`, and none of the ledger. */
const manager = () => as(MANAGER, ["office_manager"]);

const meta = { ip: "203.0.113.7" };

const ask = (over: Partial<apps.InstallRequestInput> = {}) => apps.requestInstall(db(), {
  company: SLUG,
  name: "Neighbrium",
  publisher: "Neighbrium Inc",
  description: "Books neighbourhood group jobs into your calendar.",
  permissions: ["customer:read", "job:read"],
  scopes: { customer: "all", job: "all" },
  redirectUri: "https://partner.example.test/back",
  state: "xyz",
  ...over,
}, meta);

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Consent Co", slug: SLUG });
  await raw`delete from public."user" where id = ${MANAGER}`;
  await raw`insert into public."user" (id, email) values (${MANAGER}, 'consent-manager@test.local')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${MANAGER}, 'office_manager')`;
  await raw`delete from public.public_rate_limit where key like 'app-%'`;
});

afterAll(async () => {
  if (raw) await raw.end();
});

run("asking", () => {
  it("writes a pending app, hands back a claim secret and the decision page, and grants nothing", async () => {
    const request = await ask();
    expect(request.status).toBe("pending");
    expect(request.decisionPath).toBe(`/settings/apps/requests/${request.id}`);
    expect(request.claimSecret).toMatch(/^otc_/);

    const [row] = await raw<{ status: string; source: string; claim_hash: string }[]>`
      select status, source, claim_hash from public.connected_app where id = ${request.id}`;
    expect(row).toMatchObject({ status: "pending", source: "request" });
    expect(row!.claim_hash).not.toContain(request.claimSecret);

    // A pending app cannot be issued a token by anybody.
    await expect(apps.issueToken(owner(), { appId: request.id })).rejects.toThrow(/not active/);
    const collected = await apps.claim(db(), { id: request.id, claimSecret: request.claimSecret }, meta);
    expect(collected.status).toBe("pending");
    expect(collected).not.toHaveProperty("token");
  });

  it("refuses an unknown permission rather than dropping it", async () => {
    await expect(ask({ permissions: ["customer:read", "customer:teleport"] }))
      .rejects.toThrow(/Unknown permissions: customer:teleport/);
  });

  it("refuses a return address that is not https", async () => {
    await expect(ask({ redirectUri: "http://partner.example.test/back" })).rejects.toThrow(/https/);
  });

  it("does not know a company that does not exist", async () => {
    await expect(ask({ company: "nobody-here" })).rejects.toBeInstanceOf(NotFoundError);
  });

  it("is reachable over HTTP with no session at all", async () => {
    const response = await dispatch(new Request("http://x/v1/public/app-requests", {
      method: "POST",
      headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.8" },
      body: JSON.stringify({ company: SLUG, name: "Over HTTP", permissions: ["job:read"] }),
    }), { db: db(), resolveSession: async () => null });
    expect(response.status).toBe(201);
    const body = await response.json() as { id: string; claimSecret: string };
    expect(body.claimSecret).toMatch(/^otc_/);
  });
});

run("deciding", () => {
  it("shows the exact list in plain words, with what the viewer holds", async () => {
    const request = await ask({ permissions: ["customer:read", "ledger:read"] });
    const review = await apps.review(manager(), { id: request.id });
    expect(review.asks.map((a) => a.permission)).toEqual(["customer:read", "ledger:read"]);
    expect(review.asks.find((a) => a.permission === "customer:read")!.label).toBe("View customers");
    expect(review.asks.find((a) => a.permission === "ledger:read")).toMatchObject({ held: false, sensitive: true });
    expect(review.approvable).toBe(false);
    expect(review.blockedBecause).toMatch(/connects integrations/);
    expect(review.app.request).toMatchObject({ returnsTo: "partner.example.test", expired: false });
  });

  it("cannot approve what the approver does not hold", async () => {
    const request = await ask({ permissions: ["customer:read", "payroll:read"] });
    // An administrator holds integration:write and not payroll.
    const admin = as(OWNER, ["admin"]);
    await expect(apps.approve(admin, { id: request.id })).rejects.toBeInstanceOf(AppEscalationError);
    const [row] = await raw<{ status: string }[]>`select status from public.connected_app where id = ${request.id}`;
    expect(row!.status).toBe("pending");
  });

  it("approves exactly the list, sends the person back with the outcome, and hands the credential over once", async () => {
    const request = await ask();
    const decided = await apps.approve(owner(), { id: request.id });
    expect(decided.app.status).toBe("active");
    const back = new URL(decided.returnTo!);
    expect(back.host).toBe("partner.example.test");
    expect(Object.fromEntries(back.searchParams)).toEqual({ request: request.id, status: "approved", state: "xyz" });

    // Approving again changes nothing and succeeds.
    await expect(apps.approve(owner(), { id: request.id })).resolves.toMatchObject({ returnTo: decided.returnTo });

    // A wrong secret is the same not found as an id that does not exist.
    await expect(apps.claim(db(), { id: request.id, claimSecret: "otc_wrong" }, meta)).rejects.toBeInstanceOf(NotFoundError);
    await expect(apps.claim(db(), { id: fixtureId("no such request"), claimSecret: request.claimSecret }, meta))
      .rejects.toBeInstanceOf(NotFoundError);

    const collected = await apps.claim(db(), { id: request.id, claimSecret: request.claimSecret }, meta);
    expect(collected.status).toBe("approved");
    expect(collected.token).toMatch(/^ots_/);

    // The token works, and carries exactly what was asked for.
    const who = await authenticate(
      new Request("http://x", { headers: { authorization: `Bearer ${collected.token}` } }),
      { db: db(), session: async () => null },
    );
    expect(who?.appId).toBe(request.id);
    expect([...(who!.ctx.actor.grants ?? [])].sort()).toEqual(["customer:read", "job:read"]);

    const again = await apps.claim(db(), { id: request.id, claimSecret: request.claimSecret }, meta);
    expect(again.status).toBe("claimed");
    expect(again).not.toHaveProperty("token");
  });

  it("refuses, tells the app no, and hands over nothing", async () => {
    const request = await ask();
    const decided = await apps.refuse(owner(), { id: request.id, reason: "We do not know you" });
    expect(decided.app.status).toBe("refused");
    expect(new URL(decided.returnTo!).searchParams.get("status")).toBe("refused");
    const collected = await apps.claim(db(), { id: request.id, claimSecret: request.claimSecret }, meta);
    expect(collected).toMatchObject({ status: "refused", message: "Refused: We do not know you" });
    expect(collected).not.toHaveProperty("token");
    // Refusing again succeeds; approving after a refusal does not.
    await expect(apps.refuse(owner(), { id: request.id })).resolves.toBeDefined();
    await expect(apps.approve(owner(), { id: request.id })).rejects.toBeInstanceOf(ConflictError);
  });

  it("does not let a request's grant be edited before it is answered", async () => {
    const request = await ask();
    await expect(apps.update(owner(), { id: request.id, permissions: ["customer:read"] }))
      .rejects.toThrow(/Only an approved app/);
  });

  it("will not approve a request that expired", async () => {
    const request = await ask();
    await raw`update public.connected_app set request_expires_at = now() - interval '1 minute' where id = ${request.id}`;
    await expect(apps.approve(owner(), { id: request.id })).rejects.toThrow(/expired/);
    const collected = await apps.claim(db(), { id: request.id, claimSecret: request.claimSecret }, meta);
    expect(collected.status).toBe("expired");
  });

  it("revoke stays: turning an approved app off kills the credential it collected", async () => {
    const request = await ask();
    await apps.approve(owner(), { id: request.id });
    const collected = await apps.claim(db(), { id: request.id, claimSecret: request.claimSecret }, meta);
    await apps.revoke(owner(), { id: request.id });
    expect(await apps.resolveToken(db(), collected.token!)).toBeNull();
  });
});
