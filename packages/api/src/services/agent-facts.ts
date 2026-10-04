import { and, eq, ilike, inArray, isNull, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { agents as a, time } from "@opentradesos/core";
import { memberTestAmong, openSlots, type MemberShare } from "./booking";
import { inForceAt } from "./pricebook";

/**
 * THE COMPANY'S OWN FACTS, AS AN AGENT IS GIVEN THEM
 *
 * Read from the same rows the rest of the product reads: the booking windows
 * the online booking page offers, from the same function, the hours on the
 * setup screen, the territories on the service area screen. An agent that kept
 * its own copy of "when are we open" would be the second calendar this
 * codebase keeps refusing to have.
 *
 * Every reader takes a transaction the caller already opened inside the
 * tenant, so row level security is what scopes it.
 */

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

export interface CompanyFacts {
  name: string;
  slug: string;
  timezone: string;
  today: string;
  localTime: string;
}

export async function companyOf(tx: Database, organizationId: string, now: Date): Promise<CompanyFacts> {
  const [org] = await tx.select({
    name: schema.organization.name, slug: schema.organization.slug, timezone: schema.organization.timezone,
  }).from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const timezone = org?.timezone ?? "America/Chicago";
  return {
    name: org?.name ?? "the company",
    slug: org?.slug ?? "",
    timezone,
    today: time.dateIn(now, timezone),
    localTime: now.toLocaleTimeString("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" }),
  };
}

/**
 * The services the company books online and the windows open on each, from
 * the function the booking page itself calls.
 *
 * Capped, because a model given two hundred windows reads the first ten and
 * pays for the rest. A handful per service over the next week is what an
 * office would offer on the phone.
 */
export async function servicesAndWindows(
  tx: Database, organizationId: string, timezone: string, today: string,
  options: {
    days?: number; perService?: number;
    /** A member reached the assistant: the windows include their plan's share of what is held. */
    member?: MemberShare | null | undefined;
  } = {},
): Promise<{
  services: (typeof schema.bookableService.$inferSelect)[];
  windows: a.OpenWindow[];
}> {
  const services = await tx.select().from(schema.bookableService)
    .where(and(
      eq(schema.bookableService.organizationId, organizationId),
      eq(schema.bookableService.isActive, true),
    ))
    .orderBy(schema.bookableService.publicName);
  const windows: a.OpenWindow[] = [];
  for (const service of services.slice(0, 12)) {
    const slots = await openSlots(tx, {
      organizationId, timezone, service, from: today, days: options.days ?? 8,
      ...(options.member ? { member: options.member } : {}),
    });
    for (const slot of slots.slice(0, options.perService ?? 6)) {
      windows.push({
        bookableServiceId: service.id,
        date: slot.date,
        arrivalWindowId: slot.arrivalWindowId,
        label: `${slot.label}, ${slot.date} (${slot.startsAt.slice(0, 5)} to ${slot.endsAt.slice(0, 5)})`,
      });
    }
  }
  return { services, windows };
}

/**
 * A MEMBER, RECOGNISED BY HOW THEY REACHED US
 *
 * The number a caller rings or texts from, or an email or number a visitor
 * gives, matched to the customers who have it, and whether any of them holds
 * a running plan that promises priority. When one does, the windows offered
 * include their plan's share of what is held for members, as their own
 * account would offer them.
 *
 * NOTHING IS SAID ABOUT IT. A number can be borrowed and an email typed by
 * anybody, so neither proves who is asking. The assistant is never told
 * there is a membership, a plan or an account: the only difference is which
 * windows are on its list, which is no more than the booking page would show
 * the member, and nothing the caller hears tells them whose number it was.
 * The office is told, in the assistant's own record of what it did.
 *
 * Read with the organization named, because the chat's public side reaches
 * this without a person's scope; a match is a lookup, not a disclosure.
 */
