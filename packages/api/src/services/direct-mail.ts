import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNull, lt, ne, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  SYSTEM_USER_ID, campaign as cp, directMail as dm, money as m, time, type Actor,
} from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { replayed, remember } from "./once";
import * as acquisition from "./acquisition";
import { clauseFor, parseRules, utmFor, MAX_AUDIENCE } from "./campaigns";
import { revenueByJob } from "./marketing";
import { senderFor } from "./phone-numbers";
import { render } from "../lib/render";
import {
  PlatformRefusedError, createMailProvider, type HttpTransport, type MailParty,
} from "../direct-mail/index";
import { readerFor } from "../secrets/store";

/**
 * DIRECT MAIL: SENDING A MAILING AND CREDITING WHAT COMES BACK
 *
 * The audience is the text campaigns' audience: the same nine rules, the same
 * refusal of an empty list, the same "frozen at send" rule. Pressing Send
 * runs the rules once and writes one piece per customer they select, each
 * with the address it is going to, a code of its own, and a reason when it
 * cannot be posted at all. From then on who it went to is a fact.
 *
 * The pieces go to the mail house a hundred at a time, each under its own id
 * as the printer's idempotency key, so a send retried after a timeout prints
 * nobody twice; a mailing larger than that is finished by the worker. What a
 * day's pieces cost is written as spend on the mailing's tracking campaign,
 * found again by the mailing and the day, so the funnel shows the mailing's
 * cost against what it brought like any other channel's.
 *
 * WHAT IT BRINGS is read three ways, all onto the same tracking campaign:
 * calls to its tracking number (call tracking, already there), visits to each
 * piece's own address (a touch on the customer it was addressed to, below),
 * and the jobs `creditWork` then credits to that campaign.
 */

export interface MailDeps {
  transport?: HttpTransport | undefined;
  readSecret?: ((ref: string) => Promise<string>) | undefined;
  env?: Record<string, string | undefined> | undefined;
  now?: (() => Date) | undefined;
}

/** Pieces handed to the printer per send, and per worker pass. */
export const MAIL_BATCH = 100;
/** A piece the printer could not be reached for is tried this many times, then left as failed for a person. */
const MAX_ATTEMPTS = 5;

function mailActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "direct-mail" };
}

type MailRow = typeof schema.mailCampaign.$inferSelect;

/* --------------------------------------------------------------- writing */

export interface MailCampaignInput {
  name: string;
  kind: dm.MailKind;
  size?: string | null | undefined;
  /** Core's audience rules, checked by `parseRules` on every write: what arrives is not trusted to be them. */
  audience: readonly unknown[];
  /** The tracking campaign responses are credited to. Left out, one is made under the direct mail channel. */
  acquisitionCampaignId?: string | null | undefined;
  front: string;
  back?: string | null | undefined;
  landingHeadline?: string | null | undefined;
  landingBody?: string | null | undefined;
  pricePerPiece?: string | null | undefined;
}

function checkInput(input: Pick<MailCampaignInput, "kind" | "size" | "front" | "back" | "pricePerPiece" | "name">) {
  if (input.name.trim() === "") throw new ConflictError("Name the mailing.");
  if (!dm.MAIL_KINDS.includes(input.kind)) throw new ConflictError("A mailing is a postcard or a letter.");
  if (input.kind === "postcard" && input.size && !(dm.POSTCARD_SIZES as readonly string[]).includes(input.size)) {
    throw new ConflictError(`A postcard is ${dm.POSTCARD_SIZES.join(", ")}.`);
  }
  const design = dm.checkDesign({ kind: input.kind, front: input.front, back: input.back ?? null });
  if (!design.ok) throw new ConflictError(design.reason);
  if (input.pricePerPiece) {
    const price = m.money(input.pricePerPiece);
    if (m.isNegative(price)) throw new ConflictError("A price per piece cannot be less than nothing.");
  }
}

/**
 * The tracking campaign a mailing is credited to: the one chosen, or one made
 * under the direct mail channel with the mailing's name (or found, when a live
 * one already has that name), carrying a utm tag from the name so the booking
 * link on the landing page credits it too.
 */
async function trackingCampaignFor(tx: Database, organizationId: string, input: { name: string; acquisitionCampaignId?: string | null | undefined }) {
  if (input.acquisitionCampaignId) {
    const campaign = await acquisition.loadCampaign(tx, organizationId, input.acquisitionCampaignId);
    if (campaign.archivedAt) throw new ConflictError(`${campaign.name} is archived. Choose a live tracking campaign.`);
    return campaign.id;
  }
  const name = input.name.trim();
  const [same] = await tx.select({ id: schema.acquisitionCampaign.id }).from(schema.acquisitionCampaign).where(and(
    eq(schema.acquisitionCampaign.organizationId, organizationId),
    sql`lower(${schema.acquisitionCampaign.name}) = lower(${name})`,
    isNull(schema.acquisitionCampaign.archivedAt),
  )).limit(1);
  if (same) return same.id;
  const channelId = await acquisition.channelForSource(tx, organizationId, "direct_mail");
  if (!channelId) throw new ConflictError("The direct mail channel is archived. Bring it back on Marketing, Channels, or choose a tracking campaign.");
  const utm = utmFor(name);
  const [taken] = await tx.select({ id: schema.acquisitionCampaign.id }).from(schema.acquisitionCampaign).where(and(
    eq(schema.acquisitionCampaign.organizationId, organizationId),
    sql`lower(${schema.acquisitionCampaign.utmCampaign}) = lower(${utm})`,
    isNull(schema.acquisitionCampaign.archivedAt),
  )).limit(1);
  const [made] = await tx.insert(schema.acquisitionCampaign).values({
    organizationId, channelId, name, costModel: "recorded", utmCampaign: taken ? null : utm,
    notes: "Made for a direct mail campaign. Its spend is the mailing's cost, written when the pieces go.",
  }).returning({ id: schema.acquisitionCampaign.id });
  return made!.id;
}

