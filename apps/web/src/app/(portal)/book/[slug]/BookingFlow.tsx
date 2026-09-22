"use client";

import { useState, useTransition } from "react";
import { loadSlots, submitBooking, type Slot } from "./actions";

type Service = {
  id: string;
  publicName: string;
  publicDescription: string | null;
  displayPrice: string | null;
  minNoticeHours: number;
};

const dollars = (v: string) =>
  Number(v).toLocaleString("en-US", { style: "currency", currency: "USD" });

const dayLabel = (iso: string) =>
  new Date(`${iso}T12:00:00Z`).toLocaleDateString("en-US", {
    weekday: "short", month: "short", day: "numeric",
  });

/**
 * Service, then time, then details.
 *
 * Three steps rather than one long form, because the times depend on the
 * service and asking for a name and an address before showing whether anyone
 * can come is how a booking widget gets abandoned. The contact details come
 * last, once the person has something to lose by leaving.
 */
export function BookingFlow({ slug, services }: { slug: string; services: Service[] }) {
  const [service, setService] = useState<Service | null>(
    services.length === 1 ? services[0]! : null,
  );
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [slot, setSlot] = useState<Slot | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  function chooseService(s: Service) {
    setService(s);
    setSlot(null);
    setSlots(null);
    setError(null);
    start(async () => setSlots(await loadSlots({ slug, serviceId: s.id })));
  }

  if (done) {
    return (
      <div className="rounded-md border border-steel-200 bg-canvas p-8 text-center">
        <p className="text-lg font-medium">You are booked.</p>
        <p className="mt-2 text-sm text-ink-700">
          We will confirm shortly. You can follow along here:
        </p>
        <a
          href={done}
          className="mt-4 inline-block break-all text-sm text-ink-900 underline underline-offset-4"
        >
          {done}
        </a>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Step n={1} title="What do you need?">
        <div className="space-y-2">
          {services.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => chooseService(s)}
              className={`flex w-full items-start justify-between gap-4 rounded-md border p-4 text-left transition-colors ${
                service?.id === s.id
                  ? "border-ink-900 bg-canvas ring-1 ring-ink-900"
                  : "border-steel-200 bg-canvas hover:bg-steel-100"
              }`}
            >
              <span>
                <span className="font-medium">{s.publicName}</span>
                {s.publicDescription && (
                  <span className="mt-1 block text-sm text-ink-700">{s.publicDescription}</span>
                )}
              </span>
              <span className="shrink-0 font-mono tabular-nums">
                {/* No price is an honest answer, and it converts better than a
                    number the company will not honour once they see the job. */}
                {s.displayPrice ? dollars(s.displayPrice) : "Quoted on site"}
              </span>
            </button>
          ))}
        </div>
      </Step>

      {service && (
        <Step n={2} title="When suits you?">
          {pending && !slots && <p className="text-sm text-ink-500">Checking the schedule…</p>}
          {slots && slots.length === 0 && (
            <p className="text-sm text-ink-700">
              Nothing open in the next three weeks. Give us a call and we will sort
              something out.
            </p>
          )}
          {slots && slots.length > 0 && <SlotPicker slots={slots} chosen={slot} onPick={setSlot} />}
        </Step>
      )}

      {service && slot && (
        <Step n={3} title="Where are we going?">
          <DetailsForm
            error={error}
            onSubmit={(details) =>
              start(async () => {
                const result = await submitBooking({
                  slug,
                  serviceId: service.id,
                  date: slot.date,
                  arrivalWindowId: slot.arrivalWindowId,
                  ...details,
                });
                if (result.ok) {
                  setDone(result.trackingUrl);
                  return;
                }
                setError(result.message);
                if (result.retry) {
                  // The times are stale, so go back and show real ones rather
                  // than let them try the same gone slot again.
                  setSlot(null);
                  setSlots(await loadSlots({ slug, serviceId: service.id }));
                }
              })
            }
            pending={pending}
          />
        </Step>
      )}
    </div>
  );
}

