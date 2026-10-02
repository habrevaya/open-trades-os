import { and, asc, eq } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import type { comms } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError, type ServiceContext,
} from "./context";

/**
 * WHO THE CARRIERS THINK YOU ARE
 *
 * `messaging_brand` and `messaging_campaign` have been in the schema since
 * the first migration and nothing has ever written a row. They are the record
 * of A2P 10DLC registration: in the United States a business cannot send
 * application-to-person SMS at all until a carrier has vetted the business
 * and approved the use case it is sending for. Unregistered traffic is not
 * merely rejected, it is filtered silently and it counts against the sender,
 * so the texts stop arriving and nobody is told.
 *
 * The product already ships messaging. `phone_number.sms_registered` is the
 * flag a send is gated on today, and it is a boolean somebody ticks. These
 * two tables are the answer to "on what basis", which is the question an
 * operator cannot currently answer and the carrier will eventually ask.
 *
 * THESE ARE RECORDS OF A REGISTRATION, NOT AN API THAT REGISTERS.
 *
 * Nothing here submits anything to anybody. An operator registers in their
 * carrier's own portal, which is where the process genuinely lives, and
 * writes down here what they submitted and what came back. That is worth
 * saying plainly rather than leaving somebody to discover it: a status field
 * called `submitted` next to a button might reasonably be read as this
 * software having submitted something.
 *
 * It is still worth holding, for three reasons the schema comments already
 * give. A carrier audits against the opt-in language and the sample messages
 * that were registered, and an operator who changed their web form eighteen
 * months later needs to know what they told the carrier. The approved
 * throughput is what lets a sender pace rather than fail. And a rejection
 * reason in the carrier's own words is the only thing that tells an operator
 * what to fix.
 *
 * ONE MORE THING IT DOES, which is the part with teeth. A brand may hold
 * several campaigns, one per purpose, and that is how transactional and
 * marketing stay separable all the way down to the carrier. Once a company
 * has registered ANYTHING here, `purposeBlocked` below will refuse a purpose
 * that has no approved campaign behind it. See that function for why it is
 * silent until they do.
 */

/**
 * NO `deleted_at` FILTER ANYWHERE IN THIS FILE, and that is deliberate.
 *
 * There is no way to delete a brand or a campaign here and there should not
 * be. These are the record of what a business told a carrier: the opt in
 * language, the sample messages, the date it was approved. An audit eighteen
 * months later asks exactly those questions, and a registration you can make
 * disappear is not a record of anything.
 *
 * The filters were written out of habit and removed on purpose. Nothing sets
 * the column, so every one of them was a guard whose answer was decided
 * before the query ran, and `test/unwritten-columns.test.ts` counts precisely
 * that: it holds the number of tables filtering a delete nothing performs, so
 * a twenty fifth and twenty sixth cannot join quietly. These two did, and the
 * count is what caught them.
 */
export const REGISTRATION_STATUSES = [
  "not_started", "submitted", "pending_review", "approved", "rejected", "suspended",
] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/**
 * Where a status may go from where it is.
 *
 * Declared rather than left open, because a status that can move anywhere is
 * a status nobody can reason about: an approved campaign silently going back
 * to `not_started` because a settings screen posted a default would stop a
 * company's texts with no record of a rejection anywhere.
 *
 * `suspended` can be reached from approved and nowhere else, because that is
 * what it means: a carrier withdrawing something it had granted.
 */
const NEXT: Record<RegistrationStatus, readonly RegistrationStatus[]> = {
  not_started: ["submitted"],
  submitted: ["pending_review", "approved", "rejected"],
  pending_review: ["approved", "rejected"],
  rejected: ["submitted"],
  approved: ["suspended", "rejected"],
  suspended: ["submitted", "approved"],
};

function assertTransition(from: string, to: RegistrationStatus, what: string): void {
  if (from === to) return;
  const allowed = NEXT[from as RegistrationStatus] ?? [];
  if (!allowed.includes(to)) {
    throw new ConflictError(
      `A ${what} cannot go from "${from}" to "${to}". `
      + (allowed.length > 0
        ? `From "${from}" it can go to ${allowed.map((a) => `"${a}"`).join(" or ")}.`
        : `"${from}" is where it stops.`),
    );
  }
}