export async function create(ctx: ServiceContext, input: MailCampaignInput) {
  return guardedWrite(ctx, "campaign:write", async (tx) => {
    const again = await replayed<{ id: string }>(tx, ctx, "mail_campaign");
    if (again) return again;
    checkInput(input);
    const rules = parseRules(input.audience);
    const org = ctx.actor.organizationId;
    const acquisitionCampaignId = await trackingCampaignFor(tx, org, input);
    const [row] = await tx.insert(schema.mailCampaign).values({
      organizationId: org,
      name: input.name.trim(),
      kind: input.kind,
      size: input.kind === "postcard" ? input.size ?? "4x6" : null,
      audience: rules as unknown as Record<string, unknown>[],
      acquisitionCampaignId,
      front: input.front,
      back: input.kind === "postcard" ? input.back ?? null : null,
      landingHeadline: input.landingHeadline?.trim() || null,
      landingBody: input.landingBody?.trim() || null,
      pricePerPiece: input.pricePerPiece || null,
      createdByUserId: ctx.actor.userId === SYSTEM_USER_ID ? null : ctx.actor.userId,
    }).returning({ id: schema.mailCampaign.id });
    await audit(tx, ctx, "mail_campaign.created", "mail_campaign", row!.id, null, { name: input.name, kind: input.kind });
    const answer = { id: row!.id };
    await remember(tx, ctx, "mail_campaign", row!.id, answer);
    return answer;
  });
}

export type MailCampaignPatch = { [K in keyof MailCampaignInput]?: MailCampaignInput[K] | undefined } & { id: string };

export async function update(ctx: ServiceContext, input: MailCampaignPatch) {
  return guardedWrite(ctx, "campaign:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    if (before.state !== "draft") {
      throw new ConflictError("This mailing has gone to the printer, and what is in letterboxes cannot be edited. Copy it into a new one.");
    }
    const merged = {
      name: input.name ?? before.name,
      kind: (input.kind ?? before.kind) as dm.MailKind,
      size: input.size !== undefined ? input.size : before.size,
      front: input.front ?? before.front,
      back: input.back !== undefined ? input.back : before.back,
      pricePerPiece: input.pricePerPiece !== undefined ? input.pricePerPiece : before.pricePerPiece,
    };
    checkInput(merged);
    const rules = input.audience ? parseRules(input.audience) : undefined;
    const acquisitionCampaignId = input.acquisitionCampaignId
      ? await trackingCampaignFor(tx, ctx.actor.organizationId, { name: merged.name, acquisitionCampaignId: input.acquisitionCampaignId })
      : undefined;
    const [after] = await tx.update(schema.mailCampaign).set({
      name: merged.name.trim(),
      kind: merged.kind,
      size: merged.kind === "postcard" ? merged.size ?? "4x6" : null,
      front: merged.front,
      back: merged.kind === "postcard" ? merged.back : null,
      pricePerPiece: merged.pricePerPiece || null,
      ...(rules ? { audience: rules as unknown as Record<string, unknown>[] } : {}),
      ...(acquisitionCampaignId ? { acquisitionCampaignId } : {}),
      ...(input.landingHeadline !== undefined ? { landingHeadline: input.landingHeadline?.trim() || null } : {}),
      ...(input.landingBody !== undefined ? { landingBody: input.landingBody?.trim() || null } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.mailCampaign.id, input.id)).returning();
    await audit(tx, ctx, "mail_campaign.updated", "mail_campaign", input.id, { name: before.name }, { name: after!.name });
    return { id: input.id };
  });
}

export async function cancel(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "campaign:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    if (before.state === "cancelled") return { id: input.id, state: "cancelled" };
    if (!dm.canTransition(before.state, "cancelled")) {
      throw new ConflictError("This mailing has all gone to the printer. Nothing is left to stop.");
    }
    await tx.update(schema.mailCampaign).set({ state: "cancelled", updatedAt: new Date() }).where(eq(schema.mailCampaign.id, input.id));
    /** Pieces not yet with the printer are stopped and say so; the ones that went stay as they are. */
    await tx.update(schema.mailPiece).set({ status: "skipped", reason: "cancelled", updatedAt: new Date() })
      .where(and(eq(schema.mailPiece.mailCampaignId, input.id), inArray(schema.mailPiece.status, ["pending", "failed"])));
    await audit(tx, ctx, "mail_campaign.cancelled", "mail_campaign", input.id, { state: before.state }, { state: "cancelled" });
    return { id: input.id, state: "cancelled" };
  });
}

async function load(tx: Database, organizationId: string, id: string): Promise<MailRow> {
  const [row] = await tx.select().from(schema.mailCampaign)
    .where(and(eq(schema.mailCampaign.organizationId, organizationId), eq(schema.mailCampaign.id, id))).limit(1);
  if (!row) throw new NotFoundError("Mailing");
  return row;
}

