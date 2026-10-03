import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as billing from "../src/services/billing";
import * as customers from "../src/services/customers";
import * as estimates from "../src/services/estimates";
import * as portal from "../src/services/portal";
import * as portalAccount from "../src/services/portal-account";
import * as portalSignIn from "../src/services/portal-sign-in";
import * as savedCards from "../src/services/saved-cards";
import * as visitChanges from "../src/services/visit-changes";
import * as referrals from "../src/services/referrals";
import {
  InvalidGrantError, NotFoundError, SignInRefusedError, TooManyRequestsError, UnprocessableError, inTenant,
  type ServiceContext,
} from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * A CUSTOMER SIGNING IN WITH A CODE
 *
 * The code is the only thing between a stranger and a customer's saved card,
 * so these tests hold the things that make it safe: it goes only to an
 * address on the customer's own record, through the company's own senders;
 * only its hash is kept; it expires, it works once, five wrong tries kill
 * it, and asking for codes is counted. Then the other half: a sign in
 * reaches its own customer and NOTHING else, however the ids in a request
 * are chosen, and a link somebody was sent is never mistaken for one.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("portal-sign-in:org");
const USER = fixtureId("portal-sign-in:user");
const OTHER_ORG = fixtureId("portal-sign-in:other-org");
const OTHER_USER = fixtureId("portal-sign-in:other-user");
const SLUG = "sign-in-heating";
const OTHER_SLUG = "sign-in-other-heating";

