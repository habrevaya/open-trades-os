import { VisitChangeForm, type SendVisitChange } from "./VisitChangeForm";
import { ProposalAnswer, type SendProposalAnswer } from "./ProposalAnswer";
import type { visitChanges } from "@opentradesos/api/services";

type ChangeOptions = visitChanges.ChangeOptions;

const when = (start: string, end: string | null, timezone: string) => {
  const s = new Date(start);
  const day = s.toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: timezone });
  const at = (d: Date) => d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: timezone });
  return end ? `${day}, ${at(s)} to ${at(new Date(end))}` : `${day} at ${at(s)}`;
};

/**
 * ONE VISIT, AND WHAT THE CUSTOMER CAN DO ABOUT IT.
 *
 * Shared by the job link and the account link, which reach a visit by
 * different routes and show the same thing once there. Separate from the
 * pages so it renders in a test without a database.
 *
 * Three states and they are said, not implied: a request already waiting
 * (nothing more can be asked until the office answers), a visit that can no
 * longer be changed from here (the van is on its way), and the choice.
 */
export function VisitChange({
  token, send, answer, options, path, visitId,
}: {
  /** The link's token, on a link page. */
  token?: string;
  /** On a signed in page: an action bound to the company that reads the sign in on the server. */
  send?: SendVisitChange;
  /** On a signed in page: the same, for answering a time the office offered. */
  answer?: SendProposalAnswer;
  options: ChangeOptions;
  path: string;
  visitId?: string;
}) {
  const { visit, timezone } = options;
  return (
    <>
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{options.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">Change your visit</h1>
        <p className="mt-1 text-sm text-ink-500">{visit.summary}</p>
      </header>

      <section className="rounded-md border border-steel-200 bg-canvas p-5">
        <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Booked for</p>
        <p className="mt-1 text-lg font-medium">{when(visit.windowStart, visit.windowEnd, timezone)}</p>
      </section>

      {options.pending ? (
        <section role="status" className="rounded-md border border-steel-200 bg-canvas p-5 text-sm text-ink-700">
          {options.pending.kind === "cancel"
            ? "You have asked to cancel this visit."
            : `You have asked to move this visit to ${options.pending.requestedStart
              ? when(options.pending.requestedStart, options.pending.requestedEnd, timezone)
              : "another time"}.`}
          {" "}{options.organizationName} will reply to you. It stays as it is until they do.
        </section>
      ) : null}

      {options.proposal ? (
        <section aria-label="Another time offered" className="rounded-md border border-amber-700 bg-amber-tint p-5 text-sm">
          <p className="font-medium text-ink-900">
            {options.organizationName} cannot do{" "}
            {options.proposal.requestedStart
              ? when(options.proposal.requestedStart, options.proposal.requestedEnd, timezone)
              : "the time you asked for"}
            . They offer {when(options.proposal.proposedStart, options.proposal.proposedEnd, timezone)} instead.
          </p>
          {options.proposal.response ? <p className="mt-1 text-ink-700">{options.proposal.response}</p> : null}
          <p className="mt-1 text-ink-700">Your visit stays where it is until you say yes.</p>
          {options.proposal.open ? (
            <div className="mt-4">
              <ProposalAnswer
                {...(token ? { token } : {})}
                {...(answer ? { send: answer } : {})}
                {...(visitId ? { visitId } : { visitId: visit.id })}
                offered={when(options.proposal.proposedStart, options.proposal.proposedEnd, timezone)}
                path={path}
              />
            </div>
          ) : (
            <p className="mt-2 text-ink-700">That time can no longer be used. Reply to the message that brought you here.</p>
          )}
        </section>
      ) : null}

      {!options.pending && !options.proposal && options.decided ? (
        <section className="rounded-md border border-steel-200 bg-canvas p-5 text-sm text-ink-700">
          {options.decided.status === "approved"
            ? "Your last request about this visit was agreed."
            : options.decided.status === "accepted"
              ? "You took the time the office offered, and your visit was moved to it."
              : options.decided.status === "turned_down"
                ? "You said no to the time the office offered. They will be in touch."
                : `Your last request about this visit was not agreed${options.decided.response ? `: ${options.decided.response}` : "."}`}
        </section>
      ) : null}

      {options.canChange ? (
        <section className="rounded-md border border-steel-200 bg-canvas p-5">
          <VisitChangeForm
            {...(token ? { token } : {})}
            {...(send ? { send } : {})}
            {...(visitId ? { visitId } : {})}
            slots={options.slots}
            rescheduleBlockedBy={options.rescheduleBlockedBy}
            path={path}
            organizationName={options.organizationName}
          />
        </section>
      ) : !options.pending && !options.proposal && options.changeBlockedBy ? (
        <p className="text-center text-sm text-ink-700">{options.changeBlockedBy}</p>
      ) : null}
    </>
  );
}
