"use client";

import { useState, useTransition } from "react";
import { assignVisit, reorderDay, proposeRoute, suggestAssignments, lockVisit, livePositions } from "./actions";
import type { dispatch } from "@opentradesos/api/services";
import type { TileSource } from "@/lib/map-tiles";
import { DispatchMap, type MapData } from "./DispatchMap";
import { RoutePreview, Suggestions, type Proposal, type Suggested } from "./Proposals";

type BoardData = Awaited<ReturnType<typeof dispatch.board>>;
type Column = BoardData["technicians"][number];
type Card = Column["visits"][number];
type Unassigned = BoardData["unassigned"][number];
type CrewLane = BoardData["crews"][number];

export type BoardView = "board" | "map" | "split";

/**
 * Formatted in the COMPANY's timezone, passed in, not the viewer's.
 *
 * Two reasons, and the second one is a bug that was live.
 *
 * A window is a promise made to a customer standing in a particular house. A
 * dispatcher covering from another state, or an owner checking the board from
 * a hotel, has to see the time that customer was given, not the same instant
 * translated into where they happen to be sitting.
 *
 * And this is a client component that also renders on the server. With no
 * explicit zone, the server formatted in the server's and the browser
 * reformatted in the browser's, so any deployment where those differ threw a
 * hydration mismatch and silently rewrote every time on the board after the
 * page had already been read.
 */
type TimeFormatter = (iso: string | null) => string | null;

const timeIn = (zone: string): TimeFormatter => (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit", timeZone: zone,
      })
    : null;

/** The map's live pins, read again through the server action, or nothing when it refuses. */
const readLive = async () => {
  const result = await livePositions();
  return result.ok ? result.live : null;
};

const shiftDate = (date: string, days: number) =>
  new Date(new Date(`${date}T12:00:00Z`).getTime() + days * 864e5).toISOString().slice(0, 10);

/**
 * A day, across everybody.
 *
 * Columns rather than a calendar grid. The vertical axis is ORDER, not time:
 * a technician's day is a sequence of stops and the gap between two of them is
 * drive time, not an hour of availability. Rendering it against a clock makes
 * a full day look half empty, which is how a dispatcher over-books somebody.
 */
