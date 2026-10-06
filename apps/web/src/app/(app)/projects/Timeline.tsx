"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { dragPhase } from "./document-actions";

export interface TimelinePhase {
  id: string;
  sequence: number;
  name: string;
  status: string;
  dependsOnPhaseId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  floatDays: number | null;
  critical: boolean;
  overlapsPredecessor: boolean;
  people: string;
  /** Who is booked twice on this phase and another that runs at once. */
  clashNames: string[];
}

export interface TimelineClash {
  /** Stable per person and pair of phases. */
  key: string;
  name: string;
  phaseIds: [string, string];
  from: string;
  to: string;
  statement: string;
}

const DAY = 86_400_000;
const dayOf = (date: string) => Math.round(Date.parse(`${date}T00:00:00Z`) / DAY);
const dateOf = (day: number) => new Date(day * DAY).toISOString().slice(0, 10);
const ROW = 44;
const LABEL = 208;

/**
 * THE PHASES ON A TIMELINE, AND DRAGGING ONE.
 *
 * A bar per phase from its start to its end, the critical ones in red with
 * the words "Critical" on them so the colour is never the only signal, an
 * elbow from each phase to the one it waits for, and today as a line.
 *
 * DRAGGING ASKS THE SERVER, it does not decide. The bar follows the pointer
 * in whole days, and on release the new start goes to the same move the API
 * makes; the server moves everything waiting for it, or refuses in words
 * (too early for the phase it waits for, already complete) and the bar goes
 * back with the sentence under the chart. The keyboard does the same with
 * the arrow keys on a focused bar, a day at a time, because a schedule only
 * a mouse can change is one some people cannot change.
 *
 * A PERSON BOOKED ON TWO PHASES AT ONCE is marked, not moved: an amber strip
 * under both bars across the days they overlap, the words "Booked twice" and
 * the name on each bar, and the sentence (who, which phases, which days) in a
 * list under the chart. Colour is never the only signal.
 */
