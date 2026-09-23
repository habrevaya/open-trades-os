import { and, asc, eq, desc, sql, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m, branding as brand } from "@opentradesos/core";
import { createHash, randomBytes } from "node:crypto";
import type { z } from "zod";
import {
  type ServiceContext, guardedWrite, inTenant, NotFoundError, ConflictError,
} from "./context";
import { audit } from "./customers";
import { decide, loadEstimate } from "./estimates";
import type {
  openPortalLink, viewPortalEstimate, approvePortalEstimate,
  declinePortalEstimate, viewPortalJob, issuePortalGrant, revokePortalGrant,
} from "../contracts/portal";

/**
 * THE CUSTOMER SIDE
 *
 * Everything in this file runs for someone with no account and no session, so
 * none of it can use the ordinary guards: there is no actor to check a
 * permission against. Three rules stand in for that, and all three are
 * structural rather than a matter of remembering.
 *
 * The subject comes from the grant, never from the request. There is no id in
 * any of these inputs that a caller could change to reach another record.
 *
 * Resolution runs through a SECURITY DEFINER function, because the lookup has
 * to happen before the organization is known and therefore cannot go through
 * row level security. The function takes a 256 bit hash the caller must
 * already hold and returns one row or none, so it cannot enumerate anything.
 *
 * Everything after resolution runs inside the tenant boundary as a synthetic
 * actor scoped to the resolved organization, so a bug in a handler below
 * cannot reach across tenants even if it tries.
 */

export class InvalidGrantError extends Error {
  constructor() {
    // Deliberately says nothing about why. Expired, revoked, spent and never
    // existed are all the same message, because distinguishing them tells an
    // attacker which tokens were once real.
    super("This link is no longer valid.");
    this.name = "InvalidGrantError";
  }
}

interface ResolvedGrant {
  grantId: string;
  organizationId: string;
  customerId: string | null;
  scope: "estimate" | "job" | "invoice" | "customer" | "booking";
  subjectId: string | null;
  usesRemaining: number | null;
}

const hash = (token: string) => createHash("sha256").update(token).digest("hex");

/**
 * Reads a grant without spending a use.
 *
 * Every refresh of a tracking page would otherwise burn one, which makes
 * `maxUses` unusable on exactly the scopes that need it.
 */
export async function peek(db: Database, token: string): Promise<ResolvedGrant> {
  const rows = await db.execute(
    sql`select * from app.peek_portal_grant(${hash(token)})`,
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!row) throw new InvalidGrantError();
  return normalize(row);
}

/**
 * Reads a grant and spends a use, atomically.
 *
 * The increment happens in the same statement as the read, with the limit in
 * the WHERE clause. Checking and then separately incrementing lets two
 * requests arriving together both pass the check, and on a single use payment
 * link the second one is a duplicate charge.
 */
export async function consume(db: Database, token: string, ip?: string): Promise<ResolvedGrant> {
  const rows = await db.execute(
    sql`select * from app.consume_portal_grant(${hash(token)}, ${ip ?? null})`,
  );
  const row = (rows as unknown as Array<Record<string, unknown>>)[0];
  if (!row) throw new InvalidGrantError();
  return normalize(row);
}

function normalize(row: Record<string, unknown>): ResolvedGrant {
  return {
    grantId: String(row["grant_id"] ?? row["grantId"]),
    organizationId: String(row["organization_id"] ?? row["organizationId"]),
    customerId: (row["customer_id"] ?? row["customerId"] ?? null) as string | null,
    scope: (row["scope"] ?? "customer") as ResolvedGrant["scope"],
    subjectId: (row["subject_id"] ?? row["subjectId"] ?? null) as string | null,
    usesRemaining: (row["uses_remaining"] ?? row["usesRemaining"] ?? null) as number | null,
  };
}

/**
 * The actor a portal request runs as.
 *
 * It holds no permissions at all, which is the point: nothing in the normal
 * service layer will serve it, so a handler here cannot accidentally reach a
 * guarded path. What it carries is the organization, so that row level
 * security scopes every query it makes.
 */
