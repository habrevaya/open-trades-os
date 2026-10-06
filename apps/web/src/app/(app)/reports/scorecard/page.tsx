import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { kpis, inTenant } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { packById } from "@opentradesos/trade-packs";
import { schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { todayIn, formatDay } from "@/lib/dates";
import { Figure, Needs } from "./Scorecard";

export const dynamic = "force-dynamic";

/**
 * THE TRADE SCORECARD
 *
 * Not a report. A report answers "show me these rows grouped this way"; this
 * answers "of the numbers my trade runs on, what are they this month". The
 * eight trade packs have declared those numbers since they shipped and nothing
 * read one.
 *
 * Two lists and they are both the answer. The computed figures are the top
 * half; the ones this product cannot compute are the bottom half, each naming
 * the single datum it needs. That second list is not an apology for the
 * screen: most of these definitions turn on an exclusion, and a KPI computed
 * without its exclusions is worse than an absent one because it looks like the
 * definition. Six real numbers with two gaps named beats eight where two are
 * guesses, because the guesses are the ones somebody makes a hiring decision
 * on.
 */
export default async function ScorecardPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "report:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Trade scorecard" />
        <Empty title="Reports are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const [org] = await inTenant(ctx, (tx) =>
    tx.select({ timezone: schema.organization.timezone })
      .from(schema.organization)
      .where(eq(schema.organization.id, user.actor.organizationId)).limit(1));
  const zone = org?.timezone ?? "UTC";

  /**
   * The window defaults to the month so far in the COMPANY's timezone. A
   * scorecard dated by the server's clock would roll over at seven in the
   * evening in Austin and show an owner an empty month.
   */
  const params = await searchParams;
  const today = todayIn(zone);
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const from = one("from") ?? `${today.slice(0, 7)}-01`;
  const to = one("to") ?? today;

  /**
   * A backwards window is a refusal in the service, so it is caught here and
   * said in a sentence rather than rendered as a stack trace. Somebody typing
   * two dates into two boxes gets them the wrong way round roughly once.
   */
  const card = to < from ? null : await kpis.scorecard(ctx, { from, to });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Trade scorecard" />

      <form method="get" className="mt-4 flex flex-wrap items-end gap-2 text-sm">
        <label className="flex flex-col gap-1">
          <span className="text-ink-700">From</span>
          <input type="date" name="from" defaultValue={from}
                 className="h-8 rounded border border-steel-300 px-2" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-ink-700">To</span>
          <input type="date" name="to" defaultValue={to}
                 className="h-8 rounded border border-steel-300 px-2" />
        </label>
        <button type="submit"
                className="h-8 rounded bg-ink-900 px-3 font-medium text-white hover:bg-ink-700">
          Show
        </button>
      </form>

      {card === null ? (
        <Empty title="The end of the window is before its start">
          Swap the two dates and try again.
        </Empty>
      ) : card.tradePack === null ? (
        <Empty title="No trade chosen yet">
          A scorecard is the numbers a trade runs on, so it needs to know which trade. Apply a
          trade pack in setup and this screen fills itself in.
        </Empty>
      ) : (
        <>
          {/*
            The pack's own name rather than its id prettified. "hvac" through a
            prettifier is "Hvac", and a screen that misspells the trade it
            claims to measure is not one anybody reads twice.
          */}
          <p className="mt-4 text-sm text-ink-700">
            {packById(card.tradePack)?.name ?? card.tradePack}, {formatDay(from, zone)} to{" "}
            {formatDay(to, zone)}.
          </p>

          {card.computed.length === 0 ? (
            <Empty title="Nothing to measure in this window">
              Every figure here is a ratio of two counted things, and in this window both halves
              are empty. A wider window will show something.
            </Empty>
          ) : (
            <ul className="mt-6 grid gap-3 sm:grid-cols-2">
              {card.computed.map((kpi) => (
                <li key={kpi.key} className="rounded-md border border-steel-200 bg-canvas p-4">
                  <Figure kpi={kpi} records={(half) => `/reports/scorecard/records?${new URLSearchParams({
                    key: kpi.key, half, from, to,
                  }).toString()}`} />
                </li>
              ))}
            </ul>
          )}

          {card.elsewhere.length > 0 && (
            <>
              <h2 className="mt-10 text-sm font-medium text-ink-700">Already answered elsewhere</h2>
              {/*
                Not computed twice. These are the rental numbers, and the fleet
                report is where they live: two screens computing one number
                from two queries is how they come to disagree.
              */}
              <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
                {card.elsewhere.map((kpi) => (
                  <li key={kpi.key} className="bg-canvas p-4">
                    <div className="flex flex-wrap items-baseline justify-between gap-2">
                      <span className="font-medium">{kpi.label}</span>
                      <Chip tone="info">{kpi.endpoint}</Chip>
                    </div>
                    <p className="mt-1 text-sm text-ink-700">{kpi.definition}</p>
                  </li>
                ))}
              </ul>
            </>
          )}

          {card.unavailable.length > 0 && (
            <>
              <h2 className="mt-10 text-sm font-medium text-ink-700">
                Not computed, and what each one needs
              </h2>
              <p className="mt-1 text-sm text-ink-500">
                Named rather than hidden. Each of these turns on an exclusion this product cannot
                yet make, and a figure computed without its exclusions reads as the definition
                while meaning something else.
              </p>
              <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
                {card.unavailable.map((kpi) => (
                  <li key={kpi.key} className="bg-canvas p-4">
                    <Needs kpi={kpi} />
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
    </div>
  );
}
