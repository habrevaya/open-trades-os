import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { Figure, Needs } from "../src/app/(app)/reports/scorecard/Scorecard";
import { NAV } from "../src/lib/nav";

const base = {
  key: "avg_ticket", label: "Average ticket", definition: "Revenue over completed jobs.",
  target: "$620", state: "computed" as const, needs: null, endpoint: null,
  numeratorMoney: false, denominatorMoney: false,
};

/** M21's SCORECARD ON A SCREEN: EVERY NUMBER AS AN ARITHMETIC */
describe("the trade scorecard", () => {
  it("shows both halves under the number, not just the number", () => {
    /**
     * The whole reason this screen is not a tile of eight big numbers. "$620"
     * is an assertion nobody can check; "$186,000 over 300 jobs" is one a
     * contractor can argue with, and arguing with it is how they come to
     * trust it.
     */
    const html = renderToStaticMarkup(<Figure kpi={{
      ...base, format: "money", value: "620.0000", numeratorMoney: true,
      numerator: "186000.0000", denominator: "300",
      numeratorLabel: "revenue posted to the ledger", denominatorLabel: "completed jobs",
    }} />);
    expect(html).toContain("$620.00");
    expect(html).toContain("$186,000.00");
    expect(html).toContain("revenue posted to the ledger");
    expect(html).toContain("300");
    expect(html).toContain("completed jobs");
    expect(html).toContain("target $620");
  });

  it("says not this window rather than nought when the denominator is empty", () => {
    /**
     * The service reports an empty denominator as null deliberately: a nought
     * per cent close rate says every estimate was lost, and no estimates
     * presented says there is nothing to measure. A screen that rendered the
     * null as 0% would undo that decision at the last step.
     */
    const html = renderToStaticMarkup(<Figure kpi={{
      ...base, key: "close_rate", label: "Close rate", format: "percent", value: null,
      definition: "Estimates won, divided by estimates presented.",
      numerator: null, denominator: null, numeratorLabel: null, denominatorLabel: null,
      target: null,
    }} />);
    expect(html).toContain("Not this window");
    expect(html).not.toContain("0%");
    /** And no halves line, which would read as "null over null". */
    expect(html).not.toContain(" over ");
  });

  it("gives a percentage its sign and a duration its unit", () => {
    const percent = renderToStaticMarkup(<Figure kpi={{
      ...base, key: "close_rate", format: "percent", value: "42.5",
      numerator: "17", denominator: "40", numeratorLabel: "won", denominatorLabel: "presented",
      target: null,
    }} />);
    expect(percent).toContain("42.5%");
    /** A count is not money, so neither half carries a dollar sign. */
    expect(percent).not.toContain("$");

    const duration = renderToStaticMarkup(<Figure kpi={{
      ...base, key: "drive_time_pct", format: "duration", value: "1.75",
      numerator: "7", denominator: "4", numeratorLabel: "hours", denominatorLabel: "days",
      target: null,
    }} />);
    expect(duration).toContain("1.75 hrs");
  });

  it("shows both halves as money when both are dollars, as install margin's are", () => {
    /** A percentage of two dollar figures: a bare "62000" over a bare "186000" would read as a count of something. */
    const html = renderToStaticMarkup(<Figure kpi={{
      ...base, key: "install_gross_margin", label: "Install gross margin", format: "percent", value: "33.3",
      numerator: "62000.0000", denominator: "186000.0000", numeratorMoney: true, denominatorMoney: true,
      numeratorLabel: "dollars earned on installs whose costs are all in", denominatorLabel: "install revenue on those jobs",
      target: "45",
    }} />);
    expect(html).toContain("33.3%");
    expect(html).toContain("$62,000.00");
    expect(html).toContain("$186,000.00");
    expect(html).not.toContain(">186000.0000");
  });

  it("opens each half onto the records behind it", () => {
    /**
     * Every number on a report is a link, and the scorecard's two halves are
     * too: "$186,000 over 300 jobs" opens on the jobs, and the list adds up to
     * the half that was clicked.
     */
    const html = renderToStaticMarkup(<Figure
      kpi={{
        ...base, format: "money", value: "620.0000", numeratorMoney: true,
        numerator: "186000.0000", denominator: "300",
        numeratorLabel: "revenue on completed jobs", denominatorLabel: "completed jobs",
      }}
      records={(half) => `/reports/scorecard/records?key=avg_ticket&half=${half}&from=2026-06-01&to=2026-06-30`}
    />);
    expect(html).toContain('href="/reports/scorecard/records?key=avg_ticket&amp;half=numerator&amp;from=2026-06-01&amp;to=2026-06-30"');
    expect(html).toContain('href="/reports/scorecard/records?key=avg_ticket&amp;half=denominator&amp;from=2026-06-01&amp;to=2026-06-30"');
    expect(html).toMatch(/>\$186,000\.00<\/span> revenue on completed jobs<\/a>|\$186,000\.00.*revenue on completed jobs<\/a>/);
  });

  it("names the one missing datum rather than saying not built", () => {
    /**
     * The bottom half of the screen is the other half of the answer. Six real
     * numbers with two gaps named beats eight where two are guesses, because
     * the guesses are the ones somebody makes a hiring decision on.
     */
    const html = renderToStaticMarkup(<Needs kpi={{
      ...base, key: "recurring_retention", label: "Retention", format: "percent",
      state: "unavailable", value: null, numerator: null, denominator: null,
      numeratorLabel: null, denominatorLabel: null, target: null,
      needs: "A coded cancellation reason, so a house sale is not counted as churn.",
    }} />);
    expect(html).toContain("Needs:");
    expect(html).toContain("coded cancellation reason");
    expect(html).not.toContain("Not built");
  });

  it("is under Reports in the navigation rather than beside it", () => {
    const reports = NAV.flatMap((g) => g.items).find((i) => i.href === "/reports");
    expect(reports?.children?.map((c) => c.href)).toContain("/reports/scorecard");
    /** A top level item for one screen is how a rail becomes a list of every screen. */
    expect(NAV.flatMap((g) => g.items).map((i) => i.href)).not.toContain("/reports/scorecard");
  });
});