/* -------------------------------------------------------------- audience */

interface MailCandidate {
  customerId: string;
  name: string;
  propertyId: string | null;
  address: dm.MailAddress;
}

/**
 * Who the rules select, with where to post to: the customer's primary
 * property, which is the house the work is done at and the letterbox a
 * service offer belongs in, else the billing address. A customer with
 * neither is still selected, and skipped with the reason when it is sent.
 */
async function select(tx: Database, rules: readonly cp.AudienceRule[], limit: number): Promise<MailCandidate[]> {
  if (rules.length === 0) throw new ConflictError("An audience with no rules would be everybody. Refused.");
  const rows = await tx.execute<{
    customer_id: string; name: string; property_id: string | null;
    p_line1: string | null; p_line2: string | null; p_city: string | null; p_state: string | null; p_postal: string | null;
    b_line1: string | null; b_line2: string | null; b_city: string | null; b_state: string | null; b_postal: string | null;
  }>(sql`
    select c.id as customer_id, c.name, p.id as property_id,
           p.address_line1 as p_line1, p.address_line2 as p_line2, p.city as p_city, p.state as p_state, p.postal_code as p_postal,
           c.billing_address_line1 as b_line1, c.billing_address_line2 as b_line2, c.billing_city as b_city,
           c.billing_state as b_state, c.billing_postal_code as b_postal
      from public.customer c
      left join lateral (
        select pr.* from public.customer_property cpr
          join public.property pr on pr.id = cpr.property_id
         where cpr.customer_id = c.id and pr.deleted_at is null
         order by cpr.is_primary desc, cpr.created_at asc
         limit 1
      ) p on true
     where c.deleted_at is null
       and c.do_not_service = false
       and c.merged_into_id is null
       and ${sql.join(rules.map(clauseFor), sql` and `)}
     order by c.name asc, c.id asc
     limit ${limit}
  `);
  return [...rows].map((r) => {
    const property: dm.MailAddress = { name: r.name, line1: r.p_line1, line2: r.p_line2, city: r.p_city, state: r.p_state, postalCode: r.p_postal };
    const billing: dm.MailAddress = { name: r.name, line1: r.b_line1, line2: r.b_line2, city: r.b_city, state: r.b_state, postalCode: r.b_postal };
    const useProperty = dm.checkAddress(property).ok || !dm.checkAddress(billing).ok && r.p_line1 !== null;
    return { customerId: r.customer_id, name: r.name, propertyId: useProperty ? r.property_id : null, address: useProperty ? property : billing };
  });
}

/**
 * The company's name, the number on the card, and the return address.
 *
 * The company's own address and number from its details (Settings, Company)
 * first, because that is the address printed on its invoices and the one a
 * returned card should come back to; the first office location with a full
 * address when the details have none.
 */
async function senderOf(tx: Database, organizationId: string, campaign: MailRow) {
  const [org] = await tx.select({
    name: schema.organization.name, slug: schema.organization.slug, phone: schema.organization.phone,
    line1: schema.organization.addressLine1, line2: schema.organization.addressLine2,
    city: schema.organization.city, state: schema.organization.state, postalCode: schema.organization.postalCode,
  }).from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const main = org?.phone ? null : await senderFor(tx, organizationId, { smsRequired: false, purpose: "conversation" });
  /** The mailing's own tracking number, which is what credits a call from the card to it. */
  const [tracking] = await tx.select({ e164: schema.phoneNumber.e164 }).from(schema.phoneNumber).where(and(
    eq(schema.phoneNumber.organizationId, organizationId),
    eq(schema.phoneNumber.acquisitionCampaignId, campaign.acquisitionCampaignId),
    isNull(schema.phoneNumber.releasedAt),
  )).orderBy(asc(schema.phoneNumber.createdAt)).limit(1);
  const name = org?.name ?? "";
  const own = { name, line1: org?.line1 ?? null, line2: org?.line2 ?? null, city: org?.city ?? null, state: org?.state ?? null, postalCode: org?.postalCode ?? null };
  let returnAddress: MailParty | null = dm.checkAddress(own).ok
    ? { name, line1: own.line1!, line2: own.line2, city: own.city!, state: own.state!, postalCode: own.postalCode! }
    : null;
  if (!returnAddress) {
    const offices = await tx.select().from(schema.location).where(and(
      eq(schema.location.organizationId, organizationId), eq(schema.location.active, true),
    )).orderBy(asc(schema.location.isWarehouse), asc(schema.location.createdAt));
    const office = offices.find((l) => dm.checkAddress({
      name, line1: l.addressLine1, line2: l.addressLine2, city: l.city, state: l.state, postalCode: l.postalCode,
    }).ok);
    if (office) {
      returnAddress = { name, line1: office.addressLine1!, line2: office.addressLine2, city: office.city!, state: office.state!, postalCode: office.postalCode! };
    }
  }
  return {
    companyName: name,
    slug: org?.slug ?? "",
    companyPhone: dm.printedPhone(org?.phone ?? main?.e164 ?? null),
    trackingPhone: dm.printedPhone(tracking?.e164 ?? null),
    returnAddress,
  };
}

/* --------------------------------------------------------------- preview */