export async function memberByContact(
  tx: Database, organizationId: string,
  contact: { phone?: string | null | undefined; email?: string | null | undefined; customerId?: string | null | undefined },
): Promise<MemberShare | null> {
  const digits = (contact.phone ?? "").replace(/\D/g, "");
  const local = digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  const email = contact.email?.trim() ?? "";
  const ors = [
    contact.customerId ? eq(schema.customer.id, contact.customerId) : undefined,
    local.length >= 10
      ? sql`right(regexp_replace(coalesce(${schema.customer.phone}, ''), '[^0-9]', '', 'g'), 10) = ${local.slice(-10)}`
      : undefined,
    /.+@.+\..+/.test(email) ? ilike(schema.customer.email, email.replace(/[%_\\]/g, "")) : undefined,
  ].filter((x) => x !== undefined);
  if (ors.length === 0) return null;
  const rows = await tx.select({ id: schema.customer.id }).from(schema.customer)
    .where(and(eq(schema.customer.organizationId, organizationId), isNull(schema.customer.deletedAt), or(...ors)))
    .limit(5);
  return memberTestAmong(tx, organizationId, rows.map((r) => r.id));
}

/** The phone numbers and emails somebody wrote in their own messages, for `memberByContact`. */
export function contactsIn(texts: readonly string[]): { phone: string | null; email: string | null } {
  const joined = texts.join("\n");
  const email = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.exec(joined)?.[0] ?? null;
  const phone = /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/.exec(joined)?.[0] ?? null;
  return { phone, email };
}

/** Opening hours as sentences, one per day, closed days said. */
export async function hoursOf(tx: Database, organizationId: string): Promise<string[]> {
  const rows = await tx.select().from(schema.businessHours)
    .where(eq(schema.businessHours.organizationId, organizationId));
  if (rows.length === 0) return [];
  return DAYS.map((day, index) => {
    const row = rows.find((r) => r.dayOfWeek === index && r.businessUnitId === null) ?? rows.find((r) => r.dayOfWeek === index);
    if (!row || row.closed || !row.opensAt || !row.closesAt) return `${day}: closed`;
    return `${day}: ${row.opensAt.slice(0, 5)} to ${row.closesAt.slice(0, 5)}`;
  });
}

/** Where the company works, by territory, with the postal codes each covers. */
export async function serviceAreaOf(tx: Database, organizationId: string): Promise<string[]> {
  const rows = await tx.select().from(schema.territory)
    .where(and(eq(schema.territory.organizationId, organizationId), eq(schema.territory.active, true)));
  return rows.map((row) => row.postalCodes.length > 0
    ? `${row.name}: postal codes ${row.postalCodes.slice(0, 60).join(", ")}`
    : row.name);
}

/** A window's two instants, in the company's zone. */
export function windowInstants(date: string, startsAt: string, endsAt: string, timezone: string): { start: Date; end: Date } {
  const day = time.startOfDayIn(date, timezone).getTime();
  const minutes = (clock: string) => {
    const [h, m] = clock.split(":").map(Number);
    return (h ?? 0) * 60 + (m ?? 0);
  };
  return { start: new Date(day + minutes(startsAt) * 60_000), end: new Date(day + minutes(endsAt) * 60_000) };
}

/**
 * Price book items with the price in force now, and never their cost.
 *
 * Cost and margin are fields a technician's role is refused, and a model's
 * prompt is not a place to put a number some of the people reading its output
 * may not see. Only the selling price goes in.
 */
export async function bookItems(
  tx: Database, organizationId: string, options: { ids?: readonly string[]; limit?: number } = {},
): Promise<{ items: a.BookItem[]; truncated: boolean }> {
  if (options.ids && options.ids.length === 0) return { items: [], truncated: false };
  const limit = options.limit ?? 400;
  const rows = await tx.select({
    id: schema.priceBookItem.id,
    name: schema.priceBookItemVersion.name,
    description: schema.priceBookItemVersion.description,
    price: schema.priceBookItemVersion.price,
  }).from(schema.priceBookItem)
    .innerJoin(schema.priceBookItemVersion, eq(schema.priceBookItemVersion.itemId, schema.priceBookItem.id))
    .where(and(
      eq(schema.priceBookItem.organizationId, organizationId),
      eq(schema.priceBookItem.active, true),
      inForceAt(),
      options.ids ? inArray(schema.priceBookItem.id, [...options.ids]) : undefined,
    ))
    .orderBy(schema.priceBookItemVersion.name)
    .limit(limit + 1);
  return { items: rows.slice(0, limit), truncated: rows.length > limit };
}
