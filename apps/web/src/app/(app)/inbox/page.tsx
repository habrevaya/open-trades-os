import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { comms } from "@opentradesos/api/services";
import { Chip, Phone } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";
import { Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * THE INBOX
 *
 * Sorted by what happened last, and the only thing distinguished is whether
 * the last thing said came from them. That is the question somebody opening
 * this screen is actually asking, and an inbox that sorts by anything else
 * makes them read every row to find the two that need an answer.
 */
export default async function InboxPage() {
  const user = await requireSetupUser();
  const page = await comms.threads({ actor: user.actor, db: getDb() }, { limit: 100 });
  const waiting = page.data.filter((t) => t.awaitingReply).length;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Inbox" count={page.data.length} />
      {waiting > 0 && (
        <p className="mt-2 text-sm text-ink-700">
          {waiting === 1 ? "One conversation is" : `${waiting} conversations are`} waiting on a reply.
        </p>
      )}

      {page.data.length === 0 ? (
        <Empty title="Nothing here yet">
          Replies to your texts land here. Connect a number in settings and
          send one to see it.
        </Empty>
      ) : (
        <ul className="mt-6 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {page.data.map((thread) => (
            <li key={thread.id}>
              <a
                href={`/inbox/${thread.id}`}
                className="flex gap-4 bg-canvas p-4 transition-colors hover:bg-steel-100"
              >
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">
                      {thread.customerName ?? "Unknown number"}
                    </span>
                    {/*
                      The number when we do not know who it is. An inbound
                      text from a number matching no customer is a lead, and
                      showing it as "Unknown" with nothing else would make it
                      unanswerable.
                    */}
                    {thread.customerName === null && (
                      <span className="text-sm text-ink-500">
                        <Phone value={thread.externalAddress} />
                      </span>
                    )}
                    {thread.awaitingReply && <Chip tone="warning">Needs a reply</Chip>}
                    {thread.unread > 0 && <Chip tone="info">{thread.unread} unread</Chip>}
                  </div>
                  {/* Truncated to one line. A preview that wraps is a list
                      that scrolls, and the point of a list is scanning it. */}
                  <p className="mt-1 truncate text-sm text-ink-700">
                    {thread.lastMessagePreview ?? "No messages yet"}
                  </p>
                </div>
                <span className="shrink-0 text-sm text-ink-500">
                  {thread.lastMessageAt
                    ? formatIn(thread.lastMessageAt, user.organizationTimezone)
                    : ""}
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
