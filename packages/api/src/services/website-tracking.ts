import { and, asc, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, marketing as mk, tracking, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, ConflictError, NotFoundError, OrganizationSuspendedError, DemoReadOnlyError,
  TooManyRequestsError, type RequestMeta, type ServiceContext,
} from "./context";
import * as marketingService from "./marketing";

/**
 * THE SNIPPET'S SERVER SIDE
 *
 * Two public endpoints and the settings behind them. `POST /v1/public/touches`
 * records how a visitor arrived on the company's own site, and
 * `GET /v1/public/dni` hands a visitor a number from the company's pool and
 * keeps their lease on it alive. Both are reached by a stranger's browser with
 * no login, so both resolve the company from its public key (the slug its
 * booking page already shows), both are counted per key and refused past a
 * ceiling, and both accept only what `core/tracking` says a touch may carry.
 *
 * When a call arrives on a pool number, `leaseForCall` finds the visit that
 * was holding the number at that moment, and the call is recorded with that
 * visit's arrival as its attribution (see `call-tracking.record`).
 */

/* ------------------------------------------------------------- settings */

export async function settingsWithin(tx: Database, organizationId: string): Promise<tracking.TrackingSettings> {
  const [row] = await tx.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const stored = ((row?.settings ?? {}) as Record<string, unknown>)["tracking"] as Record<string, unknown> | undefined;
  const checked = tracking.checkTrackingSettings({ idleMinutes: stored?.["idleMinutes"] });
  return checked.ok ? checked.settings : { idleMinutes: tracking.DEFAULT_IDLE_MINUTES };
}

/** What the settings screen shows: the key, the pool and who holds each number now. */
export async function overview(ctx: ServiceContext) {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const org = ctx.actor.organizationId;
    const settings = await settingsWithin(tx, org);
    const [company] = await tx.select({ slug: schema.organization.slug })
      .from(schema.organization).where(eq(schema.organization.id, org)).limit(1);
    await releaseLapsed(tx, org, settings.idleMinutes, new Date());
    const pool = await tx.select({ id: schema.phoneNumber.id, e164: schema.phoneNumber.e164, label: schema.phoneNumber.label })
      .from(schema.phoneNumber)
      .where(and(eq(schema.phoneNumber.purpose, "pool"), isNull(schema.phoneNumber.releasedAt)))
      .orderBy(asc(schema.phoneNumber.createdAt));
    const live = await tx.select({ phoneNumberId: schema.dniSession.phoneNumberId, lastSeenAt: schema.dniSession.lastSeenAt })
      .from(schema.dniSession).where(isNull(schema.dniSession.releasedAt));
    const held = new Map(live.map((l) => [l.phoneNumberId, l.lastSeenAt]));
    return {
      companyKey: company?.slug ?? "",
      idleMinutes: settings.idleMinutes,
      pool: pool.map((n) => ({
        ...n,
        heldSince: held.get(n.id)?.toISOString() ?? null,
      })),
    };
  });
}

