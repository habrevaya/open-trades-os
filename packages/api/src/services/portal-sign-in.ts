import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import { and, asc, desc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { AnyPgColumn } from "drizzle-orm/pg-core";
import { customerPortal as cp, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import {
  audit, inTenant, InvalidGrantError, NotFoundError, SignInRefusedError, UnprocessableError,
  type RequestMeta, type ServiceContext,
} from "./context";
import * as email from "./email";
import { sendTransactional } from "./comms-send";
import { companyFor, throttle } from "./website-tracking";
import { inGrant, mintGrant, peek, type ResolvedGrant } from "./portal";

/**
 * A CUSTOMER SIGNING IN
 *
 * The customer types the email or mobile number the company has for them,
 * gets a six digit code there, and types it back. What they get is a
 * customer scope portal grant held in a cookie: the same capability the
 * account link (`/c/{token}`) is, resolved by the same security definer
 * function, scoped by the same rules, so everything already true of that
 * link is true of a sign in. Two things set it apart, and both live on the
 * grant row as the sign in that opened it: it may save a card, and it may
 * open the customer's own estimates, jobs and invoices as narrower links,
 * because the code went to an address on the customer's own record and a
 * forwarded link did not.
 *
 * WHAT A STRANGER LEARNS. Nothing. Asking for a code for an address no
 * customer has gets the same answer, in the same shape, as asking for one
 * that is on file. A wrong code, an expired one, a spent one and one for an
 * address nobody has all get the same refusal. Telling those apart would
 * turn this page into a way to find out who is a customer of the company.
 *
 * WHAT A STRANGER CANNOT DO. Guess: five wrong tries kill a code, and a new
 * code kills the one before it. Flood somebody's phone: codes are counted
 * per address and per network address, before anything is sent. Read a code
 * out of the database: only a salted hash is kept (see `portal_sign_in`).
 *
 * THE MESSAGE GOES THROUGH THE COMPANY'S OWN SENDERS, `email.queue` and
 * `sendTransactional`, with their consent rules. A sign in code is a
 * transactional message the customer asked for, so it needs no marketing
 * consent; an address that replied STOP or bounced is still not written to,
 * and then the customer gets no code. The page says to contact the company
 * if nothing arrives, which is the honest answer to that case and does not
 * give away which case it was.
 */

/**
 * The actor sign in writes as. It holds the one permission the senders
 * check, for the reason `visit-changes.transport` gives: telling a customer
 * something they asked for is the act, and it must not depend on somebody in
 * the office holding `message:send`.
 */
function signInActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID, organizationId, roles: [], grants: ["message:send"], agentId: "portal-sign-in",
  };
}

/** Salted with the row id, so two rows with the same code do not share a hash. */
const codeHash = (signInId: string, code: string) =>
  createHash("sha256").update(`${signInId}:${code}`).digest("hex");

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  return x.length === y.length && timingSafeEqual(x, y);
}

const ipOf = (meta?: RequestMeta) => meta?.ip?.slice(0, 64) || "unknown";

/** Every refusal of a code, in one sentence that says nothing about why. */
const REFUSED = "That code is not right, or it has expired. Ask for a new one.";

function addressOrRefuse(typed: string): cp.SignInAddress {
  const address = cp.signInAddress(typed);
  if (!address) {
    throw new UnprocessableError("That is not an email address or a mobile number.", [{
      path: "address", message: "Type the email address or mobile number the company has for you.",
    }]);
  }
  return address;
}

export interface SignInAccount {
  id: string;
  name: string;
  /** The first line of an address they have with the company, so two accounts can be told apart. */
  place: string | null;
}

/** An account an address reaches, and the contact it reaches it through when it is not the customer's own. */
export interface SignInMatch extends SignInAccount {
  contactId: string | null;
}