/* ----------------------------------------------------------------- brands */

export interface BrandInput {
  legalName: string;
  displayName: string;
  entityType?: string | null | undefined;
  taxIdLast4?: string | null | undefined;
  website?: string | null | undefined;
  externalBrandId?: string | null | undefined;
}

function brandShape(row: typeof schema.messagingBrand.$inferSelect) {
  return {
    id: row.id,
    legalName: row.legalName,
    displayName: row.displayName,
    entityType: row.entityType,
    taxIdLast4: row.taxIdLast4,
    website: row.website,
    externalBrandId: row.externalBrandId,
    status: row.status,
    statusReason: row.statusReason,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
  };
}

export async function registerBrand(ctx: ServiceContext, input: BrandInput) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const legalName = input.legalName.trim();
    const displayName = input.displayName.trim();

    if (legalName === "" || displayName === "") {
      throw new ConflictError(
        "A brand needs both its legal name and the name customers see. The carrier vets the "
        + "first and shows the second, and a mismatch between the two is the most common "
        + "reason a registration is rejected.",
      );
    }

    /**
     * FOUR DIGITS OF A TAX ID, NEVER THE WHOLE THING. The column is named
     * `tax_id_last4` and holding more in it would put a full EIN in a
     * database row that every backup and every support export carries, to
     * answer a question nobody here asks: the carrier already has it, because
     * the operator gave it to them directly.
     */
    const taxIdLast4 = input.taxIdLast4?.trim() || null;
    if (taxIdLast4 && !/^\d{4}$/.test(taxIdLast4)) {
      throw new ConflictError(
        "Record only the last four digits of the tax id. The carrier has the whole one "
        + "because you gave it to them; this is here so you can tell which registration "
        + "this row is about.",
      );
    }

    const [row] = await tx.insert(schema.messagingBrand).values({
      organizationId: ctx.actor.organizationId,
      legalName,
      displayName,
      entityType: input.entityType?.trim() || null,
      taxIdLast4,
      website: input.website?.trim() || null,
      externalBrandId: input.externalBrandId?.trim() || null,
      status: "not_started",
    }).returning();

    await audit(tx, ctx, "messaging_brand.recorded", "messaging_brand", row!.id, null, row!);
    return brandShape(row!);
  });
}

export async function setBrandStatus(
  ctx: ServiceContext,
  input: { id: string; status: RegistrationStatus; reason?: string | null | undefined; externalBrandId?: string | undefined },
) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [before] = await tx.select().from(schema.messagingBrand)
      .where(and(
        eq(schema.messagingBrand.id, input.id),
      )).limit(1);
    if (!before) throw new NotFoundError("Brand");

    assertTransition(before.status, input.status, "brand registration");

    /**
     * A REJECTION WITHOUT THE CARRIER'S REASON IS USELESS.
     *
     * The one thing an operator needs from a rejected registration is what to
     * change, and the carrier's own words are the only source of it. A
     * rejected row with a blank reason is a dead end somebody will re-submit
     * unchanged.
     */
    const reason = input.reason?.trim() || null;
    if ((input.status === "rejected" || input.status === "suspended") && !reason) {
      throw new ConflictError(
        `Record what the carrier said. A ${input.status} registration with no reason leaves `
        + "nothing to act on, and the next person will submit the same thing again.",
      );
    }

    const [after] = await tx.update(schema.messagingBrand).set({
      status: input.status,
      statusReason: reason,
      ...(input.externalBrandId ? { externalBrandId: input.externalBrandId.trim() } : {}),
      ...(input.status === "submitted" ? { submittedAt: new Date() } : {}),
      ...(input.status === "approved" ? { approvedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.messagingBrand.id, input.id)).returning();

    await audit(tx, ctx, "messaging_brand.status", "messaging_brand", input.id, before, after!);
    return brandShape(after!);
  });
}

/* -------------------------------------------------------------- campaigns */

export interface CampaignInput {
  brandId: string;
  purpose: comms.Purpose;
  useCase: string;
  description?: string | null | undefined;
  optInDescription?: string | null | undefined;
  sampleMessages?: string[] | undefined;
}

