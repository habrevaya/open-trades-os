import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agentIntake, booking } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { PageHeader, Empty } from "@/components/Table";
import { IntakeDraft } from "./IntakeDraft";
import { ActionForm, Select } from "@/components/ActionForm";
import { bookRequest, declineRequest } from "./actions";

export const dynamic = "force-dynamic";

/**
 * INBOX → BOOKING DRAFTS
 *
 * What the intake agent read and drafted from texts, emails, call transcripts
 * and web forms, newest first, each bookable with one click. Below them, what
 * was booked and set aside lately, so the office can see what the agent did
 * overnight and who said yes to it.
 */
export default async function BookingDraftsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "booking:read")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
        <PageHeader title="Booking drafts" />
        <Empty title="Not shown to your role">Seeing booking drafts needs the View booking requests permission.</Empty>
      </div>
    );
  }

  const [open, recent, requests] = await Promise.all([
    agentIntake.drafts(ctx, { status: ["proposed"], limit: 100 }),
    agentIntake.drafts(ctx, { status: ["applied"], limit: 20 }),
    booking.listRequests(ctx, { status: ["pending"], limit: 50 }),
  ]);
  const canDecide = can(user.actor, "booking:decide") && can(user.actor, "visit:write");

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <PageHeader title="Booking drafts" count={open.drafts.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        The intake agent reads new texts, emails, call transcripts and web forms and drafts a booking from each.
        Check it and book it, or set it aside. Turn it on and choose what it reads under{" "}
        <a href="/settings/agents" className="underline underline-offset-4">Settings, AI agents</a>.
      </p>
      {open.drafts.length === 0 ? (
        <Empty title="No drafts waiting">New drafts appear here as messages arrive.</Empty>
      ) : (
        <div className="mt-6 space-y-4">
          {open.drafts.map((draft) => (
            <div key={draft.id}>
              <IntakeDraft proposal={draft} canDecide={canDecide} />
              {draft.sourceKind === "conversation" ? (
                <a href={`/inbox/${draft.sourceId}`} className="mt-1 inline-block text-sm text-ink-700 underline underline-offset-4">
                  Read the conversation
                </a>
              ) : null}
            </div>
          ))}
        </div>
      )}
      {requests.data.length > 0 ? (
        <section aria-label="Booking requests" className="mt-10">
          <h2 className="text-base font-semibold">Booking requests</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">
            Times customers asked for themselves, on your booking page or in the website chat. Booking one makes the
            job and puts the visit in the window they chose.
          </p>
          <ul className="mt-3 space-y-3">
            {requests.data.map((request) => (
              <li key={request.id} aria-label={`Booking request from ${request.contactName}`}
                  className="rounded-md border border-steel-200 bg-canvas p-4 text-sm">
                <p className="font-medium">{request.contactName}</p>
                <p className="text-ink-700">
                  {String(request["serviceName"] ?? "")} on {request.requestedDate}
                  {request.addressLine1 ? `, ${request.addressLine1}, ${request.city ?? ""} ${request.postalCode ?? ""}` : ""}
                </p>
                {request.notes ? <p className="mt-1">{request.notes}</p> : null}
                <p className="text-ink-500">{[request.contactPhone, request.contactEmail].filter(Boolean).join(", ")}</p>
                {canDecide ? (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <ActionForm action={bookRequest} submit="Book it" hidden={{ id: request.id }} className="flex items-end" />
                    <ActionForm action={declineRequest} submit="Decline" hidden={{ id: request.id }} tone="quiet"
                                className="flex flex-wrap items-end gap-3">
                      <Select label="Why" name="reason" className="w-56" options={[
                        { value: "outside_service_area", label: "Outside our area" },
                        { value: "no_capacity", label: "No room that day" },
                        { value: "not_a_service_we_offer", label: "Not something we do" },
                        { value: "duplicate", label: "Asked twice" },
                        { value: "unreachable", label: "Could not reach them" },
                        { value: "other", label: "Something else" },
                      ]} />
                    </ActionForm>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {recent.drafts.length > 0 ? (
        <section aria-label="Booked lately" className="mt-10">
          <h2 className="text-base font-semibold">Booked lately</h2>
          <div className="mt-3 space-y-3">
            {recent.drafts.map((draft) => <IntakeDraft key={draft.id} proposal={draft} canDecide={false} />)}
          </div>
        </section>
      ) : null}
    </div>
  );
}
