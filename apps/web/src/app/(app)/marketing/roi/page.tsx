import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { adPlatforms, marketingReport } from "@opentradesos/api/services";
import { marketing as mk } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Empty, PageHeader, Table, Td, Th } from "@/components/Table";
import { todayIn, formatIn } from "@/lib/dates";
import { funnelQuery, rowsHref, type FunnelParams } from "../funnel-params";

export const dynamic = "force-dynamic";

/**
 * RETURN ON SPEND: WHAT EACH DOLLAR BOUGHT
 *
 * The funnel's money columns and nothing else, for the owner whose question
 * is "which of these is worth it": what it cost, how many people it brought,
 * how many booked, what they billed, and the three ratios that compare them.
 * By channel, by tracking campaign or by ad platform, over the dates and the
 * model the reader picks.
 *
 * THE SAME NUMBERS AS THE FUNNEL, from the same computation, and every count
 * and sum opens into the same rows, so this screen cannot disagree with that
 * one. What it adds is WHERE THE SPEND CAME FROM, because a return is only as
 * good as its cost: pulled from the platform itself, loaded from a file, or
 * typed by somebody, and how fresh each connected platform's pull is. A
 * platform that stopped pulling on Tuesday shows a cheap week, and that is
 * said beside the figure rather than discovered in March.
 */
