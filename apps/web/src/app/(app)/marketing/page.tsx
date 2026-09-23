import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { marketing } from "@opentradesos/api/services";
import { Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { Chip } from "@opentradesos/ui";

export const dynamic = "force-dynamic";

/**
 * WHAT IT COST AND WHAT CAME BACK
 *
 * The one question a contractor cannot answer from inside any other system
 * they own. The ad account knows what it spent, the CRM knows what was
 * booked, and nobody joins them.
 *
 * THREE THINGS THIS SCREEN WILL NOT DO.
 *
 * It does not show a zero where it means "we do not know". A source with
 * spend and no leads has no cost per lead, and printing zero there would
 * sort the worst line in the account to the top of a list of cheap channels.
 *
 * It does not show a pie chart of sources. A pie implies the slices are
 * measured and that they sum to the business, and neither is true: most of a
 * trades company's leads arrive with nothing recorded, and this screen says
 * so instead of quietly filing them under direct.
 *
 * It does not pick an attribution model. That choice lives on the job, where
 * every model is shown at once, because when first touch and last touch
 * disagree somebody is about to cut the channel that starts every job.
 */
const SINCE_DAYS = 30;

export default async function MarketingPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  const to = new Date();
  const from = new Date(to.getTime() - SINCE_DAYS * 86_400_000);
  const iso = (date: Date) => date.toISOString().slice(0, 10);

  /**
   * Through the handler rather than the service, so this screen reads
   * exactly what an API client reads. Going straight to the service would
   * hand it core's `Money` objects, and the screen would end up with its own
   * formatting of numbers the API renders differently.
   */
  const report = await marketing.handlers.getPerformance(ctx, { from: iso(from), to: iso(to) });
  const unplaced = await marketing.unplaced(ctx, 10);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Marketing" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        The last {SINCE_DAYS} days. Spend is what you or an import recorded;
        leads and booked work are counted from what actually happened, never
        from a number a platform reported about itself.
      </p>

      {!report.reported ? (
        <Empty title="Nothing to report yet">
          {/*
            The refusal's own sentence. "No spend and no results" is not the
            same as a period of zeroes, and a table of zeroes would say a
            channel wasted nothing when nobody had told the product anything.
          */}
          {report.detail}
        </Empty>
      ) : (
        <>
          <dl className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
            <Figure label="Spend" value={<Money value={report.totalSpend!} />} />
            <Figure label="Leads" value={String(report.totalLeads!)} />
            <Figure label="Booked jobs" value={String(report.totalBookedJobs!)} />
            <Figure
              label="Cost per booked job"
              value={report.blendedCostPerBookedJob
                ? <Money value={report.blendedCostPerBookedJob} />
                /*
                  Said in words rather than shown as a dash. A dash is read
                  as "zero" by roughly half of everybody.
                */
                : <span className="text-ink-500">Nothing booked yet</span>}
            />
          </dl>

          {report.wastedSources!.length > 0 && (
            /*
              First, and named. The most useful number on this screen is
              money that went out against a channel that booked nothing, and
              putting it below the table is how it gets scrolled past.
            */
            <p className="mt-6 rounded-md border border-red-600/20 bg-red-tint p-3 text-sm text-ink-900">
              <Money value={report.wastedSpend!} /> went to{" "}
              {report.wastedSources!.join(", ")} and booked nothing in
              this period.
            </p>
          )}

          {report.unpricedSources!.length > 0 && (
            <p className="mt-3 rounded-md border border-steel-200 bg-steel-100 p-3 text-sm text-ink-700">
              {report.unpricedSources!.join(", ")} booked work with no
              spend recorded against it. That is usually a missing feed rather
              than a free channel.
            </p>
          )}

          <Table
            head={
              <>
                <Th>Source</Th><Th>Spend</Th><Th>Leads</Th><Th>Booked</Th>
                <Th>Cost per lead</Th><Th>Cost per job</Th><Th>Return</Th>
              </>
            }
          >
            {report.rows!.map((row) => (
              <tr key={row.source} title={row.verdict.message}>
                <Td className="font-medium">{row.source.replace(/_/g, " ")}</Td>
                <Td><Money value={row.spend} /></Td>
                <Td className="tabular-nums">{row.leads}</Td>
                <Td className="tabular-nums">{row.bookedJobs}</Td>
                {/*
                  Null is rendered as a word, never as zero and never as a
                  dash. Both of those are read as a measurement.
                */}
                <Td>{row.costPerLead ? <Money value={row.costPerLead} /> : <NotMeasured />}</Td>
                <Td>{row.costPerBookedJob ? <Money value={row.costPerBookedJob} /> : <NotMeasured />}</Td>
                <Td>
                  {row.roas
                    ? <span className="tabular-nums">{Number(row.roas).toFixed(2)}x</span>
                    : <NotMeasured />}
                </Td>
              </tr>
            ))}
          </Table>
        </>
      )}

      {unplaced.length > 0 && (
        <section className="mt-10">
          <h2 className="text-base font-semibold">Campaigns nothing can group</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">
            Real money went into each of these and no report can name it. The
            fix is one alias in the source catalogue. Left alone this becomes
            a quarter of your leads sitting under &ldquo;unknown&rdquo; with
            no way to find out what they were.
          </p>
          <Table head={<><Th>What was written</Th><Th>Medium</Th><Th>Touches</Th></>}>
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

const NotMeasured = () => (
  <Chip tone="neutral">Not measured</Chip>
);

function Figure({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-md border border-steel-200 p-4">
      <dt className="text-sm text-ink-700">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
    </div>
  );
}
