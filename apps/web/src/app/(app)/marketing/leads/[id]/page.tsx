import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { marketplaceLeads, leadIntake } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money, Phone } from "@opentradesos/ui";
import { PageHeader } from "@/components/Table";
import { Crumb, Facts, Fact } from "@/components/Detail";
import { ActionForm, TextArea } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { acceptOffer, declineOffer } from "../../actions";
import { replyToLead } from "../actions";

export const dynamic = "force-dynamic";

/**
 * ONE LEAD: WHO, WHAT, WHERE, WHAT IT COST, AND THE CONVERSATION
 *
 * The thread is the marketplace's, read in as it arrives: a Thumbtack or Yelp
 * customer's messages, and the office's replies, which go back through the
 * marketplace because that is often the only way to the person. A lead from
 * a marketplace that takes no replies says so where the reply box would be,
 * and what to do instead.
 */
export default async function LeadOfferPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const offer = await marketplaceLeads.offerDetail(ctx, { id }).catch(() => null);
  if (!offer) notFound();
  const decides = can(user.actor, "job:write") && can(user.actor, "customer:write");
  const replies = can(user.actor, "message:send");
  const zone = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/marketing/leads">Lead offers</Crumb>
      <PageHeader title={offer.contactName ?? "No name"} />
      <p className="mt-1 text-sm text-ink-700">
        From {offer.connector}
        {offer.campaignName ? `, credited to ${offer.campaignName}` : offer.channelName ? `, credited to ${offer.channelName}` : ""}.
      </p>

      <Facts>
        <Fact label="Phone">{offer.contactPhone ? <Phone value={offer.contactPhone} /> : "Not given"}</Fact>
        <Fact label="Email">{offer.contactEmail ?? "Not given"}</Fact>
        <Fact label="Wants">{offer.serviceRequested ?? "Not said"}</Fact>
        <Fact label="Where">{[offer.addressLine1, offer.city, offer.state, offer.postalCode].filter(Boolean).join(", ") || "Not given"}</Fact>
        <Fact label="It cost">{offer.charge ? <Money value={offer.charge} /> : "Not said"}</Fact>
        <Fact label="Arrived">{formatIn(offer.createdAt, zone)}</Fact>
        <Fact label="Where it stands">
          {offer.status === "accepted" && offer.jobId
            ? <a href={`/jobs/${offer.jobId}`} className="underline underline-offset-4">Accepted: the job</a>
            : offer.status === "declined" ? `Declined: ${offer.declineReason ?? ""}`
              : offer.expired ? <Chip tone="warning">Expired</Chip> : <Chip tone="info">Waiting</Chip>}
        </Fact>
      </Facts>
      {offer.notes ? <p className="mt-4 whitespace-pre-line text-sm text-ink-700">{offer.notes}</p> : null}

      {offer.status === "offered" && decides ? (
        <div className="mt-6 flex flex-wrap items-start gap-4">
          {!offer.expired ? <ActionForm action={acceptOffer} submit="Accept" hidden={{ id: offer.id }} className="flex items-center gap-2" /> : null}
          <ActionForm action={declineOffer} submit="Decline" tone="quiet" hidden={{ id: offer.id }} className="flex flex-wrap items-center gap-2">
            <select name="reason" aria-label="Why it is declined" className="h-9 rounded border border-steel-300 px-2 text-sm">
              {Object.entries(leadIntake.DECLINE_REASONS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
            </select>
          </ActionForm>
        </div>
      ) : null}

      <section className="mt-10" aria-labelledby="thread-heading">
        <h2 id="thread-heading" className="text-base font-semibold">Conversation</h2>
        {offer.messages.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">Nothing written on this lead yet.</p>
        ) : (
          <ol className="mt-3 space-y-3" aria-label="Messages on this lead">
            {offer.messages.map((msg) => (
              <li key={msg.id}
                  className={`max-w-xl rounded-md border p-3 text-sm ${msg.direction === "outbound" ? "ml-auto border-steel-300 bg-steel-100" : "border-steel-200 bg-canvas"}`}>
                <p className="text-xs text-ink-500">
                  {msg.direction === "outbound" ? "You" : offer.contactName ?? "The customer"}, {formatIn(msg.at, zone)}
                  {msg.state === "failed" ? <> <Chip tone="danger">Not sent</Chip></> : msg.state === "sending" ? <> <Chip tone="neutral">Sending</Chip></> : null}
                </p>
                <p className="mt-1 whitespace-pre-line">{msg.body}</p>
                {msg.error ? <p className="mt-1 text-xs text-red-600">{msg.error}</p> : null}
              </li>
            ))}
          </ol>
        )}
        {offer.canReply ? (
          replies ? (
            <ActionForm action={replyToLead} submit={`Send through ${offer.connector}`} hidden={{ id: offer.id }} className="mt-4 max-w-xl space-y-3">
              <TextArea label="Reply" name="body" rows={3} required />
            </ActionForm>
          ) : null
        ) : (
          <p className="mt-4 text-sm text-ink-700">{offer.cannotReplyBecause}</p>
        )}
      </section>
    </div>
  );
}
