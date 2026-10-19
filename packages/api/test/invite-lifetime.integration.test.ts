import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import type { EmailProvider, OutboundEmail } from "../src/email/provider";
import * as team from "../src/services/team";
import * as invites from "../src/services/invites";
import * as email from "../src/services/email";
import * as setupTokens from "../src/services/setup-tokens";
import { ConflictError, type ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * HOW LONG AN INVITE'S LINK WORKS IS THE COMPANY'S TO SAY
 *
 * One to thirty days, seven until the company sets it. It is read when an
 * invite is sent and kept on the invite as the day it runs out, so changing it
 * never moves an invite already sent. The invite screen says it, the email says
 * it beside the day, and the result of inviting carries it. Setting it needs
 * `settings:write`, which the person who merely sends invites does not hold.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("invite-days:org");
const OWNER = fixtureId("invite-days:owner");
const ODA = fixtureId("invite-days:oda");
const RAY = fixtureId("invite-days:ray");
const FROM = "office@invitedays.test";
const DAY = 86_400_000;

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (userId: string, roles: Actor["roles"]): ServiceContext => ({ actor: { userId, organizationId: ORG, roles }, db: db() });
const owner = () => as(OWNER, ["owner"]);
const oda = () => as(ODA, ["office_manager"]);
const ray = () => as(RAY, ["technician"]);

function fakeProvider(): EmailProvider & { sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = [];
  return {
    name: "fake", sent, delivery: { kind: "none", because: "A fake reports nothing." },
    async send(message) { sent.push(message); return { ok: true, providerMessageId: `fake_${sent.length}` }; },
  };
}

const tokenIn = (text: string | undefined) => /\/welcome\?token=([A-Za-z0-9_%-]+)/.exec(text ?? "")?.[1];
const previous = process.env["PUBLIC_URL"];

async function member(userId: string, address: string, name: string, role: string) {
  await raw`delete from public."user" where id = ${userId} or email = ${address}`;
  await raw`insert into public."user" (id, email, name) values (${userId}, ${address}, ${name})`;
  await raw`insert into public.credential (user_id, password_hash) values (${userId}, 'not-a-real-hash')`;
  await raw`insert into public.membership (organization_id, user_id, role) values (${ORG}, ${userId}, ${role}::public.member_role)`;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  process.env["PUBLIC_URL"] = "https://ots.invitedays.test";
});
afterAll(async () => {
  if (previous === undefined) delete process.env["PUBLIC_URL"]; else process.env["PUBLIC_URL"] = previous;
  if (raw) await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  await seedOrg(raw, { organizationId: ORG, userId: OWNER, name: "Invite Days Heating", slug: "invite-days-heating" });
  await raw`delete from public."user" where email like ${"invite-days-%@test.local"} and id <> ${OWNER}`;
  await raw`update public."user" set name = 'Olive Owner' where id = ${OWNER}`;
  await member(ODA, "invite-days-oda@test.local", "Oda Office", "office_manager");
  await member(RAY, "invite-days-ray@test.local", "Ray Ortiz", "technician");
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: FROM })})`;
});

const expiresIn = (iso: string) => (new Date(iso).getTime() - Date.now()) / DAY;

run("how long an invite's link works", () => {
  it("is seven days until the company says otherwise, and the invite says so", async () => {
    expect(await invites.lifetime(owner())).toEqual({ days: 7 });
    const sent = await team.invite(owner(), { email: "invite-days-a@test.local", name: "Ana A", role: "csr" });
    expect(sent.days).toBe(7);
    expect(expiresIn(sent.expiresAt)).toBeGreaterThan(6.9);
    expect(expiresIn(sent.expiresAt)).toBeLessThan(7.01);
  });

  it("lets the company choose, and the new invite, its email and the team list all use it", async () => {
    expect(await invites.setLifetime(owner(), { days: 3 })).toEqual({ days: 3 });
    expect(await invites.lifetime(owner())).toEqual({ days: 3 });

    const sent = await team.invite(owner(), { email: "invite-days-b@test.local", name: "Bea B", role: "csr" });
    expect(sent.days).toBe(3);
    expect(expiresIn(sent.expiresAt)).toBeGreaterThan(2.9);
    expect(expiresIn(sent.expiresAt)).toBeLessThan(3.01);

    const [queued] = await raw<{ body: string; body_html: string }[]>`
      select body, body_html from public.message where organization_id = ${ORG} and to_address = 'invite-days-b@test.local'`;
    expect(queued!.body).toMatch(/The link works once, for 3 days, until [A-Z][a-z]{2}, [A-Z][a-z]{2} \d{1,2}\./);
    expect(queued!.body_html).toContain("for 3 days, until");
    expect(queued!.body).not.toMatch(/[\u2014\u2013]/);

    const provider = fakeProvider();
    await email.flush(db(), ORG, { provider });
    const emailed = tokenIn(provider.sent.find((m) => m.to === "invite-days-b@test.local")!.text)!;
    expect((await setupTokens.peek(db(), decodeURIComponent(emailed)))?.email).toBe("invite-days-b@test.local");
    const [token] = await raw<{ expires_at: Date }[]>`
      select t.expires_at from public.setup_token t join public."user" u on u.id = t.user_id
       where u.email = 'invite-days-b@test.local' order by t.created_at desc limit 1`;
    expect((token!.expires_at.getTime() - Date.now()) / DAY).toBeLessThan(3.01);

    const roster = await team.roster(owner());
    const bea = roster.find((p) => p.email === "invite-days-b@test.local")!;
    expect(bea.invite?.sentence).toMatch(/^Emailed\. The link works until /);
  });

  it("says one day in the singular", async () => {
    await invites.setLifetime(owner(), { days: 1 });
    await team.invite(owner(), { email: "invite-days-c@test.local", name: "Cy C", role: "csr" });
    const [queued] = await raw<{ body: string }[]>`
      select body from public.message where organization_id = ${ORG} and to_address = 'invite-days-c@test.local'`;
    expect(queued!.body).toContain("for 1 day, until");
  });

  it("never moves an invite already sent, and a resend uses what is set now", async () => {
    const first = await team.invite(owner(), { email: "invite-days-d@test.local", name: "Di D", role: "csr" });
    await invites.setLifetime(owner(), { days: 30 });
    const [kept] = await raw<{ expires_at: Date }[]>`
      select expires_at from public.membership_invite where membership_id = ${first.membershipId} and replaced_at is null`;
    expect(kept!.expires_at.toISOString()).toBe(first.expiresAt);
    expect(expiresIn(first.expiresAt)).toBeLessThan(7.01);

    const again = await team.resendInvite(owner(), { membershipId: first.membershipId });
    expect(again.days).toBe(30);
    expect(expiresIn(again.expiresAt)).toBeGreaterThan(29.9);
  });

  it("takes from one to thirty whole days and refuses anything else, leaving the setting alone", async () => {
    await invites.setLifetime(owner(), { days: 30 });
    await invites.setLifetime(owner(), { days: 1 });
    for (const days of [0, 31, 2.5, -3]) {
      await expect(invites.setLifetime(owner(), { days })).rejects.toBeInstanceOf(ConflictError);
    }
    await expect(invites.setLifetime(owner(), { days: 45 })).rejects.toThrow(/whole number from 1 to 30/);
    expect(await invites.lifetime(owner())).toEqual({ days: 1 });
  });

  it("is read by whoever sends invites and changed only by whoever may change settings", async () => {
    expect(await invites.lifetime(oda())).toEqual({ days: 7 });
    await expect(invites.setLifetime(oda(), { days: 14 })).rejects.toThrow(PermissionError);
    await expect(invites.lifetime(ray())).rejects.toThrow(PermissionError);
    await expect(invites.setLifetime(ray(), { days: 14 })).rejects.toThrow(PermissionError);
    expect(await invites.lifetime(owner())).toEqual({ days: 7 });
  });

  it("audits who changed it and from what", async () => {
    await invites.setLifetime(owner(), { days: 10 });
    const [row] = await raw<{ before: { days: number }; after: { days: number } }[]>`
      select before, after from public.audit_log where organization_id = ${ORG} and action = 'organization.invite_days_set'`;
    expect(row).toEqual({ before: { days: 7 }, after: { days: 10 } });
  });

  it("falls back to seven for a saved value that is not a good number of days", async () => {
    await raw`update public.organization set settings = '{"inviteLink": {"days": 400}}'::jsonb where id = ${ORG}`;
    expect(await invites.lifetime(owner())).toEqual({ days: 7 });
    await raw`update public.organization set settings = '{"inviteLink": {"days": "9"}}'::jsonb where id = ${ORG}`;
    expect(await invites.lifetime(owner())).toEqual({ days: 7 });
  });
});
