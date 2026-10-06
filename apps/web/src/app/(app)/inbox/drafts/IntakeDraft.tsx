import { Chip } from "@opentradesos/ui";
import { ActionForm, Select } from "@/components/ActionForm";
import type { agents } from "@opentradesos/api/services";
import { bookDraft, dismissDraft } from "./actions";

/**
 * One booking the intake agent drafted, and the one click that books it.
 *
 * Everything the office needs to say yes is on the card: who, where, what is
 * wrong, how soon, the service and the window. The agent's first window is
 * chosen already, so booking is the one press; another open window is a
 * choice away. What the agent could not find out is listed, because a draft
 * missing an address should be a phone call, not a booking.
 */

interface BookingDraft {
  customerId: string | null; customerName: string | null; contactName: string;
  phone: string | null; email: string | null;
  address: { line1: string; line2?: string; city: string; state: string; postalCode: string } | null;
  problemSummary: string; urgency: "emergency" | "soon" | "routine";
  serviceName: string | null; windows: { date: string; arrivalWindowId: string; label: string }[];
  missing: string[]; droppedWindows: number;
  /** The number or email it came from is a member's, so the windows held for members were offered. Absent on older drafts. */
  member?: boolean;
  source: { kind: string; from: string | null };
}

const URGENCY = { emergency: "Emergency", soon: "Soon", routine: "Routine" } as const;
const URGENCY_TONE = { emergency: "danger", soon: "warning", routine: "neutral" } as const;
const SOURCE = { text: "Text", email: "Email", call: "Call", form: "Web form" } as Record<string, string>;

export function IntakeDraft({
  proposal, canDecide, conversationId,
}: {
  proposal: agents.ProposalView;
  canDecide: boolean;
  /** The thread this card sits on, so the thread page is refreshed after booking. */
  conversationId?: string | undefined;
}) {
  const draft = proposal.draft as unknown as BookingDraft;
  const bookable = draft.windows.length > 0 && draft.address !== null && (draft.phone || draft.email);
  const hidden = { id: proposal.id, ...(conversationId ? { conversationId } : {}) };
  const outcome = proposal.outcome as { jobId?: string } | null;

  return (
    <article aria-label={`Booking draft for ${draft.customerName ?? draft.contactName}`}
             className="rounded-md border border-steel-200 bg-canvas p-4">
      <div className="flex flex-wrap items-baseline gap-2">
        <h3 className="font-medium">{draft.customerName ?? draft.contactName}</h3>
        <Chip tone={URGENCY_TONE[draft.urgency]}>{URGENCY[draft.urgency]}</Chip>
        <Chip tone={draft.customerId ? "info" : "neutral"}>{draft.customerId ? "Existing customer" : "New customer"}</Chip>
        <span className="text-xs text-ink-500">
          {SOURCE[draft.source.kind] ?? draft.source.kind}{draft.source.from ? ` from ${draft.source.from}` : ""} · drafted by the intake agent
        </span>
      </div>
      <p className="mt-2 text-sm text-ink-900">{draft.problemSummary}</p>
      <dl className="mt-2 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-2">
        <div><dt className="inline text-ink-500">Address: </dt><dd className="inline">
          {draft.address ? `${draft.address.line1}${draft.address.line2 ? `, ${draft.address.line2}` : ""}, ${draft.address.city}, ${draft.address.state} ${draft.address.postalCode}` : "Not given"}
        </dd></div>
        <div><dt className="inline text-ink-500">Contact: </dt><dd className="inline">{[draft.phone, draft.email].filter(Boolean).join(", ") || "None given"}</dd></div>
        <div><dt className="inline text-ink-500">Service: </dt><dd className="inline">{draft.serviceName ?? "Not chosen"}</dd></div>
      </dl>
      {draft.missing.length > 0 ? (
        <p className="mt-2 text-sm text-amber-700">Still to ask: {draft.missing.join(" ")}</p>
      ) : null}
      {draft.member ? (
        <p className="mt-1 text-xs text-ink-500">
          This came from a member&apos;s number or email, so the times offered include those held for members.
          Nothing was said to them about it.
        </p>
      ) : null}
      {draft.droppedWindows > 0 ? (
        <p className="mt-1 text-xs text-ink-500">
          The agent suggested {draft.droppedWindows === 1 ? "a time that was" : `${draft.droppedWindows} times that were`} not open, and {draft.droppedWindows === 1 ? "it was" : "they were"} left out.
        </p>
      ) : null}

      {proposal.status === "applied" ? (
        <p className="mt-3 text-sm">
          Booked{proposal.appliedAutomatically ? " by the agent on its own" : ""}.{" "}
          {outcome?.jobId ? <a href={`/jobs/${outcome.jobId}`} className="underline underline-offset-4">Open the job</a> : null}
        </p>
      ) : proposal.status === "proposed" && canDecide ? (
        <div className="mt-3 flex flex-wrap items-end gap-3">
          {bookable ? (
            <ActionForm action={bookDraft} submit="Book it" hidden={hidden} className="flex flex-wrap items-end gap-3">
              <Select label="Window" name="window" className="w-72"
                      options={draft.windows.map((w) => ({ value: `${w.date}|${w.arrivalWindowId}`, label: w.label }))} />
            </ActionForm>
          ) : (
            <p className="text-sm text-ink-700">
              {draft.windows.length === 0 ? "No open window to book it in." : "Missing what a booking needs."} Book it by hand from{" "}
              <a href="/jobs/new" className="underline underline-offset-4">a new job</a>.
            </p>
          )}
          <ActionForm action={dismissDraft} submit="Not a booking" hidden={hidden} tone="quiet" className="flex items-end" />
        </div>
      ) : proposal.note ? (
        <p className="mt-3 text-sm text-ink-500">{proposal.note}</p>
      ) : null}
    </article>
  );
}