export async function preview(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "campaign:read", async (tx) => {
    const org = ctx.actor.organizationId;
    const campaign = await load(tx, org, input.id);
    const rules = parseRules(campaign.audience);
    const selected = await select(tx, rules, MAX_AUDIENCE + 1);
    const postable = selected.filter((c) => dm.checkAddress(c.address).ok);
    const sender = await senderOf(tx, org, campaign);
    const first = postable[0] ?? selected[0] ?? null;
    const base = process.env["PUBLIC_URL"] ?? "https://your-installation";
    const sampleScope = dm.mailScope({
      customerName: first?.name ?? "Maria Lopez",
      companyName: sender.companyName,
      companyPhone: sender.companyPhone,
      url: dm.mailUrl(base, "k7p2x9qrta"),
      phone: sender.trackingPhone,
      code: "k7p2x9qrta",
    });
    return {
      id: campaign.id,
      sentence: cp.describeAudience(rules),
      selected: Math.min(selected.length, MAX_AUDIENCE),
      overflow: selected.length > MAX_AUDIENCE,
      postable: Math.min(postable.length, MAX_AUDIENCE),
      noAddress: selected.filter((c) => !dm.checkAddress(c.address).ok).length,
      estimatedCost: dm.mailCost(Math.min(postable.length, MAX_AUDIENCE), campaign.pricePerPiece),
      trackingPhone: sender.trackingPhone,
      returnAddress: sender.returnAddress,
      sample: selected.slice(0, 10).map((c) => ({
        customerId: c.customerId,
        name: c.name,
        address: [c.address.line1, c.address.city, c.address.state, c.address.postalCode].filter(Boolean).join(", "),
        postable: dm.checkAddress(c.address).ok,
      })),
      /** As the first person on the list will get it, escaped as it will be printed. Shown in a frame that runs nothing. */
      front: render(campaign.front, sampleScope),
      back: campaign.back ? render(campaign.back, sampleScope) : null,
    };
  });
}

/* ------------------------------------------------------------------ send */

const newCode = (): string => {
  for (;;) {
    const code = dm.codeFrom(randomBytes(32));
    if (code) return code;
  }
};

export interface MailSendReport {
  id: string;
  state: string;
  pieces: number;
  sent: number;
  skipped: number;
  refused: number;
  failed: number;
  pending: number;
}

/**
 * Send a mailing: freeze its audience the first time, then hand the next batch
 * to the printer. Safe to repeat: the pieces are written once, each piece is
 * printed under its own id, and a second press sends the next batch.
 */
export async function send(ctx: ServiceContext, input: { id: string }, deps: MailDeps = {}): Promise<MailSendReport> {
  const again = await guardedWrite(ctx, "campaign:write", (tx) => replayed<MailSendReport>(tx, ctx, "mail_send"));
  if (again) return again;
  const env = deps.env ?? process.env;
  if (!env["PUBLIC_URL"]) {
    throw new ConflictError("Set PUBLIC_URL first. Every piece prints its own web address on this installation, and without it there is nothing to print.");
  }
  await guardedWrite(ctx, "campaign:write", async (tx) => {
    const org = ctx.actor.organizationId;
    const campaign = await load(tx, org, input.id);
    if (campaign.state === "cancelled") throw new ConflictError("This mailing was cancelled.");
    if (campaign.state !== "draft") return;
    await mailConnection(tx, org);
    const sender = await senderOf(tx, org, campaign);
    if (!sender.returnAddress) {
      throw new ConflictError("Add the company's address under Settings, Company first. It is the return address on every piece, and the post office will not take mail without one.");
    }
    const rules = parseRules(campaign.audience);
    const selected = await select(tx, rules, MAX_AUDIENCE);
    if (selected.length === 0) throw new ConflictError(`Nobody is ${cp.describeAudience(rules)} right now, so there is nothing to post.`);
    for (let i = 0; i < selected.length; i += 500) {
      await tx.insert(schema.mailPiece).values(selected.slice(i, i + 500).map((c) => {
        const verdict = dm.checkAddress(c.address);
        return {
          organizationId: org,
          mailCampaignId: campaign.id,
          customerId: c.customerId,
          propertyId: c.propertyId,
          name: c.name.slice(0, 200),
          addressLine1: c.address.line1,
          addressLine2: c.address.line2,
          city: c.address.city,
          state: c.address.state?.trim().toUpperCase() ?? null,
          postalCode: c.address.postalCode?.trim() ?? null,
          code: newCode(),
          status: verdict.ok ? "pending" as const : "skipped" as const,
          reason: verdict.ok ? null : verdict.reason,
        };
      })).onConflictDoNothing();
    }
    const zone = await timezoneOf(tx, org);
    await tx.update(schema.mailCampaign).set({
      state: "sending", sentOn: time.dateIn((deps.now ?? (() => new Date()))(), zone), updatedAt: new Date(),
    }).where(eq(schema.mailCampaign.id, campaign.id));
    await audit(tx, ctx, "mail_campaign.sent", "mail_campaign", campaign.id, { state: "draft" }, { state: "sending", pieces: selected.length });
  });
  await sendBatch(ctx.db, ctx.actor.organizationId, input.id, deps);
  return guardedWrite(ctx, "campaign:write", async (tx) => {
    const report = await reportOf(tx, ctx.actor.organizationId, input.id);
    await remember(tx, ctx, "mail_send", input.id, report);
    return report;
  });
}

