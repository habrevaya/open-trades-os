"use client";

import { useState, useTransition } from "react";
import { assignVisit, reorderDay } from "./actions";
import type { dispatch } from "@opentradesos/api/services";

type BoardData = Awaited<ReturnType<typeof dispatch.board>>;
type Column = BoardData["technicians"][number];
type Card = Column["visits"][number];
type Unassigned = BoardData["unassigned"][number];

const time = (iso: string | null) =>
  iso
    ? new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" })
    : null;

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
  board, date, canDispatch, canReorder,
}: {
  board: BoardData;
  date: string;
  canDispatch: boolean;
  canReorder: boolean;
}) {
  const [dragging, setDragging] = useState<{ id: string; from: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function drop(technicianId: string, beforeVisitId?: string) {
    if (!dragging) return;
    const { id, from } = dragging;
    setDragging(null);
    setError(null);

    start(async () => {
      if (from !== technicianId) {
        const result = await assignVisit({ visitId: id, technicianId, date });
        if (!result.ok) { setError(result.message); return; }
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
  const isPast = date < new Date().toISOString().slice(0, 10);

  return (
    <div className="flex h-[calc(100vh-3.5rem)] flex-col">
      <header className="flex flex-wrap items-center gap-3 border-b border-steel-200 px-4 py-3 lg:px-6">
        <div className="flex items-center gap-1">
          <a href={`/schedule?date=${shiftDate(date, -1)}`} aria-label="Previous day"
             className="flex h-9 w-9 items-center justify-center rounded border border-steel-300 text-lg leading-none">
            ‹
          </a>
          <a href={`/schedule?date=${shiftDate(date, 1)}`} aria-label="Next day"
             className="flex h-9 w-9 items-center justify-center rounded border border-steel-300 text-lg leading-none">
            ›
          </a>
        </div>

        <h1 className="text-base font-semibold">
          {new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
            weekday: "long", month: "long", day: "numeric",
          })}
        </h1>

        <a href={`/schedule?date=${new Date().toISOString().slice(0, 10)}`}
           className="rounded border border-steel-300 px-2.5 py-1 text-sm">
          Today
        </a>

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
        </div>
      </header>

      {error && (
        <div className="border-b border-red-600 bg-red-tint px-4 py-2 text-sm text-red-600 lg:px-6">
          {error}
        </div>
      )}

      <div className="flex flex-1 overflow-hidden">
        {/*
          The unassigned pile is a column, pinned left, not a modal or a
          drawer. It is the thing a dispatcher is trying to empty, and a pile
          you have to open to see is a pile that stays full.
        */}
        <aside className="w-72 shrink-0 overflow-y-auto border-r border-steel-200 bg-steel-100 p-3">
          <h2 className="px-1 pb-2 text-xs font-medium uppercase tracking-[0.08em] text-ink-500">
            Unassigned
          </h2>
          {board.unassigned.length === 0 ? (
            <p className="px-1 text-sm text-ink-500">Nothing waiting.</p>
          ) : (
            <ul className="space-y-2">
              {board.unassigned.map((v) => (
                <li key={v.id}>
                  <UnassignedCard visit={v} draggable={canDispatch} onDragStart={() =>
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
            />
          ))}
          {board.technicians.length === 0 && (
            <p className="p-6 text-ink-500">
              No technicians yet. Add one in Settings and they will get a column here.
            </p>
          )}
        </div>
      </div>
    </div>
  );
}

function TechnicianColumn({
  technician, canDispatch, dragging, onDragStart, onDrop,
}: {
  technician: Column;
  canDispatch: boolean;
  dragging: boolean;
  onDragStart: (visitId: string) => void;
  onDrop: (beforeVisitId?: string) => void;
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
              <VisitCard visit={v} draggable={canDispatch} onDragStart={() => onDragStart(v.id)} />
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

function VisitCard({
  visit, draggable, onDragStart,
}: {
  visit: Card;
  draggable: boolean;
  onDragStart: () => void;
}) {
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
      </div>
    </article>
  );
}

function UnassignedCard({
  visit, draggable, onDragStart,
}: {
  visit: Unassigned;
  draggable: boolean;
  onDragStart: () => void;
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
