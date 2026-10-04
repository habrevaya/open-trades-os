"use client";

import { useState, useTransition } from "react";
import type { AccountSlot } from "./actions";

const field = "mt-1 h-12 w-full rounded border border-steel-300 bg-canvas px-3 text-base";
const brand = { backgroundColor: "var(--brand, #111827)", color: "var(--brand-on, #ffffff)" } as const;

const dayLabel = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { weekday: "long", month: "long", day: "numeric", timeZone: "UTC" });

const clock = (hhmm: string) => {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}${m ? `:${String(m).padStart(2, "0")}` : ""}${h < 12 ? "am" : "pm"}`;
};

/**
 * Choosing what, where, who and when, then asking.
 *
 * The windows are loaded again whenever the service or the technician
 * changes, because "with Ray" is Ray's own free time and not the company's.
 * The press of the button carries a key made when the page loaded, so a
 * double tap asks once.
 */
export function BookVisit({ services, properties, technicians, load, book }: {
  services: { id: string; name: string; description: string | null }[];
  properties: { id: string; label: string }[];
  technicians: { id: string; name: string }[];
  load: (input: { serviceId: string; technicianId?: string }) => Promise<{ ok: true; slots: AccountSlot[] } | { ok: false; message: string }>;
  book: (input: {
    serviceId: string; propertyId: string; date: string; arrivalWindowId: string;
    technicianId?: string; notes?: string; requestKey: string;
  }) => Promise<{ ok: false; message: string }>;
}) {
  const [serviceId, setServiceId] = useState("");
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? "");
  const [technicianId, setTechnicianId] = useState("");
  const [slots, setSlots] = useState<AccountSlot[] | null>(null);
  const [slot, setSlot] = useState<AccountSlot | null>(null);
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [sending, startSending] = useTransition();
  const [requestKey] = useState(() => crypto.randomUUID());

  const refresh = (service: string, technician: string) => {
    setSlot(null);
    setSlots(null);
    setError(null);
    if (!service) return;
    startLoading(async () => {
      const result = await load({ serviceId: service, ...(technician ? { technicianId: technician } : {}) });
      if (result.ok) setSlots(result.slots);
      else setError(result.message);
    });
  };

  const byDate = new Map<string, AccountSlot[]>();
  for (const s of slots ?? []) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);
  const chosenName = technicians.find((t) => t.id === technicianId)?.name;

  return (
    <form
      className="space-y-5 rounded-md border border-steel-200 bg-canvas p-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (!slot) return;
        startSending(async () => {
          const result = await book({
            serviceId, propertyId, date: slot.date, arrivalWindowId: slot.arrivalWindowId,
            ...(technicianId ? { technicianId } : {}), ...(notes.trim() ? { notes } : {}), requestKey,
          });
          setError(result.message);
        });
      }}
    >
      <label className="block">
        <span className="text-sm font-medium">What do you need?</span>
        <select
          className={field}
          value={serviceId}
          onChange={(event) => { setServiceId(event.target.value); refresh(event.target.value, technicianId); }}
          required
        >
          <option value="">Choose a service</option>
          {services.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </label>

      {properties.length > 1 && (
        <label className="block">
          <span className="text-sm font-medium">Where?</span>
          <select className={field} value={propertyId} onChange={(event) => setPropertyId(event.target.value)}>
            {properties.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
          </select>
        </label>
      )}

      {technicians.length > 0 && (
        <label className="block">
          <span className="text-sm font-medium">Who would you like?</span>
          <select
            className={field}
            value={technicianId}
            onChange={(event) => { setTechnicianId(event.target.value); refresh(serviceId, event.target.value); }}
          >
            <option value="">Whoever is free first</option>
            {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
          <span className="mt-1 block text-xs text-ink-500">
            The times below are when that person is free. We will send them if they still can be there on the day.
          </span>
        </label>
      )}

      {serviceId && (
        <fieldset>
          <legend className="text-sm font-medium">When?</legend>
          {loading && <p className="mt-2 text-sm text-ink-500">Checking the schedule…</p>}
          {slots && slots.length === 0 && (
            <p className="mt-2 text-sm text-ink-700">
              {chosenName
                ? `${chosenName} has no free time in the next three weeks. Choose whoever is free first, or ask us.`
                : "Nothing is open in the next three weeks. Reply to any message from us and we will find a time."}
            </p>
          )}
          <div className="mt-2 space-y-3">
            {[...byDate.entries()].slice(0, 10).map(([date, day]) => (
              <div key={date}>
                <p className="text-xs uppercase tracking-[0.08em] text-ink-500">{dayLabel(date)}</p>
                <div className="mt-2 flex flex-wrap gap-2">
                  {day.map((s) => {
                    const picked = slot?.date === s.date && slot.arrivalWindowId === s.arrivalWindowId;
                    return (
                      <button
                        key={`${s.date}-${s.arrivalWindowId}`}
                        type="button"
                        aria-pressed={picked}
                        onClick={() => setSlot(s)}
                        className={`h-12 rounded border px-4 text-base transition-colors ${picked ? "border-ink-900 bg-ink-900 text-white" : "border-steel-300 bg-canvas hover:bg-steel-100"}`}
                      >
                        {clock(s.startsAt)} to {clock(s.endsAt)}
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </fieldset>
      )}

      {slot && (
        <label className="block">
          <span className="text-sm font-medium">Anything we should know?</span>
          <textarea
            className="mt-1 min-h-24 w-full rounded border border-steel-300 bg-canvas p-3 text-base"
            value={notes}
            onChange={(event) => setNotes(event.target.value)}
            maxLength={2000}
          />
        </label>
      )}

      <button type="submit" disabled={!slot || sending} style={brand}
              className="h-12 w-full rounded text-base font-medium transition-opacity hover:opacity-90 disabled:opacity-40">
        {sending ? "Sending…" : slot ? `Ask for ${dayLabel(slot.date)}, ${clock(slot.startsAt)} to ${clock(slot.endsAt)}` : "Ask for this visit"}
      </button>
      <p className="text-center text-xs text-ink-500">We confirm every visit before it goes in the diary.</p>
      {error && <p role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{error}</p>}
    </form>
  );
}