async function mailConnection(tx: Database, organizationId: string) {
  const [connection] = await tx.select().from(schema.integrationConnection).where(and(
    eq(schema.integrationConnection.organizationId, organizationId),
    eq(schema.integrationConnection.capability, "direct_mail"),
    eq(schema.integrationConnection.status, "connected"),
    isNull(schema.integrationConnection.deletedAt),
  )).limit(1);
  if (!connection || !connection.credentialRef) {
    throw new ConflictError("Connect a mail house (Lob) on Settings, Integrations first, with the name of the secret holding its API key.");
  }
  return connection;
}

async function reportOf(tx: Database, organizationId: string, id: string): Promise<MailSendReport> {
  const campaign = await load(tx, organizationId, id);
  const counts = await tx.select({ status: schema.mailPiece.status, n: sql<number>`count(*)::int` })
    .from(schema.mailPiece).where(eq(schema.mailPiece.mailCampaignId, id)).groupBy(schema.mailPiece.status);
  const n = (status: string) => counts.find((c) => c.status === status)?.n ?? 0;
  return {
    id, state: campaign.state,
    pieces: counts.reduce((sum, c) => sum + c.n, 0),
    sent: n("sent"), skipped: n("skipped"), refused: n("refused"), failed: n("failed"), pending: n("pending"),
  };
}

/**
 * One batch of one mailing to the printer, and the spend for it.
 *
 * Claimed and rendered in one transaction, printed outside any, recorded in a
 * third. A piece the printer could not be reached for is `failed` and tried
 * again on the next batch until it has been tried five times; one it refused
 * is `refused` with its words and left, because the same address gets the same
 * answer.
 */
export async function sendBatch(db: Database, organizationId: string, id: string, deps: MailDeps = {}): Promise<number> {
  const ctx: ServiceContext = { actor: mailActor(organizationId), db };
  const env = deps.env ?? process.env;
  const base = env["PUBLIC_URL"];
  const now = (deps.now ?? (() => new Date()))();

  const claimed = await inTenant(ctx, async (tx) => {
    const campaign = await load(tx, organizationId, id);
    if (campaign.state !== "sending" || !base) return null;
    const connection = await mailConnection(tx, organizationId).catch(() => null);
    if (!connection) return null;
    const sender = await senderOf(tx, organizationId, campaign);
    if (!sender.returnAddress) return null;
    const pieces = await tx.select().from(schema.mailPiece).where(and(
      eq(schema.mailPiece.mailCampaignId, id),
      or(eq(schema.mailPiece.status, "pending"), and(eq(schema.mailPiece.status, "failed"), lt(schema.mailPiece.attempts, MAX_ATTEMPTS))),
    )).orderBy(asc(schema.mailPiece.name), asc(schema.mailPiece.id)).limit(MAIL_BATCH);
    return { campaign, connection, sender, pieces, returnAddress: sender.returnAddress };
  });
  if (!claimed) return 0;
  if (claimed.pieces.length === 0) {
    await inTenant(ctx, (tx) => finishIfDone(tx, organizationId, id));
    return 0;
  }

  const { campaign, connection, sender, pieces, returnAddress } = claimed;
  const provider = createMailProvider(connection.provider, {
    settings: (connection.settings ?? {}) as Record<string, unknown>,
    apiKey: await (deps.readSecret ?? readerFor(db, organizationId))(connection.credentialRef!),
    transport: deps.transport ?? (globalThis.fetch as unknown as HttpTransport),
  });

  const results: { id: string; ok: true; providerId: string; expected: string | null }[] = [];
  const problems: { id: string; refused: boolean; message: string }[] = [];
  for (const piece of pieces) {
    const url = dm.mailUrl(base!, piece.code);
    const scope = dm.mailScope({
      customerName: piece.name, companyName: sender.companyName, companyPhone: sender.companyPhone,
      url, phone: sender.trackingPhone, code: piece.code,
    });
    const to: MailParty = {
      name: piece.name, line1: piece.addressLine1!, line2: piece.addressLine2, city: piece.city!, state: piece.state!, postalCode: piece.postalCode!,
    };
    try {
      const result = await provider.send({
        idempotencyKey: piece.id,
        kind: campaign.kind as dm.MailKind,
        size: campaign.size,
        to,
        from: returnAddress,
        front: render(campaign.front, scope),
        back: campaign.back ? render(campaign.back, scope) : null,
        qrUrl: url,
        description: `${campaign.name}: ${piece.code}`,
      });
      results.push({ id: piece.id, ok: true, providerId: result.providerId, expected: result.expectedDeliveryOn });
    } catch (error) {
      problems.push({ id: piece.id, refused: error instanceof PlatformRefusedError, message: (error as Error).message.slice(0, 1000) });
    }
  }

  await inTenant(ctx, async (tx) => {
    for (const result of results) {
      await tx.update(schema.mailPiece).set({
        status: "sent", providerId: result.providerId, expectedDeliveryOn: result.expected, sentAt: now, reason: null,
        attempts: sql`${schema.mailPiece.attempts} + 1`, updatedAt: new Date(),
      }).where(eq(schema.mailPiece.id, result.id));
    }
    for (const problem of problems) {
      await tx.update(schema.mailPiece).set({
        status: problem.refused ? "refused" : "failed", reason: problem.message,
        attempts: sql`${schema.mailPiece.attempts} + 1`, updatedAt: new Date(),
      }).where(eq(schema.mailPiece.id, problem.id));
    }
    await recordSpend(tx, organizationId, campaign, now);
    await finishIfDone(tx, organizationId, id);
    await audit(tx, ctx, "mail_campaign.batch", "mail_campaign", id, null, { sent: results.length, problems: problems.length });
  });
  return results.length;
}

