import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as booking from "../src/services/booking";
import * as bookingPage from "../src/services/booking-page";
import * as portal from "../src/services/portal";
import type { ServiceContext } from "../src/services/context";
import { listBookableServices, createBookingRequest, setBookingPageSettings } from "../src/contracts/booking";
import { openPortalLink } from "../src/contracts/portal";
import { seedOrg, testDb, fixtureId, companyToday } from "./helpers";

/**
 * THE BOOKING PAGE TELLS PEOPLE ABOUT A DEPOSIT, IF THE BUSINESS WANTS IT TO
 *
 * Three services: a set $50 deposit, ten percent of a $189 price, and ten
 * percent with no price shown; and a fourth with no deposit at all. With the
 * company's choice off (as every company starts) the public list carries no
 * deposit terms whatsoever, and a booking's confirmation says nothing. On, a
 * service with terms says them in words with the amount worked out, and one
 * without says nothing. Only somebody who may edit booking services may
 * change the choice, and changing it writes an audit row.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("bpd:org");
const USER = fixtureId("bpd:user");
const SLUG = "booking-page-deposits";
const DAY = companyToday(3);

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: string[]): ServiceContext => ({
  actor: { userId: USER, organizationId: ORG, roles: roles as Actor["roles"] }, db: db(),
});
const owner = () => as(["owner"]);

let windowId = "";
const ids: Record<"flat" | "priced" | "unpriced" | "none", string> = { flat: "", priced: "", unpriced: "", none: "" };

async function listed() {
  const result = await booking.listServices(db(), { organizationSlug: SLUG });
  expect(() => listBookableServices.output.parse(result)).not.toThrow();
  const by = (id: string) => result.services.find((s) => s.id === id)!;
  return { flat: by(ids.flat), priced: by(ids.priced), unpriced: by(ids.unpriced), none: by(ids.none) };
}

let booked = 0;
async function book(serviceId: string) {
  booked += 1;
  const made = await booking.createRequest(db(), {
    organizationSlug: SLUG, bookableServiceId: serviceId, requestedDate: DAY, arrivalWindowId: windowId,
    contactName: `Pat Booker ${booked}`, contactEmail: `pat${booked}@example.com`,
    addressLine1: `${booked} Elm St`, city: "Austin", state: "TX", postalCode: "78701",
    intakeAnswers: {}, utm: {},
  });
  expect(() => createBookingRequest.output.parse(made)).not.toThrow();
  return made;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Deposit Page Plumbing", slug: SLUG });
  for (let day = 0; day < 7; day += 1) {
    await raw`insert into public.business_hours (organization_id, day_of_week, opens_at, closes_at)
              values (${ORG}, ${day}, '07:00', '18:00')`;
  }
  const [w] = await raw<{ id: string }[]>`insert into public.arrival_window (organization_id, name, starts_at, ends_at, days_of_week)
    values (${ORG}, 'Morning', '08:00', '12:00', ${[0, 1, 2, 3, 4, 5, 6]}) returning id`;
  windowId = w!.id;
  const make = async (name: string, price: string | null, amount: string | null, percent: string | null) => {
    const [t] = await raw<{ id: string }[]>`insert into public.job_type (organization_id, name) values (${ORG}, ${name}) returning id`;
    const [s] = await raw<{ id: string }[]>`insert into public.bookable_service
      (organization_id, job_type_id, public_name, display_price, deposit_amount, deposit_percent, max_per_window, min_notice_hours)
      values (${ORG}, ${t!.id}, ${name}, ${price}, ${amount}, ${percent}, 20, 0) returning id`;
    return s!.id;
  };
  ids.flat = await make("Water heater swap", "1200.00", "50.00", null);
  ids.priced = await make("Drain clearing", "189.00", null, "0.10");
  ids.unpriced = await make("Repipe", null, null, "0.10");
  ids.none = await make("Leak check", "89.00", null, null);
});

afterAll(async () => { if (raw) await raw.end(); });

run("the booking page shows deposits only when the company chooses to", () => {
  it("starts off, and the public list then carries no deposit terms at all", async () => {
    expect(await bookingPage.bookingPageSettings(owner())).toEqual({ showDeposits: false });
    const services = await listed();
    for (const s of Object.values(services)) {
      expect(s.depositAmount).toBeNull();
      expect(s.depositPercent).toBeNull();
      expect(s.deposit).toBeNull();
    }
    expect(JSON.stringify(services)).not.toMatch(/deposit of/i);
  });

  it("says nothing about a deposit on a booking's confirmation or its tracking link while off", async () => {
    const made = await book(ids.flat);
    expect(made.deposit).toBeNull();
    /** What a website booking through the API was told before this choice existed, unchanged. */
    expect(made.depositDue).toBe("50.0000");
    expect(made.paymentUrl).toBeNull();
    const session = await portal.openLink(db(), { token: made.trackingUrl.split("/b/")[1]! });
    expect(session.scope).toBe("booking");
    expect(session.bookingDeposit).toBeNull();
  });

  it("refuses somebody who cannot edit booking services, and changes nothing", async () => {
    await expect(bookingPage.setBookingPageSettings(as(["dispatcher"]), { showDeposits: true })).rejects.toThrow();
    await expect(bookingPage.setBookingPageSettings(as(["technician"]), { showDeposits: true })).rejects.toThrow();
    expect(await bookingPage.bookingPageSettings(owner())).toEqual({ showDeposits: false });
    /** A dispatcher may read it: they see booking requests. */
    expect(await bookingPage.bookingPageSettings(as(["dispatcher"]))).toEqual({ showDeposits: false });
    const [{ n } = { n: 0 }] = await raw<{ n: number }[]>`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'booking.page_settings_set'`;
    expect(n).toBe(0);
  });

  it("turns on under booking:configure and writes an audit row with what it was", async () => {
    const after = await bookingPage.setBookingPageSettings(owner(), { showDeposits: true });
    expect(() => setBookingPageSettings.output.parse(after)).not.toThrow();
    expect(after).toEqual({ showDeposits: true });
    expect(await bookingPage.bookingPageSettings(owner())).toEqual({ showDeposits: true });
    const rows = await raw<{ before: unknown; after: unknown; entity_type: string; actor_user_id: string }[]>`
      select before, after, entity_type, actor_user_id from public.audit_log
      where organization_id = ${ORG} and action = 'booking.page_settings_set'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ before: { showDeposits: false }, after: { showDeposits: true }, entity_type: "organization", actor_user_id: USER });
  });

  it("then shows a set amount in dollars, a percent of the price worked out, and a percent with no price as a percent", async () => {
    const services = await listed();
    expect(services.flat.depositAmount).toBe("50.0000");
    expect(services.flat.deposit).toEqual({
      amount: "50.0000", percent: null,
      summary: "This service needs a deposit of $50.00.",
      nextStep: "You pay nothing on this page. After we confirm your booking, we will ask you for the deposit.",
    });
    expect(services.priced.depositPercent).toBe("0.100000");
    expect(services.priced.deposit).toMatchObject({
      amount: "18.9000", percent: "0.100000",
      summary: "This service needs a deposit of $18.90, which is 10% of $189.00.",
    });
    expect(services.unpriced.deposit).toMatchObject({
      amount: null, percent: "0.100000",
      summary: "This service needs a deposit of 10% of the price. We will tell you the amount when we ask for it.",
    });
  });

  it("shows nothing for a service with no deposit terms, even when on", async () => {
    const { none } = await listed();
    expect(none.depositAmount).toBeNull();
    expect(none.depositPercent).toBeNull();
    expect(none.deposit).toBeNull();
    const made = await book(ids.none);
    expect(made.deposit).toBeNull();
    expect(made.depositDue).toBeNull();
  });

  it("says it again on the booking's confirmation and on its tracking link, and takes no money", async () => {
    const made = await book(ids.priced);
    expect(made.deposit?.summary).toBe("This service needs a deposit of $18.90, which is 10% of $189.00.");
    expect(made.depositDue).toBe("18.9000");
    expect(made.paymentUrl).toBeNull();
    const session = await portal.openLink(db(), { token: made.trackingUrl.split("/b/")[1]! });
    expect(() => openPortalLink.output.parse(session)).not.toThrow();
    expect(session.bookingDeposit?.summary).toBe("This service needs a deposit of $18.90, which is 10% of $189.00.");
    const [{ n } = { n: 0 }] = await raw<{ n: number }[]>`select count(*)::int as n from public.deposit where organization_id = ${ORG}`;
    expect(n).toBe(0);
  });

  it("a confirmed booking asks for no deposit on its own: the office asks for it after", async () => {
    const made = await book(ids.flat);
    await booking.confirm(owner(), { id: made.request.id });
    const [{ n } = { n: 0 }] = await raw<{ n: number }[]>`select count(*)::int as n from public.deposit where organization_id = ${ORG}`;
    expect(n).toBe(0);
  });

  it("turned off again, the public list goes back to carrying nothing", async () => {
    await bookingPage.setBookingPageSettings(owner(), { showDeposits: false });
    const services = await listed();
    expect(services.flat.deposit).toBeNull();
    expect(services.flat.depositAmount).toBeNull();
    expect(services.priced.depositPercent).toBeNull();
  });
});
