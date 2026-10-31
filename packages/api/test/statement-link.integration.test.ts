import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as customers from "../src/services/customers";
import * as billing from "../src/services/billing";
import * as statementDelivery from "../src/services/statement-delivery";
import * as portal from "../src/services/portal";
import * as portalAccount from "../src/services/portal-account";
import * as documents from "../src/services/documents";
import * as payerDelivery from "../src/services/payer-delivery";
import type { ServiceContext } from "../src/services/context";
import { issuePortalGrant, openPortalLink } from "../src/contracts/portal";
import { listStatementDeliveries, viewStatementLink } from "../src/contracts/statements";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * A LINK THAT OPENS ONLY THE STATEMENT (M13)
 *
 * A copy of a statement to an address the office typed reaches somebody the
 * customer record does not name. It used to carry the link to the customer's
 * whole account page. Now it carries a link of its own scope, `statement`,
 * whose subject is the statement that went: it opens that statement, read from
 * the books, and its PDF, and nothing else. It expires, it can be stopped, and
 * every other reader of a link refuses it, as it refuses every other link.
 * The customer's own people keep the statement's own link, and copying a typed
 * address still needs `portal:grant`.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("stlink:org");
const USER = fixtureId("stlink:owner");
const OUR_NUMBER = "+15125550277";

let raw: postgres.Sql;
const db = () => testDb(url!);
const owner = (): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: ["owner"] as Actor["roles"] }, db: db(),
});

let manager = "", other = "", clerk = "";

