import { eq, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { money as m } from "@opentradesos/core";
import { audit, type ServiceContext, guardedRead, guardedWrite } from "./context";

/**
 * WHAT THE PUBLIC BOOKING PAGE SAYS ABOUT A DEPOSIT
 *
 * A service can carry deposit terms (a set amount, or a percent of the price
 * shown). Whether the public booking page tells a customer about them before
 * they book is the company's choice, and it starts off: a company that never
 * turns it on shows nothing about deposits, on the page or in the public
 * services list, exactly as before.
 *
 * Kept in `organization.settings.bookingPage`, beside the member hold, because
 * it is one company wide choice about the booking page.
 *
 * The page takes no money. What it says is what really happens next: the
 * office confirms the booking, and then asks for the deposit. Confirming does
 * not ask for it on its own (see M05, booking deposits).
 */
export interface BookingPageSettings {
  /** The public booking page tells customers about a service's deposit before they book. */
  showDeposits: boolean;
}

const DEFAULT_SETTINGS: BookingPageSettings = { showDeposits: false };

/** The company's choice, read without a session: the public page has none. */
export async function bookingPageSettingsOf(db: Database, organizationId: string): Promise<BookingPageSettings> {
  const [row] = await db.select({ settings: schema.organization.settings })
    .from(schema.organization).where(eq(schema.organization.id, organizationId)).limit(1);
  const saved = ((row?.settings ?? {}) as Record<string, unknown>)["bookingPage"] as Partial<BookingPageSettings> | undefined;
  return { showDeposits: saved?.showDeposits === true ? true : DEFAULT_SETTINGS.showDeposits };
}

export async function bookingPageSettings(ctx: ServiceContext): Promise<BookingPageSettings> {
  return guardedRead(ctx, "booking:read", (tx) => bookingPageSettingsOf(tx, ctx.actor.organizationId));
}

/** Under the permission that edits booking services, with an audit row of what it was. */
export async function setBookingPageSettings(ctx: ServiceContext, input: BookingPageSettings): Promise<BookingPageSettings> {
  return guardedWrite(ctx, "booking:configure", async (tx) => {
    const before = await bookingPageSettingsOf(tx, ctx.actor.organizationId);
    const after: BookingPageSettings = { showDeposits: input.showDeposits === true };
    await tx.update(schema.organization).set({
      settings: sql`coalesce(${schema.organization.settings}, '{}'::jsonb) || ${JSON.stringify({ bookingPage: after })}::jsonb`,
      updatedAt: new Date(),
    }).where(eq(schema.organization.id, ctx.actor.organizationId));
    await audit(tx, ctx, "booking.page_settings_set", "organization", ctx.actor.organizationId, before, after);
    return after;
  });
}

/** A service's deposit terms as the public page tells them. */
export interface PublicDepositTerms {
  /** The dollars asked for: the set amount, or the percent of the price shown. Null for a percent of a service with no price shown. */
  amount: string | null;
  /** The percent asked for, as a rate (0.1 is 10 per cent). Null for a set amount. */
  percent: string | null;
  /** The deposit in words: "This service needs a deposit of $50.00." */
  summary: string;
  /** What happens next, in words, the same for every service. */
  nextStep: string;
}

/**
 * What the customer is told happens next. True to the product as it is: the
 * page takes no money, confirming the booking asks for nothing on its own,
 * and the office asks for the deposit once it has confirmed.
 */
export const DEPOSIT_NEXT_STEP = "You pay nothing on this page. After we confirm your booking, we will ask you for the deposit.";

const dollars = (v: string) =>
  Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" });

/** A rate as a person reads it: 0.1 is "10%", 0.125 is "12.5%". */
const percentOf = (rate: string) => `${Number((Number(rate) * 100).toFixed(4))}%`;

/**
 * The terms for one service, or null when it asks for no deposit. The amount
 * is worked out exactly as a website booking through the API is told it is
 * due (`depositDue`): the set amount, or the percent of the price shown,
 * rounded to the cent.
 */
export function depositTermsOf(service: {
  depositAmount: string | null; depositPercent: string | null; displayPrice: string | null;
}): PublicDepositTerms | null {
  if (service.depositAmount) {
    const amount = m.toString(m.round(m.money(service.depositAmount, "USD"), 2));
    return {
      amount, percent: null,
      summary: `This service needs a deposit of ${dollars(amount)}.`,
      nextStep: DEPOSIT_NEXT_STEP,
    };
  }
  if (service.depositPercent) {
    if (service.displayPrice) {
      const amount = m.toString(m.round(m.multiply(m.money(service.displayPrice, "USD"), service.depositPercent), 2));
      return {
        amount, percent: service.depositPercent,
        summary: `This service needs a deposit of ${dollars(amount)}, which is ${percentOf(service.depositPercent)} of ${dollars(service.displayPrice)}.`,
        nextStep: DEPOSIT_NEXT_STEP,
      };
    }
    return {
      amount: null, percent: service.depositPercent,
      summary: `This service needs a deposit of ${percentOf(service.depositPercent)} of the price. We will tell you the amount when we ask for it.`,
      nextStep: DEPOSIT_NEXT_STEP,
    };
  }
  return null;
}

/** The terms the public may be told: none at all unless the company turned the choice on. */
export function publicDepositTerms(
  settings: BookingPageSettings,
  service: { depositAmount: string | null; depositPercent: string | null; displayPrice: string | null },
): PublicDepositTerms | null {
  return settings.showDeposits ? depositTermsOf(service) : null;
}