export default async function ReturnPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const raw = await searchParams;
  const asked = funnelQuery(raw, todayIn(user.organizationTimezone));
  /** Tracking numbers are a phone question rather than a spend one, so this view offers the other three. */
  const params: FunnelParams = { ...asked, by: asked.by === "number" ? "platform" : asked.by };

  const [report, spend, platforms] = await Promise.all([
    marketingReport.handlers.getMarketingFunnel(ctx, params),
    marketingReport.drill(ctx, { ...params, key: "all", measure: "spend" }),
    adPlatforms.platforms(ctx).catch(() => []),
  ]);

  /** Where the period's spend came from, in money. */
  const origin = { pulled: 0n, file: 0n, typed: 0n, planned: 0n };
  if (spend.kind === "spend") {
    for (const line of spend.spend) {
      const cents = BigInt(Math.round(Number(line.amount) * 100));
      if (line.kind !== "recorded") origin.planned += cents;
      else if (line.note?.startsWith("Pulled from")) origin.pulled += cents;
      else if (line.note) origin.file += cents;
      else origin.typed += cents;
    }
  }
  const dollars = (cents: bigint) => (Number(cents) / 100).toFixed(2);
  const firstColumn = params.by === "channel" ? "Channel" : params.by === "campaign" ? "Tracking campaign" : "Ad platform";
  const rows = [
    ...report.rows.map((row) => ({ ...row, total: false })),
    { ...report.total, key: "all", label: "Everything", detail: "People counted once", total: true },
  ];
  const lastSpend = platforms
    .map((p) => ({ label: p.label, run: p.runs.find((r) => r.entity === "spend"), status: p.status }))
    .filter((p) => p.run || p.status !== "connected");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Return on spend" />
      <p className="mt-2 max-w-3xl text-sm text-ink-700">
        What each channel, campaign or ad platform cost, and what came back: cost per lead, cost
        per booked job, and revenue per dollar spent. The same figures as the{" "}
        <Link href="/marketing" className="underline underline-offset-4">funnel</Link>, and every one opens into the rows behind it.
      </p>

      <form method="get" className="mt-5 flex flex-wrap items-end gap-3 rounded-md border border-steel-200 p-3">
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-700">From</span>
          <input type="date" name="from" defaultValue={params.from} className="h-9 rounded border border-steel-300 px-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-700">To</span>
          <input type="date" name="to" defaultValue={params.to} className="h-9 rounded border border-steel-300 px-2" />
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-700">By</span>
          <select name="by" defaultValue={params.by} className="h-9 rounded border border-steel-300 px-2">
            <option value="platform">Ad platform</option>
            <option value="channel">Channel</option>
            <option value="campaign">Tracking campaign</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 text-sm">
          <span className="text-ink-700">Credit by</span>
          <select name="model" defaultValue={report.model} className="h-9 rounded border border-steel-300 px-2">
            {mk.ATTRIBUTION_MODEL_KEYS.map((key) => (
              <option key={key} value={key}>{mk.ATTRIBUTION_MODELS[key].label}</option>
            ))}
          </select>
        </label>
        <button type="submit" className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white">Show</button>
      </form>

      <section aria-label="Where the spend came from" className="mt-4 text-sm text-ink-700">
        <p>
          Spend in these dates: <Money value={dollars(origin.pulled)} /> pulled from the platforms
          themselves, <Money value={dollars(origin.file)} /> loaded from files,{" "}
          <Money value={dollars(origin.typed)} /> typed in, and <Money value={dollars(origin.planned)} /> from
          fixed price and per lead campaigns.
        </p>
        {lastSpend.length > 0 && (
          <ul className="mt-2 flex flex-wrap gap-2">
            {lastSpend.map((p) => (
              <li key={p.label}>
                <Chip tone={p.run?.error || p.status !== "connected" ? "danger" : "neutral"}>
                  {p.label}: {p.status !== "connected"
                    ? "not pulling, sign in again"
                    : p.run?.error
                      ? `last pull failed ${formatIn(new Date(p.run.startedAt), user.organizationTimezone)}`
                      : `pulled ${formatIn(new Date(p.run!.finishedAt ?? p.run!.startedAt), user.organizationTimezone)}`}
                </Chip>
              </li>
            ))}
          </ul>
        )}
      </section>

      <p className="mt-3 max-w-3xl text-xs text-ink-500">
        <span className="font-medium text-ink-700">{report.modelLabel}.</span> {report.modelWrongAbout}
      </p>

      {report.rows.length === 0 ? (
        <Empty title="Nothing in these dates">
          No spend, no leads and no booked jobs between {params.from} and {params.to}.
        </Empty>
      ) : (
        <Table
          label="Return on spend"
          head={<><Th>{firstColumn}</Th><Th>Spend</Th><Th>Leads</Th><Th>Booked jobs</Th><Th>Revenue</Th>
            <Th>Cost per lead</Th><Th>Cost per booked job</Th><Th>Revenue per dollar</Th></>}
        >
          {rows.map((row) => (
            <tr key={row.key} className={row.total ? "bg-steel-100 font-medium" : undefined}>
              <Td>
                <span className="font-medium">{row.label}</span>
                {row.detail ? <span className="block text-xs text-ink-500">{row.detail}</span> : null}
              </Td>
              <Td><Cell href={rowsHref(params, row.key, "spend")} label={`${row.label} spend`}><Money value={row.spend} /></Cell></Td>
              <Td><Cell href={rowsHref(params, row.key, "leads")} label={`${row.label} leads`}>{mk.weightText(row.leadsWeight)}</Cell></Td>
              <Td><Cell href={rowsHref(params, row.key, "booked")} label={`${row.label} booked`}>{row.booked}</Cell></Td>
              <Td><Cell href={rowsHref(params, row.key, "revenue")} label={`${row.label} revenue`}><Money value={row.revenue} /></Cell></Td>
              {/* Empty is said in words, never as zero: zero reads as a measurement, and the cheapest one. */}
              <Td>{row.costPerLead ? <Money value={row.costPerLead} /> : <NotMeasured />}</Td>
              <Td>{row.costPerBookedJob ? <Money value={row.costPerBookedJob} /> : <NotMeasured />}</Td>
              <Td>{row.roas ? <span className="tabular-nums">{Number(row.roas).toFixed(2)}</span> : <NotMeasured />}</Td>
            </tr>
          ))}
        </Table>
      )}
      <p className="mt-2 max-w-3xl text-xs text-ink-500">
        Revenue per dollar is revenue divided by spend: 3.00 means three dollars billed for every
        dollar spent. Revenue is what was invoiced on the job, without the tax.
      </p>
    </div>
  );
}

const NotMeasured = () => <Chip tone="neutral">Not measured</Chip>;

function Cell({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return (
    <a href={href} aria-label={label}
       className="tabular-nums underline decoration-steel-300 underline-offset-4 hover:decoration-ink-900">
      {children}
    </a>
  );
}