/** The address as a condition on an email column and a phone column, compared the way each is stored. */
function addressMatch(
  address: cp.SignInAddress,
  columns: { email: AnyPgColumn; phone: AnyPgColumn },
) {
  if (address.channel === "email") return eq(sql`lower(trim(${columns.email}))`, address.address);
  /**
   * By the digits, because the record holds the number as it was typed
   * and the address is E.164: "(512) 555-0192" on the record is
   * "+15125550192" here.
   */
  const digits = address.address.replace(/\D/g, "");
  const forms = digits.length === 11 && digits.startsWith("1") ? [digits, digits.slice(1)] : [digits];
  return inArray(sql`regexp_replace(${columns.phone}, '[^0-9]', '', 'g')`, forms);
}

/**
 * The customers this address belongs to.
 *
 * The customer record's own email and phone, and the contacts on a customer
 * the office has let sign in (`contact.portal_access_at`). A contact the
 * office has not chosen is somebody it talks to about the account, which
 * is not the same as somebody who may pay its bills with a saved card, so
 * their address finds nothing. Merged and deleted customers, and removed
 * contacts, are left out, so a code never signs anybody in as a record the
 * office has retired.
 *
 * The customer's own address wins over a contact's for the same account: a
 * homeowner whose number is also on a contact is the homeowner.
 */
export async function customersAt(tx: Database, address: cp.SignInAddress): Promise<SignInMatch[]> {
  const own = await tx.select({ id: schema.customer.id, name: schema.customer.name })
    .from(schema.customer)
    .where(and(addressMatch(address, schema.customer), isNull(schema.customer.deletedAt)))
    .orderBy(asc(schema.customer.name), asc(schema.customer.id))
    .limit(10);
  const viaContact = await tx.select({
    id: schema.customer.id, name: schema.customer.name, contactId: schema.contact.id,
  })
    .from(schema.contact)
    .innerJoin(schema.customer, eq(schema.customer.id, schema.contact.customerId))
    .where(and(
      addressMatch(address, schema.contact),
      isNotNull(schema.contact.portalAccessAt),
      isNull(schema.contact.deletedAt),
      isNull(schema.customer.deletedAt),
    ))
    .orderBy(asc(schema.customer.name), asc(schema.contact.id))
    .limit(10);

  const rows: { id: string; name: string; contactId: string | null }[] = own.map((r) => ({ ...r, contactId: null }));
  for (const row of viaContact) {
    if (!rows.some((r) => r.id === row.id)) rows.push(row);
  }
  rows.sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  if (rows.length === 0) return [];

  const places = await tx.select({
    customerId: schema.customerProperty.customerId,
    line1: schema.property.addressLine1,
  })
    .from(schema.customerProperty)
    .innerJoin(schema.property, eq(schema.property.id, schema.customerProperty.propertyId))
    .where(inArray(schema.customerProperty.customerId, rows.map((r) => r.id)))
    .orderBy(desc(schema.customerProperty.isPrimary), asc(schema.property.addressLine1));
  return rows.slice(0, 10).map((r) => ({
    id: r.id, name: r.name, contactId: r.contactId,
    place: places.find((p) => p.customerId === r.id)?.line1 ?? null,
  }));
}

/**
 * The company a sign in page is for, by its public key, for the heading.
 *
 * The name and nothing else, which the booking page already shows to anybody
 * with the same slug. A suspended company has no sign in page: its customers'
 * links open nothing either.
 */
export async function companyNamed(db: Database, slug: string): Promise<{ name: string; slug: string }> {
  const org = await companyFor(db, slug);
  const [row] = await db.select({ name: schema.organization.name })
    .from(schema.organization).where(eq(schema.organization.id, org.id)).limit(1);
  return { name: row?.name ?? "", slug: org.slug };
}

/* ------------------------------------------------------------- the code */

export interface CodeRequested {
  /** Always true. The answer is the same whether or not the address is on file. */
  accepted: true;
  expiresInMinutes: number;
}

/**
 * Send a code, if the address belongs to a customer.
 *
 * Counted before anything else happens, per network address and per
 * address, so a refusal for asking too often costs nothing and sends
 * nothing. A second request supersedes the first: only the newest code
 * works, so a customer who asked twice and typed the first one is told to
 * use the newer one rather than being let in with either.
 */
