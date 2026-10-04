import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, comms, marketplaces as mp, marketing as mk, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";
import { resolveConnectorChannel } from "./lead-connectors";
import { receiveLead } from "./lead-intake";
import { keepMessageIn } from "./marketplace-leads";
import * as email from "./email";
import type { InboundEmail } from "../email/provider";

/**
 * THE LEAD INBOX: MARKETPLACE LEADS BY EMAIL
 *
 * Every marketplace emails the company when it sells it a lead, whether or
 * not it will let the company's software near its API. Angi and Thumbtack
 * want a partner agreement first, Yelp the same, and Nextdoor has no API for
 * a business's enquiries at all. The email is the one thing all of them send.
 *
 * So each company has one address, `leads+TOKEN@` the domain its email
 * provider receives replies on, and a rule in its mailbox forwards the
 * marketplaces' lead emails to it. Each one arrives through the same signed
 * email webhook replies do, is read by core's label reader, and becomes a lead
 * offer credited to the platform it came from, exactly as a webhook lead is.
 *
 * NOTHING IS DROPPED. An email this cannot read (a redesign, a lead with no
 * number, the mailbox's own confirmation of the forwarding rule) is kept with
 * the reason, and the lead sources screen lists it, because the cost of a
 * lead nobody saw is the lead.
 *
 * ONE LEAD, HOWEVER IT ARRIVES. A company forwarding Thumbtack's emails that
 * later gets Thumbtack's API, or forwards the same email twice, would get the
 * lead twice. A lead is found again by the platform's own lead number when
 * the email carries one, and otherwise by the same phone or email from the
 * same platform in the last three days.
 */

const DUPLICATE_DAYS = 3;
const MESSAGE_MATCH_DAYS = 30;
const EXCERPT = 2000;

function inboxActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "lead-inbox" };
}

const newToken = () => randomBytes(18).toString("base64url").toLowerCase().replace(/[^a-z0-9]/g, "x");

/** Read by the catalogue test, beside the marketplaces' own adapters. */
export const registeredLeadEmailReaders = (): string[] => ["lead_email", ...mp.MARKETPLACE_KEYS.filter((k) => mp.MARKETPLACES[k].api === "none")];

/* ---------------------------------------------------------------- the address */

export interface LeadInboxView {
  /** The address to forward to, or null while the company cannot receive email. */
  address: string | null;
  /** Why there is no address yet, in words. */
  missing: string | null;
  platforms: { key: string; label: string; api: string; replies: boolean; needsApproval: boolean; approval: string }[];
}

async function tokenFor(tx: Database, organizationId: string): Promise<string> {
  const [held] = await tx.select({ token: schema.leadInbox.token }).from(schema.leadInbox)
    .where(eq(schema.leadInbox.organizationId, organizationId)).limit(1);
  if (held) return held.token;
  /**
   * Minted the first time anybody looks, like a customer's referral code:
   * an address nobody has asked for is an address nothing needs.
   */
  await tx.insert(schema.leadInbox).values({ organizationId, token: newToken() }).onConflictDoNothing();
  const [made] = await tx.select({ token: schema.leadInbox.token }).from(schema.leadInbox)
    .where(eq(schema.leadInbox.organizationId, organizationId)).limit(1);
  return made!.token;
}

async function receivingDomain(tx: Database, organizationId: string): Promise<{ domain: string | null; missing: string | null }> {
  const [connection] = await tx.select().from(schema.integrationConnection).where(and(
    eq(schema.integrationConnection.organizationId, organizationId),
    eq(schema.integrationConnection.capability, "email"),
    eq(schema.integrationConnection.status, "connected"),
    isNull(schema.integrationConnection.deletedAt),
  )).limit(1);
  if (!connection) {
    return { domain: null, missing: "Connect an email provider that receives mail on Settings, Integrations first. The lead inbox is an address on its receiving domain." };
  }
  const domain = email.replyDomainOf((connection.settings ?? {}) as Record<string, unknown>);
  if (!domain) {
    return { domain: null, missing: "Enter the domain your email provider receives replies on (Settings, Integrations, Email). The lead inbox is an address on it." };
  }
  return { domain, missing: null };
}

