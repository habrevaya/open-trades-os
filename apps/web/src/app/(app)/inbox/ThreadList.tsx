import { Chip, formatPhone } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";

export interface ThreadRow {
  id: string;
  externalAddress: string;
  customerName: string | null;
  lastMessageAt: Date | string | null;
  lastMessagePreview: string | null;
  awaitingReply: boolean;
  unread: number;
  /** The customer closed this chat from their account. */
  closedByCustomer?: boolean;
  /** Who closed it: the customer, a person in the office, or the quiet chat rule. */
  closedBy?: "customer" | "office" | "idle" | null;
  /** The person, when somebody in the office closed it. */
  closedByName?: string | null;
  /** `webchat` for a website chat, whose address is not a number anybody can ring. */
  channel?: string;
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
                <span className="font-medium">
                  {thread.customerName ?? (thread.channel === "webchat" ? "Website chat" : thread.channel === "email" ? "Unknown sender" : "Unknown number")}
                </span>
                {/*
                  The number when we do not know who it is. An inbound text
                  from a number matching no customer is a lead, and showing it
                  as "Unknown" with nothing else would make it unanswerable.
                */}
                {/* The address as text, not the Phone link: the whole row is already a link, and a link inside a link is invalid HTML that breaks hydration. */}
                {thread.customerName === null && thread.channel !== "webchat" && (
                  <span className="font-mono text-sm tabular-nums text-ink-500">
                    {thread.channel === "email" ? thread.externalAddress : formatPhone(thread.externalAddress)}
                  </span>
                )}
                {thread.awaitingReply && <Chip tone="warning">Needs a reply</Chip>}
                {thread.unread > 0 && <Chip tone="info">{thread.unread} unread</Chip>}
                {thread.closedByCustomer && <Chip tone="neutral">Closed by the customer</Chip>}
                {thread.closedBy === "office" && <Chip tone="neutral">Closed by the office</Chip>}
                {thread.closedBy === "office" && thread.closedByName && (
                  <span className="text-xs text-ink-500">{thread.closedByName}</span>
                )}
                {thread.closedBy === "idle" && <Chip tone="neutral">Closed, went quiet</Chip>}
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
