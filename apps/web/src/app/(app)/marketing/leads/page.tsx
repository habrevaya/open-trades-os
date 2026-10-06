import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { leadIntake } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money, Phone } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { acceptOffer, declineOffer } from "../actions";

export const dynamic = "force-dynamic";

/**
 * LEADS A MARKETPLACE SENT, TO TAKE OR TURN DOWN
 *
 * An offer is not a job. It costs money to accept, it expires in minutes, and
 * a company at capacity has to be able to say no without that being a
 * cancelled job on its own board. So accepting is what makes the customer,
 * the property and the job, credited to the marketplace that sold the lead,
 * and declining asks why from a list, because the point of recording it is
 * to count it.
 */
export default async function LeadOffersPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const offers = await leadIntake.openOffers(ctx, { include: "all" });
  const open = offers.filter((o) => o.status === "offered");
  const decided = offers.filter((o) => o.status !== "offered").slice(0, 30);
  const writes = can(user.actor, "job:write") && can(user.actor, "customer:write");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Lead offers" count={open.length} />
      <p className="mt-2 max-w-2xl text-sm">
        <a href="/marketing/leads/connectors" className="underline underline-offset-4">Set up a lead source</a>{" "}
        <span className="text-ink-700">to receive them from Angi, Thumbtack, Yelp, Nextdoor, a partner or a website form, or see the</span>{" "}
        <a href="/marketing/leads/emails" className="underline underline-offset-4">lead emails that arrived</a>.
      </p>

      {open.length === 0 ? (
        <Empty title="Nothing waiting">New leads appear here the moment a connected source sends one.</Empty>
      ) : (
        <Table label="Open offers" head={<><Th>Lead</Th><Th>Wants</Th><Th>Where</Th><Th>From</Th><Th>Worth</Th><Th>Time left</Th><Th></Th></>}>
          {open.map((offer) => (
            <tr key={offer.id}>
              <Td>
                <a href={`/marketing/leads/${offer.id}`} className="font-medium underline underline-offset-4">{offer.contactName ?? "No name"}</a>
                {offer.contactPhone ? <span className="block"><Phone value={offer.contactPhone} /></span> : null}
                {offer.contactEmail ? <span className="block text-xs text-ink-500">{offer.contactEmail}</span> : null}
              </Td>
              <Td>
                {offer.serviceRequested}
                {offer.notes ? <span className="block text-xs text-ink-500">{offer.notes}</span> : null}
              </Td>
              <Td className="text-ink-700">{[offer.addressLine1, offer.city, offer.postalCode].filter(Boolean).join(", ")}</Td>
              <Td>{offer.connector}</Td>
              <Td>{offer.estimatedValue ? <Money value={offer.estimatedValue} /> : null}</Td>
              <Td>
                {offer.expired ? <Chip tone="warning">Expired</Chip>
                  : offer.secondsLeft !== null ? `${Math.ceil(offer.secondsLeft / 60)} min` : "No limit"}
              </Td>
              <Td>
                {writes ? (
                  <div className="flex flex-col gap-2">
                    {!offer.expired ? (
                      <ActionForm action={acceptOffer} submit="Accept" hidden={{ id: offer.id }} className="flex items-center gap-2" />
                    ) : null}
                    <ActionForm action={declineOffer} submit="Decline" tone="quiet" hidden={{ id: offer.id }}
                                className="flex flex-wrap items-center gap-2">
                      <select name="reason" aria-label={`Why ${offer.contactName ?? "this lead"} is declined`}
                              className="h-9 rounded border border-steel-300 px-2 text-sm">
                        {Object.entries(leadIntake.DECLINE_REASONS).map(([key, label]) => (
                          <option key={key} value={key}>{label}</option>
                        ))}
                      </select>
                      <input name="note" placeholder="Note" aria-label="Note"
                             className="h-9 w-28 rounded border border-steel-300 px-2 text-sm" />
                    </ActionForm>
                  </div>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {decided.length > 0 && (
        <section className="mt-10">
          <h2 className="text-base font-semibold">Decided</h2>
          <Table label="Decided offers" head={<><Th>Lead</Th><Th>From</Th><Th>Decided</Th><Th>What happened</Th></>}>
            {decided.map((offer) => (
              <tr key={offer.id}>
                <Td><a href={`/marketing/leads/${offer.id}`} className="underline underline-offset-4">{offer.contactName ?? "No name"}</a></Td>
                <Td>{offer.connector}</Td>
                <Td>{offer.decidedAt ? formatIn(offer.decidedAt, user.organizationTimezone) : ""}</Td>
                <Td>
                  {offer.status === "accepted" && offer.jobId
                    ? <a href={`/jobs/${offer.jobId}`} className="underline underline-offset-4">Accepted: the job</a>
                    : offer.status === "declined"
                      ? `Declined: ${offer.declineReason ?? ""}`
                      : offer.status}
                </Td>
              </tr>
            ))}
          </Table>
        </section>
      )}
    </div>
  );
}