/** A mailing with nothing left to print is sent. */
async function finishIfDone(tx: Database, organizationId: string, id: string) {
  const [left] = await tx.select({ n: sql<number>`count(*)::int` }).from(schema.mailPiece).where(and(
    eq(schema.mailPiece.mailCampaignId, id),
    or(eq(schema.mailPiece.status, "pending"), and(eq(schema.mailPiece.status, "failed"), lt(schema.mailPiece.attempts, MAX_ATTEMPTS))),
  ));
  if ((left?.n ?? 0) === 0) {
    await tx.update(schema.mailCampaign).set({ state: "sent", updatedAt: new Date() })
      .where(and(eq(schema.mailCampaign.id, id), eq(schema.mailCampaign.organizationId, organizationId), eq(schema.mailCampaign.state, "sending")));
  }
}

/** The origin a mailing's cost is written under. */
export const MAIL_SPEND_ORIGIN = "direct_mail";

/**
 * What the pieces handed over on one company day cost, as one spend row on
 * the mailing's tracking campaign for that day, rewritten (never added to)
 * each time a batch goes, so a mailing sent over two days is two rows that
 * add up to its pieces times its price.
 */
async function recordSpend(tx: Database, organizationId: string, campaign: MailRow, now: Date) {
  if (!campaign.pricePerPiece) return;
  const zone = await timezoneOf(tx, organizationId);
  const day = time.dateIn(now, zone);
  const sentToday = await tx.select({ sentAt: schema.mailPiece.sentAt }).from(schema.mailPiece).where(and(
    eq(schema.mailPiece.mailCampaignId, campaign.id), eq(schema.mailPiece.status, "sent"),
  ));
  const count = sentToday.filter((p) => p.sentAt && time.dateIn(p.sentAt, zone) === day).length;
  const declared = await acquisition.resolveDeclared(tx, organizationId, { campaignId: campaign.acquisitionCampaignId });
  const externalId = `${campaign.id}:${day}`;
  const amount = dm.mailCost(count, campaign.pricePerPiece);
  const [existing] = await tx.select({ id: schema.adSpend.id }).from(schema.adSpend).where(and(
    eq(schema.adSpend.organizationId, organizationId), eq(schema.adSpend.origin, MAIL_SPEND_ORIGIN),
    eq(schema.adSpend.externalId, externalId), isNull(schema.adSpend.deletedAt),
  )).limit(1);
  if (existing) {
    await tx.update(schema.adSpend).set({ amount, updatedAt: new Date() }).where(eq(schema.adSpend.id, existing.id));
    return;
  }
  if (count === 0) return;
  await tx.insert(schema.adSpend).values({
    organizationId,
    source: declared?.sourceKey ?? "direct_mail",
    channelId: declared?.channelId ?? null,
    acquisitionCampaignId: declared?.campaignId ?? campaign.acquisitionCampaignId,
    campaign: `${campaign.name} (mailing)`.slice(0, 200),
    spentOn: day,
    amount,
    origin: MAIL_SPEND_ORIGIN,
    externalId,
  }).onConflictDoNothing();
}

/**
 * The worker's pass: every company with a mailing half sent, a batch each,
 * oldest first. One company's printer being down stops nobody else's.
 */
export async function mailPass(db: Database, options: { deps?: MailDeps | undefined; shouldStop?: (() => boolean) | undefined } = {}) {
  const found = await db.execute<{ organization_id: string }>(sql`select organization_id from app.mail_work_organizations(50)`);
  const done: { organizationId: string; sent: number }[] = [];
  for (const { organization_id: organizationId } of found) {
    if (options.shouldStop?.()) break;
    try {
      const sending = await inTenant({ actor: mailActor(organizationId), db }, (tx) =>
        tx.select({ id: schema.mailCampaign.id }).from(schema.mailCampaign).where(and(
          eq(schema.mailCampaign.organizationId, organizationId), eq(schema.mailCampaign.state, "sending"),
        )).orderBy(asc(schema.mailCampaign.updatedAt)));
      let sent = 0;
      for (const { id } of sending) sent += await sendBatch(db, organizationId, id, options.deps ?? {});
      done.push({ organizationId, sent });
    } catch (error) {
      console.error(`[mail] ${organizationId}:`, (error as Error).message);
    }
  }
  return done;
}

