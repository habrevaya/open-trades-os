import { Chip, Phone } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";

export interface ThreadRow {
  id: string;
  externalAddress: string;
  customerName: string | null;
  lastMessageAt: Date | string | null;
  lastMessagePreview: string | null;
  awaitingReply: boolean;
  unread: number;
}

/**
 * Conversations as rows, newest activity first, the ones waiting on us
 * marked. Shared by the inbox and a customer's page, so "everything we have
 * said to them" reads the same in both places.
 */
export function ThreadList({ threads, timezone }: { threads: ThreadRow[]; timezone: string }) {
  return (
    <ul className="divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
      {threads.map((thread) => (
        <li key={thread.id}>
          <a
            href={`/inbox/${thread.id}`}
            className="flex gap-4 bg-canvas p-4 transition-colors hover:bg-steel-100"
          >
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium">{thread.customerName ?? "Unknown number"}</span>
                {/*
                  The number when we do not know who it is. An inbound text
                  from a number matching no customer is a lead, and showing it
                  as "Unknown" with nothing else would make it unanswerable.
                */}
                {thread.customerName === null && (
                  <span className="text-sm text-ink-500"><Phone value={thread.externalAddress} /></span>
                )}
                {thread.awaitingReply && <Chip tone="warning">Needs a reply</Chip>}
                {thread.unread > 0 && <Chip tone="info">{thread.unread} unread</Chip>}
              </div>
              {/* One line. A preview that wraps is a list that scrolls. */}
              <p className="mt-1 truncate text-sm text-ink-700">
                {thread.lastMessagePreview ?? "No messages yet"}
              </p>
            </div>
            <span className="shrink-0 text-sm text-ink-500">
              {thread.lastMessageAt ? formatIn(new Date(thread.lastMessageAt), timezone) : ""}
            </span>
          </a>
        </li>
      ))}
    </ul>
  );
}
