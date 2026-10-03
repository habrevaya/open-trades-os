"use client";

import { useState } from "react";
import { requestVisitChange, type VisitChangeResult } from "./visit-change-actions";

/** What a page can hand in instead of a token: an action bound on the server that reads the sign in itself. */
export type SendVisitChange = (input: {
  visitId?: string | undefined;
  kind: "reschedule" | "cancel";
  requestedDate?: string | undefined;
  arrivalWindowId?: string | undefined;
  reason?: string | undefined;
}) => Promise<VisitChangeResult>;

interface Slot {
  date: string;
  arrivalWindowId: string;
  label: string;
  startsAt: string;
  endsAt: string;
}

const clock = (value: string) => {
  const [h = "0", m = "0"] = value.split(":");
  const hour = Number(h);
  const suffix = hour >= 12 ? "PM" : "AM";
  const twelve = hour % 12 === 0 ? 12 : hour % 12;
  return `${twelve}:${m.padStart(2, "0")} ${suffix}`;
};

const longDay = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", timeZone: "UTC",
  });

/**
 * Move it or call it off.
 *
 * The windows are the ones online booking would offer, already filtered by the
 * company's notice period, open days and per window limit, so anything that
 * can be chosen here is something the company has said it can serve. Nothing
 * is chosen for them, and nothing moves when they press the button: it asks.
 */
export function VisitChangeForm({
  token, send, visitId, slots, rescheduleBlockedBy, path, organizationName,
}: {
  /** The link's token, on a link page. */
  token?: string;
  /** On a signed in page, which has no token to hand the browser. */
  send?: SendVisitChange;
  visitId?: string;
  slots: Slot[];
  rescheduleBlockedBy: string | null;
  path: string;
  organizationName: string;
}) {
  const [kind, setKind] = useState<"reschedule" | "cancel" | null>(null);
  const [chosen, setChosen] = useState<string>("");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  const byDay = new Map<string, Slot[]>();
  for (const slot of slots) byDay.set(slot.date, [...(byDay.get(slot.date) ?? []), slot]);

  if (sent) {
    return (
      <p role="status" className="rounded-md border border-steel-200 bg-canvas p-4 text-sm text-ink-700">
        Sent. {organizationName} will look at it and reply to you. Your visit stays as it is until they do.
      </p>
    );
  }

  const submit = async () => {
    if (!kind) return;
    setBusy(true);
    setError(null);
    const [date, windowId] = chosen.split("|");
    const asked = {
      kind,
      ...(visitId ? { visitId } : {}),
      ...(kind === "reschedule" ? { requestedDate: date, arrivalWindowId: windowId } : {}),
      reason,
    };
    const result = send
      ? await send(asked)
      : await requestVisitChange({ ...asked, token: token ?? "", path });
    setBusy(false);
    if (result.ok) setSent(true);
    else setError(result.message);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-2" role="group" aria-label="What would you like to do">
        <button
          type="button"
          disabled={Boolean(rescheduleBlockedBy)}
          onClick={() => setKind("reschedule")}
          aria-pressed={kind === "reschedule"}
          className={`inline-flex h-10 items-center rounded px-4 text-sm font-medium disabled:opacity-50 ${
            kind === "reschedule" ? "bg-ink-900 text-white" : "border border-steel-300 bg-canvas"
          }`}
        >
          Move it to another time
        </button>
        <button
          type="button"
          onClick={() => setKind("cancel")}
          aria-pressed={kind === "cancel"}
          className={`inline-flex h-10 items-center rounded px-4 text-sm font-medium ${
            kind === "cancel" ? "bg-ink-900 text-white" : "border border-steel-300 bg-canvas"
          }`}
        >
          Cancel it
        </button>
      </div>

      {rescheduleBlockedBy ? <p className="text-sm text-ink-700">{rescheduleBlockedBy}</p> : null}

      {kind === "reschedule" && (
        <fieldset className="rounded-md border border-steel-200 bg-canvas p-4">
          <legend className="px-1 text-sm font-medium">Choose a time</legend>
          <div className="max-h-80 space-y-3 overflow-y-auto">
            {[...byDay.entries()].map(([date, windows]) => (
              <div key={date}>
                <p className="text-sm font-medium">{longDay(date)}</p>
                <div className="mt-1 flex flex-wrap gap-2">
                  {windows.map((w) => {
                    const value = `${w.date}|${w.arrivalWindowId}`;
                    return (
                      <label key={value} className="inline-flex items-center gap-2 rounded border border-steel-300 px-3 py-1.5 text-sm">
                        <input
                          type="radio" name="slot" value={value}
                          checked={chosen === value}
                          onChange={() => setChosen(value)}
                          aria-label={`${longDay(date)}, ${clock(w.startsAt)} to ${clock(w.endsAt)}`}
                        />
                        {clock(w.startsAt)} to {clock(w.endsAt)}
                      </label>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
      )}

      {kind && (
        <label className="block text-sm">
          <span className="font-medium">
            {kind === "cancel" ? "Why do you need to cancel?" : "Anything the office should know? (optional)"}
          </span>
          <textarea
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={1000}
            className="mt-1 w-full rounded border border-steel-300 bg-canvas p-2 text-sm"
          />
        </label>
      )}

      {error ? <p role="alert" className="text-sm text-red-600">{error}</p> : null}

      {kind && (
        <button
          type="button"
          onClick={submit}
          disabled={busy || (kind === "reschedule" && !chosen) || (kind === "cancel" && reason.trim() === "")}
          className="inline-flex h-11 w-full items-center justify-center rounded px-4 text-sm font-medium disabled:opacity-50"
          style={{ backgroundColor: "var(--brand, #111827)", color: "var(--brand-on, #ffffff)" }}
        >
          {busy ? "Sending" : kind === "cancel" ? "Ask to cancel" : "Ask to move it"}
        </button>
      )}
      <p className="text-xs text-ink-500">
        This asks {organizationName}. Nothing changes until they reply.
      </p>
    </div>
  );
}