export async function requestCode(
  db: Database,
  input: { organizationSlug: string; address: string },
  meta?: RequestMeta,
): Promise<CodeRequested> {
  const address = addressOrRefuse(input.address);
  const org = await companyFor(db, input.organizationSlug);

  await throttle(db, `portal-code:ip:${ipOf(meta)}`, cp.LIMITS.codesPerIp.limit, cp.LIMITS.codesPerIp.windowSeconds);
  const key = `portal-code:addr:${org.id}:${address.address}`;
  await throttle(db, key, cp.LIMITS.codesPerAddress.limit, cp.LIMITS.codesPerAddress.windowSeconds);
  await throttle(db, `${key}:day`, cp.LIMITS.codesPerAddressDaily.limit, cp.LIMITS.codesPerAddressDaily.windowSeconds);

  const ctx: ServiceContext = { actor: signInActor(org.id), db };
  await inTenant(ctx, async (tx) => {
    const now = new Date();

    /**
     * The same press arriving twice, from a phone on one bar, is the same
     * request: the code already on its way is the answer, and a second one
     * would kill the first while the customer is reading it.
     */
    if (meta?.idempotencyKey) {
      const [replay] = await tx.select({ id: schema.portalSignIn.id }).from(schema.portalSignIn)
        .where(and(
          eq(schema.portalSignIn.address, address.address),
          eq(schema.portalSignIn.requestKey, meta.idempotencyKey.slice(0, 200)),
          gt(schema.portalSignIn.expiresAt, now),
        )).limit(1);
      if (replay) return;
    }

    await tx.update(schema.portalSignIn)
      .set({ endedAt: now, endedReason: "superseded", updatedAt: now })
      .where(and(eq(schema.portalSignIn.address, address.address), isNull(schema.portalSignIn.endedAt)));

    const customers = await customersAt(tx, address);
    const id = randomUUID();
    const code = cp.newCode(() => randomInt(10));
    const expiresAt = new Date(now.getTime() + cp.CODE_TTL_MINUTES * 60_000);

    await tx.insert(schema.portalSignIn).values({
      id,
      organizationId: org.id,
      channel: address.channel,
      address: address.address,
      codeHash: customers.length > 0 ? codeHash(id, code) : null,
      expiresAt,
      matchedCustomerIds: customers.map((c) => c.id),
      ...(customers.length === 0 ? { endedAt: now, endedReason: "no_customer" } : {}),
      requestKey: meta?.idempotencyKey?.slice(0, 200) ?? null,
      requestedIp: meta?.ip?.slice(0, 64) ?? null,
    });

    if (customers.length === 0) return;

    const [company] = await tx.select({ name: schema.organization.name })
      .from(schema.organization).where(eq(schema.organization.id, org.id)).limit(1);
    const words = cp.codeMessage(company?.name ?? "", code);
    /** The one customer when it is one, so the message lands on their timeline. */
    const customerId = customers.length === 1 ? customers[0]!.id : null;

    let delivery: string;
    if (address.channel === "email") {
      const sent = await email.queue({ ...ctx, db: tx }, {
        to: address.address, subject: words.subject, text: words.text, customerId, purpose: "transactional",
      });
      delivery = sent.queued ? "queued" : sent.explanation;
    } else {
      const sent = await sendTransactional(tx, {
        organizationId: org.id, address: address.address, body: words.text, customerId,
      });
      delivery = sent.sent ? "queued" : sent.explanation;
    }
    await tx.update(schema.portalSignIn).set({ delivery, updatedAt: new Date() })
      .where(eq(schema.portalSignIn.id, id));
  });

  return { accepted: true, expiresInMinutes: cp.CODE_TTL_MINUTES };
}

export type CodeVerified =
  | { status: "signed_in"; token: string; expiresAt: string; customerName: string }
  /** The address is on more than one customer record, and the person has to say which. */
  | { status: "choose"; accounts: SignInAccount[] };

