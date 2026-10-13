import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { staffNotices } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm } from "@/components/ActionForm";
import { Empty } from "@/components/Table";
import { NoticeLine } from "@/components/NoticeBell";
import { markAllNoticesRead, markNoticeRead } from "./actions";

export const dynamic = "force-dynamic";

/**
 * EVERYTHING YOU WERE TOLD
 *
 * The bell's whole list: the last hundred notices for the person signed in,
 * newest first, each a link to what it is about. Only their own, and only
 * about records they can still open. Where each kind reaches them (here, the
 * phone app, a text) is on `/me`.
 */
export default async function NoticesPage({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  const user = await requireSetupUser();
  if (!can(user.actor, "profile:own")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        <h1 className="text-xl font-semibold">Notices</h1>
        <Empty title="Not part of your access">Ask the office to give your role See your own staff record.</Empty>
      </div>
    );
  }
  const unreadOnly = (await searchParams).show === "unread";
  const { notices, unread } = await staffNotices.list({ actor: user.actor, db: getDb() }, { limit: 100, unread: unreadOnly });

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Notices</h1>
        {unread > 0 ? <ActionForm action={markAllNoticesRead} submit="Mark all read" tone="quiet" className="inline-flex" /> : null}
      </div>
      <p className="mt-1 text-sm text-ink-700">
        {unread === 0 ? "You have read everything." : `${unread > 99 ? "More than 99" : unread} not read yet.`}{" "}
        <a href="/me#notices" className="text-blue-600 underline underline-offset-4">Choose what you are told, and where</a>
      </p>
      <nav aria-label="Which notices" className="mt-4 flex gap-4 text-sm">
        <a href="/notices" aria-current={unreadOnly ? undefined : "page"}
           className={unreadOnly ? "text-ink-500" : "font-medium text-ink-900"}>All</a>
        <a href="/notices?show=unread" aria-current={unreadOnly ? "page" : undefined}
           className={unreadOnly ? "font-medium text-ink-900" : "text-ink-500"}>Not read</a>
      </nav>
      {notices.length === 0 ? (
        <Empty title={unreadOnly ? "Nothing unread" : "No notices yet"}>
          When a task is given to you, an order waits for your approval, or something of yours needs you, it shows here.
        </Empty>
      ) : (
        <ul className="mt-3 divide-y divide-steel-200 rounded-md border border-steel-200 bg-canvas" aria-label="Your notices">
          {notices.map((notice) => (
            <li key={notice.id} className="flex flex-wrap items-center justify-between gap-2 pr-3">
              <div className="min-w-0 flex-1"><NoticeLine notice={notice} timezone={user.organizationTimezone} /></div>
              {notice.readAt === null ? (
                <ActionForm action={markNoticeRead} submit="Mark read" tone="quiet" className="inline-flex" hidden={{ id: notice.id }} />
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
