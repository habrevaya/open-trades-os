import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { formatDay, formatIn } from "@/lib/dates";
import { Empty, PageHeader, Table, Th, Td } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * AGREEMENTS ENDING SOON
 *
 * The list the renewal conversation starts from, which is the conversation
 * this whole module exists for. Thirty, sixty or ninety days out, soonest
 * first, and above them the ones that ended in the last month without
 * renewing, because a member whose plan ran out last week and nobody rang is
 * the most valuable call on the page.
 *
 * Each row says whether it will renew on its own and whether the notice the
 * plan owes has gone. "Notice could not be sent" is said in words, with the
 * reason, because that is the member who will be surprised by a charge.
 */
const WINDOWS = [30, 60, 90] as const;

export default async function RenewalsPage({
  searchParams,
}: {
  searchParams: Promise<{ within?: string }>;
}) {
  const user = await requireSetupUser();
  const params = await searchParams;
  const within = WINDOWS.find((d) => String(d) === params.within) ?? 30;

  if (!can(user.actor, "membership:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Ending soon" />
        <Empty title="Agreements are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const rows = await agreements.expiring({ actor: user.actor, db: getDb() }, { withinDays: within });
  const zone = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <a href="/agreements" className="text-sm text-ink-500 hover:underline">Agreements</a>
      <div className="mt-2">
        <PageHeader
          title="Ending soon" count={rows.length}
          action={can(user.actor, "settings:read")
            ? <a href="/agreements/renewals/notices" className="text-sm text-ink-700 hover:underline">Renewal notices</a>
            : undefined}
        />
      </div>

      <div className="mt-4 flex flex-wrap gap-2" role="group" aria-label="How far ahead">
        {WINDOWS.map((days) => (
          <a
            key={days}
            href={`/agreements/renewals?within=${days}`}
            aria-current={days === within ? "page" : undefined}
            className={`inline-flex h-8 items-center rounded px-3 text-sm ${
              days === within
                ? "bg-ink-900 font-medium text-white"
                : "border border-steel-300 text-ink-700 hover:bg-steel-100"
            }`}
          >
            Next {days} days
          </a>
        ))}
      </div>

      {rows.length === 0 ? (
        <Empty title={`Nothing ends in the next ${within} days`}>
          Agreements appear here as their end date comes into view, and stay for a
          month after it if nobody renewed them.
        </Empty>
      ) : (
        <Table head={<><Th>Ends</Th><Th>Customer</Th><Th>Plan</Th><Th>Renews</Th><Th>Notice</Th><Th className="text-right">Price</Th></>}>
          {rows.map((row) => (
            <tr key={row.id}>
              <Td className="tabular-nums">
                {formatDay(row.endsOn, zone)}
                <span className={`block text-xs ${row.daysLeft < 0 ? "text-red-600" : "text-ink-500"}`}>
                  {row.daysLeft < 0
                    ? `Ended ${-row.daysLeft} ${row.daysLeft === -1 ? "day" : "days"} ago`
                    : row.daysLeft === 0 ? "Today" : `In ${row.daysLeft} ${row.daysLeft === 1 ? "day" : "days"}`}
                </span>
              </Td>
              <Td>
                <a href={`/agreements/${row.id}`} className="font-medium hover:underline">{row.customerName}</a>
              </Td>
              <Td className="text-ink-700">{row.planName}</Td>
              <Td>
                {row.status === "lapsed"
                  ? <Chip tone="warning">Lapsed</Chip>
                  : row.renewsAutomatically
                    ? <Chip tone="success">On its own</Chip>
                    : <Chip tone="neutral">Needs a call</Chip>}
              </Td>
              <Td className="text-sm">
                {row.renewalNoticeSentAt === null
                  ? <span className="text-ink-500">Not yet</span>
                  : row.renewalNoticeOutcome === "queued"
                    ? <span className="text-ink-700">Sent {formatIn(row.renewalNoticeSentAt, zone)}</span>
                    : row.renewalNoticeOutcome?.startsWith("Sent by")
                      ? <span className="text-ink-700">{row.renewalNoticeOutcome}</span>
                      : <span className="text-red-600">Could not be sent. {row.renewalNoticeOutcome}</span>}
              </Td>
              <Td className="text-right"><Money value={row.price} /></Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
