import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { marketing, marketingReport } from "@opentradesos/api/services";
import { marketing as mk } from "@opentradesos/core";
import { Money, Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { todayIn } from "@/lib/dates";
import { funnelQuery, rowsHref, type FunnelParams } from "./funnel-params";

export const dynamic = "force-dynamic";

/**
 * WHAT IT COST AND WHAT CAME BACK, AND EVERY NUMBER OPENS
 *
 * The one question a contractor cannot answer from inside any other system
 * they own: the Spring AC tune up on Google Ads, with its own phone number,
 * cost this much, so how many people rang, how many booked, what did it bill
 * and what did each of those cost? The ad account knows what it spent, the
 * CRM knows what was booked, and nobody joins them.
 *
 * Cut three ways with one switch, by channel, by tracking campaign or by
 * tracking number, over the dates the reader picks and under the attribution
 * model the reader picks. EVERY COUNT AND EVERY SUM IS A LINK to the calls,
 * people, jobs or spend lines behind it, computed by the same code as the
 * cell, so a figure that looks wrong can be opened and argued with rather than
 * taken on trust.
 *
 * THREE THINGS THIS SCREEN WILL NOT DO, which it has always refused:
 *
 *   A zero where it means "we do not know". A channel with spend and no leads
 *   has no cost per lead, and printing zero would sort the worst line in the
 *   account to the top of a list of cheap channels.
 *
 *   A pie chart. A pie implies the slices are measured and sum to the
 *   business, and most trades leads arrive with nothing recorded, which this
 *   says on a row called "Not attributed" rather than folding it into direct.
 *
 *   A house model. The company has a default; the model is named above the
 *   table with what it is wrong about, and any other is one click away.
 */
export default async function MarketingPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const params: FunnelParams = funnelQuery(await searchParams, todayIn(user.organizationTimezone));

  /**
   * Through the handler rather than the service, so this screen reads
   * exactly what an API client reads.
   */
  const report = await marketingReport.handlers.getMarketingFunnel(ctx, params);
  const unplaced = await marketing.unplaced(ctx, 10);
  const firstColumn = params.by === "channel" ? "Channel" : params.by === "campaign" ? "Tracking campaign" : "Tracking number";
  const rows = [
    ...report.rows.map((row) => ({ ...row, total: false })),
    { ...report.total, key: "all", label: "Everything", detail: "People counted once", total: true },
  ];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Marketing" />
      <p className="mt-2 max-w-3xl text-sm text-ink-700">
        Spend is what you or an import recorded. Calls, leads, jobs and revenue are counted from
        what actually happened, never from a number a platform reported about itself. Revenue is
        what was invoiced on the job, without the tax. Every number opens into the rows behind it.
      </p>

      {/* A plain GET form: the report is a page of its URL, so it can be bookmarked and sent. */}
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
            <option value="channel">Channel</option>
            <option value="campaign">Tracking campaign</option>
            <option value="number">Tracking number</option>
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
        <button type="submit" className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white">
          Show
        </button>
      </form>

      <p className="mt-3 max-w-3xl text-xs text-ink-500">
        <span className="font-medium text-ink-700">{report.modelLabel}.</span> {report.modelWrongAbout}
      </p>

      {report.rows.length === 0 ? (
        <Empty title="Nothing in these dates">
          No spend, no calls, no leads and no booked jobs between {params.from} and {params.to}. That
          is not the same as a period of zeroes: set up a channel and a tracking number, or widen the
          dates.
        </Empty>
      ) : (
        <>
          <dl className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-5">
            <Figure label="Spend" href={rowsHref(params, "all", "spend")} value={<Money value={report.total.spend} />} />
            <Figure label="Leads" href={rowsHref(params, "all", "leads")} value={String(report.total.leads)} />
            <Figure label="Booked jobs" href={rowsHref(params, "all", "booked")} value={report.total.booked} />
            <Figure label="Revenue" href={rowsHref(params, "all", "revenue")} value={<Money value={report.total.revenue} />} />
            <Figure
              label="Cost per booked job"
              value={report.total.costPerBookedJob
                ? <Money value={report.total.costPerBookedJob} />
                : <span className="text-ink-500">Nothing booked yet</span>}
            />
          </dl>

          <Table
            label="The funnel"
            head={
              <>
                <Th>{firstColumn}</Th><Th>Spend</Th><Th>Calls</Th><Th>Answered</Th><Th>Missed</Th>
                <Th>First time</Th><Th>Leads</Th><Th>Booked</Th><Th>Booking rate</Th><Th>Completed</Th>
                <Th>Revenue</Th><Th>Average ticket</Th><Th>Cost per lead</Th><Th>Cost per booked job</Th>
                <Th>Return</Th><Th>Revenue per dollar</Th>
              </>
            }
          >
            {rows.map((row) => (
              <tr key={row.key} className={row.total ? "bg-steel-100 font-medium" : undefined}>
                <Td>
                  <span className="font-medium">{row.label}</span>
                  {row.detail ? <span className="block text-xs text-ink-500">{row.detail}</span> : null}
                </Td>
                <Td><Cell href={rowsHref(params, row.key, "spend")} label={`${row.label} spend`}><Money value={row.spend} /></Cell></Td>
                <Td><Cell href={rowsHref(params, row.key, "calls")} label={`${row.label} calls`}>{row.calls}</Cell></Td>
                <Td><Cell href={rowsHref(params, row.key, "answered")} label={`${row.label} answered`}>{row.answered}</Cell></Td>
                <Td><Cell href={rowsHref(params, row.key, "missed")} label={`${row.label} missed`}>{row.missed}</Cell></Td>
                <Td><Cell href={rowsHref(params, row.key, "firstTime")} label={`${row.label} first time`}>{row.firstTime}</Cell></Td>
                <Td><Cell href={rowsHref(params, row.key, "leads")} label={`${row.label} leads`}>{row.leads}</Cell></Td>
                <Td><Cell href={rowsHref(params, row.key, "booked")} label={`${row.label} booked`}>{row.booked}</Cell></Td>
                <Td>{row.bookingRate ? `${row.bookingRate}%` : <NotMeasured />}</Td>
                <Td><Cell href={rowsHref(params, row.key, "completed")} label={`${row.label} completed`}>{row.completed}</Cell></Td>
                <Td><Cell href={rowsHref(params, row.key, "revenue")} label={`${row.label} revenue`}><Money value={row.revenue} /></Cell></Td>
                {/*
                  Null is rendered as a word, never as zero and never as a dash.
                  Both of those are read as a measurement.
                */}
                <Td>{row.averageTicket ? <Money value={row.averageTicket} /> : <NotMeasured />}</Td>
                <Td>{row.costPerLead ? <Money value={row.costPerLead} /> : <NotMeasured />}</Td>
                <Td>{row.costPerBookedJob ? <Money value={row.costPerBookedJob} /> : <NotMeasured />}</Td>
                <Td>{row.roi ? <span className="tabular-nums">{row.roi}%</span> : <NotMeasured />}</Td>
                <Td>{row.roas ? <span className="tabular-nums">{Number(row.roas).toFixed(2)}</span> : <NotMeasured />}</Td>
              </tr>
            ))}
          </Table>
          <p className="mt-2 max-w-3xl text-xs text-ink-500">
            Booked jobs are the jobs created in these dates, credited across what each customer did
            before it. Under an even or weighted split a job can be half on two rows. Leads are people
            who called, filled in a form or were sent by a marketplace in these dates, so somebody who
            rang last month and booked this month is last month&rsquo;s lead and this month&rsquo;s job.
          </p>
        </>
      )}

      {unplaced.length > 0 && (
        <section className="mt-10">
          <h2 className="text-base font-semibold">Campaigns nothing can group</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">
            Real money went into each of these and no report can name it. The fix is a tracking
            campaign carrying that tag, or one alias in the source catalogue. Left alone this becomes
            a quarter of your leads sitting under &ldquo;unknown&rdquo; with no way to find out what
            they were.
          </p>
          <Table label="Unplaced sources" head={<><Th>What was written</Th><Th>Medium</Th><Th>Touches</Th></>}>
            {unplaced.map((row) => (
              <tr key={`${row.wrote}-${row.medium ?? ""}`}>
                <Td className="font-mono text-xs">{row.wrote}</Td>
                <Td className="text-ink-700">{row.medium ?? ""}</Td>
                <Td className="tabular-nums">{row.touches}</Td>
              </tr>
            ))}
          </Table>
        </section>
      )}
    </div>
  );
}

const NotMeasured = () => <Chip tone="neutral">Not measured</Chip>;

/**
 * A number that opens. Underlined, because a link that looks like plain text
 * is never clicked, and named, because "1" is not a link anybody can find.
 */
function Cell({ href, label, children }: { href: string; label: string; children: React.ReactNode }) {
  return (
    <a href={href} aria-label={label}
       className="tabular-nums underline decoration-steel-300 underline-offset-4 hover:decoration-ink-900">
      {children}
    </a>
  );
}

function Figure({ label, value, href }: { label: string; value: React.ReactNode; href?: string }) {
  return (
    <div className="rounded-md border border-steel-200 p-4">
      <dt className="text-sm text-ink-700">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">
        {href ? <a href={href} className="hover:underline">{value}</a> : value}
      </dd>
    </div>
  );
}