export function Timeline({ projectId, phases, today, editable, clashes = [] }: {
  projectId: string; phases: TimelinePhase[]; today: string; editable: boolean; clashes?: TimelineClash[];
}) {
  const router = useRouter();
  const [drag, setDrag] = useState<{ id: string; startX: number; shift: number } | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const track = useRef<HTMLDivElement>(null);

  const dated = phases.filter((p) => p.startsOn && p.endsOn);
  if (dated.length === 0) {
    return <p className="mt-4 text-sm text-ink-500">No phase has a start and an end yet. Give them dates below and they appear here.</p>;
  }
  const first = Math.min(...dated.map((p) => dayOf(p.startsOn!))) - 2;
  const last = Math.max(...dated.map((p) => dayOf(p.endsOn!))) + 3;
  const span = last - first;
  const pct = (day: number) => ((day - first) / span) * 100;
  const rowOf = new Map(phases.map((p, i) => [p.id, i]));

  async function commit(id: string, shift: number) {
    const phase = phases.find((p) => p.id === id);
    if (!phase?.startsOn || shift === 0) return;
    setPending(id);
    setMessage(null);
    const result = await dragPhase(projectId, id, dateOf(dayOf(phase.startsOn) + shift));
    setPending(null);
    if (!result.ok) setMessage(result.message);
    router.refresh();
  }

  function onPointerDown(event: React.PointerEvent<HTMLDivElement>, id: string) {
    if (!editable || pending) return;
    (event.target as HTMLElement).setPointerCapture(event.pointerId);
    setDrag({ id, startX: event.clientX, shift: 0 });
  }
  function onPointerMove(event: React.PointerEvent<HTMLDivElement>) {
    if (!drag || !track.current) return;
    const perDay = track.current.getBoundingClientRect().width / span;
    setDrag({ ...drag, shift: Math.round((event.clientX - drag.startX) / perDay) });
  }
  function onPointerUp() {
    if (!drag) return;
    const { id, shift } = drag;
    setDrag(null);
    void commit(id, shift);
  }

  const months: { label: string; at: number }[] = [];
  for (let day = first; day <= last; day += 1) {
    const date = dateOf(day);
    if (date.endsWith("-01") || day === first) {
      months.push({ label: new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" }), at: pct(day) });
    }
  }
  const todayAt = dayOf(today) >= first && dayOf(today) <= last ? pct(dayOf(today)) : null;

  return (
    <div className="mt-4">
      <div className="overflow-x-auto rounded-md border border-steel-200 bg-canvas">
        <div className="relative min-w-[720px]" style={{ height: phases.length * ROW + 28 }}>
          <div className="absolute inset-y-0 left-0 border-r border-steel-200 bg-canvas" style={{ width: LABEL }} />
          <div ref={track} className="absolute inset-y-0 right-2" style={{ left: LABEL }}
               onPointerMove={onPointerMove} onPointerUp={onPointerUp} onPointerCancel={() => setDrag(null)}>
            {months.map((m) => (
              <span key={m.label + m.at} className="absolute top-1 text-xs text-ink-500" style={{ left: `${m.at}%` }}>{m.label}</span>
            ))}
            {todayAt !== null && (
              <div className="absolute bottom-0 top-6 border-l border-dashed border-blue-600" style={{ left: `${todayAt}%` }}
                   aria-label="Today" />
            )}
            <svg className="pointer-events-none absolute inset-0 h-full w-full overflow-visible text-ink-500" aria-hidden="true">
              {dated.map((phase) => {
                if (!phase.dependsOnPhaseId) return null;
                const before = phases.find((p) => p.id === phase.dependsOnPhaseId);
                if (!before?.endsOn) return null;
                const from = rowOf.get(before.id)!;
                const to = rowOf.get(phase.id)!;
                const x1 = pct(dayOf(before.endsOn) + 1);
                const x2 = pct(dayOf(phase.startsOn!));
                const y1 = 28 + from * ROW + ROW / 2;
                const y2 = 28 + to * ROW + ROW / 2;
                return (
                  <g key={`${before.id}-${phase.id}`} className={phase.overlapsPredecessor ? "text-red-600" : undefined}>
                    <line x1={`${x1}%`} y1={y1} x2={`${x1}%`} y2={y2} stroke="currentColor" strokeWidth={1} />
                    <line x1={`${x1}%`} y1={y2} x2={`${x2}%`} y2={y2} stroke="currentColor" strokeWidth={1} />
                  </g>
                );
              })}
            </svg>
            {phases.map((phase, row) => {
              if (!phase.startsOn || !phase.endsOn) return null;
              const shift = drag?.id === phase.id ? drag.shift : 0;
              const start = dayOf(phase.startsOn) + shift;
              const end = dayOf(phase.endsOn) + shift + 1;
              const tone = phase.status === "complete"
                ? "bg-green-tint text-green-700 border-green-700"
                : phase.critical ? "bg-red-tint text-red-600 border-red-600" : "bg-blue-100 text-blue-700 border-blue-600";
              return (
                <div
                  key={phase.id}
                  role="slider"
                  tabIndex={editable ? 0 : -1}
                  aria-label={`${phase.name}, ${phase.startsOn} to ${phase.endsOn}${phase.critical ? ", critical" : ""}${phase.clashNames.length > 0 ? `, ${phase.clashNames.join(" and ")} booked twice` : ""}`}
                  aria-valuetext={dateOf(start)}
                  aria-valuenow={start}
                  onPointerDown={(e) => onPointerDown(e, phase.id)}
                  onKeyDown={(e) => {
                    if (!editable) return;
                    if (e.key === "ArrowRight") { e.preventDefault(); void commit(phase.id, 1); }
                    if (e.key === "ArrowLeft") { e.preventDefault(); void commit(phase.id, -1); }
                  }}
                  className={`absolute flex h-7 select-none items-center overflow-hidden rounded border px-2 text-xs font-medium ${tone} ${editable ? "cursor-grab touch-none" : ""} ${pending === phase.id ? "opacity-60" : ""}`}
                  style={{ left: `${pct(start)}%`, width: `${Math.max(pct(end) - pct(start), 1.5)}%`, top: 28 + row * ROW + (ROW - 28) / 2 }}
                >
                  <span className="truncate">
                    {phase.critical ? "Critical: " : ""}
                    {phase.clashNames.length > 0 ? `Booked twice: ${phase.clashNames.join(", ")}` : shift !== 0 ? dateOf(start) : phase.people}
                  </span>
                </div>
              );
            })}
            {clashes.flatMap((clash) => clash.phaseIds.map((phaseId) => {
              const row = rowOf.get(phaseId);
              if (row === undefined) return null;
              return (
                <div
                  key={`${clash.key}-${phaseId}`}
                  data-clash={clash.name}
                  title={clash.statement}
                  className="pointer-events-none absolute h-1.5 rounded-sm bg-amber-700"
                  style={{
                    left: `${pct(dayOf(clash.from))}%`,
                    width: `${Math.max(pct(dayOf(clash.to) + 1) - pct(dayOf(clash.from)), 0.8)}%`,
                    top: 28 + row * ROW + ROW - 9,
                  }}
                />
              );
            }))}
          </div>
          {phases.map((phase, row) => (
            <div key={phase.id} className="absolute left-0 flex flex-col justify-center px-3 text-sm" style={{ top: 28 + row * ROW, height: ROW, width: LABEL }}>
              <span className="truncate font-medium">{phase.sequence}. {phase.name}</span>
              <span className="truncate text-xs text-ink-500">
                {phase.startsOn ? `${phase.startsOn} to ${phase.endsOn}` : "No dates"}
                {phase.floatDays !== null && !phase.critical && phase.status !== "complete" ? `, ${phase.floatDays} days to spare` : ""}
              </span>
            </div>
          ))}
        </div>
      </div>
      {clashes.length > 0 && (
        <div className="mt-3 rounded-md border border-amber-700 bg-amber-tint p-3 text-sm text-ink-900" aria-label="Booked twice">
          <p className="font-medium">Booked twice</p>
          <ul className="mt-1 list-disc space-y-1 pl-5">
            {clashes.map((clash) => <li key={clash.key}>{clash.statement}</li>)}
          </ul>
          <p className="mt-2 text-xs text-ink-700">Nobody has been moved. Change who is booked on the dispatch board.</p>
        </div>
      )}
      {message && <p role="alert" className="mt-2 text-sm text-red-600">{message}</p>}
      {editable && <p className="mt-2 text-xs text-ink-500">Drag a bar, or focus it and use the arrow keys, to move a phase. Everything waiting for it moves with it.</p>}
    </div>
  );
}