const days = (n: number) => new Date(Date.parse(`${companyToday()}T12:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
const tokenOf = (link: string, path: string) => link.split(`/${path}/`)[1]!.split(/[/?\s]/)[0]!;

async function customer(name: string, email: string) {
  return (await customers.create(owner(), {
    type: "commercial", name, phone: "+15125558900", email,
    paymentTermsDays: 0, taxExempt: false, tags: [], customFields: {},
  } as Parameters<typeof customers.create>[1])).id as string;
}

const copyRows = (deliveryId: string) => raw<{
  typed: boolean; message_id: string | null; portal_grant_id: string | null; error: string | null;
}[]>`select typed, message_id, portal_grant_id, error from public.statement_delivery_copy
       where statement_delivery_id = ${deliveryId} order by position`;
const bodyOf = async (id: string | null) =>
  (await raw<{ body: string }[]>`select body from public.message where id = ${id!}`)[0]!.body;

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Statement Link Co", slug: "statement-link-co" });
  await raw`update public.organization set timezone = 'America/Chicago' where id = ${ORG}`;
  await raw`insert into public.integration_connection (organization_id, capability, provider, status, settings)
    values (${ORG}, 'email', 'fake', 'connected', ${raw.json({ fromAddress: "office@link.test" })})`;
  await raw`insert into public.phone_number (organization_id, e164, purpose, sms_registered)
    values (${ORG}, ${OUR_NUMBER}, 'main', true)`;

  manager = await customer("Harbor Property Management", "ap@harbor.test");
  other = await customer("Another Customer", "another@else.test");
  const [person] = await raw<{ id: string }[]>`insert into public.contact
    (organization_id, customer_id, name, phone, email, preferred_channel, is_primary)
    values (${ORG}, ${manager}, 'Cora Clerk', '+15125558911', 'cora@harbor.test', 'email', true) returning id`;
  clerk = person!.id;
  for (const id of [manager, other]) {
    await billing.create(owner(), {
      customerId: id, issuedOn: days(-40),
      lines: [{ name: "Work", quantity: "1", unitPrice: "500.00", discountAmount: "0", taxable: false }],
    });
  }
});

afterAll(async () => { if (raw) await raw.end(); });

run("a copy to a typed address carries a link to the statement only", () => {
  it("carries an /s/ link in the email and the text, while the customer's own person keeps the account link", async () => {
    const sent = await statementDelivery.emailStatement(owner(), {
      id: manager, from: days(-60), to: days(-1),
      copies: [
        { contactId: clerk, channel: "email" },
        { address: "boss@harbor-owners.test", channel: "email" },
        { address: "(512) 555-0299", channel: "sms" },
      ],
    });
    expect(sent.state).toBe("queued");
    expect(sent.copies.map((c) => [c.typed, c.state])).toEqual([[false, "queued"], [true, "queued"], [true, "queued"]]);

    const rows = await copyRows(sent.deliveryId);
    /** The customer's own person: the statement's own link, to the account, as before. */
    expect(rows[0]!.portal_grant_id).toBeNull();
    expect(await bodyOf(rows[0]!.message_id)).toContain(sent.portalUrl);

    /** Each typed copy: a link of its own, not the account link. */
    const mail = await bodyOf(rows[1]!.message_id);
    const text = await bodyOf(rows[2]!.message_id);
    expect(mail).not.toContain(sent.portalUrl);
    expect(text).not.toContain(sent.portalUrl);
    expect(mail).not.toMatch(/\/c\//);
    expect(text).not.toMatch(/\/c\//);
    expect(mail).toMatch(/\/s\/[A-Za-z0-9_-]{40,}/);
    expect(text).toMatch(/\/s\/[A-Za-z0-9_-]{40,}/);
    expect(mail).toContain("The link opens this statement and nothing else, until ");
    expect(mail).not.toContain("opens their account");
    expect(rows[1]!.portal_grant_id).not.toBeNull();
    expect(rows[2]!.portal_grant_id).not.toBe(rows[1]!.portal_grant_id);

    const grants = await raw<{ scope: string; subject_id: string; customer_id: string; expires_at: Date }[]>`
      select scope::text as scope, subject_id, customer_id, expires_at from public.portal_grant
       where id in (${rows[1]!.portal_grant_id!}, ${rows[2]!.portal_grant_id!})`;
    expect(grants.every((g) => g.scope === "statement" && g.subject_id === sent.deliveryId && g.customer_id === manager)).toBe(true);
    /** It expires, like the statement's own link. */
    expect(grants.every((g) => g.expires_at.getTime() > Date.now() + 40 * 864e5 && g.expires_at.getTime() < Date.now() + 50 * 864e5)).toBe(true);

    /** The link opens that statement, for the period it was sent for. */
    const token = tokenOf(mail, "s");
    const opened = await statementDelivery.viewStatementLink(db(), { token });
    expect(opened).toMatchObject({ customerName: "Harbor Property Management", from: days(-60), to: days(-1) });
    expect(() => viewStatementLink.output.parse(opened)).not.toThrow();
    const file = await statementDelivery.statementLinkPdf(db(), { token: tokenOf(text, "s") });
    expect(file.filename).toBe(`statement-harbor-property-management-${days(-60)}-to-${days(-1)}.pdf`);

    /** The list says each typed copy has a link that is open. */
    const [listed] = await statementDelivery.deliveries(owner(), { customerId: manager, limit: 1 });
    expect(listed!.copies.map((c) => c.link?.state ?? null)).toEqual([null, "open", "open"]);
    expect(() => listStatementDeliveries.output.parse({
      deliveries: [{
        ...listed!, createdAt: listed!.createdAt.toISOString(),
        copies: listed!.copies.map((c) => ({ ...c, link: c.link ? { ...c.link, expiresAt: c.link.expiresAt.toISOString() } : null })),
      }],
    })).not.toThrow();
  });

  it("never opens anything but that statement", async () => {
    const sent = await statementDelivery.emailStatement(owner(), {
      id: manager, copies: [{ address: "auditor@harbor-owners.test", channel: "email" }],
    });
    const [row] = await copyRows(sent.deliveryId);
    const token = tokenOf(await bodyOf(row!.message_id), "s");
    const [invoice] = await raw<{ id: string }[]>`select id from public.invoice where customer_id = ${manager} limit 1`;

    /** Every reader of a link checks its own kind, and refuses this one. */
    await expect(portalAccount.viewAccount(db(), { token })).rejects.toThrow();
    await expect(portalAccount.viewStatement(db(), { token })).rejects.toThrow();
    await expect(portalAccount.viewStatement(db(), { token, from: days(-400), to: days(-1) })).rejects.toThrow();
    await expect(documents.statementPdfForToken(db(), { token })).rejects.toThrow();
    await expect(documents.invoicePdfForAccount(db(), { token, invoiceId: invoice!.id })).rejects.toThrow();
    await expect(documents.invoicePdfForToken(db(), { token })).rejects.toThrow();
    await expect(portal.viewEstimate(db(), { token } as Parameters<typeof portal.viewEstimate>[1])).rejects.toThrow();
    await expect(portal.viewJob(db(), { token } as Parameters<typeof portal.viewJob>[1])).rejects.toThrow();
    await expect(payerDelivery.viewPortal(db(), { token })).rejects.toThrow();

    /** Opening it says what it is and nothing more. */
    const session = await portal.openLink(db(), { token });
    expect(session.scope).toBe("statement");
    expect(() => openPortalLink.output.parse(session)).not.toThrow();

    /** And the customer's own account link does not open as a statement link. */
    const account = tokenOf(sent.portalUrl, "c");
    await expect(statementDelivery.viewStatementLink(db(), { token: account })).rejects.toThrow();
  });

  it("opens nothing for a statement of another customer, even when somebody makes such a grant by hand", async () => {
    const theirs = await statementDelivery.emailStatement(owner(), { id: other });
    const forged = await db().transaction(async (tx) => portal.mintGrant(tx as never, {
      organizationId: ORG, customerId: manager, scope: "statement", subjectId: theirs.deliveryId, expiresInDays: 1,
    }));
    await expect(statementDelivery.viewStatementLink(db(), { token: forged.token })).rejects.toThrow();
  });

  it("stops opening when it is stopped or runs out, and the list says which", async () => {
    const sent = await statementDelivery.emailStatement(owner(), {
      id: manager,
      copies: [{ address: "one@harbor-owners.test", channel: "email" }, { address: "two@harbor-owners.test", channel: "email" }],
    });
    const rows = await copyRows(sent.deliveryId);
    const first = tokenOf(await bodyOf(rows[0]!.message_id), "s");
    const second = tokenOf(await bodyOf(rows[1]!.message_id), "s");

    await portal.revokeGrant(owner(), { id: rows[0]!.portal_grant_id! });
    await expect(statementDelivery.viewStatementLink(db(), { token: first })).rejects.toThrow();
    await expect(statementDelivery.statementLinkPdf(db(), { token: first })).rejects.toThrow();
    /** The other copy's link, and the customer's own, still open. */
    await expect(statementDelivery.viewStatementLink(db(), { token: second })).resolves.toMatchObject({ customerName: "Harbor Property Management" });
    await expect(portalAccount.viewAccount(db(), { token: tokenOf(sent.portalUrl, "c") })).resolves.toBeTruthy();

    await raw`update public.portal_grant set expires_at = now() - interval '1 minute' where id = ${rows[1]!.portal_grant_id!}`;
    await expect(statementDelivery.viewStatementLink(db(), { token: second })).rejects.toThrow();

    const [listed] = await statementDelivery.deliveries(owner(), { customerId: manager, limit: 1 });
    expect(listed!.copies.map((c) => c.link?.state)).toEqual(["stopped", "expired"]);
  });

  it("leaves no live link behind for a typed copy that did not go", async () => {
    await raw`insert into public.suppression (organization_id, address, channel, reason)
      values (${ORG}, '+15125550288', 'sms', 'stop')`;
    try {
      const before = (await raw`select 1 from public.portal_grant where organization_id = ${ORG}
        and scope = 'statement' and revoked_at is null`).length;
      const sent = await statementDelivery.emailStatement(owner(), { id: manager, copies: [{ address: "+15125550288", channel: "sms" }] });
      expect(sent.copies[0]).toMatchObject({ typed: true, state: "refused" });
      const after = (await raw`select 1 from public.portal_grant where organization_id = ${ORG}
        and scope = 'statement' and revoked_at is null`).length;
      expect(after).toBe(before);
      expect((await copyRows(sent.deliveryId))[0]!.portal_grant_id).toBeNull();
    } finally {
      await raw`delete from public.suppression where organization_id = ${ORG}`;
    }
  });

  it("is never issued by hand: a statement link is made only with the copy it goes in", () => {
    expect(() => issuePortalGrant.input.parse({ customerId: manager, scope: "statement", subjectId: manager })).toThrow();
  });

  it("still needs portal:grant to copy a typed address, and says it is a link to the statement", async () => {
    const sender: ServiceContext = {
      actor: {
        userId: USER, organizationId: ORG, roles: [] as unknown as Actor["roles"],
        grants: ["invoice:read", "invoice:send", "customer:read"] as NonNullable<Actor["grants"]>,
      },
      db: db(),
    };
    await expect(statementDelivery.emailStatement(sender, { id: manager, copies: [{ address: "x@harbor-owners.test", channel: "email" }] }))
      .rejects.toThrow("A copy to an address you type gives that address a link to this statement, which needs the right to give customers links (portal:grant).");
  });
});