function portalActor(grant: ResolvedGrant): ServiceContext["actor"] {
  return {
    userId: `portal:${grant.grantId}`,
    organizationId: grant.organizationId,
    roles: [],
    grants: [],
    revocations: [],
  } as unknown as ServiceContext["actor"];
}

function portalContext(db: Database, grant: ResolvedGrant): ServiceContext {
  return { actor: portalActor(grant), db, portalGrantId: grant.grantId };
}

/**
 * The tenant boundary, for a caller who has no session to establish it.
 *
 * IT DELEGATES TO `inTenant` RATHER THAN SETTING THE CONTEXT ITSELF, and
 * that is a correction rather than a tidy up.
 *
 * This function used to set `app.organization_id` and `app.user_id` and stop
 * there. It did NOT switch the database role, which `inTenant` does on the
 * line above the two it had copied. Every row level security policy in this
 * schema is written `to authenticated`, and the application connects as a
 * role that owns these tables, so without that switch the policies did not
 * apply at all: every portal read ran with row level security effectively
 * off, and the only thing keeping one company's data away from another's
 * link was that each handler happened to filter by an id resolved from the
 * grant.
 *
 * The comment at the top of this file has claimed since it was written that
 * a bug in a handler below cannot reach across tenants even if it tries.
 * That was not true. It is now, and it is true because this calls the same
 * function every other read in the product calls rather than because it
 * carries its own copy of what that function does.
 *
 * I found it by adding a handler that relies on the boundary instead of
 * filtering: a read of this company's logo with no organization in the
 * query. It returned another company's, which is exactly what the comment
 * said could not happen.
 */
async function inGrant<T>(
  db: Database, grant: ResolvedGrant, fn: (tx: Database, ctx: ServiceContext) => Promise<T>,
): Promise<T> {
  const ctx = portalContext(db, grant);
  return inTenant(ctx, (tx) => fn(tx, ctx));
}

function requireScope(grant: ResolvedGrant, scope: ResolvedGrant["scope"]): string {
  if (grant.scope !== scope) throw new InvalidGrantError();
  if (!grant.subjectId) throw new InvalidGrantError();
  return grant.subjectId;
}

/**
 * Only a booking grant is allowed to have no customer, and only until someone
 * confirms it. Anything else reaching here without one is a grant that was
 * built wrong, and it should fail rather than write a timeline entry attached
 * to nobody.
 */
function customerOf(grant: ResolvedGrant): string {
  if (!grant.customerId) throw new InvalidGrantError();
  return grant.customerId;
}

/**
 * THE COMPANY'S LOOK, FOR A PAGE WITH NO SESSION.
 *
 * This is the branding that matters most. The proposal and the tracking page
 * are the two screens a contractor's customer actually sees, and until now
 * they were the only ones that could not be branded: `branding.current` reads
 * the organization off an actor, and there is no actor here.
 *
 * The token stands in for one. It already grants a stranger sight of this
 * customer's estimate or job, so serving that company's public mark with it
 * is strictly less than the caller already has.
 *
 * Derived colours are computed here rather than stored, exactly as in
 * `branding.current`, because two places computing it is one place fewer than
 * two places storing it and being asked which is right.
 */
export async function brandingFor(db: Database, token: string) {
  const grant = await peek(db, token);
  return inGrant(db, grant, async (tx) => {
    const [org] = await tx.select({
      name: schema.organization.name,
      color: schema.organization.brandColor,
      updatedAt: schema.organization.updatedAt,
    }).from(schema.organization)
      .where(eq(schema.organization.id, grant.organizationId)).limit(1);

    const assets = await tx.select({
      kind: schema.brandAsset.kind,
      updatedAt: schema.brandAsset.updatedAt,
    }).from(schema.brandAsset);

    const color = org?.color ? brand.parseColor(org.color) : null;
    const latest = [org?.updatedAt, ...assets.map((a) => a.updatedAt)]
      .filter((at) => at !== null && at !== undefined)
      .reduce((max, at) => (at! > max ? at! : max), new Date(0));

    return {
      organizationName: org?.name ?? "",
      color,
      on: color ? brand.readableOn(color) : null,
      text: color ? brand.textSafe(color) : null,
      hasLogo: assets.some((a) => a.kind === "logo"),
      version: Math.floor(latest.getTime() / 1000),
    };
  });
}

