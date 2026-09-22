"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FieldQueue, WebStorage } from "@opentradesos/field-client";
import type { dispatch } from "@opentradesos/api/services";
import { sync, onMyWay } from "./actions";

type Snapshot = Awaited<ReturnType<typeof dispatch.snapshot>>;
type Visit = Snapshot["visits"][number];

/**
 * THE DAY
 *
 * Built for a phone held in one hand, often a gloved one, often in sunlight.
 * Controls are 48px, the type does not go below 16px, and the only colours
 * that carry meaning are also distinguishable by position and label, because
 * a technician's phone screen is frequently unreadable and they are working
 * from memory of where the button is.
 *
 * Every action goes into the local queue FIRST and is sent afterwards. The
 * screen updates from the queue, not from the server, so the difference
 * between one bar and none is a spinner in a corner rather than a button that
 * does nothing.
 */
export function Day({
  date, deviceId, lastSequence, visits, openTimeEntry, technicianName,
}: {
  date: string;
  deviceId: string;
  lastSequence: number;
  visits: Visit[];
  openTimeEntry: Snapshot["openTimeEntry"];
  technicianName: string;
}) {
  const queueRef = useRef<FieldQueue | null>(null);
  const [queued, setQueued] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [storageBroken, setStorageBroken] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  // Optimistic, keyed by visit. The server is the truth and the queue is what
  // the technician has done since it last agreed.
  const [localStatus, setLocalStatus] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!WebStorage.available()) {
      /**
       * Private browsing, or site data blocked. Everything still works while
       * there is a connection, and nothing survives losing one. Saying so is
       * the whole point: a technician who believes their taps are being kept
       * will stop checking.
       */
      setStorageBroken(true);
      return;
    }

    const queue = new FieldQueue({ storage: new WebStorage("otos:"), deviceId });
    queueRef.current = queue;
    void queue.adoptSequence(lastSequence).then(() => refresh(queue));
  }, [deviceId, lastSequence]);

  async function refresh(queue: FieldQueue) {
    const pending = await queue.pending();
    setQueued(pending.length);
    const problems = await queue.problems();
    setProblem(problems[0]?.conflict ?? problems[0]?.lastError ?? null);
  }

  async function record(kind: Parameters<FieldQueue["enqueue"]>[0]["kind"], visitId?: string, payload?: Record<string, unknown>) {
    const queue = queueRef.current;
    if (!queue) return;

    await queue.enqueue({
      kind,
      ...(visitId ? { subjectId: visitId } : {}),
      ...(payload ? { payload } : {}),
    });

    if (visitId) {
      const next =
        kind === "visit.en_route" ? "en_route"
        : kind === "visit.arrive" ? "en_route"
        : kind === "visit.start" ? "working"
        : kind === "visit.complete" ? "completed"
        : null;
      if (next) setLocalStatus((s) => ({ ...s, [visitId]: next }));
    }

    await refresh(queue);
    void flush();
  }

  async function flush() {
    const queue = queueRef.current;
    if (!queue || syncing) return;
    setSyncing(true);
    try {
      await queue.flush({
        async send(input) {
          const result = await sync({
            deviceId: input.deviceId,
            operations: input.operations as never,
          });
          // A server error is thrown so the queue keeps the operations. It
          // must not treat a failed request as a rejection.
          if (!result.ok) throw new Error(result.message);
          return { results: result.results as never, awaiting: [], snapshotRevision: 0 };
        },
      });
      await refresh(queue);
    } finally {
      setSyncing(false);
    }
  }

  // A background attempt every half minute, and one whenever the browser says
  // the connection is back. Neither is enough alone: the online event does not
  // fire for a connection that is technically up and carrying nothing.
  useEffect(() => {
    const timer = setInterval(() => void flush(), 30_000);
    const onOnline = () => void flush();
    window.addEventListener("online", onOnline);
    return () => { clearInterval(timer); window.removeEventListener("online", onOnline); };
  });

  const ordered = useMemo(
    () => [...visits].sort((a, b) => (a.routeOrder ?? 99) - (b.routeOrder ?? 99)),
    [visits],
  );

  const statusOf = (v: Visit) => localStatus[v.id] ?? v.status;
  const done = ordered.filter((v) => statusOf(v) === "completed").length;

  return (
    <div className="mx-auto max-w-lg pb-24">
      <header className="sticky top-14 z-30 border-b border-steel-200 bg-canvas px-4 py-3">
        <div className="flex items-baseline justify-between">
          <h1 className="text-lg font-semibold">
            {new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
              weekday: "long", month: "short", day: "numeric",
            })}
          </h1>
          <span className="text-sm tabular-nums text-ink-500">
            {done} of {ordered.length} done
          </span>
        </div>

        <div className="mt-1 flex items-center gap-2 text-sm">
          <span className="text-ink-500">{technicianName}</span>
          {queued > 0 && (
            <span className="rounded bg-amber-tint px-2 py-0.5 text-xs font-medium text-amber-700">
              {queued} waiting to send{syncing ? "…" : ""}
            </span>
          )}
          {queued === 0 && !syncing && (
            <span className="text-xs text-ink-500">All sent</span>
          )}
        </div>
      </header>

      {storageBroken && (
        <p className="border-b border-red-600 bg-red-tint px-4 py-3 text-sm text-red-600">
          This browser is not saving anything locally, so work recorded here is lost if
          you lose signal. Turn off private browsing, or use the app.
        </p>
      )}

      {problem && (
        <p className="border-b border-amber-700 bg-amber-tint px-4 py-3 text-sm text-amber-700">
          {problem}
        </p>
      )}

      <div className="px-4 py-4">
        <TimeClock openEntry={openTimeEntry} onPunch={(kind) => void record(kind)} />
      </div>

      {ordered.length === 0 ? (
        <p className="px-4 py-10 text-center text-ink-500">Nothing on today.</p>
      ) : (
        <ol className="space-y-3 px-4">
          {ordered.map((v, i) => (
            <li key={v.id}>
              <VisitCard
                visit={v}
                index={i + 1}
                status={statusOf(v)}
                expanded={open === v.id}
                onToggle={() => setOpen(open === v.id ? null : v.id)}
                onRecord={(kind, payload) => void record(kind, v.id, payload)}
              />
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function TimeClock({
  openEntry, onPunch,
}: {
  openEntry: Snapshot["openTimeEntry"];
  onPunch: (kind: "timeclock.punch_in" | "timeclock.punch_out") => void;
}) {
  const since = openEntry
    ? new Date(openEntry.startedAt).toLocaleTimeString("en-US", {
        hour: "numeric", minute: "2-digit",
      })
    : null;

  return (
    <div className="flex items-center gap-3 rounded-md border border-steel-200 p-3">
      <div className="flex-1">
        <p className="text-sm font-medium">
          {openEntry ? "On the clock" : "Not clocked in"}
        </p>
        {since && <p className="text-sm text-ink-500">Since {since}</p>}
      </div>
      <button
        type="button"
        onClick={() => onPunch(openEntry ? "timeclock.punch_out" : "timeclock.punch_in")}
        className={`h-12 rounded px-5 text-base font-medium ${
          openEntry
            ? "border border-steel-300 bg-canvas text-ink-900"
            : "bg-ink-900 text-white"
        }`}
      >
        {openEntry ? "Clock out" : "Clock in"}
      </button>
    </div>
  );
}

/**
 * The window as a technician reads it off a card at a glance.
 *
 * Rendered from the visit's own timestamps rather than from a preformatted
 * string, because the same payload feeds a phone that may be in a different
 * timezone from the office that scheduled it, and the technician wants the
 * time where they are standing.
 */
function arrivalWindow(start: string | null, end: string | null): string | null {
  if (!start) return null;
  const time = (iso: string) =>
    new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const from = time(start);
  return end ? `${from} to ${time(end)}` : from;
}

const NEXT_ACTION: Record<string, { kind: "visit.en_route" | "visit.arrive" | "visit.start" | "visit.complete"; label: string } | null> = {
  unassigned: { kind: "visit.en_route", label: "On my way" },
  scheduled: { kind: "visit.en_route", label: "On my way" },
  dispatched: { kind: "visit.en_route", label: "On my way" },
  en_route: { kind: "visit.start", label: "Start work" },
  working: { kind: "visit.complete", label: "Finish" },
  completed: null,
  cancelled: null,
  no_show: null,
  completed_after_cancellation: null,
};

function VisitCard({
  visit, index, status, expanded, onToggle, onRecord,
}: {
  visit: Visit;
  index: number;
  status: string;
  expanded: boolean;
  onToggle: () => void;
  onRecord: (
    kind: "visit.en_route" | "visit.arrive" | "visit.start" | "visit.complete" | "visit.note" | "visit.add_line",
    payload?: Record<string, unknown>,
  ) => void;
}) {
  const [note, setNote] = useState("");
  const [sendingEta, setSendingEta] = useState(false);
  const next = NEXT_ACTION[status] ?? null;
  const address = `${visit.property.addressLine1}, ${visit.property.city} ${visit.property.postalCode}`;
  const window = arrivalWindow(visit.windowStart, visit.windowEnd);

  return (
    <article className={`rounded-md border ${
      status === "completed" ? "border-steel-200 bg-steel-100" : "border-steel-300 bg-canvas"
    }`}>
      <button type="button" onClick={onToggle} className="flex w-full items-start gap-3 p-4 text-left">
        <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-ink-900 text-sm font-medium tabular-nums text-white">
          {index}
        </span>
        <span className="min-w-0 flex-1">
          <span className="block font-medium">{visit.customer.name}</span>
          <span className="block text-ink-700">{visit.summary}</span>
          <span className="block text-sm text-ink-500">{address}</span>
          {/*
            The window goes under the address rather than in the corner beside
            the status. "When am I due there" is the first question a
            technician asks of this list, so it has to be on the collapsed
            card. Putting it in the corner cost the summary enough width to
            wrap onto three lines at phone width, and the summary is the
            second question.
          */}
          {window && (
            <span className="mt-1 block text-sm font-medium tabular-nums text-ink-900">{window}</span>
          )}
        </span>
        <span className="shrink-0 text-right text-sm capitalize text-ink-500">
          {status.replace(/_/g, " ")}
        </span>
      </button>

      {expanded && (
        <div className="space-y-4 border-t border-steel-200 p-4">
          {/*
            Before anything else. A technician needs the gate code and the dog
            before they get out of the truck, not after, and these ship with
            the schedule rather than being fetched at the exact moment there
            is no signal.
          */}
          {(visit.property.gateCode || visit.property.accessNotes ||
            visit.property.hazardNotes || visit.property.hasDog) && (
            <div className="rounded border border-amber-700 bg-amber-tint p-3 text-sm">
              {visit.property.hasDog && <p className="font-medium text-amber-700">There is a dog.</p>}
              {visit.property.gateCode && (
                <p className="text-amber-700">
                  Gate code <span className="font-mono font-medium">{visit.property.gateCode}</span>
                </p>
              )}
              {visit.property.accessNotes && <p className="mt-1 text-amber-700">{visit.property.accessNotes}</p>}
              {visit.property.hazardNotes && (
                <p className="mt-1 font-medium text-amber-700">{visit.property.hazardNotes}</p>
              )}
            </div>
          )}

          {visit.customerComplaint && (
            <div>
              <p className="text-xs uppercase tracking-[0.08em] text-ink-500">What they said</p>
              <p className="mt-1 text-ink-700">{visit.customerComplaint}</p>
            </div>
          )}

          <div className="flex flex-wrap gap-2">
            {visit.customer.phone && (
              <a href={`tel:${visit.customer.phone}`}
                 className="flex h-12 flex-1 items-center justify-center rounded border border-steel-300 px-4 text-base font-medium">
                Call
              </a>
            )}
            <a href={`https://maps.google.com/?q=${encodeURIComponent(address)}`}
               className="flex h-12 flex-1 items-center justify-center rounded border border-steel-300 px-4 text-base font-medium">
              Directions
            </a>
          </div>

          {(status === "dispatched" || status === "scheduled") && (
            <button
              type="button"
              disabled={sendingEta}
              onClick={async () => {
                setSendingEta(true);
                await onMyWay({ visitId: visit.id, etaMinutes: 20 });
                setSendingEta(false);
              }}
              className="h-12 w-full rounded border border-steel-300 text-base font-medium"
            >
              {sendingEta ? "Sending…" : "Text the customer I am on my way"}
            </button>
          )}

          <div>
            <label className="block">
              <span className="text-sm font-medium">Note</span>
              <textarea
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={2}
                className="mt-1 w-full rounded border border-steel-300 p-3 text-base"
                placeholder="What you found"
              />
            </label>
            {note.trim() && (
              <button
                type="button"
                onClick={() => { onRecord("visit.note", { text: note.trim() }); setNote(""); }}
                className="mt-2 h-12 w-full rounded border border-steel-300 text-base font-medium"
              >
                Save note
              </button>
            )}
          </div>

          {next && (
            <button
              type="button"
              onClick={() => onRecord(next.kind)}
              className="h-14 w-full rounded bg-ink-900 text-lg font-medium text-white"
            >
              {next.label}
            </button>
          )}
        </div>
      )}
    </article>
  );
}
