import { VisitChangeForm } from "./VisitChangeForm";
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
  token, options, path, visitId,
}: {
  token: string;
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

      {!options.pending && options.decided ? (
        <section className="rounded-md border border-steel-200 bg-canvas p-5 text-sm text-ink-700">
          {options.decided.status === "approved"
            ? "Your last request about this visit was agreed."
            : `Your last request about this visit was not agreed${options.decided.response ? `: ${options.decided.response}` : "."}`}
        </section>
      ) : null}

      {options.canChange ? (
        <section className="rounded-md border border-steel-200 bg-canvas p-5">
          <VisitChangeForm
            token={token}
            {...(visitId ? { visitId } : {})}
            slots={options.slots}
            rescheduleBlockedBy={options.rescheduleBlockedBy}
            path={path}
            organizationName={options.organizationName}
          />
        </section>
      ) : !options.pending && options.changeBlockedBy ? (
        <p className="text-center text-sm text-ink-700">{options.changeBlockedBy}</p>
      ) : null}
    </>
  );
}
