import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { comms, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Phone } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";
import { Crumb } from "@/components/Detail";
import { ReplyBox } from "./ReplyBox";

export const dynamic = "force-dynamic";

/**
 * A thread, in order, with the reply box at the bottom.
 *
 * Opening it marks what is in it as read, because a person who opened the
 * conversation read it. Asking them to tick each message is a chore they stop
 * doing within a week, and an unread count nobody clears is worse than none.
 */
export default async function ThreadPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };

  const thread = await comms.thread(ctx, { id }).catch((error: unknown) => {
    // Out of scope reads as missing, the same as everywhere else.
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  await comms.markRead(ctx, { id });

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 lg:px-6">
      <Crumb href="/inbox">Inbox</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          {thread.customer?.name ?? "Unknown number"}
        </h1>
        <span className="text-sm text-ink-500">
          <Phone value={thread.conversation.externalAddress} />
        </span>
      </div>

      <ol className="mt-8 space-y-4">
        {thread.messages.map((message) => {
          const outbound = message.direction === "outbound";
          return (
            <li key={message.id} className={outbound ? "flex justify-end" : "flex"}>
              <div className={`max-w-[85%] rounded-md px-4 py-3 text-sm ${
                outbound
                  ? "bg-ink-900 text-white"
                  : "border border-steel-200 bg-canvas text-ink-900"
              }`}>
                <p className="whitespace-pre-wrap">{message.body}</p>
                <p className={`mt-1.5 text-xs ${outbound ? "text-steel-300" : "text-ink-500"}`}>
                  {formatIn(message.createdAt, user.organizationTimezone)}
                  {/*
                    Queued is said out loud. A message that shows as delivered
                    when it is sitting in a table is the one thing that would
                    make this log untrustworthy.
                  */}
                  {outbound && message.status === "queued" ? " · queued" : ""}
                  {outbound && message.status === "failed" ? " · failed to send" : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {can(user.actor, "message:send") ? (
        thread.canReply ? (
          <ReplyBox conversationId={id} />
        ) : (
          /*
            Said before somebody types rather than after they press send. A
            box that accepts a reply and then refuses it has wasted their
            typing and taught them the guard is an obstacle.
          */
          <p className="mt-8 rounded-md border border-steel-300 bg-canvas-raised px-4 py-3 text-sm text-ink-700">
            {BLOCKED[thread.blockedReason ?? ""] ?? "You cannot reply to this number."}
          </p>
        )
      ) : null}
    </div>
  );
}

const BLOCKED: Record<string, string> = {
  suppressed: "They replied STOP. You cannot text this number until they opt back in.",
  no_consent: "No consent on record for this number.",
  revoked: "They withdrew consent for this number.",
  channel_unregistered: "No registered sending number. Add one in settings before replying.",
  quiet_hours: "Outside the hours this customer may be contacted.",
};
