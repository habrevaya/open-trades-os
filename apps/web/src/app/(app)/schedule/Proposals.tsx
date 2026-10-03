"use client";

import type { proposeRoute, suggestAssignments } from "./actions";

export type Proposal = Extract<Awaited<ReturnType<typeof proposeRoute>>, { ok: true }>["proposal"];
export type Suggested = Extract<Awaited<ReturnType<typeof suggestAssignments>>, { ok: true }>["result"];

/**
 * THE OPTIMISER'S PROPOSAL, BEFORE ANYTHING MOVES
 *
 * Before and after drive time, the windows it still cannot keep, what it left
 * where it was and why, and the order itself. "Use this order" sends the
 * whole day to the same reorder a drag uses; closing it changes nothing.
 * Every figure says what it was worked out from: by road when the company
 * has a routing service, otherwise a straight line at an average speed,
 * which is an estimate and is called one.
 */
export function RoutePreview({
  proposal, technicianName, customerOf, canApply, onApply, onClose,
}: {
  proposal: Proposal;
  technicianName: string;
  customerOf: Map<string, string>;
  canApply: boolean;
  onApply: () => void;
  onClose: () => void;
}) {
  const saved = proposal.current.driveMinutes - proposal.proposed.driveMinutes;
  const name = (id: string) => customerOf.get(id) ?? "A visit";
  return (
    <section
      role="dialog"
      aria-label={`Proposed order for ${technicianName}`}
      className="border-b border-steel-200 bg-canvas px-4 py-3 text-sm lg:px-6"
    >
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <h2 className="font-semibold">Proposed order for {technicianName}</h2>
        <p className="tabular-nums text-ink-700">
          About {proposal.current.driveMinutes} min driving now,
          {" "}about {proposal.proposed.driveMinutes} min in this order
          {saved > 0 ? `: ${saved} min less.` : "."}
        </p>
      </div>
      {!proposal.improved && (
        <p className="mt-1 text-ink-700">The current order is already the best this can find.</p>
      )}
      {!proposal.startKnown && (
        <p className="mt-1 text-amber-700">
          Where {technicianName}&apos;s day starts is not on the map, so the drive to the first stop and home
          is left out.
        </p>
      )}
      {proposal.missed.length > 0 && (
        <ul aria-label="Windows that cannot be kept" className="mt-2 space-y-1">
          {proposal.missed.map((m) => (
            <li key={m.visitId} className="rounded bg-red-tint px-2 py-1 text-red-600">
              {m.customerName}: about {m.lateByMinutes} min after the window closes.
              {m.unreachable ? " No order could make it: the window closes before anybody could get there." : ""}
            </li>
          ))}
        </ul>
      )}
      <ol className="mt-2 flex flex-wrap gap-2" aria-label="The order">
        {proposal.applyOrder.map((id, i) => (
          <li key={id} className="rounded border border-steel-200 px-2 py-0.5">
            {i + 1}. {name(id)}
            {proposal.locked.includes(id) ? " (under way, not moved)" : ""}
            {proposal.unplaced.includes(id) ? " (not on the map, kept last)" : ""}
          </li>
        ))}
      </ol>
      <p className="mt-2 text-xs text-ink-500">
        {proposal.driveSource === "road" ? proposal.driveNote : (
          <>
            {proposal.driveSource === "mixed" ? `${proposal.driveNote} ` : ""}
            Estimates use the straight line at {proposal.travel.averageKmh} km/h with a road factor of{" "}
            {proposal.travel.roadFactor}
          </>
        )}
        {proposal.declaredLegs > 0 ? `, and the route's own drive time for ${proposal.declaredLegs} legs` : ""}.
        {proposal.pinned.length > 0 ? ` ${proposal.pinned.length} locked ${proposal.pinned.length === 1 ? "visit keeps its" : "visits keep their"} place.` : ""}
      </p>
      <div className="mt-3 flex gap-2">
        {canApply && proposal.improved && (
          <button type="button" onClick={onApply} className="h-9 rounded bg-ink-900 px-3 font-medium text-white">
            Use this order
          </button>
        )}
        <button type="button" onClick={onClose} className="h-9 rounded border border-steel-300 px-3 font-medium">
          {proposal.improved ? "Keep the current order" : "Close"}
        </button>
      </div>
    </section>
  );
}

/**
 * WHO SHOULD TAKE THE UNASSIGNED WORK, SUGGESTED
 *
 * Each with the technician it fits, the driving it adds, any window it would
 * break, and, behind a fold, everybody else considered with their figure or
 * the reason they were ruled out. Accepting one is the ordinary assignment.
 */
export function Suggestions({
  suggested, customerOf, onAccept, onClose,
}: {
  suggested: Suggested;
  customerOf: Map<string, string>;
  onAccept: (visitId: string, technicianId: string) => void;
  onClose: () => void;
}) {
  return (
    <section aria-label="Suggestions" className="mb-3 rounded border border-steel-300 bg-canvas p-2 text-sm">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-medium uppercase tracking-[0.08em] text-ink-500">Suggested</h3>
        <button type="button" onClick={onClose} className="text-xs underline">Close</button>
      </div>
      {suggested.suggestions.length === 0 && (
        <p className="mt-1 text-xs text-ink-500">Nothing on the map to suggest for.</p>
      )}
      <ul className="mt-1 space-y-2">
        {suggested.suggestions.map((s) => (
          <li key={s.visitId} className="border-t border-steel-200 pt-2 first:border-0 first:pt-0">
            <p className="font-medium">{s.customerName}</p>
            {s.technicianId ? (
              <>
                <p className="text-xs text-ink-700">
                  {s.technicianName}, stop {s.position}, adds about {s.addedDriveMinutes} min driving.
                </p>
                {s.wouldBeLate.length > 0 && (
                  <p className="text-xs text-red-600">
                    Nobody can keep every window: this makes {s.wouldBeLate.length} late.
                  </p>
                )}
                {s.unknownSkills.length > 0 && (
                  <p className="text-xs text-ink-500">Not checked: nothing records who does {s.unknownSkills.join(" or ")}.</p>
                )}
                <button
                  type="button"
                  onClick={() => onAccept(s.visitId, s.technicianId!)}
                  className="mt-1 rounded bg-ink-900 px-2 py-0.5 text-xs font-medium text-white"
                >
                  Assign to {s.technicianName}
                </button>
              </>
            ) : (
              <p className="text-xs text-red-600">Nobody here can take it.</p>
            )}
            <details className="mt-1 text-xs text-ink-700">
              <summary className="cursor-pointer">Everybody considered</summary>
              <ul className="mt-1 space-y-0.5">
                {s.considered.map((c) => (
                  <li key={c.technicianId}>
                    {c.technicianName}: {c.refused ?? `adds about ${c.addedDriveMinutes} min${c.makesLate ? ", and makes something late" : ""}`}
                  </li>
                ))}
              </ul>
            </details>
          </li>
        ))}
      </ul>
      {suggested.unplaced.length > 0 && (
        <p className="mt-2 text-xs text-amber-700">
          {suggested.unplaced.length} unassigned {suggested.unplaced.length === 1 ? "visit is" : "visits are"} not on
          the map, so nothing can be suggested for {suggested.unplaced.length === 1 ? "it" : "them"}:{" "}
          {suggested.unplaced.map((id) => customerOf.get(id) ?? "a visit").join(", ")}.
        </p>
      )}
    </section>
  );
}