/**
 * The bytes of a mark, for a customer holding a link.
 *
 * Only the logo. A favicon on a portal page would be the contractor's mark
 * on a browser tab the customer opened from a text message, which is a nice
 * touch and not worth a second code path until somebody asks for it.
 */
export async function brandAssetFor(
  db: Database, token: string,
): Promise<{ bytes: Buffer; contentType: string } | null> {
  const grant = await peek(db, token);
  return inGrant(db, grant, async (tx) => {
    const [found] = await tx.select({
      bytes: schema.brandAsset.bytes,
      contentType: schema.brandAsset.contentType,
    }).from(schema.brandAsset)
      .where(eq(schema.brandAsset.kind, "logo")).limit(1);
    return found ?? null;
  });
}

export async function openLink(db: Database, input: z.infer<typeof openPortalLink.input>) {
  const grant = await peek(db, input.token);
  return inGrant(db, grant, async (tx) => {
    const [org] = await tx.select({
      name: schema.organization.name,
      logoUrl: schema.organization.logoUrl,
    }).from(schema.organization).where(eq(schema.organization.id, grant.organizationId)).limit(1);

    const [customer] = await tx.select({ name: schema.customer.name })
      .from(schema.customer).where(eq(schema.customer.id, grant.customerId ?? "")).limit(1);

    const [row] = await tx.select({ expiresAt: schema.portalGrant.expiresAt })
      .from(schema.portalGrant).where(eq(schema.portalGrant.id, grant.grantId)).limit(1);

    return {
      organizationName: org?.name ?? "",
      organizationLogoUrl: org?.logoUrl ?? null,
      customerName: customer?.name ?? "",
      scope: grant.scope,
      expiresAt: (row?.expiresAt ?? new Date()).toISOString(),
    };
  });
}

/**
 * Viewing.
 *
 * Marks the estimate viewed the first time, which is what makes "sent and
 * never opened" distinguishable from "read and ignored". Those two need
 * completely different follow up, and a company that cannot tell them apart
 * chases the wrong one.
 */
export async function viewEstimate(db: Database, input: z.infer<typeof viewPortalEstimate.input>) {
  const grant = await peek(db, input.token);
  const estimateId = requireScope(grant, "estimate");

  return inGrant(db, grant, async (tx, ctx) => {
    const full = await loadEstimate(tx, ctx, estimateId);

    if (full.status === "sent") {
      await tx.update(schema.estimate)
        .set({ status: "viewed", viewedAt: new Date(), updatedAt: new Date() })
        .where(and(eq(schema.estimate.id, estimateId), eq(schema.estimate.status, "sent")));

      await tx.insert(schema.portalEvent).values({
        organizationId: grant.organizationId,
        customerId: customerOf(grant),
        estimateId,
        kind: "estimate_viewed",
        headline: `Estimate #${full.number} opened by the customer`,
        isCustomerVisible: false,
      });

      return shapeForCustomer(tx, grant, await loadEstimate(tx, ctx, estimateId));
    }

    return shapeForCustomer(tx, grant, full);
  });
}

/**
 * The customer says yes. This is the endpoint the whole phase exists for.
 *
 * It spends the grant, so a forwarded link cannot approve a second time or
 * switch the chosen option after the fact. The spend happens BEFORE the
 * decision is written: a request that is going to fail the limit should never
 * have reached the estimate at all.
 */
