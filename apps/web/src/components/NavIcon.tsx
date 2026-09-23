/**
 * THE RAIL'S ICONS
 *
 * Drawn here rather than pulled from a package. An icon set is a dependency
 * that ships thousands of glyphs to use fourteen, and this product is meant
 * to be read, forked and self hosted by people who did not choose its
 * dependencies. Fourteen small paths are cheaper than that in every sense.
 *
 * They exist because the rail collapses. With labels beside them an icon is
 * decoration and almost any icon will do; collapsed, the icon IS the label,
 * and the ones that have to survive that are the pairs somebody would
 * otherwise confuse: jobs against tasks, invoices against agreements,
 * reports against dashboards. So each of those pairs is a different shape
 * rather than the same shape with a different detail.
 *
 * Same line weight and joins as the logo, so the rail looks like one thing.
 */
export type IconName =
  | "day" | "today" | "schedule" | "jobs" | "tasks"
  | "customers" | "inbox"
  | "invoices" | "agreements" | "pricebook"
  | "dashboards" | "reports" | "automations" | "settings" | "inventory"
  | "timesheets";

const PATHS: Record<IconName, React.ReactNode> = {
  // A sun. One technician's own day, and the only screen they open.
  day: (
    <>
      <circle cx="12" cy="12" r="3.75" />
      <path d="M12 3v1.8M12 19.2V21M4.2 12H3M21 12h-1.2M6.3 6.3 5.5 5.5M18.5 18.5l-.8-.8M17.7 6.3l.8-.8M5.5 18.5l.8-.8" />
    </>
  ),
  // Today: the calendar, with today marked on it.
  today: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 9.5h17M8 3.5V6M16 3.5V6" />
      <circle cx="12" cy="14.5" r="1.6" fill="currentColor" stroke="none" />
    </>
  ),
  // The board: the same calendar, ruled into columns for the technicians.
  schedule: (
    <>
      <rect x="3.5" y="5" width="17" height="15.5" rx="2" />
      <path d="M3.5 9.5h17M8 3.5V6M16 3.5V6M9.8 9.5v11M14.2 9.5v11" />
    </>
  ),
  // A clipboard. Work somebody was sent out to do.
  jobs: (
    <>
      <path d="M9 4.5H7.5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h9a2 2 0 0 0 2-2v-12a2 2 0 0 0-2-2H15" />
      <rect x="9" y="2.8" width="6" height="3.4" rx="1.1" />
      <path d="M8.8 12h6.4M8.8 15.5h4.2" />
    </>
  ),
  // Ticked off. Deliberately not a clipboard, because a task is not a job.
  tasks: (
    <>
      <path d="M4 7.2h2.6M4 12h2.6M4 16.8h2.6" />
      <path d="M9.8 7.2H20M9.8 12H20M9.8 16.8H20" />
    </>
  ),
  customers: (
    <>
      <circle cx="9.5" cy="8.5" r="3.2" />
      <path d="M3.8 19.5a5.7 5.7 0 0 1 11.4 0" />
      <path d="M16 6.1a3.2 3.2 0 0 1 0 6.3M17.4 14.6a5.7 5.7 0 0 1 2.8 4.9" />
    </>
  ),
  inbox: (
    <>
      <rect x="3" y="5.5" width="18" height="13" rx="2" />
      <path d="m3.6 7 7.3 5.3a2 2 0 0 0 2.2 0L20.4 7" />
    </>
  ),
  // A bill: a document, torn off at the bottom.
  invoices: (
    <>
      <path d="M5.5 3.8h13v16.9l-2.6-1.7-2.6 1.7-2.6-1.7-2.6 1.7-2.6-1.7V3.8Z" />
      <path d="M9 8.5h6M9 12.3h6" />
    </>
  ),
  // Recurring. The same visit, coming round again, which is what a plan is.
  agreements: (
    <>
      <path d="M4.6 10.2a7.6 7.6 0 0 1 12.9-3.3l2 2" />
      <path d="M19.4 13.8a7.6 7.6 0 0 1-12.9 3.3l-2-2" />
      <path d="M19.9 4.6v4.3h-4.3M4.1 19.4v-4.3h4.3" />
    </>
  ),
  pricebook: (
    <>
      <path d="M4.5 4.6a2 2 0 0 1 2-2H18v16.8H6.5a2 2 0 0 0-2 2V4.6Z" />
      <path d="M4.5 19.4a2 2 0 0 0 2 2H18" />
      <path d="M8.6 7.6h5.8M8.6 11.2h3.4" />
    </>
  ),
  // Tiles. What a dashboard is, and nothing like a bar chart.
  dashboards: (
    <>
      <rect x="3.2" y="3.2" width="7.6" height="6.4" rx="1.5" />
      <rect x="13.2" y="3.2" width="7.6" height="9.9" rx="1.5" />
      <rect x="3.2" y="13.1" width="7.6" height="7.7" rx="1.5" />
      <rect x="13.2" y="16.6" width="7.6" height="4.2" rx="1.5" />
    </>
  ),
  // Bars against an axis. A number you read, rather than a number you watch.
  reports: (
    <>
      <path d="M4 3.8v16.4h16.2" />
      <path d="M8 16.8V11M12.2 16.8V6.6M16.4 16.8v-3.6" />
    </>
  ),
  // Stacked boxes on a shelf. Deliberately not a van and not a box on its
  // own: this screen answers where a part IS, and a van is one of the places.
  inventory: (
    <>
      <path d="M3.2 20.4V9.6M20.8 9.6v10.8M3.2 20.4h17.6" />
      <path d="M2.4 9.6 12 4.2l9.6 5.4" />
      <rect x="7.4" y="12.6" width="4.2" height="4" rx="0.6" />
      <rect x="13.2" y="12.6" width="3.4" height="4" rx="0.6" />
    </>
  ),
  // A clock. Deliberately not the calendar the schedule uses and not the sun
  // the day uses: this screen is about how LONG, which neither of those says.
  timesheets: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.2V12l3.2 2.1" />
    </>
  ),
  automations: <path d="M13.4 2.6 5.2 13.2h5.4l-.9 8.2 8.2-10.6h-5.4l.9-8.2Z" />,
  settings: (
    <>
      <path d="M4 7.4h4.4M12.6 7.4H20M4 16.6h7.4M15.6 16.6H20" />
      <circle cx="10.5" cy="7.4" r="2.1" />
      <circle cx="13.5" cy="16.6" r="2.1" />
    </>
  ),
};

export function NavIcon({ name, className = "h-[18px] w-[18px]" }: {
  name: IconName;
  className?: string;
}) {
  return (
    <svg
      viewBox="0 0 24 24" className={className} aria-hidden
      fill="none" stroke="currentColor"
      strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round"
    >
      {PATHS[name]}
    </svg>
  );
}
