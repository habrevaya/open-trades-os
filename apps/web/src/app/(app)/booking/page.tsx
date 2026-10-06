import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { BookingSections } from "./BookingSections";
import { MemberHold } from "./Forms";
import { booking } from "@opentradesos/api/services";

export const dynamic = "force-dynamic";

/**
 * TURNING THE BOOKING PAGE ON
 *
 * The public booking page reads three tables, and until now nothing in this
 * product could write any of them. `bookable_service` had an endpoint that
 * UPDATED a row and no path that created one; `arrival_window` and
 * `business_hours` had neither. So /book/[slug] listed nothing for every
 * company that has ever existed, and the only symptom was an empty page that
 * reads as "this company offers nothing online" rather than as a feature
 * nobody could reach.
 *
 * Three things in the order a person sets them up: what may be booked, when
 * somebody can arrive, and which days you are open. All three have to be
 * answered before a single slot appears, which is why they are on one screen
 * rather than three.
 */
export default async function BookingPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "booking:configure")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Online booking" />
        <Empty title="Booking setup is not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Online booking" />
      <BookingSections ctx={ctx} />
      <p className="mt-3 max-w-prose text-sm text-ink-500">
        Days you close for a holiday, or open shorter, are on{" "}
        <a href="/settings/holidays" className="underline underline-offset-4">Settings, Holidays</a>. The booking
        page offers nothing on a closed day.
      </p>
      <h2 className="mt-10 font-medium text-ink-900">Held for members</h2>
      <MemberHold {...await memberHoldFor(ctx)} />
    </div>
  );
}

async function memberHoldFor(ctx: Parameters<typeof booking.memberHold>[0]) {
  const { plansWithPriority, plans, ...current } = await booking.memberHold(ctx);
  return { current, plansWithPriority, plans };
}
