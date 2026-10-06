import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { comms, consent, agents, agentIntake, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Phone } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";
import { Crumb } from "@/components/Detail";
import { ReplyBox } from "./ReplyBox";
import { ConsentSummary } from "./ConsentSummary";
import { IntakeDraft } from "../drafts/IntakeDraft";
import { draftFromThread } from "../drafts/actions";
import { ActionForm } from "@/components/ActionForm";

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
  const consentRows = await consent.history(ctx, { address: thread.conversation.externalAddress });
  const byEmail = thread.conversation.channel === "email";
  const byChat = thread.conversation.channel === "webchat";

  /**
   * The intake agent's draft for this thread, beside the messages it was read
   * from, so the office books it without leaving the conversation. The button
   * to ask for one is offered only when the agent is on; the service refuses
   * otherwise anyway.
   */
  const drafts = can(user.actor, "booking:read") && !byChat
    ? (await agentIntake.drafts(ctx, { sourceKind: "conversation", sourceId: id, status: ["proposed", "applied"], limit: 1 })).drafts
    : [];
  const intakeOn = !byChat && can(user.actor, "message:read") && await agents.isOn(ctx, "intake");

  return (
    <div className="mx-auto max-w-2xl px-4 py-8 lg:px-6">
      <Crumb href="/inbox">Inbox</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          {thread.customer?.name ?? (byChat ? "Website visitor" : byEmail ? thread.conversation.externalAddress : "Unknown number")}
        </h1>
        <span className="text-sm text-ink-500">
          {byChat ? "Website chat" : byEmail ? `Email, ${thread.conversation.externalAddress}` : <Phone value={thread.conversation.externalAddress} />}
        </span>
      </div>
      {thread.customer && (
        <p className="mt-1 text-sm">
          <a href={`/inbox?customer=${String(thread.customer["id"])}`} className="text-ink-700 underline underline-offset-4">
            Every conversation with them
          </a>
        </p>
      )}

      {byChat ? null : <ConsentSummary
        entries={consentRows}
        suppressed={thread.blockedReason === "suppressed"}
        customerId={thread.conversation.customerId}
      />}

      {drafts[0] ? (
        <div className="mt-6">
          <IntakeDraft proposal={drafts[0]} conversationId={id}
                       canDecide={can(user.actor, "booking:decide") && can(user.actor, "visit:write")} />
        </div>
      ) : null}
      {intakeOn && drafts[0]?.status !== "proposed" ? (
        <ActionForm action={draftFromThread} submit="Draft a booking from this" tone="quiet"
                    hidden={{ sourceKind: "conversation", sourceId: id, conversationId: id, ...(drafts[0] ? { fresh: "yes" } : {}) }}
                    className="mt-4" />
      ) : null}

      <ol className="mt-8 space-y-4">
        {thread.messages.map((raw) => {
          const message = raw as typeof raw & {
            subject?: string | null; fromAddress?: string;
            media?: { contentType: string; storageKey?: string; refused?: string }[];
          };
          const outbound = message.direction === "outbound";
          const otherSender = !outbound && byEmail && message.fromAddress
            && message.fromAddress !== thread.conversation.externalAddress;
          return (
            <li key={message.id} className={outbound ? "flex justify-end" : "flex"}>
              <div className={`max-w-[85%] rounded-md px-4 py-3 text-sm ${
                outbound
                  ? "bg-ink-900 text-white"
                  : "border border-steel-200 bg-canvas text-ink-900"
              }`}>
                {message.subject ? <p className="mb-1 font-medium">{message.subject}</p> : null}
                {otherSender ? <p className="mb-1 text-xs">From {message.fromAddress}</p> : null}
                {message.body ? <p className="whitespace-pre-wrap">{message.body}</p> : null}
                {/*
                  Pictures kept here are shown from this product's own copy, so
                  nobody needs a login at the carrier. Anything not kept says
                  what it was and why, rather than leaving a gap.
                */}
                {(message.media ?? []).map((item, i) => item.storageKey ? (
                  <a key={i} href={`/inbox/${id}/media/${item.storageKey}`} target="_blank" rel="noreferrer" className="mt-2 block">
                    <img src={`/inbox/${id}/media/${item.storageKey}`} alt={outbound ? "Picture sent" : "Picture from the customer"}
                         className="max-h-64 rounded border border-steel-200" />
                  </a>
                ) : item.refused ? (
                  <p key={i} className="mt-2 text-xs italic">{item.refused}</p>
                ) : null)}
                <p className={`mt-1.5 text-xs ${outbound ? "text-steel-300" : "text-ink-500"}`}>
                  {formatIn(message.createdAt, user.organizationTimezone)}
                  {/*
                    Queued is said out loud. A message that shows as delivered
                    when it is sitting in a table is the one thing that would
                    make this log untrustworthy.
                  */}
                  {outbound && message.status === "queued" ? " · queued" : ""}
                  {outbound && message.status === "failed" ? " · failed to send" : ""}
                  {outbound && byChat && !(message as { sentByUserId?: string | null }).sentByUserId ? " · automated assistant" : ""}
                </p>
              </div>
            </li>
          );
        })}
      </ol>

      {can(user.actor, "message:send") ? (
        thread.canReply ? (
          <ReplyBox conversationId={id} byEmail={byEmail} />
        ) : (
          /*
            Said before somebody types rather than after they press send. A
            box that accepts a reply and then refuses it has wasted their
            typing and taught them the guard is an obstacle.
          */
          <p className="mt-8 rounded-md border border-steel-300 bg-canvas-raised px-4 py-3 text-sm text-ink-700">
            {thread.blockedExplanation ?? "You cannot reply to this number."}
          </p>
        )
      ) : null}
    </div>
  );
}
