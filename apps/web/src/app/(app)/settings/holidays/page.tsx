import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { PageHeader } from "@/components/Table";
import { HolidaysSection } from "./HolidaysSection";
import { RatesSection } from "./RatesSection";

export const dynamic = "force-dynamic";

/**
 * SETTINGS → HOLIDAYS AND RATES
 *
 * The company's own days off and short days, and what it charges for work
 * booked outside its hours or on one of them. Shown to anybody who may read
 * settings. The list is changed with the permission the week's hours are set
 * with (`booking:configure`), because both answer "when are you open"; the
 * rates with `pricebook:write`, because they are price book items.
 */
export default async function HolidaysPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Holidays and rates" />
      <div className="mt-4">
        <HolidaysSection ctx={ctx} timezone={user.organizationTimezone} />
      </div>
      <h2 className="mt-10 text-base font-semibold">After hours and holiday rates</h2>
      <div className="mt-2">
        <RatesSection ctx={ctx} />
      </div>
    </div>
  );
}