export async function approveEstimate(
  db: Database,
  input: z.infer<typeof approvePortalEstimate.input>,
  request?: { ip?: string | undefined; userAgent?: string | undefined },
) {
  const grant = await consume(db, input.token, request?.ip);
  const estimateId = requireScope(grant, "estimate");

  return inGrant(db, grant, async (tx, ctx) => {
    const approved = await decide(tx, ctx, {
      estimateId,
      optionId: input.optionId,
      selectedLineIds: input.selectedLineIds,
      signerName: input.signerName,
      capturedVia: "portal",
      signatureImage: input.signatureImage,
      ipAddress: request?.ip,
      userAgent: request?.userAgent,
    });

    const option = approved.options.find((o) => o.id === input.optionId);
    const deposit = await depositFor(tx, grant, estimateId, option?.total ?? "0");

    return {
      estimate: await shapeForCustomer(tx, grant, approved),
      depositDue: deposit.due,
      paymentUrl: deposit.url,
    };
  });
}

export async function declineEstimate(db: Database, input: z.infer<typeof declinePortalEstimate.input>) {
  const grant = await consume(db, input.token);
  const estimateId = requireScope(grant, "estimate");

  return inGrant(db, grant, async (tx) => {
    const [current] = await tx.select({
      number: schema.estimate.number,
      status: schema.estimate.status,
    }).from(schema.estimate).where(eq(schema.estimate.id, estimateId)).limit(1);
    if (!current) throw new NotFoundError("Estimate");

    if (current.status === "approved" || current.status === "converted") {
      throw new ConflictError("This estimate has already been approved.");
    }

    await tx.update(schema.estimate).set({
      status: "declined",
      decidedAt: new Date(),
      declineReason: input.reason ?? null,
      updatedAt: new Date(),
    }).where(eq(schema.estimate.id, estimateId));

    await tx.insert(schema.portalEvent).values({
      organizationId: grant.organizationId,
      customerId: customerOf(grant),
      estimateId,
      kind: "estimate_declined",
      headline: `Estimate #${current.number} declined by the customer`,
      detail: input.reason ?? null,
      isCustomerVisible: false,
    });

    return { ok: true as const };
  });
}

/**
 * The tracking page.
 *
 * The timeline is read straight off `portal_event` rather than assembled from
 * a dozen tables, because a customer refreshes this through a four hour
 * arrival window and it has to stay one indexed read.
 */