type Verdict = CodeVerified | { status: "refused" };

/**
 * Check a code and, when it is right, sign in.
 *
 * A wrong code is counted and REMEMBERED before the refusal is raised: the
 * transaction returns a verdict rather than throwing, because a throw would
 * roll the count back with it and a script could guess for ever. That is the
 * same lesson the upload queue learned, in `files.storeUpload`.
 *
 * An address on two customer records (a landlord who is also a homeowner, a
 * couple entered twice) is answered with the two, by name and first address,
 * and the code stays good until one is chosen or it expires. They are shown
 * only to somebody who has just proved they hold the address on both.
 */
export async function verifyCode(
  db: Database,
  input: { organizationSlug: string; address: string; code: string; customerId?: string | undefined },
  meta?: RequestMeta,
): Promise<CodeVerified> {
  const address = cp.signInAddress(input.address);
  const code = cp.normaliseCode(input.code);
  if (!address || !code) throw new SignInRefusedError(REFUSED);
  const org = await companyFor(db, input.organizationSlug);
  await throttle(db, `portal-check:ip:${ipOf(meta)}`, cp.LIMITS.checksPerIp.limit, cp.LIMITS.checksPerIp.windowSeconds);

  const ctx: ServiceContext = { actor: signInActor(org.id), db };
  const verdict = await inTenant(ctx, async (tx): Promise<Verdict> => {
    const now = new Date();
    const [row] = await tx.select().from(schema.portalSignIn)
      .where(and(
        eq(schema.portalSignIn.address, address.address),
        isNull(schema.portalSignIn.endedAt),
        isNotNull(schema.portalSignIn.codeHash),
        gt(schema.portalSignIn.expiresAt, now),
      ))
      .orderBy(desc(schema.portalSignIn.createdAt))
      .limit(1)
      .for("update");
    if (!row) return { status: "refused" };

    if (!sameHash(row.codeHash!, codeHash(row.id, code))) {
      const attempts = row.attempts + 1;
      const dead = attempts >= cp.MAX_CODE_ATTEMPTS;
      await tx.update(schema.portalSignIn).set({
        attempts,
        ...(dead ? { endedAt: now, endedReason: "too_many_attempts" } : {}),
        updatedAt: now,
      }).where(eq(schema.portalSignIn.id, row.id));
      return { status: "refused" };
    }

    const accounts = await customersAt(tx, address);
    if (accounts.length === 0) {
      /** Retired since the code went out. Nobody to sign in as. */
      await tx.update(schema.portalSignIn).set({ endedAt: now, endedReason: "no_customer", updatedAt: now })
        .where(eq(schema.portalSignIn.id, row.id));
      return { status: "refused" };
    }
    if (accounts.length > 1 && !input.customerId) {
      return { status: "choose", accounts: accounts.map(({ contactId: _contact, ...account }) => account) };
    }
    const chosen = input.customerId ? accounts.find((a) => a.id === input.customerId) : accounts[0];
    if (!chosen) return { status: "refused" };

    /** Spent in the same statement that checks it is unspent, so two presses cannot both sign in. */
    const spent = await tx.update(schema.portalSignIn).set({
      endedAt: now, endedReason: "signed_in", customerId: chosen.id, contactId: chosen.contactId,
      signedInIp: meta?.ip?.slice(0, 64) ?? null, updatedAt: now,
    }).where(and(eq(schema.portalSignIn.id, row.id), isNull(schema.portalSignIn.endedAt)))
      .returning({ id: schema.portalSignIn.id });
    if (spent.length === 0) return { status: "refused" };

    const { row: grant, token } = await mintGrant(tx, {
      organizationId: org.id,
      customerId: chosen.id,
      scope: "customer",
      expiresInDays: cp.SESSION_DAYS,
      signInId: row.id,
      contactId: chosen.contactId,
    });
    await audit(tx, { ...ctx, portalGrantId: grant.id, portalContactId: chosen.contactId },
      "portal.signed_in", "customer", chosen.id, null, {
        channel: row.channel, signInId: row.id, ...(chosen.contactId ? { contactId: chosen.contactId } : {}),
      });
    return {
      status: "signed_in", token, expiresAt: grant.expiresAt.toISOString(), customerName: chosen.name,
    };
  });

  if (verdict.status === "refused") throw new SignInRefusedError(REFUSED);
  return verdict;
}