/** Unique per run, so the counters a previous run left behind cannot trip this one. */
const RUN = Date.now().toString(36);
const DANA = `dana.${RUN}@sign-in.test`;
const ELI = `eli.${RUN}@sign-in.test`;
const SHARED = `household.${RUN}@sign-in.test`;
const NOBODY = `nobody.${RUN}@sign-in.test`;
const DANA_PHONE = "(512) 555-0142";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (org = ORG, user = USER): ServiceContext => ({
  actor: { userId: user, organizationId: org, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let ipSeq = 0;
/** A fresh network address per call, so one test's counter is not another's. */
const ip = () => `198.51.${Math.floor(Math.random() * 250)}.${(ipSeq += 1) % 250}`;

let dana = "";
let eli = "";
let householdA = "";
let householdB = "";
let otherOrgDana = "";

async function aCustomer(org: string, name: string, email: string | null, phone: string | null = null) {
  const c = await customers.create(owner(org, org === ORG ? USER : OTHER_USER), {
    type: "residential", name, paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
    ...(email ? { email } : {}), ...(phone ? { phone } : {}),
  });
  const [p] = await raw<{ id: string }[]>`insert into public.property
    (organization_id, address_line1, city, state, postal_code)
    values (${org}, ${`${name.length} Live Oak St`}, 'Austin', 'TX', '78704') returning id`;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
    values (${org}, ${c.id}, ${p!.id})`;
  return c.id as string;
}

/** The newest code sent to an address, read off the outbox the way the customer reads it off their phone. */
async function codeSentTo(address: string): Promise<string> {
  const [row] = await raw<{ body: string }[]>`
    select body from public.message
     where organization_id = ${ORG} and to_address = ${address} and direction = 'outbound'
     order by created_at desc limit 1`;
  const code = /\b(\d{6})\b/.exec(row?.body ?? "")?.[1];
  if (!code) throw new Error(`No code went to ${address}`);
  return code;
}

async function signIn(address: string, customerId?: string): Promise<string> {
  await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address }, { ip: ip() });
  const code = await codeSentTo(address.includes("@") ? address : "+15125550142");
  const verdict = await portalSignIn.verifyCode(db(), {
    organizationSlug: SLUG, address, code, ...(customerId ? { customerId } : {}),
  }, { ip: ip() });
  if (verdict.status !== "signed_in") throw new Error("expected to sign in");
  return verdict.token;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Sign In Heating", slug: SLUG });
  await seedOrg(raw, { organizationId: OTHER_ORG, userId: OTHER_USER, name: "Other Heating", slug: OTHER_SLUG });
  await raw`delete from public.public_rate_limit where key like 'portal-code:%' or key like 'portal-check:%'`;
  await raw`
    insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@sign-in.test" })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
            values (${ORG}, '+15125559944', 'main', true)`;

  dana = await aCustomer(ORG, "Dana Okafor", DANA, DANA_PHONE);
  eli = await aCustomer(ORG, "Eli Brandt", ELI);
  householdA = await aCustomer(ORG, "Ruth Mendez", SHARED);
  householdB = await aCustomer(ORG, "Mendez Rentals LLC", SHARED);
  // The same person, as a customer of a different company. Never reachable from this one.
  otherOrgDana = await aCustomer(OTHER_ORG, "Dana Okafor", DANA);
});

afterAll(async () => {
  if (!raw) return;
  await resetOrg(raw, ORG);
  await resetOrg(raw, OTHER_ORG);
  await raw.end();
});

beforeEach(async () => {
  if (!url) return;
  /**
   * The counters are global and outlive a test, so each test starts with
   * none. The two tests about the ceilings fill them inside themselves.
   */
  await raw`delete from public.public_rate_limit where key like 'portal-code:%' or key like 'portal-check:%'`;
  await raw`delete from public.portal_grant where organization_id = ${ORG}`;
  await raw`delete from public.portal_sign_in where organization_id = ${ORG}`;
});

run("asking for a code", () => {
  it("sends one to an email on file, through the company's own email sender, and keeps only its hash", async () => {
    const answer = await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: `  ${DANA.toUpperCase()} ` }, { ip: ip() });
    expect(answer).toEqual({ accepted: true, expiresInMinutes: 10 });

    const code = await codeSentTo(DANA);
    const [row] = await raw<{ code_hash: string; channel: string; delivery: string; expires_at: Date }[]>`
      select code_hash, channel, delivery, expires_at from public.portal_sign_in
       where organization_id = ${ORG} and address = ${DANA}`;
    expect(row!.channel).toBe("email");
    expect(row!.delivery).toBe("queued");
    expect(row!.code_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(row!.code_hash).not.toContain(code);
    const minutes = (row!.expires_at.getTime() - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(9);
    expect(minutes).toBeLessThanOrEqual(10);
  });

  it("texts one to a phone number however it was typed", async () => {
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: "+1 512 555 0142" }, { ip: ip() });
    const [message] = await raw<{ channel: string; to_address: string; purpose: string; customer_id: string | null }[]>`
      select m.channel, m.to_address, m.purpose, c.customer_id
        from public.message m join public.conversation c on c.id = m.conversation_id
       where m.organization_id = ${ORG} and m.to_address = '+15125550142'
       order by m.created_at desc limit 1`;
    expect(message).toMatchObject({ channel: "sms", purpose: "transactional", customer_id: dana });
  });

  it("answers an address nobody has exactly as it answers one on file, and sends nothing", async () => {
    const onFile = await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: ELI }, { ip: ip() });
    const stranger = await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: NOBODY }, { ip: ip() });
    expect(stranger).toEqual(onFile);
    const sent = await raw`select 1 from public.message where organization_id = ${ORG} and to_address = ${NOBODY}`;
    expect(sent).toHaveLength(0);
    const [row] = await raw<{ code_hash: string | null; ended_reason: string }[]>`
      select code_hash, ended_reason from public.portal_sign_in where organization_id = ${ORG} and address = ${NOBODY}`;
    expect(row).toEqual({ code_hash: null, ended_reason: "no_customer" });
  });

  it("refuses something that is neither an email nor a phone number, before anything is counted", async () => {
    await expect(portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: "dana at home" }, { ip: ip() }))
      .rejects.toThrow(UnprocessableError);
  });

  it("sends one code for a double press carrying the same key", async () => {
    const key = `press-${RUN}`;
    const address = `double.${RUN}@sign-in.test`;
    await aCustomer(ORG, "Double Press", address);
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address }, { ip: ip(), idempotencyKey: key });
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address }, { ip: ip(), idempotencyKey: key });
    const sent = await raw`select 1 from public.message where organization_id = ${ORG} and to_address = ${address}`;
    expect(sent).toHaveLength(1);
  });

  it("counts requests per address, and refuses past the ceiling without sending", async () => {
    const address = `counted.${RUN}@sign-in.test`;
    await aCustomer(ORG, "Counted Customer", address);
    for (let i = 0; i < 3; i += 1) {
      await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address }, { ip: ip() });
    }
    await expect(portalSignIn.requestCode(db(), { organizationSlug: SLUG, address }, { ip: ip() }))
      .rejects.toThrow(TooManyRequestsError);
    const sent = await raw`select 1 from public.message where organization_id = ${ORG} and to_address = ${address}`;
    expect(sent).toHaveLength(3);
  });

  it("counts requests per network address, whatever addresses they are for", async () => {
    const from = ip();
    for (let i = 0; i < 10; i += 1) {
      await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: `walk${i}.${RUN}@sign-in.test` }, { ip: from });
    }
    await expect(portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: `walk10.${RUN}@sign-in.test` }, { ip: from }))
      .rejects.toThrow(TooManyRequestsError);
  });
});

run("checking a code", () => {
  it("signs in with the right code, once, as a session for that customer only", async () => {
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: DANA }, { ip: ip() });
    const code = await codeSentTo(DANA);
    const verdict = await portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: DANA, code: `${code.slice(0, 3)} ${code.slice(3)}` }, { ip: ip() });
    expect(verdict.status).toBe("signed_in");
    if (verdict.status !== "signed_in") return;
    expect(verdict.customerName).toBe("Dana Okafor");

    const session = await portalSignIn.sessionFor(db(), verdict.token);
    expect(session.customerId).toBe(dana);
    expect(new Date(session.expiresAt).getTime() - Date.now()).toBeGreaterThan(6.9 * 864e5);

    // Spent: the same code a second time is refused in the same words as a wrong one.
    await expect(portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: DANA, code }, { ip: ip() }))
      .rejects.toThrow(SignInRefusedError);
  });

  it("refuses a code that has expired", async () => {
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: DANA }, { ip: ip() });
    const code = await codeSentTo(DANA);
    await raw`update public.portal_sign_in set expires_at = now() - interval '1 second'
               where organization_id = ${ORG} and address = ${DANA} and ended_at is null`;
    await expect(portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: DANA, code }, { ip: ip() }))
      .rejects.toThrow(SignInRefusedError);
  });

  it("kills a code after five wrong tries, and the right one is no good after that", async () => {
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: DANA }, { ip: ip() });
    const code = await codeSentTo(DANA);
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i += 1) {
      await expect(portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: DANA, code: wrong }, { ip: ip() }))
        .rejects.toThrow(SignInRefusedError);
    }
    await expect(portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: DANA, code }, { ip: ip() }))
      .rejects.toThrow(SignInRefusedError);
    const [row] = await raw<{ attempts: number; ended_reason: string }[]>`
      select attempts, ended_reason from public.portal_sign_in
       where organization_id = ${ORG} and address = ${DANA} order by created_at desc limit 1`;
    expect(row).toEqual({ attempts: 5, ended_reason: "too_many_attempts" });
  });

  it("ends the code before when a new one is asked for", async () => {
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: DANA }, { ip: ip() });
    const first = await codeSentTo(DANA);
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: DANA }, { ip: ip() });
    const second = await codeSentTo(DANA);
    if (first !== second) {
      await expect(portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: DANA, code: first }, { ip: ip() }))
        .rejects.toThrow(SignInRefusedError);
    }
    const verdict = await portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: DANA, code: second }, { ip: ip() });
    expect(verdict.status).toBe("signed_in");
  });

  it("is a code for one company, and another company's sign in page refuses it", async () => {
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: DANA }, { ip: ip() });
    const code = await codeSentTo(DANA);
    await expect(portalSignIn.verifyCode(db(), { organizationSlug: OTHER_SLUG, address: DANA, code }, { ip: ip() }))
      .rejects.toThrow(SignInRefusedError);
  });

  it("asks which account when the address is on two, and signs in only as one of those two", async () => {
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: SHARED }, { ip: ip() });
    const code = await codeSentTo(SHARED);
    const asked = await portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: SHARED, code }, { ip: ip() });
    expect(asked.status).toBe("choose");
    if (asked.status !== "choose") return;
    expect(asked.accounts.map((a) => a.id).sort()).toEqual([householdA, householdB].sort());

    // A customer the address does not belong to is refused, even with the right code.
    await expect(portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: SHARED, code, customerId: eli }, { ip: ip() }))
      .rejects.toThrow(SignInRefusedError);

    const chosen = await portalSignIn.verifyCode(db(), {
      organizationSlug: SLUG, address: SHARED, code, customerId: householdB,
    }, { ip: ip() });
    expect(chosen.status).toBe("signed_in");
    if (chosen.status !== "signed_in") return;
    expect((await portalSignIn.sessionFor(db(), chosen.token)).customerId).toBe(householdB);
  });
});

run("a sign in reaches its own customer and nothing else", () => {
  async function workFor(customerId: string, total: string) {
    const invoice = await billing.create(owner(), {
      customerId,
      lines: [{ name: "Furnace repair", quantity: "1", unitPrice: total, discountAmount: "0", taxable: false }],
    });
    await raw`update public.invoice set status = 'open' where id = ${invoice.id as string} and status = 'draft'`;
    const [property] = await raw<{ property_id: string }[]>`
      select property_id from public.customer_property where customer_id = ${customerId} limit 1`;
    const estimate = await estimates.create(owner(), {
      customerId, propertyId: property!.property_id, taxRate: "0",
      options: [{
        name: "Replace", isRecommended: true,
        lines: [{
          name: "Furnace", quantity: "1", unitPrice: "4000.00", unitCost: "1800.00",
          discountAmount: "0", taxable: false, isOptional: false, isSelected: false,
        }],
      }],
    }) as Record<string, unknown>;
    await raw`update public.estimate set status = 'sent', sent_at = now() where id = ${estimate["id"] as string}`;
    const [job] = await raw<{ id: string }[]>`insert into public.job
      (organization_id, number, customer_id, property_id, status, summary)
      values (${ORG}, ${Math.floor(Math.random() * 1e8)}, ${customerId}, ${property!.property_id}, 'scheduled', 'Furnace')
      returning id`;
    const [visit] = await raw<{ id: string }[]>`insert into public.visit
      (organization_id, job_id, status, window_start, window_end)
      values (${ORG}, ${job!.id}, 'scheduled', now() + interval '5 days', now() + interval '5 days 4 hours')
      returning id`;
    return { invoiceId: invoice.id as string, estimateId: estimate["id"] as string, jobId: job!.id, visitId: visit!.id };
  }

  it("sees only its own customer's account, and every other customer's id is not found", async () => {
    const mine = await workFor(dana, "210.00");
    const theirs = await workFor(eli, "990.00");
    const token = await signIn(DANA);

    const account = await portalAccount.viewAccount(db(), { token });
    expect(account.customerName).toBe("Dana Okafor");
    const invoiceIds = account.invoices.map((i) => i.id);
    expect(invoiceIds).toContain(mine.invoiceId);
    expect(invoiceIds).not.toContain(theirs.invoiceId);
    expect(account.estimates.map((e) => e.id)).not.toContain(theirs.estimateId);
    expect(account.jobs.map((j) => j.id)).not.toContain(theirs.jobId);
    expect(account.visits.map((v) => v.id)).not.toContain(theirs.visitId);

    // Every route that takes an id from the request refuses another customer's.
    await expect(portalAccount.startInvoicePayment(db(), { token, invoiceId: theirs.invoiceId }))
      .rejects.toThrow(NotFoundError);
    for (const [kind, id] of [["estimate", theirs.estimateId], ["job", theirs.jobId], ["invoice", theirs.invoiceId]] as const) {
      await expect(portalSignIn.openRecord(db(), { token, kind, id })).rejects.toThrow(NotFoundError);
    }
    await expect(savedCards.pay(db(), { token, invoiceId: theirs.invoiceId, cardId: fixtureId("no-card") }))
      .rejects.toThrow(NotFoundError);
    await expect(savedCards.remove(db(), { token, cardId: fixtureId("no-card") })).rejects.toThrow(NotFoundError);
    await expect(visitChanges.options(db(), { token, visitId: theirs.visitId })).rejects.toThrow();

    // Its own records open, as narrower links for one record.
    const opened = await portalSignIn.openRecord(db(), { token, kind: "estimate", id: mine.estimateId });
    const estimateToken = opened.url.split("/").pop()!;
    const grant = await portal.peek(db(), estimateToken);
    expect(grant).toMatchObject({ scope: "estimate", subjectId: mine.estimateId, customerId: dana, usesRemaining: 1 });

    // The statement is this customer's alone.
    const statement = await portalAccount.viewStatement(db(), { token });
    expect(JSON.stringify(statement)).not.toContain("990.00");
  });

  it("never reaches the same person's account at another company", async () => {
    const token = await signIn(DANA);
    const session = await portalSignIn.sessionFor(db(), token);
    expect(session.grant.organizationId).toBe(ORG);
    expect(session.customerId).not.toBe(otherOrgDana);
    // Row level security holds it to its own company even for a read that names no company.
    const seen = await portal.inGrant(db(), session.grant, async (tx) =>
      tx.execute(`select id from public.customer where id = '${otherOrgDana}'`));
    expect(seen).toHaveLength(0);
  });

  it("is never confused with an account link, which cannot save a card or open an approval link", async () => {
    const link = await inTenant(owner(), (tx) => portal.mintGrant(tx, {
      organizationId: ORG, customerId: dana, scope: "customer", expiresInDays: 30,
    }));
    // The link still opens the account, as every link a customer was sent keeps doing.
    expect((await portalAccount.viewAccount(db(), { token: link.token })).customerName).toBe("Dana Okafor");
    await expect(portalSignIn.sessionFor(db(), link.token)).rejects.toThrow(InvalidGrantError);
    await expect(savedCards.list(db(), { token: link.token })).rejects.toThrow(InvalidGrantError);
    await expect(savedCards.startSave(db(), { token: link.token })).rejects.toThrow(InvalidGrantError);
    await expect(portalSignIn.openRecord(db(), { token: link.token, kind: "job", id: fixtureId("x") }))
      .rejects.toThrow(InvalidGrantError);
    await expect(portalSignIn.signOut(db(), { token: link.token })).rejects.toThrow(InvalidGrantError);
    // And signing out of a link did not withdraw it.
    expect((await portal.peek(db(), link.token)).customerId).toBe(dana);
  });

  it("ends everywhere on sign out", async () => {
    const token = await signIn(DANA);
    await portalSignIn.signOut(db(), { token });
    await expect(portalAccount.viewAccount(db(), { token })).rejects.toThrow(InvalidGrantError);
    await expect(portalSignIn.sessionFor(db(), token)).rejects.toThrow(InvalidGrantError);
    await expect(referrals.forPortal(db(), { token })).rejects.toThrow();
  });

  it("records who signed in, from where, on the audit trail as the session", async () => {
    await portalSignIn.requestCode(db(), { organizationSlug: SLUG, address: DANA }, { ip: "192.0.2.77" });
    const code = await codeSentTo(DANA);
    await portalSignIn.verifyCode(db(), { organizationSlug: SLUG, address: DANA, code }, { ip: "192.0.2.78" });
    const [row] = await raw<{ requested_ip: string; signed_in_ip: string; customer_id: string; ended_reason: string }[]>`
      select requested_ip, signed_in_ip, customer_id, ended_reason from public.portal_sign_in
       where organization_id = ${ORG} and address = ${DANA} order by created_at desc limit 1`;
    expect(row).toEqual({ requested_ip: "192.0.2.77", signed_in_ip: "192.0.2.78", customer_id: dana, ended_reason: "signed_in" });
    const audit = await raw<{ actor_portal_grant_id: string | null }[]>`
      select actor_portal_grant_id from public.audit_log
       where organization_id = ${ORG} and action = 'portal.signed_in' and entity_id = ${dana}`;
    expect(audit.length).toBeGreaterThan(0);
    expect(audit[0]!.actor_portal_grant_id).not.toBeNull();
  });
});