export async function viewJob(
  db: Database, input: z.infer<typeof viewPortalJob.input>,
): Promise<z.infer<typeof viewPortalJob.output>> {
  const grant = await peek(db, input.token);
  const jobId = requireScope(grant, "job");

  return inGrant(db, grant, async (tx) => {
    const [job] = await tx.select().from(schema.job)
      .where(eq(schema.job.id, jobId)).limit(1);
    if (!job) throw new NotFoundError("Job");

    const [org] = await tx.select({ name: schema.organization.name })
      .from(schema.organization).where(eq(schema.organization.id, grant.organizationId)).limit(1);

    const [property] = await tx.select({
      line1: schema.property.addressLine1,
      city: schema.property.city,
      state: schema.property.state,
    }).from(schema.property).where(eq(schema.property.id, job.propertyId)).limit(1);

    /**
     * The visit the customer is actually waiting on.
     *
     * Not the first visit and not the last: the one in progress if there is
     * one, otherwise the next one still to come, otherwise the most recent.
     * A four visit maintenance agreement must not show the customer the date
     * of visit one in March when they are asking about the technician outside
     * their house today.
     */
    const visits = await tx.select({
      visit: schema.visit,
      technicianName: schema.technician.displayName,
    })
      .from(schema.visit)
      .leftJoin(schema.visitAssignment, and(
        eq(schema.visitAssignment.visitId, schema.visit.id),
        eq(schema.visitAssignment.isLead, true),
      ))
      .leftJoin(schema.technician, eq(schema.technician.id, schema.visitAssignment.technicianId))
      .where(eq(schema.visit.jobId, jobId))
      .orderBy(asc(schema.visit.windowStart));

    const current = pickVisit(visits.map((v) => ({
      id: v.visit.id,
      status: v.visit.status,
      windowStart: v.visit.windowStart,
      windowEnd: v.visit.windowEnd,
      technicianName: v.technicianName,
    })));

    /**
     * The estimate is only shown while it is still an estimate.
     *
     * A notice sent an hour ago saying "twenty minutes away" is worse than no
     * notice at all, because the customer stops watching the door. So the most
     * recent notice counts only while the technician is still en route and the
     * window it promised has not already passed.
     */
    let etaMinutes: number | null = null;
    if (current && current.status === "en_route") {
      const [notice] = await tx.select({
        etaMinutes: schema.arrivalNotice.etaMinutes,
        sentAt: schema.arrivalNotice.sentAt,
      })
        .from(schema.arrivalNotice)
        .where(and(
          eq(schema.arrivalNotice.visitId, current.id),
          isNull(schema.arrivalNotice.arrivedAt),
        ))
        .orderBy(desc(schema.arrivalNotice.sentAt))
        .limit(1);

      if (notice?.etaMinutes != null) {
        const elapsed = Math.floor((Date.now() - notice.sentAt.getTime()) / 60_000);
        const remaining = notice.etaMinutes - elapsed;
        etaMinutes = remaining > 0 ? remaining : null;
      }
    }

    const events = await tx.select({
      kind: schema.portalEvent.kind,
      headline: schema.portalEvent.headline,
      detail: schema.portalEvent.detail,
      occurredAt: schema.portalEvent.occurredAt,
    }).from(schema.portalEvent)
      .where(and(
        eq(schema.portalEvent.jobId, jobId),
        eq(schema.portalEvent.isCustomerVisible, true),
      ))
      .orderBy(desc(schema.portalEvent.occurredAt))
      .limit(50);

    return {
      organizationName: org?.name ?? "",
      jobNumber: job.number,
      /**
       * The VISIT's state, not the job's.
       *
       * A job stays "scheduled" while a technician is six minutes from the
       * door, so the page read "Scheduled" directly above "About 19 minutes
       * away", which is the page contradicting itself on the one screen a
       * customer refreshes while they wait.
       */
      status: current ? customerStatus(current.status) : sentenceCase(job.status),
      summary: job.summary ?? null,
      propertyAddress: [property?.line1, property?.city, property?.state].filter(Boolean).join(", "),
      /**
       * A first name only, and no photo unless the technician uploaded one.
       *
       * A last name and a phone number are not the customer's to have. A
       * technician cannot opt out of appearing on a tracking page, so the page
       * gives out the least that still makes a stranger at the door feel like
       * an expected visitor.
       */
      scheduledDate: current?.windowStart ? localDate(current.windowStart) : null,
      arrivalWindow: current ? formatWindow(current.windowStart, current.windowEnd) : null,
      technician: current?.technicianName
        ? { firstName: firstNameOf(current.technicianName), photoUrl: null }
        : null,
      etaMinutes,
      timeline: events.map((e) => ({
        kind: e.kind,
        headline: e.headline,
        detail: e.detail,
        occurredAt: e.occurredAt.toISOString(),
      })),
    };
  });
}

/** Issuing a link, from the office or a technician's phone. */
export async function issueGrant(ctx: ServiceContext, input: z.infer<typeof issuePortalGrant.input>) {
  return guardedWrite(ctx, "portal:grant", async (tx) => {
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + input.expiresInDays * 864e5);

    const [row] = await tx.insert(schema.portalGrant).values({
      organizationId: ctx.actor.organizationId,
      customerId: input.customerId,
      scope: input.scope,
      subjectId: input.subjectId ?? null,
      tokenHash: hash(token),
      expiresAt,
      maxUses: input.maxUses ?? null,
    }).returning();

    await audit(tx, ctx, "portal.grant.issued", "portal_grant", row!.id, null, {
      scope: input.scope, subjectId: input.subjectId ?? null,
    });

    return {
      grant: shapeGrant(row!),
      url: `${PORTAL_BASE}/${pathFor(input.scope)}/${token}`,
    };
  });
}