/* ------------------------------------------------------------------ reads */

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "campaign:read", async (tx) => {
    const rows = await tx.select({ campaign: schema.mailCampaign, tracking: schema.acquisitionCampaign.name })
      .from(schema.mailCampaign)
      .leftJoin(schema.acquisitionCampaign, eq(schema.acquisitionCampaign.id, schema.mailCampaign.acquisitionCampaignId))
      .where(eq(schema.mailCampaign.organizationId, ctx.actor.organizationId))
      .orderBy(desc(schema.mailCampaign.createdAt)).limit(200);
    const ids = rows.map((r) => r.campaign.id);
    const counts = ids.length === 0 ? [] : await tx.select({
      id: schema.mailPiece.mailCampaignId,
      sent: sql<number>`count(*) filter (where ${schema.mailPiece.status} = 'sent')::int`,
      visited: sql<number>`count(*) filter (where ${schema.mailPiece.firstVisitedAt} is not null)::int`,
    }).from(schema.mailPiece).where(inArray(schema.mailPiece.mailCampaignId, ids)).groupBy(schema.mailPiece.mailCampaignId);
    return rows.map(({ campaign, tracking }) => {
      const c = counts.find((x) => x.id === campaign.id);
      return {
        id: campaign.id, name: campaign.name, kind: campaign.kind, size: campaign.size, state: campaign.state,
        sentOn: campaign.sentOn, trackingCampaign: tracking, sent: c?.sent ?? 0, visited: c?.visited ?? 0,
        createdAt: campaign.createdAt.toISOString(),
      };
    });
  });
}

export async function get(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "campaign:read", async (tx) => {
    const org = ctx.actor.organizationId;
    const campaign = await load(tx, org, input.id);
    const [tracking] = await tx.select({ name: schema.acquisitionCampaign.name, utm: schema.acquisitionCampaign.utmCampaign })
      .from(schema.acquisitionCampaign).where(eq(schema.acquisitionCampaign.id, campaign.acquisitionCampaignId)).limit(1);
    const report = await reportOf(tx, org, input.id);
    const [visits] = await tx.select({
      visited: sql<number>`count(*) filter (where ${schema.mailPiece.firstVisitedAt} is not null)::int`,
      total: sql<number>`coalesce(sum(${schema.mailPiece.visits}), 0)::int`,
    }).from(schema.mailPiece).where(eq(schema.mailPiece.mailCampaignId, input.id));
    /** What it brought since it went: calls to its number, and work credited to its tracking campaign. */
    const since = campaign.sentOn ? new Date(`${campaign.sentOn}T00:00:00Z`) : null;
    const [calls] = since ? await tx.select({ n: sql<number>`count(*)::int` }).from(schema.call).where(and(
      eq(schema.call.organizationId, org),
      eq(schema.call.acquisitionCampaignId, campaign.acquisitionCampaignId),
      gte(schema.call.startedAt, since),
    )) : [];
    const jobs = since ? await tx.select({ id: schema.job.id }).from(schema.job).where(and(
      eq(schema.job.organizationId, org),
      eq(schema.job.acquisitionCampaignId, campaign.acquisitionCampaignId),
      gte(schema.job.createdAt, since),
      ne(schema.job.status, "cancelled"),
      isNull(schema.job.deletedAt),
    )) : [];
    const revenue = jobs.length > 0
      ? [...(await revenueByJob(tx, jobs.map((j) => j.id))).values()].reduce((sum, r) => m.add(sum, r), m.zero())
      : m.zero();
    const [spent] = await tx.select({ total: sql<string>`coalesce(sum(${schema.adSpend.amount}), 0)::text` }).from(schema.adSpend).where(and(
      eq(schema.adSpend.organizationId, org), eq(schema.adSpend.origin, MAIL_SPEND_ORIGIN),
      sql`${schema.adSpend.externalId} like ${`${campaign.id}:%`}`, isNull(schema.adSpend.deletedAt),
    ));
    return {
      id: campaign.id,
      name: campaign.name,
      kind: campaign.kind,
      size: campaign.size,
      state: campaign.state,
      sentOn: campaign.sentOn,
      audience: campaign.audience,
      sentence: (() => { try { return cp.describeAudience(parseRules(campaign.audience)); } catch { return null; } })(),
      acquisitionCampaignId: campaign.acquisitionCampaignId,
      trackingCampaign: tracking?.name ?? null,
      front: campaign.front,
      back: campaign.back,
      landingHeadline: campaign.landingHeadline,
      landingBody: campaign.landingBody,
      pricePerPiece: campaign.pricePerPiece,
      pieces: report,
      results: {
        visited: visits?.visited ?? 0,
        visits: visits?.total ?? 0,
        calls: calls?.n ?? 0,
        jobs: jobs.length,
        revenue: m.toString(m.round(revenue, 2)),
        spend: m.toString(m.round(m.money(spent?.total ?? "0"), 2)),
      },
    };
  });
}

export async function pieces(ctx: ServiceContext, input: { id: string; status?: string | undefined; limit?: number | undefined }) {
  return guardedRead(ctx, "campaign:read", async (tx) => {
    await load(tx, ctx.actor.organizationId, input.id);
    const states = ["pending", "sent", "skipped", "refused", "failed"] as const;
    const status = states.find((s) => s === input.status);
    const rows = await tx.select().from(schema.mailPiece).where(and(
      eq(schema.mailPiece.mailCampaignId, input.id),
      ...(status ? [eq(schema.mailPiece.status, status)] : []),
    )).orderBy(asc(schema.mailPiece.name)).limit(Math.min(input.limit ?? 200, 1000));
    return rows.map((p) => ({
      id: p.id,
      customerId: p.customerId,
      name: p.name,
      address: [p.addressLine1, p.addressLine2, p.city, p.state, p.postalCode].filter(Boolean).join(", "),
      code: p.code,
      url: process.env["PUBLIC_URL"] ? dm.mailUrl(process.env["PUBLIC_URL"], p.code) : `/m/${p.code}`,
      status: p.status,
      reason: p.reason && (dm.SKIP_WORDS as Record<string, string>)[p.reason] ? (dm.SKIP_WORDS as Record<string, string>)[p.reason]! : p.reason,
      providerId: p.providerId,
      expectedDeliveryOn: p.expectedDeliveryOn,
      sentAt: p.sentAt?.toISOString() ?? null,
      firstVisitedAt: p.firstVisitedAt?.toISOString() ?? null,
      visits: p.visits,
    }));
  });
}