function SlotPicker({
  slots, chosen, onPick,
}: { slots: Slot[]; chosen: Slot | null; onPick: (s: Slot) => void }) {
  const byDate = new Map<string, Slot[]>();
  for (const s of slots) byDate.set(s.date, [...(byDate.get(s.date) ?? []), s]);

  return (
    <div className="space-y-3">
      {[...byDate.entries()].slice(0, 10).map(([date, daySlots]) => (
        <div key={date}>
          <p className="text-xs uppercase tracking-[0.08em] text-ink-500">{dayLabel(date)}</p>
          <div className="mt-2 flex flex-wrap gap-2">
            {daySlots.map((s) => {
              const selected =
                chosen?.date === s.date && chosen.arrivalWindowId === s.arrivalWindowId;
              return (
                <button
                  key={`${s.date}-${s.arrivalWindowId}`}
                  type="button"
                  onClick={() => onPick(s)}
                  className={`h-12 rounded border px-4 text-base transition-colors ${
                    selected
                      ? "border-ink-900 bg-ink-900 text-white"
                      : "border-steel-300 bg-canvas hover:bg-steel-100"
                  }`}
                >
                  {s.startsAt.slice(0, 5)} to {s.endsAt.slice(0, 5)}
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

function DetailsForm({
  onSubmit, pending, error,
}: {
  onSubmit: (d: {
    contactName: string; contactEmail?: string; contactPhone?: string;
    addressLine1: string; city: string; state: string; postalCode: string; notes?: string;
  }) => void;
  pending: boolean;
  error: string | null;
}) {
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [line1, setLine1] = useState("");
  const [city, setCity] = useState("");
  const [state, setState] = useState("");
  const [zip, setZip] = useState("");
  const [notes, setNotes] = useState("");

  // The API requires one of the two, because a booking nobody can confirm is
  // not a booking. Enforced here as well so the person is told before they
  // submit rather than after.
  const reachable = phone.trim() !== "" || email.trim() !== "";
  const ready = name.trim() && line1.trim() && city.trim() && state.trim() && zip.trim() && reachable;

  return (
    <div className="space-y-3">
      <Input label="Your name" value={name} onChange={setName} autoComplete="name" />
      <div className="grid gap-3 sm:grid-cols-2">
        <Input label="Phone" value={phone} onChange={setPhone} autoComplete="tel" type="tel" />
        <Input label="Email" value={email} onChange={setEmail} autoComplete="email" type="email" />
      </div>
      {!reachable && (name || line1) && (
        <p className="text-xs text-ink-500">A phone number or an email, so we can confirm.</p>
      )}
      <Input label="Address" value={line1} onChange={setLine1} autoComplete="address-line1" />
      <div className="grid gap-3 sm:grid-cols-3">
        <Input label="City" value={city} onChange={setCity} autoComplete="address-level2" />
        <Input label="State" value={state} onChange={setState} autoComplete="address-level1" />
        <Input label="ZIP" value={zip} onChange={setZip} autoComplete="postal-code" />
      </div>
      <label className="block">
        <span className="text-sm font-medium">What is going on? Optional.</span>
        <textarea
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          className="mt-1 w-full rounded border border-steel-300 p-3 text-base"
          placeholder="Upstairs unit is blowing warm air since Tuesday…"
        />
      </label>

      {error && (
        <p className="rounded bg-alert-100 px-3 py-2 text-sm text-alert-700">{error}</p>
      )}

      <button
        type="button"
        disabled={!ready || pending}
        onClick={() =>
          onSubmit({
            contactName: name.trim(),
            ...(phone.trim() ? { contactPhone: phone.trim() } : {}),
            ...(email.trim() ? { contactEmail: email.trim() } : {}),
            addressLine1: line1.trim(),
            city: city.trim(),
            state: state.trim(),
            postalCode: zip.trim(),
            ...(notes.trim() ? { notes: notes.trim() } : {}),
          })
        }
        className="h-12 w-full rounded bg-ink-900 text-base font-medium text-white transition-colors hover:bg-ink-700 disabled:opacity-40"
      >
        {pending ? "Booking…" : "Book it"}
      </button>
    </div>
  );
}

function Input({
  label, value, onChange, autoComplete, type = "text",
}: {
  label: string; value: string; onChange: (v: string) => void;
  autoComplete?: string; type?: string;
}) {
  return (
    <label className="block">
      <span className="text-sm font-medium">{label}</span>
      <input
        type={type}
        value={value}
        autoComplete={autoComplete}
        onChange={(e) => onChange(e.target.value)}
        // 48px, because this is filled in on a phone, often one handed.
        className="mt-1 h-12 w-full rounded border border-steel-300 px-3 text-base"
      />
    </label>
  );
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-steel-200 bg-steel-100 p-5">
      <h2 className="mb-3 flex items-center gap-2 text-sm font-medium">
        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-ink-900 text-xs text-white">
          {n}
        </span>
        {title}
      </h2>
      {children}
    </section>
  );
}
