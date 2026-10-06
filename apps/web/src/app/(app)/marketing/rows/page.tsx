import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { marketingReport } from "@opentradesos/api/services";
import { Money, Chip, Phone } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { Crumb } from "@/components/Detail";
import { formatIn, todayIn } from "@/lib/dates";
import { funnelQuery, MEASURE_LABEL } from "../funnel-params";

export const dynamic = "force-dynamic";

const MEASURES = ["spend", "calls", "answered", "missed", "firstTime", "leads", "booked", "completed", "revenue"] as const;
type Measure = (typeof MEASURES)[number];

/**
 * THE ROWS BEHIND ONE NUMBER ON THE FUNNEL
 *
 * Opened from a cell, over the same dates, cut and model, and computed by the
 * same code the cell was summed from, so the list adds up to the number that
 * was clicked: the calls and the people count to it, the jobs' shares and
 * revenue sum to it, the spend lines sum to it. The total at the top is the
 * cell again, so a reader can check the arithmetic without a calculator.
 */
export default async function FunnelRowsPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const raw = await searchParams;
  const params = funnelQuery(raw, todayIn(user.organizationTimezone));
  const key = typeof raw["key"] === "string" ? raw["key"] : "all";
  const measure: Measure = MEASURES.find((m) => m === raw["measure"]) ?? "calls";
  const back = `/marketing?${new URLSearchParams({ from: params.from, to: params.to, by: params.by, ...(params.model ? { model: params.model } : {}) }).toString()}`;

  const drill = await marketingReport.handlers.drillMarketingFunnel(ctx, { ...params, key, measure });
  const when = (iso: string) => formatIn(iso, user.organizationTimezone);

  const total = measure === "spend" ? <Money value={drill.cell.spend} />
    : measure === "revenue" ? <Money value={drill.cell.revenue} />
      : measure === "booked" ? drill.cell.booked
        : measure === "completed" ? drill.cell.completed
          : String(drill.cell[measure]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <Crumb href={back}>Marketing</Crumb>
      <PageHeader title={`${MEASURE_LABEL[measure]}: ${drill.label}`} />
      <p className="mt-2 text-sm text-ink-700">
        {params.from} to {params.to}. <span className="font-medium">{MEASURE_LABEL[measure]}: {total}</span>
      </p>

      {drill.kind === "calls" && (
        drill.calls.length === 0 ? <Empty title="No calls" /> : (
          <Table label="Calls" head={<><Th>When</Th><Th>From</Th><Th>To</Th><Th>What it was</Th><Th>Caller</Th><Th>Customer</Th></>}>
            {drill.calls.map((c) => (
              <tr key={c.callId}>
                <Td>{when(c.startedAt)}</Td>
                <Td><Phone value={c.from} /></Td>
                <Td>{c.receivedOn ? <Phone value={c.receivedOn} /> : null}</Td>
                <Td><Chip tone={c.missed ? "warning" : "neutral"}>{c.outcomeLabel}</Chip></Td>
                <Td>{c.firstTime === true ? "First time" : c.firstTime === false ? "Called before" : "Not known"}</Td>
                <Td>{c.customerId ? <a href={`/customers/${c.customerId}`} className="underline underline-offset-4">{c.customerName}</a> : null}</Td>
              </tr>
            ))}
          </Table>
        )
      )}

      {drill.kind === "leads" && (
        drill.leads.length === 0 ? <Empty title="No leads" /> : (
          <Table label="Leads" head={<><Th>Who</Th><Th>First seen</Th><Th>Touches</Th><Th>Share</Th></>}>
            {drill.leads.map((l) => (
              <tr key={l.key}>
                <Td>
                  {l.customerId
                    ? <a href={`/customers/${l.customerId}`} className="underline underline-offset-4">{l.customerName}</a>
                    : l.callerE164 ? <><Phone value={l.callerE164} /> <span className="text-ink-500">not a customer yet</span></>
                      : <span className="text-ink-500">A website visitor, not a customer yet</span>}
                </Td>
                <Td>{when(l.firstAt)}</Td>
                <Td className="tabular-nums">{l.touches}</Td>
                <Td className="tabular-nums">{l.share}</Td>
              </tr>
            ))}
          </Table>
        )
      )}

      {drill.kind === "jobs" && (
        drill.jobs.length === 0 ? <Empty title="No jobs" /> : (
          <Table label="Jobs" head={<><Th>Job</Th><Th>Customer</Th><Th>Booked</Th><Th>Status</Th><Th>Share</Th><Th>Revenue credited</Th></>}>
            {drill.jobs.map((j) => (
              <tr key={j.jobId}>
                <Td><a href={`/jobs/${j.jobId}`} className="underline underline-offset-4">#{j.number} {j.summary}</a></Td>
                <Td>{j.customerName}</Td>
                <Td>{when(j.createdAt)}</Td>
                <Td>{j.status.replace(/_/g, " ")}</Td>
                <Td className="tabular-nums">{j.share}</Td>
                <Td><Money value={j.revenue} /></Td>
              </tr>
            ))}
          </Table>
        )
      )}

      {drill.kind === "spend" && (
        drill.spend.length === 0 ? <Empty title="No spend recorded">Record it on the spend screen.</Empty> : (
          <Table label="Spend" head={<><Th>Day</Th><Th>What</Th><Th>How it is counted</Th><Th>Amount</Th></>}>
            {drill.spend.map((s, i) => (
              <tr key={`${s.spendId ?? s.campaignId}-${i}`}>
                <Td>{s.spentOn ?? ""}</Td>
                <Td>{s.label}</Td>
                <Td className="text-ink-700">
                  {s.kind === "recorded" ? "Recorded" : s.kind === "fixed" ? "Part of a fixed price" : "Price per lead"}
                  {s.note ? <span className="block text-xs text-ink-500">{s.note}</span> : null}
                </Td>
                <Td><Money value={s.amount} /></Td>
              </tr>
            ))}
          </Table>
        )
      )}
    </div>
  );
}
