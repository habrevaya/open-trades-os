import type { staffNotices } from "@opentradesos/api/services";
import { formatIn } from "@/lib/dates";

export type Bell = Awaited<ReturnType<typeof staffNotices.list>>;

/**
 * THE BELL
 *
 * What the person signed in was told: a sentence each, about which record (the
 * whole line is the link to it), when, and whether they have read it. The
 * newest few here, all of them on `/notices`, and where each kind reaches them
 * on `/me`.
 *
 * A `details` rather than a state hook, like the phone menu, so it opens before
 * any JavaScript has loaded and the shell stays a server component. Opening a
 * notice goes through `/notices/{id}`, which marks it read and then goes to the
 * record, asking again whether this person may still open it.
 *
 * Nothing here decides who is told or about what. The service raised only what
 * this person can open, and lists only what they still can.
 */
export function NoticeBell({
  bell, timezone, placement, collapsed = false, markAllRead,
}: {
  bell: Bell;
  timezone: string;
  /**
   * The server action behind "Mark all read", handed in by the shell so this
   * stays a plain component that renders anywhere, a test included.
   */
  markAllRead?: (form: FormData) => Promise<void>;
  /** In the rail on a desktop, or in the header on a phone. */
  placement: "rail" | "header";
  collapsed?: boolean;
}) {
  const count = bell.unread > 99 ? "99+" : String(bell.unread);
  const name = bell.unread === 0 ? "Notices, none unread" : `Notices, ${bell.unread} unread`;
  const panel = placement === "rail"
    ? "absolute left-0 top-full z-50 mt-1 w-80"
    : "absolute right-0 top-full z-50 mt-1 w-[min(20rem,calc(100vw-6rem))]";

  return (
    <details className="relative" data-bell={placement}>
      <summary
        aria-label={name}
        title={collapsed ? name : undefined}
        className={`flex cursor-pointer list-none items-center gap-2 rounded py-1.5 text-sm text-ink-700 hover:bg-steel-100 ${
          collapsed ? "justify-center px-0" : "px-2"
        }`}
      >
        <BellMark />
        {placement === "rail" && !collapsed ? <span>Notices</span> : null}
        {bell.unread > 0 ? (
          <span aria-hidden className="ml-auto inline-flex min-w-5 items-center justify-center rounded-full bg-red-600 px-1.5 text-xs font-semibold text-white">
            {count}
          </span>
        ) : null}
      </summary>
      <div role="region" aria-label="Your notices" className={`${panel} rounded border border-steel-200 bg-canvas shadow-lg`}>
        <div className="flex items-center justify-between gap-2 border-b border-steel-200 px-3 py-2">
          <span className="text-sm font-semibold text-ink-900">Notices</span>
          {bell.unread > 0 && markAllRead ? (
            <form action={markAllRead}>
              <button type="submit" className="text-xs text-blue-600 underline underline-offset-4">Mark all read</button>
            </form>
          ) : null}
        </div>
        {bell.notices.length === 0 ? (
          <p className="px-3 py-4 text-sm text-ink-500">Nothing yet. When something needs you, it shows here.</p>
        ) : (
          <ul className="max-h-96 divide-y divide-steel-200 overflow-y-auto">
            {bell.notices.map((notice) => (
              <li key={notice.id}>
                <NoticeLine notice={notice} timezone={timezone} />
              </li>
            ))}
          </ul>
        )}
        <div className="flex items-center justify-between gap-2 border-t border-steel-200 px-3 py-2 text-xs">
          <a href="/notices" className="text-blue-600 underline underline-offset-4">See all</a>
          <a href="/me#notices" className="text-ink-500 underline underline-offset-4">Choose what you are told</a>
        </div>
      </div>
    </details>
  );
}

/** One notice as a link to what it is about. Shared by the bell and `/notices`. */
export function NoticeLine({ notice, timezone }: { notice: Bell["notices"][number]; timezone: string }) {
  const unread = notice.readAt === null;
  return (
    <a href={`/notices/${notice.id}`} className="block px-3 py-2 hover:bg-steel-100">
      <span className="flex items-start gap-2">
        <span aria-hidden className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${unread ? "bg-blue-600" : "bg-canvas"}`} />
        <span className={`text-sm ${unread ? "font-semibold text-ink-900" : "text-ink-700"}`}>{notice.title}</span>
      </span>
      {notice.body ? <span className="ml-4 block line-clamp-2 text-xs text-ink-700">{notice.body}</span> : null}
      <span className="ml-4 block text-xs text-ink-500">
        {notice.kindLabel}, {formatIn(notice.createdAt, timezone)}
        <span className="sr-only">{unread ? ", unread" : ", read"}</span>
      </span>
    </a>
  );
}

function BellMark() {
  return (
    <svg
      viewBox="0 0 24 24" className="h-[18px] w-[18px] shrink-0" aria-hidden
      fill="none" stroke="currentColor" strokeWidth="1.7"
      strokeLinecap="round" strokeLinejoin="round"
    >
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </svg>
  );
}