/* ------------------------------------------------------------- the session */

export interface PortalSession {
  grant: ResolvedGrant;
  customerId: string;
  customerName: string;
  /** The contact signed in as the customer, when it is not the customer themselves. */
  contact: { id: string; name: string } | null;
  organizationName: string;
  organizationSlug: string;
  expiresAt: string;
}

/**
 * The signed in customer behind a cookie, or a refusal.
 *
 * Refuses an account LINK as firmly as an expired token. The two are the
 * same capability to read, and only one of them is a sign in: a link held
 * in a cookie would let a forwarded email save a card.
 */
export async function sessionFor(db: Database, token: string): Promise<PortalSession> {
  const grant = await peek(db, token);
  if (grant.scope !== "customer" || !grant.customerId) throw new InvalidGrantError();
  return inGrant(db, grant, async (tx) => {
    const [row] = await tx.select({
      signInId: schema.portalGrant.signInId,
      expiresAt: schema.portalGrant.expiresAt,
      customerName: schema.customer.name,
      customerDeleted: schema.customer.deletedAt,
    })
      .from(schema.portalGrant)
      .innerJoin(schema.customer, eq(schema.customer.id, schema.portalGrant.customerId))
      .where(eq(schema.portalGrant.id, grant.grantId)).limit(1);
    if (!row?.signInId || row.customerDeleted) throw new InvalidGrantError();
    /**
     * A contact's sign in ends the moment the office takes their access
     * away or removes them. Taking access away also revokes the grant; this
     * is the second lock, for a contact removed through a path that knows
     * nothing about sign ins.
     */
    let contact: PortalSession["contact"] = null;
    if (grant.contactId) {
      const [person] = await tx.select({ id: schema.contact.id, name: schema.contact.name })
        .from(schema.contact)
        .where(and(
          eq(schema.contact.id, grant.contactId),
          eq(schema.contact.customerId, grant.customerId!),
          isNotNull(schema.contact.portalAccessAt),
          isNull(schema.contact.deletedAt),
        )).limit(1);
      if (!person) throw new InvalidGrantError();
      contact = person;
    }
    const [org] = await tx.select({ name: schema.organization.name, slug: schema.organization.slug })
      .from(schema.organization).where(eq(schema.organization.id, grant.organizationId)).limit(1);
    return {
      grant,
      customerId: grant.customerId!,
      customerName: row.customerName,
      contact,
      organizationName: org?.name ?? "",
      organizationSlug: org?.slug ?? "",
      expiresAt: row.expiresAt.toISOString(),
    };
  });
}

/** Whether a resolved grant is somebody's own sign in, asked inside its tenant. */
export async function isSignedIn(tx: Database, grant: ResolvedGrant): Promise<boolean> {
  const [row] = await tx.select({ signInId: schema.portalGrant.signInId })
    .from(schema.portalGrant).where(eq(schema.portalGrant.id, grant.grantId)).limit(1);
  return Boolean(row?.signInId);
}

/**
 * Sign out: the session ends everywhere, not only in this browser.
 *
 * Only a sign in can be ended this way. An account link somebody was sent
 * is withdrawn by the office, with `portal:revoke`, and a customer posting
 * its token here is told it is not valid rather than quietly revoking a
 * link the office may have sent to two people.
 */