const platformsList = () => mp.MARKETPLACE_KEYS.map((key) => {
  const spec = mp.MARKETPLACES[key];
  return { key, label: spec.label, api: spec.api, replies: spec.replies, needsApproval: spec.needsApproval, approval: spec.approval };
});

export async function inbox(ctx: ServiceContext): Promise<LeadInboxView> {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const { domain, missing } = await receivingDomain(tx, ctx.actor.organizationId);
    if (!domain) return { address: null, missing, platforms: platformsList() };
    const token = await tokenFor(tx, ctx.actor.organizationId);
    return { address: mp.leadInboxAddress(token, domain), missing: null, platforms: platformsList() };
  });
}

/**
 * A new address, the old one stopped. For an address that leaked into a
 * spammer's list: forwarding rules have to be changed to the new one, which
 * the screen says.
 */
export async function rotateInbox(ctx: ServiceContext): Promise<LeadInboxView> {
  await guardedWrite(ctx, "integration:write", async (tx) => {
    const again = await replayed<{ rotated: true }>(tx, ctx, "lead_inbox");
    if (again) return;
    const token = newToken();
    const [row] = await tx.insert(schema.leadInbox).values({ organizationId: ctx.actor.organizationId, token, rotatedAt: new Date() })
      .onConflictDoUpdate({
        target: [schema.leadInbox.organizationId],
        set: { token, rotatedAt: new Date(), updatedAt: new Date() },
      }).returning({ id: schema.leadInbox.id });
    await audit(tx, ctx, "lead_inbox.rotated", "lead_inbox", row!.id, null, null);
    await remember(tx, ctx, "lead_inbox", row!.id, { rotated: true });
  });
  return inbox(ctx);
}

/** Which company a lead inbox token belongs to, before any company is known. */
export async function organizationForToken(db: Database, token: string): Promise<string | null> {
  if (!/^[a-z0-9_-]{16,64}$/.test(token)) return null;
  const [row] = await db.select({ organizationId: schema.leadInbox.organizationId }).from(schema.leadInbox)
    .where(eq(schema.leadInbox.token, token)).limit(1);
  return row?.organizationId ?? null;
}

/* ------------------------------------------------------------- receiving */

export type LeadEmailOutcome =
  | { kind: "lead"; leadEmailId: string; offerId: string; platform: string }
  | { kind: "message"; leadEmailId: string; offerId: string; platform: string }
  | { kind: "duplicate"; leadEmailId: string; offerId: string | null }
  | { kind: "unreadable"; leadEmailId: string; reason: string };

/** The email connector a platform's emailed leads arrive under, made the first time one does. */
async function emailConnector(tx: Database, organizationId: string, platform: mp.MarketplaceKey): Promise<string> {
  const [existing] = await tx.select({ id: schema.leadSourceConnector.id }).from(schema.leadSourceConnector).where(and(
    eq(schema.leadSourceConnector.organizationId, organizationId),
    eq(schema.leadSourceConnector.kind, "email"),
    eq(schema.leadSourceConnector.source, platform),
    isNull(schema.leadSourceConnector.deletedAt),
  )).limit(1);
  if (existing) return existing.id;
  /**
   * Credited like the platform's API connector would be: to its channel when
   * the company has one named for it, else through the alias list to the
   * marketplace channel. A company that buys Thumbtack under a tracking
   * campaign chooses it on the lead sources screen, for either connector.
   */
  const [api] = await tx.select({ channelId: schema.leadSourceConnector.channelId, campaignId: schema.leadSourceConnector.acquisitionCampaignId })
    .from(schema.leadSourceConnector).where(and(
      eq(schema.leadSourceConnector.organizationId, organizationId),
      eq(schema.leadSourceConnector.kind, platform),
      isNull(schema.leadSourceConnector.deletedAt),
    )).limit(1);
  const channel = await resolveConnectorChannel(tx, organizationId, { source: platform, channelId: api?.channelId ?? null });
  const [made] = await tx.insert(schema.leadSourceConnector).values({
    organizationId,
    source: platform,
    kind: "email",
    channelId: channel.channelId,
    acquisitionCampaignId: api?.campaignId ?? null,
    displayName: `${mp.MARKETPLACES[platform].label} (by email)`,
    active: true,
  }).returning({ id: schema.leadSourceConnector.id });
  return made!.id;
}