export async function setSettings(ctx: ServiceContext, input: { idleMinutes: number }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const checked = tracking.checkTrackingSettings(input);
    if (!checked.ok) throw new ConflictError(checked.reason);
    const before = await settingsWithin(tx, ctx.actor.organizationId);
    /** Merged with jsonb `||`, so the other settings saved beside it are left alone. */
    await tx.update(schema.organization).set({
      settings: sql`${schema.organization.settings} || ${JSON.stringify({ tracking: checked.settings })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "tracking.settings", "organization", ctx.actor.organizationId, before, checked.settings);
    return checked.settings;
  });
}

/* --------------------------------------------------------- the open door */

/**
 * Count one knock on a key, and refuse past the ceiling.
 *
 * Through `app.count_public_hit`, a security definer function, because the
 * count is taken before any tenant is known and the table has row level
 * security on with no policy: nothing reads it but this.
 */
export async function throttle(db: Database, key: string, limit: number, windowSeconds = 60): Promise<void> {
  const [row] = await db.execute<{ hits: number }>(
    sql`select app.count_public_hit(${key}, ${windowSeconds}) as hits`,
  );
  if (Number(row?.hits ?? 0) > limit) throw new TooManyRequestsError(windowSeconds);
}

/** The ceilings, per minute. Generous for a person, small for a script. */
export const LIMITS = {
  touchPerAddress: 30,
  touchPerVisitor: 10,
  touchPerCompany: 3000,
  dniPerAddress: 60,
  dniPerCompany: 6000,
  formPerAddress: 10,
  formPerForm: 300,
} as const;

/**
 * The company a public key names, or nothing.
 *
 * The key is the company's slug, which its booking page already prints: it
 * identifies, it does not authorise, and nothing here acts on it beyond
 * writing a touch or a lease that the company's own reports then read.
 */
export async function companyFor(
  db: Database, companyKey: string,
): Promise<{ id: string; slug: string; demo: boolean }> {
  const [org] = await db.select({
    id: schema.organization.id, slug: schema.organization.slug, suspendedAt: schema.organization.suspendedAt,
    demoUserId: schema.organization.demoUserId,
  }).from(schema.organization).where(eq(schema.organization.slug, companyKey.trim().toLowerCase())).limit(1);
  if (!org) throw new NotFoundError("Company");
  if (org.suspendedAt) throw new OrganizationSuspendedError();
  return { id: org.id, slug: org.slug, demo: org.demoUserId !== null };
}

/**
 * The company a public key names, for a request that writes there. The
 * public demo keeps nothing a stranger sends it: not a visit, not a number
 * lease, not a sign in code.
 */
export async function writableCompanyFor(db: Database, companyKey: string): Promise<{ id: string; slug: string }> {
  const company = await companyFor(db, companyKey);
  if (company.demo) throw new DemoReadOnlyError();
  return company;
}

function siteActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: [], agentId: "website" };
}

const addressOf = (meta?: RequestMeta) => meta?.ip?.slice(0, 64) || "unknown";

/**
 * A visitor arrived on the company's site.
 *
 * At most one touch per visitor per arrival: the same tags and the same
 * referring host from the same visitor within half an hour is the same visit
 * moving between pages, and counting it again would make every page view a
 * lead.
 */
export async function recordVisit(
  db: Database,
  input: { companyKey: string; visitorId: string; page?: string | undefined; query?: string | undefined; referrer?: string | undefined },
  meta?: RequestMeta,
): Promise<{ recorded: boolean; touchId: string | null }> {
  const checked = tracking.checkPublicTouch(input);
  if (!checked.ok) throw new ConflictError(checked.reason);
  const company = await writableCompanyFor(db, input.companyKey);
  await throttle(db, `touch:co:${company.id}`, LIMITS.touchPerCompany);
  await throttle(db, `touch:ip:${company.id}:${addressOf(meta)}`, LIMITS.touchPerAddress);
  await throttle(db, `touch:v:${company.id}:${checked.visitorId}`, LIMITS.touchPerVisitor);

  return inTenant({ actor: siteActor(company.id), db }, async (tx) => {
    const host = checked.referrer ? mk.referrerHost(checked.referrer) : null;
    const since = new Date(Date.now() - 30 * 60_000);
    const [recent] = await tx.select({
      id: schema.marketingTouch.id, utmSource: schema.marketingTouch.utmSource,
      utmCampaign: schema.marketingTouch.utmCampaign, clickId: schema.marketingTouch.clickId,
      referrerHost: schema.marketingTouch.referrerHost,
    }).from(schema.marketingTouch)
      .where(and(
        eq(schema.marketingTouch.visitorId, checked.visitorId),
        gte(schema.marketingTouch.occurredAt, since),
      ))
      .orderBy(desc(schema.marketingTouch.occurredAt)).limit(1);
    const parsed = mk.parseTouch({ at: new Date(), query: checked.query, referrer: checked.referrer });
    if (recent
      && (recent.utmSource ?? null) === (parsed.utm.source ?? null)
      && (recent.utmCampaign ?? null) === (parsed.utm.campaign ?? null)
      && (recent.clickId ?? null) === parsed.clickId
      && (recent.referrerHost ?? null) === host) {
      return { recorded: false, touchId: recent.id };
    }

    const touch = await marketingService.recordTouch(tx, company.id, {
      at: new Date(),
      visitorId: checked.visitorId,
      query: checked.query,
      referrer: checked.referrer,
      landingPath: checked.landingPath,
    });
    return { recorded: true, touchId: touch.id };
  });
}

/**
 * The number this visitor should see.
 *
 * A live lease is renewed and returned. Otherwise the pool number free the
 * longest is leased to them; two visitors racing for the last free number
 * are settled by the live index, and the loser tries the next. With the pool
 * empty, the static tracking number for the visitor's own source, or the
 * main number, is returned unleased, and a call on it is credited the way any
 * call on that number is.
 */
export async function numberFor(
  db: Database,
  input: { companyKey: string; visitorId: string; query?: string | undefined; referrer?: string | undefined; page?: string | undefined },
  meta?: RequestMeta,
  now: Date = new Date(),
): Promise<{ number: string | null; pooled: boolean; targets: string[]; idleSeconds: number }> {
  const checked = tracking.checkPublicTouch(input);
  if (!checked.ok) throw new ConflictError(checked.reason);
  const company = await writableCompanyFor(db, input.companyKey);
  await throttle(db, `dni:co:${company.id}`, LIMITS.dniPerCompany);
  await throttle(db, `dni:ip:${company.id}:${addressOf(meta)}`, LIMITS.dniPerAddress);

  return inTenant({ actor: siteActor(company.id), db }, async (tx) => {
    const { idleMinutes } = await settingsWithin(tx, company.id);
    await releaseLapsed(tx, company.id, idleMinutes, now);

    const numbers = await tx.select({
      id: schema.phoneNumber.id, e164: schema.phoneNumber.e164, purpose: schema.phoneNumber.purpose,
      source: schema.phoneNumber.attributionSource,
    }).from(schema.phoneNumber)
      .where(and(isNull(schema.phoneNumber.releasedAt), inArray(schema.phoneNumber.purpose, ["main", "tracking", "pool"])))
      .orderBy(asc(schema.phoneNumber.createdAt));
    /** The numbers a page shows that the swap replaces: the main line and the static tracking numbers. */
    const targets = numbers.filter((n) => n.purpose !== "pool").map((n) => n.e164);
    const answer = (number: string | null, pooled: boolean) =>
      ({ number, pooled, targets, idleSeconds: idleMinutes * 60 });

    const [mine] = await tx.select().from(schema.dniSession)
      .where(and(eq(schema.dniSession.visitorId, checked.visitorId), isNull(schema.dniSession.releasedAt)))
      .limit(1);
    if (mine) {
      await tx.update(schema.dniSession).set({ lastSeenAt: now, updatedAt: now })
        .where(eq(schema.dniSession.id, mine.id));
      return answer(mine.e164, true);
    }

    const pool = numbers.filter((n) => n.purpose === "pool");
    if (pool.length > 0) {
      const live = await tx.select({ phoneNumberId: schema.dniSession.phoneNumberId })
        .from(schema.dniSession).where(isNull(schema.dniSession.releasedAt));
      const recent = await tx.select({
        phoneNumberId: schema.dniSession.phoneNumberId,
        last: sql<string>`max(${schema.dniSession.assignedAt})::text`,
      }).from(schema.dniSession).groupBy(schema.dniSession.phoneNumberId);
      const lastBy = new Map(recent.map((r) => [r.phoneNumberId, new Date(r.last)]));
      const leased = new Set(live.map((l) => l.phoneNumberId));
      for (let attempt = 0; attempt < pool.length; attempt += 1) {
        const pick = tracking.choosePoolNumber(
          pool.map((n) => ({ ...n, lastLeasedAt: lastBy.get(n.id) ?? null })), leased,
        );
        if (!pick) break;
        const [lease] = await tx.insert(schema.dniSession).values({
          organizationId: company.id,
          visitorId: checked.visitorId,
          phoneNumberId: pick.id,
          e164: pick.e164,
          landingQuery: checked.query || null,
          referrer: checked.referrer,
          landingPath: checked.landingPath,
          assignedAt: now,
          lastSeenAt: now,
        }).onConflictDoNothing({
          target: [schema.dniSession.organizationId, schema.dniSession.phoneNumberId],
          where: sql`${schema.dniSession.releasedAt} is null`,
        }).returning({ id: schema.dniSession.id });
        if (lease) return answer(pick.e164, true);
        leased.add(pick.id);
      }
    }

    const source = mk.parseTouch({ at: now, query: checked.query, referrer: checked.referrer }).source;
    const main = numbers.find((n) => n.purpose === "main")?.e164 ?? null;
    return answer(tracking.fallbackNumber({
      source,
      statics: numbers.filter((n) => n.purpose === "tracking").map((n) => ({ e164: n.e164, source: n.source })),
      main,
    }), false);
  });
}

/**
 * Hand back every lease whose visitor has gone quiet, stamped with the moment
 * it lapsed rather than now, so the window a call is matched in is the real one.
 */
export async function releaseLapsed(tx: Database, organizationId: string, idleMinutes: number, now: Date): Promise<number> {
  const cutoff = new Date(now.getTime() - idleMinutes * 60_000);
  const rows = await tx.update(schema.dniSession).set({
    releasedAt: sql`${schema.dniSession.lastSeenAt} + make_interval(mins => ${idleMinutes}::int)`,
    updatedAt: now,
  }).where(and(
    eq(schema.dniSession.organizationId, organizationId),
    isNull(schema.dniSession.releasedAt),
    lt(schema.dniSession.lastSeenAt, cutoff),
  )).returning({ id: schema.dniSession.id });
  return rows.length;
}

/** The worker's pass over one company: give back the numbers quiet visitors still hold. */
export async function releaseIdle(db: Database, organizationId: string, now: Date = new Date()): Promise<number> {
  return inTenant({ actor: siteActor(organizationId), db }, async (tx) => {
    const { idleMinutes } = await settingsWithin(tx, organizationId);
    return releaseLapsed(tx, organizationId, idleMinutes, now);
  });
}

/**
 * The visit that held a pool number when a call on it started, or nothing.
 *
 * Leases assigned in the day before the call are enough: a lease cannot
 * cover a call more than its idle time after it was last renewed, and no
 * company's idle time is a day.
 */
export async function leaseForCall(tx: Database, organizationId: string, phoneNumberId: string, at: Date) {
  const { idleMinutes } = await settingsWithin(tx, organizationId);
  const leases = await tx.select().from(schema.dniSession)
    .where(and(
      eq(schema.dniSession.organizationId, organizationId),
      eq(schema.dniSession.phoneNumberId, phoneNumberId),
      gte(schema.dniSession.assignedAt, new Date(at.getTime() - 86_400_000)),
    ));
  return tracking.leaseAt(leases, at, idleMinutes);
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  recordPublicTouch: (db: Database, input: {
    companyKey: string; visitorId: string; page?: string | undefined; query?: string | undefined; referrer?: string | undefined;
  }, meta?: RequestMeta) => recordVisit(db, input, meta),

  getVisitorNumber: (db: Database, input: {
    companyKey: string; visitorId: string; page?: string | undefined; query?: string | undefined; referrer?: string | undefined;
  }, meta?: RequestMeta) => numberFor(db, input, meta),

  getWebsiteTracking: (ctx: ServiceContext) => overview(ctx),

  setWebsiteTracking: (ctx: ServiceContext, input: { idleMinutes: number }) => setSettings(ctx, input),
} as const;