function campaignShape(row: typeof schema.messagingCampaign.$inferSelect) {
  return {
    id: row.id,
    brandId: row.brandId,
    purpose: row.purpose,
    useCase: row.useCase,
    description: row.description,
    optInDescription: row.optInDescription,
    sampleMessages: row.sampleMessages,
    messagesPerSecond: row.messagesPerSecond,
    dailyCap: row.dailyCap,
    status: row.status,
    statusReason: row.statusReason,
    submittedAt: row.submittedAt?.toISOString() ?? null,
    approvedAt: row.approvedAt?.toISOString() ?? null,
  };
}

export async function registerCampaign(ctx: ServiceContext, input: CampaignInput) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [brand] = await tx.select().from(schema.messagingBrand)
      .where(and(
        eq(schema.messagingBrand.id, input.brandId),
      )).limit(1);
    if (!brand) throw new NotFoundError("Brand");

    const useCase = input.useCase.trim();
    if (useCase === "") {
      throw new ConflictError(
        "Say what the use case is. It is the thing the carrier approves, and a campaign "
        + "without one cannot be submitted anywhere.",
      );
    }

    /**
     * THE OPT IN LANGUAGE AND THE SAMPLES ARE WHAT A CARRIER AUDITS AGAINST,
     * so they are required rather than optional.
     *
     * An audit asks what a customer agreed to and what they were sent, and
     * compares both against what was registered. A campaign row with those
     * fields empty is a row that records the approval and not the thing that
     * was approved, which is the half an operator will need eighteen months
     * later when their web form has been rewritten twice.
     */
    const optInDescription = input.optInDescription?.trim() || null;
    const sampleMessages = (input.sampleMessages ?? [])
      .map((s) => s.trim()).filter(Boolean);

    if (!optInDescription) {
      throw new ConflictError(
        "Record the opt in language exactly as you registered it. A carrier audits a campaign "
        + "against what a customer agreed to, and in eighteen months the form on your website "
        + "will not be the one you registered.",
      );
    }
    if (sampleMessages.length === 0) {
      throw new ConflictError(
        "Record at least one sample message as registered. It is what the carrier compares "
        + "real traffic against, and traffic that does not resemble the samples is what gets "
        + "a campaign suspended.",
      );
    }

    /**
     * ONE CAMPAIGN PER PURPOSE PER BRAND, which is the entire reason the
     * purpose is on this table.
     *
     * Transactional and marketing stay separable all the way down to the
     * carrier only if each has its own registration. Two live campaigns for
     * one purpose would make "is marketing approved" a question with two
     * answers, and `purposeBlocked` below would take whichever row the heap
     * returned first.
     */
    const [clash] = await tx.select({ id: schema.messagingCampaign.id })
      .from(schema.messagingCampaign)
      .where(and(
        eq(schema.messagingCampaign.brandId, input.brandId),
        eq(schema.messagingCampaign.purpose, input.purpose),
      )).limit(1);

    if (clash) {
      throw new ConflictError(
        `This brand already has a ${input.purpose} campaign. One purpose is one registration: `
        + "a second would make whether that purpose is approved a question with two answers.",
      );
    }

    const [row] = await tx.insert(schema.messagingCampaign).values({
      organizationId: ctx.actor.organizationId,
      brandId: input.brandId,
      purpose: input.purpose,
      useCase,
      description: input.description?.trim() || null,
      optInDescription,
      sampleMessages,
      status: "not_started",
    }).returning();

    await audit(tx, ctx, "messaging_campaign.recorded", "messaging_campaign", row!.id, null, row!);
    return campaignShape(row!);
  });
}