/** Every connector of this platform's, by API or by email, which a lead is looked for under. */
async function connectorsOf(tx: Database, organizationId: string, platform: string): Promise<string[]> {
  const rows = await tx.select({ id: schema.leadSourceConnector.id }).from(schema.leadSourceConnector).where(and(
    eq(schema.leadSourceConnector.organizationId, organizationId),
    eq(schema.leadSourceConnector.source, platform),
  ));
  return rows.map((r) => r.id);
}

/**
 * One email that arrived at the lead inbox. Called by the email webhook once
 * the provider's signature has passed and the recipient's token named the
 * company.
 */
export async function receive(db: Database, organizationId: string, arrived: InboundEmail): Promise<LeadEmailOutcome> {
  const ctx: ServiceContext = { actor: inboxActor(organizationId), db };
  return inTenant(ctx, async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lead-email:${organizationId}:${arrived.providerMessageId}`}))`);
    const [seen] = await tx.select({ id: schema.leadEmail.id, offerId: schema.leadEmail.offerId }).from(schema.leadEmail).where(and(
      eq(schema.leadEmail.organizationId, organizationId), eq(schema.leadEmail.providerMessageId, arrived.providerMessageId),
    )).limit(1);
    if (seen) return { kind: "duplicate", leadEmailId: seen.id, offerId: seen.offerId };

    const verdict = mp.parseLeadEmail({
      from: arrived.from, subject: arrived.subject, text: arrived.text, html: arrived.html,
      replyTo: arrived.headers["reply-to"] ?? null,
    });
    const text = arrived.text ?? (arrived.html ? comms.textFromHtml(arrived.html) : "");
    const record = async (values: { outcome: string; platform: string | null; reason?: string | null; offerId?: string | null }) => {
      const [row] = await tx.insert(schema.leadEmail).values({
        organizationId,
        providerMessageId: arrived.providerMessageId,
        fromAddress: arrived.from.slice(0, 300),
        subject: arrived.subject.slice(0, 500) || null,
        platform: values.platform,
        outcome: values.outcome,
        reason: values.reason ?? null,
        offerId: values.offerId ?? null,
        excerpt: text.slice(0, EXCERPT),
      }).returning({ id: schema.leadEmail.id });
      return row!.id;
    };

    if (!verdict.ok) {
      const id = await record({ outcome: "unreadable", platform: verdict.platform, reason: verdict.reason });
      return { kind: "unreadable", leadEmailId: id, reason: verdict.reason };
    }
    const { platform, lead } = verdict;
    const connectorIds = await connectorsOf(tx, organizationId, platform);

    /* The customer wrote again on a lead already here: a line in its thread, not a second lead. */
    if (lead.kind === "message" && connectorIds.length > 0) {
      const since = new Date(Date.now() - MESSAGE_MATCH_DAYS * 86_400_000);
      const [offer] = await tx.select({ id: schema.leadOffer.id }).from(schema.leadOffer).where(and(
        inArray(schema.leadOffer.connectorId, connectorIds),
        gte(schema.leadOffer.createdAt, since),
        sql`lower(${schema.leadOffer.contactName}) = lower(${lead.name})`,
      )).orderBy(desc(schema.leadOffer.createdAt)).limit(1);
      if (offer) {
        await keepMessageIn(tx, organizationId, offer.id, {
          externalId: `email:${arrived.providerMessageId}`.slice(0, 300),
          body: (lead.notes ?? text).slice(0, 4000),
          at: new Date(),
          from: "customer",
        });
        const id = await record({ outcome: "message", platform, offerId: offer.id });
        return { kind: "message", leadEmailId: id, offerId: offer.id, platform };
      }
    }

    /* Not a message on a lead here after all: a lead, which needs somebody to call. */
    if (!lead.phone && !lead.email) {
      const reason = mp.noReach(platform, lead.name);
      const id = await record({ outcome: "unreadable", platform, reason });
      return { kind: "unreadable", leadEmailId: id, reason };
    }

    /* The same lead by its platform number, or by the same person from the same platform lately. */
    if (connectorIds.length > 0) {
      const caller = mk.callerKey(lead.phone);
      const since = new Date(Date.now() - DUPLICATE_DAYS * 86_400_000);
      const candidates = await tx.select({
        id: schema.leadOffer.id, externalId: schema.leadOffer.externalId,
        phone: schema.leadOffer.contactPhone, email: schema.leadOffer.contactEmail, createdAt: schema.leadOffer.createdAt,
      }).from(schema.leadOffer).where(inArray(schema.leadOffer.connectorId, connectorIds))
        .orderBy(desc(schema.leadOffer.createdAt)).limit(500);
      const same = candidates.find((c) => lead.externalId !== null && c.externalId === lead.externalId)
        ?? candidates.find((c) => c.createdAt >= since && (
          (caller !== null && mk.callerKey(c.phone) === caller)
          || (lead.email !== null && c.email?.toLowerCase() === lead.email.toLowerCase())));
      if (same) {
        const id = await record({ outcome: "duplicate", platform, offerId: same.id });
        return { kind: "duplicate", leadEmailId: id, offerId: same.id };
      }
    }

    const connectorId = await emailConnector(tx, organizationId, platform);
    const outcome = await receiveLead(tx, {
      connectorId,
      organizationId,
      lead: {
        /** The platform's number, else a fingerprint of the email, so a second delivery of it is the same lead. */
        externalId: lead.externalId ?? `email:${createHash("sha256").update(arrived.providerMessageId).digest("hex").slice(0, 32)}`,
        contactName: lead.name,
        contactEmail: lead.email,
        contactPhone: lead.phone,
        addressLine1: lead.addressLine1,
        city: lead.city,
        state: lead.state,
        postalCode: lead.postalCode,
        serviceRequested: lead.service,
        notes: lead.notes,
        estimatedValue: null,
        expiresAt: null,
        source: platform,
        raw: { from: arrived.from, subject: arrived.subject, providerMessageId: arrived.providerMessageId },
      },
    });
    const id = await record({ outcome: outcome.duplicate ? "duplicate" : "lead", platform, offerId: outcome.offerId });
    return outcome.duplicate
      ? { kind: "duplicate", leadEmailId: id, offerId: outcome.offerId }
      : { kind: "lead", leadEmailId: id, offerId: outcome.offerId!, platform };
  });
}