export async function signOut(db: Database, input: { token: string }): Promise<{ ok: true }> {
  const session = await sessionFor(db, input.token);
  await inGrant(db, session.grant, async (tx, ctx) => {
    await tx.update(schema.portalGrant).set({ revokedAt: new Date(), revokedReason: "signed_out", updatedAt: new Date() })
      .where(and(eq(schema.portalGrant.id, session.grant.grantId), isNull(schema.portalGrant.revokedAt)));
    await audit(tx, ctx, "portal.signed_out", "customer", session.customerId, null, null);
  });
  return { ok: true };
}

/* ------------------------------------------------- opening one record */

export type OpenKind = "estimate" | "job" | "invoice";

/**
 * A signed in customer opening one of their own estimates, jobs or
 * invoices, on the page made for it.
 *
 * The page behind each is the token page the company already sends links
 * to, so rather than a second copy of three pages there is a narrower link,
 * minted here for one record and one day, from a session that already
 * reaches the record. That is strictly less than the session holds, which
 * is the same reasoning that lets the logo be served from any link.
 *
 * Only from a sign in. An account link opening an estimate as an approval
 * link would let a forwarded account email approve work, which is the
 * widening a grant is built never to allow.
 */
export async function openRecord(
  db: Database, input: { token: string; kind: OpenKind; id: string },
): Promise<{ url: string }> {
  const session = await sessionFor(db, input.token);
  const customerId = session.customerId;
  return inGrant(db, session.grant, async (tx, ctx) => {
    let subjectCustomer: string;
    let maxUses: number | null = null;
    if (input.kind === "estimate") {
      const [row] = await tx.select({ customerId: schema.estimate.customerId, status: schema.estimate.status })
        .from(schema.estimate)
        .where(and(eq(schema.estimate.id, input.id), eq(schema.estimate.customerId, customerId))).limit(1);
      if (!row || row.status === "draft") throw new NotFoundError("Estimate");
      subjectCustomer = row.customerId;
      /** Approving spends it, as an approval link sent by the office is spent. */
      maxUses = 1;
    } else if (input.kind === "job") {
      const [row] = await tx.select({ customerId: schema.job.customerId }).from(schema.job)
        .where(and(eq(schema.job.id, input.id), eq(schema.job.customerId, customerId), isNull(schema.job.deletedAt)))
        .limit(1);
      if (!row) throw new NotFoundError("Job");
      subjectCustomer = row.customerId;
    } else {
      const [row] = await tx.select({
        customerId: schema.invoice.customerId,
        payerCustomerId: schema.invoice.payerCustomerId,
        status: schema.invoice.status,
      }).from(schema.invoice)
        .where(and(
          eq(schema.invoice.id, input.id),
          or(eq(schema.invoice.customerId, customerId), eq(schema.invoice.payerCustomerId, customerId)),
          isNull(schema.invoice.deletedAt),
        )).limit(1);
      if (!row || row.status === "draft") throw new NotFoundError("Invoice");
      subjectCustomer = row.payerCustomerId ?? row.customerId;
    }

    const minted = await mintGrant(tx, {
      organizationId: session.grant.organizationId,
      customerId: subjectCustomer,
      scope: input.kind,
      subjectId: input.id,
      expiresInDays: 1,
      maxUses,
      /** A contact's narrower link is still theirs, so approving from it is recorded as them. */
      contactId: session.grant.contactId,
    });
    await audit(tx, ctx, "portal.grant.issued", "portal_grant", minted.row.id, null, {
      scope: input.kind, subjectId: input.id, from: "sign_in",
    });
    return { url: minted.url };
  });
}

export const handlers = {
  requestPortalCode: (db: Database, input: { organizationSlug: string; address: string }, meta?: RequestMeta) =>
    requestCode(db, input, meta),
  verifyPortalCode: (
    db: Database,
    input: { organizationSlug: string; address: string; code: string; customerId?: string | undefined },
    meta?: RequestMeta,
  ) => verifyCode(db, input, meta),
  signOutOfPortal: (db: Database, input: { token: string }) => signOut(db, input),
  openPortalRecord: (db: Database, input: { token: string; kind: OpenKind; id: string }) => openRecord(db, input),
} as const;