/* ------------------------------------------------------- the personal page */

/** A second touch for the same piece is written no more than once a day, however often the page is reloaded. */
const TOUCH_EVERY_MS = 24 * 3_600_000;

/**
 * Somebody opened a piece's own address.
 *
 * Public: the code is the whole of the address and unguessable. The visit is
 * counted on the piece, and recorded as a touch on the mailing's tracking
 * campaign against the customer it was addressed to, so the job they book
 * (by phone, online, or when the office rings them back) is credited to the
 * mailing by `creditWork` like any other touch. A cancelled mailing's page
 * still answers: the card is in a letterbox either way.
 */
export async function visit(db: Database, input: { code: string }, deps: MailDeps = {}) {
  const code = input.code.trim().toLowerCase();
  if (!dm.isMailCode(code)) return null;
  const [found] = await db.select({ piece: schema.mailPiece, campaign: schema.mailCampaign, suspendedAt: schema.organization.suspendedAt })
    .from(schema.mailPiece)
    .innerJoin(schema.mailCampaign, eq(schema.mailCampaign.id, schema.mailPiece.mailCampaignId))
    .innerJoin(schema.organization, eq(schema.organization.id, schema.mailPiece.organizationId))
    .where(eq(schema.mailPiece.code, code)).limit(1);
  if (!found || found.suspendedAt || found.piece.status !== "sent") return null;
  const { piece, campaign } = found;
  const now = (deps.now ?? (() => new Date()))();
  const ctx: ServiceContext = { actor: mailActor(piece.organizationId), db };

  return inTenant(ctx, async (tx) => {
    await tx.update(schema.mailPiece).set({
      visits: sql`${schema.mailPiece.visits} + 1`,
      firstVisitedAt: sql`coalesce(${schema.mailPiece.firstVisitedAt}, ${now.toISOString()}::timestamptz)`,
      updatedAt: new Date(),
    }).where(eq(schema.mailPiece.id, piece.id));

    const thread = `mail_piece:${piece.id}`;
    const [recent] = await tx.select({ id: schema.marketingTouch.id }).from(schema.marketingTouch).where(and(
      eq(schema.marketingTouch.organizationId, piece.organizationId),
      eq(schema.marketingTouch.visitorId, thread),
      gte(schema.marketingTouch.occurredAt, new Date(now.getTime() - TOUCH_EVERY_MS)),
    )).limit(1);
    const declared = await acquisition.resolveDeclared(tx, piece.organizationId, { campaignId: campaign.acquisitionCampaignId }).catch(() => null);
    const [tracking] = await tx.select({ utm: schema.acquisitionCampaign.utmCampaign }).from(schema.acquisitionCampaign)
      .where(eq(schema.acquisitionCampaign.id, campaign.acquisitionCampaignId)).limit(1);
    if (!recent) {
      await tx.insert(schema.marketingTouch).values({
        organizationId: piece.organizationId,
        visitorId: thread,
        customerId: piece.customerId,
        source: declared?.sourceKey ?? "direct_mail",
        basis: "utm",
        channelId: declared?.channelId ?? null,
        acquisitionCampaignId: declared?.campaignId ?? campaign.acquisitionCampaignId,
        utmSource: "mail",
        utmMedium: "direct_mail",
        utmCampaign: tracking?.utm ?? null,
        utmContent: piece.code,
        landingPath: `/m/${piece.code}`,
        occurredAt: now,
      });
    }
    const sender = await senderOf(tx, piece.organizationId, campaign);
    const query = new URLSearchParams({
      utm_source: "mail", utm_medium: "direct_mail", utm_content: piece.code,
      ...(tracking?.utm ? { utm_campaign: tracking.utm } : {}),
    });
    return {
      companyName: sender.companyName,
      firstName: cp.firstNameOf(piece.name) || null,
      headline: campaign.landingHeadline,
      body: campaign.landingBody,
      phone: sender.trackingPhone ?? sender.companyPhone,
      bookingPath: sender.slug ? `/book/${sender.slug}?${query.toString()}` : null,
    };
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listMailCampaigns: async (ctx: ServiceContext) => ({ campaigns: await list(ctx) }),
  createMailCampaign: (ctx: ServiceContext, input: MailCampaignInput) => create(ctx, input),
  getMailCampaign: (ctx: ServiceContext, input: { id: string }) => get(ctx, input),
  updateMailCampaign: (ctx: ServiceContext, input: MailCampaignPatch) => update(ctx, input),
  previewMailCampaign: (ctx: ServiceContext, input: { id: string }) => preview(ctx, input),
  sendMailCampaign: (ctx: ServiceContext, input: { id: string }) => send(ctx, input),
  cancelMailCampaign: (ctx: ServiceContext, input: { id: string }) => cancel(ctx, input),
  listMailPieces: async (ctx: ServiceContext, input: { id: string; status?: string | undefined; limit?: number | undefined }) =>
    ({ pieces: await pieces(ctx, input) }),
} as const;
