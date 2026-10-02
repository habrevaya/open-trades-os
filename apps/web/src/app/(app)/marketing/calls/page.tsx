import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { marketingReport } from "@opentradesos/api/services";
import { Chip, Phone } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { formatIn, todayIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * EVERY CALL THAT CAME IN, AND WHAT IT AMOUNTED TO
 *
 * The number it arrived on and the campaign and channel that number belonged
 * to at the time, whether the caller had rung before, and what the call was:
 * core's outcome from the facts (answered, answered for four seconds,
 * voicemail, gave up on hold, booked) rather than a disposition somebody
 * remembered to pick on the calls that went well.
 *
 * A call nobody has turned into anything is the worklist: one press makes the
 * customer and the job, credited to the call's campaign.
 */
export default async function CallsPage(
  { searchParams }: { searchParams: Promise<Record<string, string | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const params = await searchParams;
  const today = todayIn(user.organizationTimezone);
  const monthAgo = new Date(Date.parse(`${today}T12:00:00Z`) - 29 * 86_400_000).toISOString().slice(0, 10);
  const iso = (value: string | undefined, fallback: string) => value && /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
  const from = iso(params["from"], monthAgo);
  const to = iso(params["to"], today);
  const uuid = (value: string | undefined) => value && /^[0-9a-f-]{36}$/.test(value) ? value : undefined;
  const numberId = uuid(params["number"]);
  const campaignId = uuid(params["campaign"]);

  const { calls } = await marketingReport.handlers.listMarketingCalls(ctx, {
    from, to,
    ...(numberId ? { numberId } : {}),
    ...(campaignId ? { campaignId } : {}),
  });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Calls" count={calls.length} />
      <form method="get" className="mt-4 flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-700">From</span>
          <input type="date" name="from" defaultValue={from} className="h-9 rounded border border-steel-300 px-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-700">To</span>
          <input type="date" name="to" defaultValue={to} className="h-9 rounded border border-steel-300 px-2" />
        </label>
        {numberId ? <input type="hidden" name="number" value={numberId} /> : null}
        <button type="submit" className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white">Show</button>
      </form>

      {calls.length === 0 ? (
        <Empty title="No calls in these dates">
          Calls arrive from your call tracking provider. Connect CallRail under Settings, then put each
          tracking number on a campaign.
        </Empty>
      ) : (
        <Table label="Calls" head={
          <><Th>When</Th><Th>Caller</Th><Th>Number</Th><Th>Campaign</Th><Th>Channel</Th><Th>What it was</Th>
            <Th>Caller before</Th><Th>Length</Th><Th>Customer</Th></>
        }>
          {calls.map((call) => (
            <tr key={call.id}>
              <Td>{formatIn(call.startedAt, user.organizationTimezone)}</Td>
              <Td><Phone value={call.from} /></Td>
              <Td>
                {call.receivedOn ? <Phone value={call.receivedOn} /> : null}
                {call.numberLabel ? <span className="block text-xs text-ink-500">{call.numberLabel}</span> : null}
              </Td>
              <Td>{call.campaignName ?? <span className="text-ink-500">None</span>}</Td>
              <Td>{call.channelName ?? <span className="text-ink-500">Not placed</span>}</Td>
              <Td><span title={call.outcomeWhy}><Chip tone={call.outcome === "booked" ? "success" : call.outcome === "missed" || call.outcome.startsWith("voicemail") || call.outcome.startsWith("abandoned") ? "warning" : "neutral"}>{call.outcomeLabel}</Chip></span></Td>
              <Td>{call.firstTimeCaller === true ? "First time" : call.firstTimeCaller === false ? "Called before" : "Not known"}</Td>
              <Td className="tabular-nums">{call.durationSeconds !== null ? `${Math.floor(call.durationSeconds / 60)}m ${call.durationSeconds % 60}s` : ""}</Td>
              <Td>
                {call.jobId ? (
                  <a href={`/jobs/${call.jobId}`} className="underline underline-offset-4">{call.customerName ?? "The job"}</a>
                ) : call.customerId ? (
                  <>
                    <a href={`/customers/${call.customerId}`} className="underline underline-offset-4">{call.customerName}</a>{" "}
                    <a href={`/marketing/calls/${call.id}`} className="text-xs underline underline-offset-4">Book a job</a>
                  </>
                ) : (
                  <a href={`/marketing/calls/${call.id}`} className="underline underline-offset-4">Create customer and job</a>
                )}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