export async function revokeGrant(ctx: ServiceContext, input: z.infer<typeof revokePortalGrant.input>) {
  return guardedWrite(ctx, "portal:revoke", async (tx) => {
    // A retry is a no-op. Revoking an already revoked grant is not an error,
    // it is the state the caller was asking for.
    await tx.update(schema.portalGrant)
      .set({ revokedAt: new Date() })
      .where(and(eq(schema.portalGrant.id, input.id), isNull(schema.portalGrant.revokedAt)));

    await audit(tx, ctx, "portal.grant.revoked", "portal_grant", input.id, null, null);
    return { ok: true as const };
  });
}

const PORTAL_BASE = process.env.PORTAL_BASE_URL ?? "https://portal.example.com";

const pathFor = (scope: ResolvedGrant["scope"]) =>
  ({ estimate: "e", job: "j", invoice: "i", customer: "c", booking: "b" })[scope];

function shapeGrant(row: typeof schema.portalGrant.$inferSelect) {
  return {
    id: row.id,
    scope: row.scope,
    subjectId: row.subjectId,
    expiresAt: row.expiresAt.toISOString(),
    maxUses: row.maxUses,
    useCount: row.useCount,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Reshapes an office view of an estimate into a customer view.
 *
 * Cost and margin are not redacted here, they are never selected: this builds
 * a new object from the fields a customer is entitled to, rather than deleting
 * fields from one that had everything. A field added to the office shape later
 * cannot leak through a deletion somebody forgot to add.
 */
async function shapeForCustomer(
  tx: Database, grant: ResolvedGrant, full: Awaited<ReturnType<typeof loadEstimate>>,
) {
  const [org] = await tx.select({ name: schema.organization.name })
    .from(schema.organization).where(eq(schema.organization.id, grant.organizationId)).limit(1);

  const [property] = await tx.select({
    line1: schema.property.addressLine1,
    city: schema.property.city,
    state: schema.property.state,
  }).from(schema.property).where(eq(schema.property.id, full.propertyId as string)).limit(1);

  const options = (full.options as Array<Record<string, unknown>>).map((o) => ({
    id: o["id"] as string,
    name: o["name"] as string,
    description: (o["description"] ?? null) as string | null,
    isRecommended: o["isRecommended"] as boolean,
    subtotal: o["subtotal"] as string,
    taxTotal: o["taxTotal"] as string,
    total: o["total"] as string,
    baseTotal: o["baseTotal"] as string,
    lines: (o["lines"] as Array<Record<string, unknown>>).map((l) => ({
      id: l["id"] as string,
      name: l["name"] as string,
      description: (l["description"] ?? null) as string | null,
      quantity: l["quantity"] as string,
      lineTotal: l["lineTotal"] as string,
      isOptional: l["isOptional"] as boolean,
      isSelected: l["isSelected"] as boolean,
    })),
  }));

  return {
    id: full.id as string,
    number: full.number as number,
    status: full.status as string,
    customerId: full.customerId as string,
    propertyId: full.propertyId as string,
    jobId: (full.jobId ?? null) as string | null,
    title: (full.title ?? null) as string | null,
    expiresOn: (full.expiresOn ?? null) as string | null,
    sentAt: toIso(full.sentAt),
    viewedAt: toIso(full.viewedAt),
    decidedAt: toIso(full.decidedAt),
    declineReason: (full.declineReason ?? null) as string | null,
    selectedOptionId: (full.selectedOptionId ?? null) as string | null,
    signerName: (full.signerName ?? null) as string | null,
    currency: full.currency as string,
    createdAt: toIso(full.createdAt)!,
    updatedAt: toIso(full.updatedAt)!,
    organizationName: org?.name ?? "",
    propertyAddress: [property?.line1, property?.city, property?.state].filter(Boolean).join(", "),
    options,
    depositRequired: null,
    termsText: null,
  };
}

const toIso = (v: unknown): string | null =>
  v instanceof Date ? v.toISOString() : typeof v === "string" ? v : null;

/**
 * What the customer owes before the work starts, if anything.
 *
 * Returns nulls rather than throwing when no deposit is configured, because
 * "no deposit on this one" is the normal case for most trades and most jobs.
 */
async function depositFor(
  tx: Database, grant: ResolvedGrant, estimateId: string, _total: string,
): Promise<{ due: string | null; url: string | null }> {
  const [existing] = await tx.select({
    id: schema.deposit.id,
    amountRequested: schema.deposit.amountRequested,
    amountReceived: schema.deposit.amountReceived,
  }).from(schema.deposit)
    .where(and(
      eq(schema.deposit.estimateId, estimateId),
      eq(schema.deposit.organizationId, grant.organizationId),
    )).limit(1);

  if (!existing) return { due: null, url: null };

  const outstanding = m.subtract(
    m.money(existing.amountRequested, "USD"),
    m.money(existing.amountReceived, "USD"),
  );
  if (!m.isPositive(outstanding)) return { due: null, url: null };

  return { due: m.toString(outstanding), url: `${PORTAL_BASE}/pay/${existing.id}` };
}


/**
 * Which visit the customer is asking about.
 *
 * In progress beats upcoming beats most recently finished. Ordering by date
 * alone answers a different question from the one somebody standing at their
 * window is asking.
 */
interface VisitLike {
  id: string;
  status: string;
  windowStart: Date | null;
  windowEnd: Date | null;
  technicianName: string | null;
}

export function pickVisit(visits: readonly VisitLike[], now = new Date()): VisitLike | null {
  if (visits.length === 0) return null;

  const active = visits.find((v) => v.status === "en_route" || v.status === "working" || v.status === "dispatched");
  if (active) return active;

  const upcoming = visits
    .filter((v) => v.status !== "cancelled" && v.windowStart !== null && v.windowStart.getTime() >= now.getTime())
    .sort((a, b) => (a.windowStart?.getTime() ?? 0) - (b.windowStart?.getTime() ?? 0));
  if (upcoming[0]) return upcoming[0];

  const past = visits
    .filter((v) => v.windowStart !== null)
    .sort((a, b) => (b.windowStart?.getTime() ?? 0) - (a.windowStart?.getTime() ?? 0));
  return past[0] ?? visits[0] ?? null;
}

/**
 * The calendar date in the SERVER's timezone, which is the company's.
 *
 * `toISOString().slice(0, 10)` looks equivalent and is not: a 7pm Central
 * appointment is the next day in UTC, so a customer would be told their
 * technician is coming tomorrow.
 */
function localDate(when: Date): string {
  const offset = when.getTimezoneOffset() * 60_000;
  return new Date(when.getTime() - offset).toISOString().slice(0, 10);
}

function formatWindow(start: Date | null, end: Date | null): string | null {
  if (!start) return null;
  const time = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return end ? `${time(start)} to ${time(end)}` : time(start);
}

/** Enough for a customer to greet the person at the door, and no more. */
function firstNameOf(displayName: string): string {
  return displayName.trim().split(/\s+/)[0] ?? displayName;
}

/**
 * Visit states in the words a customer uses.
 *
 * The internal names are for dispatchers. "Unassigned" tells a homeowner
 * their job is unwanted, and "completed after cancellation" is an accounting
 * distinction that is none of their business: from their side the work
 * happened.
 */
export const CUSTOMER_VISIT_STATUS: Record<string, string> = {
  unassigned: "Scheduled",
  scheduled: "Scheduled",
  dispatched: "Scheduled",
  en_route: "On the way",
  working: "In progress",
  completed: "Completed",
  completed_after_cancellation: "Completed",
  cancelled: "Cancelled",
  no_show: "Rescheduling",
};

/**
 * Already cased for display, rather than left lowercase for the page to
 * capitalize.
 *
 * A CSS `capitalize` title-cases every word, so "on the way" rendered as "On
 * The Way". Sentence case is a property of the wording, and the wording lives
 * here.
 */
function customerStatus(status: string): string {
  return CUSTOMER_VISIT_STATUS[status] ?? sentenceCase(status);
}

function sentenceCase(status: string): string {
  const words = status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}