export async function setCampaignStatus(
  ctx: ServiceContext,
  input: {
    id: string; status: RegistrationStatus; reason?: string | null | undefined;
    externalCampaignId?: string | undefined;
    messagesPerSecond?: number | undefined; dailyCap?: number | undefined;
  },
) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [before] = await tx.select().from(schema.messagingCampaign)
      .where(and(
        eq(schema.messagingCampaign.id, input.id),
      )).limit(1);
    if (!before) throw new NotFoundError("Campaign");

    assertTransition(before.status, input.status, "campaign registration");

    const reason = input.reason?.trim() || null;
    if ((input.status === "rejected" || input.status === "suspended") && !reason) {
      throw new ConflictError(
        `Record what the carrier said. A ${input.status} campaign with no reason leaves nothing `
        + "to act on.",
      );
    }

    const [after] = await tx.update(schema.messagingCampaign).set({
      status: input.status,
      statusReason: reason,
      ...(input.externalCampaignId ? { externalCampaignId: input.externalCampaignId.trim() } : {}),
      ...(input.messagesPerSecond !== undefined ? { messagesPerSecond: input.messagesPerSecond } : {}),
      ...(input.dailyCap !== undefined ? { dailyCap: input.dailyCap } : {}),
      ...(input.status === "submitted" ? { submittedAt: new Date() } : {}),
      ...(input.status === "approved" ? { approvedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.messagingCampaign.id, input.id)).returning();

    await audit(tx, ctx, "messaging_campaign.status", "messaging_campaign", input.id, before, after!);
    return campaignShape(after!);
  });
}

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const brands = await tx.select().from(schema.messagingBrand)
      .where(and(
        eq(schema.messagingBrand.organizationId, ctx.actor.organizationId),
      ))
      .orderBy(asc(schema.messagingBrand.createdAt));

    const campaigns = await tx.select().from(schema.messagingCampaign)
      .where(and(
        eq(schema.messagingCampaign.organizationId, ctx.actor.organizationId),
      ))
      .orderBy(asc(schema.messagingCampaign.createdAt));

    return brands.map((brand) => ({
      ...brandShape(brand),
      campaigns: campaigns.filter((c) => c.brandId === brand.id).map(campaignShape),
    }));
  });
}

/* ------------------------------------------------------------ the gate */

/**
 * Why this company may not send a given purpose over SMS, or null if it may.
 *
 * SILENT UNTIL THEY REGISTER SOMETHING, and that is the whole design.
 *
 * Every company already using this product sends texts today with nothing in
 * these two tables. Turning on a hard check would stop all of their messaging
 * at once, for a registration they may well hold in their carrier's portal
 * and simply never have written down here. That is an outage caused by a
 * record-keeping feature, which is not a trade anybody would accept.
 *
 * So: no brand recorded means no opinion, exactly as before. Recording one is
 * the act of opting in, and from that point a purpose with no approved
 * campaign behind it is refused with the carrier's own reason attached. The
 * company that cared enough to write their registration down is the company
 * that wants to be told when it lapses.
 *
 * Takes a `tx` rather than a context, like `senderFor` next door, because the
 * caller is a technician holding `message:send` and nothing else.
 */
export async function purposeBlocked(
  tx: Database,
  organizationId: string,
  purpose: comms.Purpose,
): Promise<string | null> {
  const brands = await tx.select().from(schema.messagingBrand)
    .where(and(
      eq(schema.messagingBrand.organizationId, organizationId),
    ));

  if (brands.length === 0) return null;

  const campaigns = await tx.select().from(schema.messagingCampaign)
    .where(and(
      eq(schema.messagingCampaign.organizationId, organizationId),
      eq(schema.messagingCampaign.purpose, purpose),
    ));

  const approved = campaigns.find((c) => c.status === "approved");
  if (approved) return null;

  const live = campaigns[0];
  if (!live) {
    return `No ${purpose} campaign is registered with the carriers, so this would be filtered `
      + "rather than delivered. Register one, or remove the brand record if you are not "
      + "tracking registration here.";
  }

  return `The ${purpose} campaign is ${live.status}`
    + (live.statusReason ? `: ${live.statusReason}` : ".");
}

export const handlers = {
  recordMessagingBrand: (ctx: ServiceContext, input: BrandInput) => registerBrand(ctx, input),

  setMessagingBrandStatus: (
    ctx: ServiceContext,
    input: { id: string; status: RegistrationStatus; reason?: string | null | undefined; externalBrandId?: string | undefined },
  ) => setBrandStatus(ctx, input),

  recordMessagingCampaign: (ctx: ServiceContext, input: CampaignInput) => registerCampaign(ctx, input),

  setMessagingCampaignStatus: (
    ctx: ServiceContext,
    input: {
      id: string; status: RegistrationStatus; reason?: string | null | undefined;
      externalCampaignId?: string | undefined;
      messagesPerSecond?: number | undefined; dailyCap?: number | undefined;
    },
  ) => setCampaignStatus(ctx, input),

  listMessagingRegistrations: async (ctx: ServiceContext) => ({ brands: await list(ctx) }),
} as const;