/* ----------------------------------------------------------------- reading */

export async function list(ctx: ServiceContext, input: { outcome?: string | undefined; limit?: number | undefined } = {}) {
  return guardedRead(ctx, "job:read", async (tx) => {
    const outcomes = ["lead", "message", "duplicate", "unreadable"];
    const rows = await tx.select().from(schema.leadEmail).where(and(
      eq(schema.leadEmail.organizationId, ctx.actor.organizationId),
      ...(input.outcome && outcomes.includes(input.outcome) ? [eq(schema.leadEmail.outcome, input.outcome)] : []),
    )).orderBy(desc(schema.leadEmail.receivedAt)).limit(Math.min(input.limit ?? 100, 500));
    return rows.map((row) => ({
      id: row.id,
      receivedAt: row.receivedAt.toISOString(),
      from: row.fromAddress,
      subject: row.subject,
      platform: row.platform,
      platformLabel: row.platform && mp.isMarketplace(row.platform) ? mp.MARKETPLACES[row.platform].label : null,
      outcome: row.outcome,
      reason: row.reason,
      offerId: row.offerId,
      excerpt: row.excerpt,
    }));
  });
}

export const handlers = {
  getLeadInbox: (ctx: ServiceContext) => inbox(ctx),
  rotateLeadInbox: (ctx: ServiceContext) => rotateInbox(ctx),
  listLeadEmails: async (ctx: ServiceContext, input: { outcome?: string | undefined; limit?: number | undefined }) =>
    ({ emails: await list(ctx, input) }),
} as const;