export function Board({
  board, date, today, canDispatch, canReorder, timezone, view, map, tiles,
}: {
  board: BoardData;
  date: string;
  /** The list, the map, or both side by side. The map is read only when it is shown. */
  view: BoardView;
  map: MapData | null;
  tiles: TileSource;
  /**
   * The company's today, resolved on the server.
   *
   * Computed here it would be the BROWSER's today, which differs from the
   * company's for any dispatcher in another timezone and differs from the
   * server's render during hydration. Both of those show up as the Today
   * button pointing at the wrong day.
   */
  today: string;
  canDispatch: boolean;
  canReorder: boolean;
  timezone: string;
}) {
  const time = timeIn(timezone);
  const [dragging, setDragging] = useState<{ id: string; from: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * A qualification refusal the person at the board may override. Held
   * rather than shown as a plain error, so "Send anyway" can carry the visit
   * and the technician it was refused for.
   */
  const [refused, setRefused] = useState<{ visitId: string; technicianId: string; message: string } | null>(null);
  const [reason, setReason] = useState("");
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [suggested, setSuggested] = useState<Suggested | null>(null);
  const [pending, start] = useTransition();

  const nameOf = new Map(board.technicians.map((t) => [t.id, t.displayName]));
  const customerOf = new Map([
    ...board.technicians.flatMap((t) => t.visits.map((v) => [v.id, v.customerName] as const)),
    ...board.unassigned.map((v) => [v.id, v.customerName] as const),
  ]);

  /**
   * Every way of putting somebody on a visit goes through here: a drop, the
   * map's card, an accepted suggestion and an override. One path, so a
   * refusal reads the same and the override is offered the same wherever
   * the attempt came from.
   */
  async function assign(visitId: string, technicianId: string, overrideReason?: string): Promise<boolean> {
    const result = await assignVisit({ visitId, technicianId, date, ...(overrideReason ? { overrideReason } : {}) });
    if (!result.ok) {
      if (result.qualification?.mayOverride) setRefused({ visitId, technicianId, message: result.message });
      else setError(result.message);
      return false;
    }
    if (result.unknownSkills.length > 0) {
      setNotice(
        `Assigned. Nothing records who does ${result.unknownSkills.join(" or ")}, so that was not checked.`,
      );
    }
    return true;
  }

  function clearMessages() {
    setError(null);
    setNotice(null);
    setRefused(null);
  }

  function drop(technicianId: string, beforeVisitId?: string) {
    if (!dragging) return;
    const { id, from } = dragging;
    setDragging(null);
    clearMessages();

    start(async () => {
      if (from !== technicianId) {
        if (!await assign(id, technicianId)) return;
      }

      if (!canReorder) return;
      const column = board.technicians.find((t) => t.id === technicianId);
      if (!column) return;

      const without = column.visits.filter((v) => v.id !== id).map((v) => v.id);
      const at = beforeVisitId ? without.indexOf(beforeVisitId) : without.length;
      const ordered = [...without.slice(0, at), id, ...without.slice(at)];

      const result = await reorderDay({ technicianId, date, visitIds: ordered });
      if (!result.ok) setError(result.message);
    });
  }

  const lateCount = board.technicians.reduce(
    (n, t) => n + t.visits.filter((v) => v.isLate).length, 0,
  );

  /**
   * A dispatcher looks back at yesterday to see what got missed, and "running
   * late" is the wrong word for a day that is over: nothing is running. The
   * server's `isLate` is accurate either way, so this is only the wording.
   */
  const isPast = date < today;

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-steel-200 px-4 py-3 lg:px-6">
        <div className="flex items-center gap-1">
          <a href={`/schedule?date=${shiftDate(date, -1)}${view === "board" ? "" : `&view=${view}`}`} aria-label="Previous day"
             className="flex h-9 w-9 items-center justify-center rounded border border-steel-300 text-lg leading-none">
            ‹
          </a>
          <a href={`/schedule?date=${shiftDate(date, 1)}${view === "board" ? "" : `&view=${view}`}`} aria-label="Next day"
             className="flex h-9 w-9 items-center justify-center rounded border border-steel-300 text-lg leading-none">
            ›
          </a>
        </div>

        <h1 className="text-base font-semibold">
          {/*
            Noon UTC, so the date cannot slip a day in either direction, then
            formatted in UTC for the same reason the times are pinned above.
          */}
          {new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
            weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
          })}
        </h1>

        <a href={`/schedule?date=${today}${view === "board" ? "" : `&view=${view}`}`}
           className="rounded border border-steel-300 px-2.5 py-1 text-sm">
          Today
        </a>

        {/*
          The list, the map, or both. Links rather than a client toggle, so the
          map's data is only read when somebody asks to see it, and a reload
          keeps the view they were in.
        */}
        <nav aria-label="Board or map" className="flex overflow-hidden rounded border border-steel-300 text-sm">
          {([["board", "Board"], ["map", "Map"], ["split", "Both"]] as const).map(([key, label]) => (
            <a
              key={key}
              href={`/schedule?date=${date}${key === "board" ? "" : `&view=${key}`}`}
              aria-current={view === key ? "page" : undefined}
              className={`px-2.5 py-1 ${view === key ? "bg-ink-900 text-white" : "hover:bg-steel-100"}`}
            >
              {label}
            </a>
          ))}
        </nav>

        <div className="ml-auto flex items-center gap-3 text-sm">
          {/* The two numbers a dispatcher is actually watching. */}
          {lateCount > 0 && (
            <span className="rounded bg-red-tint px-2 py-1 font-medium text-red-600">
              {lateCount} {isPast ? "never finished" : "running late"}
            </span>
          )}
          {board.unassigned.length > 0 && (
            <span className="rounded bg-amber-tint px-2 py-1 font-medium text-amber-700">
              {board.unassigned.length} unassigned
            </span>
          )}
          {pending && <span className="text-ink-500">Saving…</span>}
          {canDispatch && canReorder && (
            <>
              <a href={`/schedule/rebalance?date=${date}`}
                 className="rounded border border-steel-300 px-2.5 py-1 font-medium hover:bg-steel-100">
                Rebalance the day
              </a>
              <a href={`/schedule/rebalance/days?from=${date}`}
                 className="rounded border border-steel-300 px-2.5 py-1 font-medium hover:bg-steel-100">
                Rebalance several days
              </a>
            </>
          )}
        </div>
      </header>

      <DayStrip board={board} time={time} timezone={timezone} />

      {error && (
        <div role="alert" className="border-b border-red-600 bg-red-tint px-4 py-2 text-sm text-red-600 lg:px-6">
          {error}
        </div>
      )}
      {notice && (
        <div role="status" className="border-b border-amber-700 bg-amber-tint px-4 py-2 text-sm text-amber-700 lg:px-6">
          {notice}
        </div>
      )}
      {refused && (
        /*
          The refusal, and the override beside it for somebody who holds the
          permission. A reason is required because the audit log keeps it next
          to what was refused, and "sent anyway" with no why is not a record.
        */
        <form
          aria-label="Not qualified"
          className="flex flex-wrap items-end gap-3 border-b border-red-600 bg-red-tint px-4 py-2 text-sm lg:px-6"
          onSubmit={(e) => {
            e.preventDefault();
            const { visitId, technicianId } = refused;
            start(async () => {
              if (await assign(visitId, technicianId, reason.trim())) {
                setRefused(null);
                setReason("");
              }
            });
          }}
        >
          <p role="alert" className="w-full text-red-600">{refused.message}</p>
          <label className="flex-1">
            <span className="block text-xs font-medium text-ink-700">Why they are going anyway</span>
            <input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              minLength={5}
              required
              className="mt-1 h-9 w-full rounded border border-steel-300 bg-canvas px-2"
            />
          </label>
          <button type="submit" className="h-9 rounded border border-red-600 px-3 font-medium text-red-600">
            Send anyway
          </button>
          <button type="button" onClick={() => setRefused(null)} className="h-9 px-2 text-ink-700 underline">
            Leave it
          </button>
        </form>
      )}

      {proposal && (
        <RoutePreview
          proposal={proposal}
          technicianName={nameOf.get(proposal.technicianId) ?? "This technician"}
          customerOf={customerOf}
          canApply={canReorder}
          onClose={() => setProposal(null)}
          onApply={() => {
            const { technicianId, applyOrder } = proposal;
            clearMessages();
            start(async () => {
              const result = await reorderDay({ technicianId, date, visitIds: applyOrder });
              if (!result.ok) setError(result.message);
              else setProposal(null);
            });
          }}
        />
      )}

      {view === "map" && map ? (
        <DispatchMap
          map={map} tiles={tiles} canDispatch={canDispatch} time={time} className="flex-1" readLive={readLive}
          onAssign={(visitId, technicianId) => {
            clearMessages();
            start(async () => { await assign(visitId, technicianId); });
          }}
        />
      ) : (
      <div className="flex flex-1 overflow-hidden">
        {view === "split" && map && (
          <DispatchMap
            map={map} tiles={tiles} canDispatch={canDispatch} time={time} stacked readLive={readLive}
            className="w-1/2 shrink-0 border-r border-steel-200"
            onAssign={(visitId, technicianId) => {
              clearMessages();
              start(async () => { await assign(visitId, technicianId); });
            }}
          />
        )}
        {/*
          The unassigned pile is a column, pinned left, not a modal or a
          drawer. It is the thing a dispatcher is trying to empty, and a pile
          you have to open to see is a pile that stays full.
        */}
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-steel-200 bg-steel-100 p-3">
          <div className="flex items-center justify-between px-1 pb-2">
            <h2 className="text-xs font-medium uppercase tracking-[0.08em] text-ink-500">
              Unassigned
            </h2>
            {canDispatch && board.unassigned.length > 0 && (
              <button
                type="button"
                className="rounded border border-steel-300 bg-canvas px-2 py-0.5 text-xs font-medium hover:bg-steel-100"
                onClick={() => {
                  clearMessages();
                  start(async () => {
                    const result = await suggestAssignments({ date });
                    if (result.ok) setSuggested(result.result);
                    else setError(result.message);
                  });
                }}
              >
                Suggest who
              </button>
            )}
          </div>
          {suggested && (
            <Suggestions
              suggested={suggested}
              customerOf={customerOf}
              onClose={() => setSuggested(null)}
              onAccept={(visitId, technicianId) => {
                clearMessages();
                start(async () => {
                  if (await assign(visitId, technicianId)) {
                    setSuggested((current) => current && {
                      ...current,
                      suggestions: current.suggestions.filter((x) => x.visitId !== visitId),
                    });
                  }
                });
              }}
            />
          )}
          {board.unassigned.length === 0 ? (
            <p className="px-1 text-sm text-ink-500">Nothing waiting.</p>
          ) : (
            <ul className="space-y-2">
              {board.unassigned.map((v) => (
                <li key={v.id}>
                  <UnassignedCard visit={v} draggable={canDispatch} time={time} onDragStart={() =>
                    setDragging({ id: v.id, from: null })} />
                </li>
              ))}
            </ul>
          )}
        </aside>

        <div className="flex flex-1 gap-3 overflow-x-auto p-3">
          {board.technicians.map((t) => (
            <TechnicianColumn
              key={t.id}
              technician={t}
              canDispatch={canDispatch}
              dragging={dragging !== null}
              onDragStart={(id) => setDragging({ id, from: t.id })}
              onDrop={(beforeVisitId) => drop(t.id, beforeVisitId)}
              time={time}
              onOptimise={canReorder ? () => {
                clearMessages();
                start(async () => {
                  const result = await proposeRoute({ technicianId: t.id, date });
                  if (result.ok) setProposal(result.proposal);
                  else setError(result.message);
                });
              } : null}
            />
          ))}
          {board.crews.map((c) => (
            <CrewColumn key={c.id} crew={c} time={time} draggable={canDispatch}
                        onDragStart={(id) => setDragging({ id, from: `crew:${c.id}` })} />
          ))}
          {board.technicians.length === 0 && (
            <p className="p-6 text-ink-500">
              No technicians yet. Add one in Settings and they will get a column here.
            </p>
          )}
        </div>
      </div>
      )}
    </div>
  );
}

