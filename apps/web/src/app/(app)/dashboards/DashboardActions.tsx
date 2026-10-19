/**
 * What somebody does with a whole dashboard rather than one tile: take it
 * away as a PDF, or have it arrive on its own.
 *
 * The PDF is the server's, the same file a schedule attaches, rather than the
 * browser's print of this page: a dashboard is a grid of cards laid out for a
 * wide screen, and printed by a browser it splits a chart across two pages.
 */
export function DashboardActions({ pdf, schedule }: {
  /** Where the PDF downloads from. */
  pdf: string;
  /** The schedule form, starting on this dashboard, for somebody who may set one up. */
  schedule: string | null;
}) {
  const button = "inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100";
  return (
    <div className="flex flex-wrap gap-2">
      <a href={pdf} className={button}>Download as PDF</a>
      {/*
        Beside the dashboard it sends, because "send me this every Monday" is
        a thought somebody has while looking at it.
      */}
      {schedule ? <a href={schedule} className={button}>Email on a schedule</a> : null}
    </div>
  );
}
