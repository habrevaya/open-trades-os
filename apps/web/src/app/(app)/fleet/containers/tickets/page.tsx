import { requireSetupUser } from "@/lib/auth";
import { can } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader } from "@/components/Table";
import { TicketImport } from "./TicketImport";

export const dynamic = "force-dynamic";

/**
 * A FACILITY'S SCALE TICKETS, ONTO THE HAULS THEY WEIGHED
 *
 * Every landfill and transfer station can send a month of tickets as a file.
 * Retyping them is how 2.4 tons becomes 4.2. Each ticket is matched to the
 * haul that collected or swapped out that can on the ticket's day or the day
 * before, and nothing a driver typed is ever overwritten: a weight that
 * disagrees with the file is skipped with both numbers.
 */
export default async function TicketsPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "asset:write")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Scale tickets" />
        <Empty title="Not part of your access">Attaching tickets to hauls needs the manage company assets permission.</Empty>
      </div>
    );
  }
  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/fleet/containers">Containers</Crumb>
      <PageHeader title="Scale tickets" />
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        A ticket number, the date, the can&apos;s number and the weight on each row. The weight can be net tons, net
        pounds, or gross and tare in pounds; dates as 2026-06-15 or 6/15/2026.
      </p>
      <div className="mt-6"><TicketImport /></div>
    </div>
  );
}