function TechnicianColumn({
  technician, canDispatch, dragging, onDragStart, onDrop, time, onOptimise,
}: {
  technician: Column;
  canDispatch: boolean;
  dragging: boolean;
  onDragStart: (visitId: string) => void;
  onDrop: (beforeVisitId?: string) => void;
  time: TimeFormatter;
  /** Null when this person may not reorder a day, so the button is not offered. */
  onOptimise: (() => void) | null;
}) {
  const [over, setOver] = useState(false);
  const minutes = technician.visits.reduce((n, v) => n + v.estimatedDurationMinutes, 0);

  return (
    <section
      className={`flex w-72 shrink-0 flex-col rounded-md border bg-canvas ${
        over ? "border-ink-900 ring-1 ring-ink-900" : "border-steel-200"
      }`}
      onDragOver={(e) => { if (canDispatch && dragging) { e.preventDefault(); setOver(true); } }}
      onDragLeave={() => setOver(false)}
      onDrop={() => { setOver(false); onDrop(); }}
    >
      <header className="flex items-center gap-2 border-b border-steel-200 px-3 py-2.5">
        <span
          className="h-2.5 w-2.5 shrink-0 rounded-full"
          style={{ background: technician.color ?? "#64748B" }}
          aria-hidden
        />
        <h2 className="truncate text-sm font-medium">{technician.displayName}</h2>
        <span className="ml-auto text-xs tabular-nums text-ink-500">
          {/*
            Hours committed, not hours available. A column that shows capacity
            remaining invites filling it, and the number nobody can compute
            from a board is drive time between these addresses.
          */}
          {technician.timeOff ? "Off" : `${Math.round(minutes / 6) / 10}h`}
        </span>
      </header>
      {onOptimise && technician.visits.length >= 2 && (
        <button
          type="button"
          onClick={onOptimise}
          aria-label={`Optimise route for ${technician.displayName}`}
          className="mx-2 mt-2 rounded border border-steel-300 px-2 py-1 text-xs font-medium hover:bg-steel-100"
        >
          Optimise route
        </button>
      )}

      {/*
        Off AND assigned is shown as both, never as one.
        
        An earlier version returned the time off notice INSTEAD of the visits,
        which hid the only situation on this board that definitely needs a
        person: somebody is off and has work on their day. The banner is a
        warning, not a replacement for the column.
      */}
      {technician.timeOff && (
        <p className={`px-3 py-2 text-sm ${
          technician.visits.length > 0
            ? "bg-red-tint text-red-600"
            : "text-ink-500"
        }`}>
          {technician.visits.length > 0
            ? `Off today, and still has ${technician.visits.length} ${
                technician.visits.length === 1 ? "job" : "jobs"
              }.`
            : "Off today."}
        </p>
      )}

      {technician.visits.length === 0 && !technician.timeOff ? (
        <p className="p-4 text-sm text-ink-500">Nothing scheduled.</p>
      ) : (
        <ol className="flex-1 space-y-2 overflow-y-auto p-2">
          {technician.visits.map((v) => (
            <li
              key={v.id}
              onDragOver={(e) => { if (canDispatch && dragging) e.preventDefault(); }}
              onDrop={(e) => { e.stopPropagation(); setOver(false); onDrop(v.id); }}
            >
              <VisitCard visit={v} draggable={canDispatch} time={time} onDragStart={() => onDragStart(v.id)} canLock={canDispatch} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

/**
 * WHAT ELSE IS ON THE DAY: who has the phone tonight, and the routes running.
 *
 * The rota said in words, including when nobody is on, because a blank where
 * a name should be reads as fine. The routes so a route business watching
 * the board sees its Tuesday pool route as a route, with how far through it
 * the day has got, rather than as forty unrelated cards.
 */
function DayStrip({ board, time, timezone }: { board: BoardData; time: TimeFormatter; timezone: string }) {
  const day = (iso: string) => new Date(iso).toLocaleDateString("en-US", { weekday: "short", timeZone: timezone });
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-steel-200 px-4 py-2 text-sm lg:px-6">
      <span aria-label="On call">
        {board.onCall.length === 0
          ? <span className="text-amber-700">Nobody is on call today.</span>
          : board.onCall.map((s, i) => (
            <span key={i} className="mr-3">
              On call: <span className="font-medium">{s.technicianName}</span>{" "}
              <span className="text-ink-500">{day(s.startsAt)} {time(s.startsAt)} to {day(s.endsAt)} {time(s.endsAt)}</span>
            </span>
          ))}
      </span>
      {board.routes.length > 0 && (
        <span aria-label="Routes today" className="flex flex-wrap gap-2">
          {board.routes.map((r) => (
            <span key={r.id} className="rounded border border-steel-300 px-2 py-0.5 text-xs">
              <span className="font-medium">{r.name}</span>{" "}
              {r.done} of {r.stops} done{r.runBy ? `, ${r.runBy}` : ""}
            </span>
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * A crew's day, beside the people's. A card can be dragged onto a person,
 * which hands the visit to them: it leaves the crew's lane, goes on their
 * day with their skills and time off checked like any drop, and the crew's
 * members are told it is no longer theirs. Sending work TO a crew is on the
 * crews screen, where the crew's equipment and lead are checked.
 */
function CrewColumn({ crew, time, draggable, onDragStart }: {
  crew: CrewLane; time: TimeFormatter; draggable: boolean; onDragStart: (visitId: string) => void;
}) {
  return (
    <section aria-label={`Crew ${crew.name}`} className="flex w-72 shrink-0 flex-col rounded-md border border-steel-200 bg-canvas">
      <header className="border-b border-steel-200 px-3 py-2.5">
        <div className="flex items-center gap-2">
          <span className="h-2.5 w-2.5 shrink-0 rounded-sm" style={{ background: crew.color ?? "#7C3AED" }} aria-hidden />
          <h2 className="truncate text-sm font-medium">{crew.name}</h2>
          <span className="ml-auto text-xs text-ink-500">Crew</span>
        </div>
        <p className="mt-0.5 truncate text-xs text-ink-500">
          {crew.leadName ? `Led by ${crew.leadName}` : "No lead named"}
          {crew.memberNames.length > 0 ? `, ${crew.memberNames.length} ${crew.memberNames.length === 1 ? "person" : "people"}` : ""}
        </p>
      </header>
      <ol className="flex-1 space-y-2 overflow-y-auto p-2">
        {crew.visits.map((v) => (
          <li key={v.id}>
            <VisitCard visit={v} draggable={draggable} time={time} onDragStart={() => onDragStart(v.id)} canLock={false} />
          </li>
        ))}
      </ol>
    </section>
  );
}

function VisitCard({
  visit, draggable, onDragStart, time, canLock,
}: {
  visit: Card;
  draggable: boolean;
  onDragStart: () => void;
  time: TimeFormatter;
  /** Whether this person may lock it to whoever has it. */
  canLock: boolean;
}) {
  const [locked, setLocked] = useState(visit.locked);
  const [saving, start] = useTransition();
  return (
    <article
      draggable={draggable}
      onDragStart={onDragStart}
      className={`rounded border p-2.5 text-sm ${
        visit.isLate ? "border-red-600 bg-red-tint" : "border-steel-200 bg-canvas"
      } ${draggable ? "cursor-grab active:cursor-grabbing" : ""}`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium">{visit.customerName}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-ink-500">
          #{visit.jobNumber}
        </span>
      </div>
      <p className="mt-0.5 truncate text-ink-700">{visit.summary}</p>
      <p className="mt-0.5 truncate text-xs text-ink-500">{visit.addressLine1}</p>
      {visit.routeName && <p className="mt-0.5 truncate text-xs font-medium text-ink-700">Route: {visit.routeName}</p>}
      <div className="mt-1.5 flex items-center gap-2 text-xs">
        {/*
          The arrival window, not a start time. A contractor promises "between
          one and four", and showing a single time is what produces the review.
        */}
        <span className="tabular-nums text-ink-500">
          {time(visit.windowStart) ?? "Any time"}
          {visit.windowEnd ? ` to ${time(visit.windowEnd)}` : ""}
        </span>
        {visit.isLate && (
          <span className="rounded bg-red-tint px-1.5 py-0.5 font-medium text-red-600">
            Late
          </span>
        )}
        <span className="ml-auto capitalize text-ink-500">
          {visit.status.replace(/_/g, " ")}
        </span>
        {/*
          Locked is "this stays with this person, in its place", which no
          window can say. The rebalance and the optimiser leave it alone.
        */}
        {canLock ? (
          <button
            type="button"
            disabled={saving}
            aria-pressed={locked}
            aria-label={`${locked ? "Unlock" : "Lock"} ${visit.customerName}'s visit`}
            title={locked ? "Locked: rebalancing leaves it here" : "Lock it to this person and place"}
            onClick={() => start(async () => {
              const result = await lockVisit({ visitId: visit.id, locked: !locked });
              if (result.ok) setLocked(!locked);
            })}
            className={`rounded border px-1.5 py-0.5 ${locked ? "border-ink-900 bg-ink-900 text-white" : "border-steel-300 text-ink-500"}`}
          >
            {locked ? "Locked" : "Lock"}
          </button>
        ) : locked ? <span className="rounded border border-ink-900 px-1.5 py-0.5">Locked</span> : null}
      </div>
    </article>
  );
}

function UnassignedCard({
  visit, draggable, onDragStart, time,
}: {
  visit: Unassigned;
  draggable: boolean;
  onDragStart: () => void;
  time: TimeFormatter;
}) {
  return (
    <article
      draggable={draggable}
      onDragStart={onDragStart}
      className={`rounded border border-steel-200 bg-canvas p-2.5 text-sm ${
        draggable ? "cursor-grab active:cursor-grabbing" : ""
      }`}
    >
      <div className="flex items-baseline justify-between gap-2">
        <span className="truncate font-medium">{visit.customerName}</span>
        <span className="shrink-0 font-mono text-xs tabular-nums text-ink-500">
          #{visit.jobNumber}
        </span>
      </div>
      <p className="mt-0.5 truncate text-ink-700">{visit.summary}</p>
      {/*
        Why this card is at the top of the pile. Their plan promised members
        are seen first, and a dispatcher who cannot see why the order is what
        it is will reorder it by habit.
      */}
      {visit.priorityPlan ? (
        <p className="mt-0.5 truncate text-xs font-medium text-ink-900">Member first: {visit.priorityPlan}</p>
      ) : null}
      <p className="mt-0.5 truncate text-xs text-ink-500">
        {visit.addressLine1}, {visit.postalCode}
      </p>
      <p className="mt-1.5 text-xs tabular-nums text-ink-500">
        {time(visit.windowStart) ?? "Any time"}
        {visit.windowEnd ? ` to ${time(visit.windowEnd)}` : ""}
      </p>
    </article>
  );
}

