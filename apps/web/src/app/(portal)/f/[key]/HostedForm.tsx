"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { submitHosted } from "./actions";

interface Field {
  key: string;
  label: string;
  type: string;
  required: boolean;
  help: string | null;
  options: { value: string; label: string }[];
}

const INPUT = "mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm";

/**
 * The visitor id: the one the website snippet put on the link (`otv`), else
 * the one this browser already keeps for the booking page, else a new random
 * one. Never a fingerprint, and nothing breaks if storage is blocked.
 */
function visitorId(): string | undefined {
  const fromLink = new URLSearchParams(window.location.search).get("otv");
  try {
    const kept = window.localStorage.getItem("ots_visitor");
    const id = fromLink && /^[A-Za-z0-9_-]{12,64}$/.test(fromLink) ? fromLink : kept ?? window.crypto.randomUUID();
    window.localStorage.setItem("ots_visitor", id);
    return id;
  } catch {
    return fromLink ?? undefined;
  }
}

/**
 * THE FORM, AS THE OFFICE BUILT IT
 *
 * Every refusal comes back at once and is shown under its field, in core's
 * words, written for the person filling it in. The spam trap is a field no
 * person sees: positioned off the screen rather than `display: none`, which
 * some scripts know to skip, and taken out of the tab order and autofill.
 */
export function HostedForm({ organizationSlug, formSlug, fields }: {
  organizationSlug: string; formSlug: string; fields: Field[];
}) {
  const started = useRef(new Date().toISOString());
  const arrival = useRef<{ visitorId?: string | undefined; landingQuery?: string | undefined; referrer?: string | undefined }>({});
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [thanks, setThanks] = useState<string | null>(null);
  const [pending, start] = useTransition();

  useEffect(() => {
    arrival.current = {
      visitorId: visitorId(),
      landingQuery: window.location.search.replace(/^\?/, "") || undefined,
      referrer: document.referrer || undefined,
    };
  }, []);

  function valuesOf(form: HTMLFormElement): Record<string, unknown> {
    const data = new FormData(form);
    const values: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.type === "consent") values[field.key] = data.get(field.key) === "yes";
      else if (field.type === "multi_choice") values[field.key] = data.getAll(field.key).map(String);
      else if (field.type === "service_address") {
        const part = (name: string) => String(data.get(`${field.key}.${name}`) ?? "").trim();
        const address = { line1: part("line1"), city: part("city"), state: part("state"), postalCode: part("postalCode") };
        if (Object.values(address).some((v) => v !== "")) values[field.key] = address;
      } else {
        const raw = String(data.get(field.key) ?? "");
        if (raw.trim() === "") continue;
        values[field.key] = field.type === "number" ? Number(raw) : raw;
      }
    }
    return values;
  }

  if (thanks !== null) {
    return (
      <div role="status" className="rounded-md border border-steel-200 bg-canvas p-6 text-center text-sm">
        {thanks}
      </div>
    );
  }

  return (
    <form
      className="space-y-4 rounded-md border border-steel-200 bg-canvas p-6"
      onSubmit={(event) => {
        event.preventDefault();
        const values = valuesOf(event.currentTarget);
        start(async () => {
          const outcome = await submitHosted({
            organizationSlug, formSlug, values, startedAt: started.current, ...arrival.current,
          });
          if (!outcome.ok) { setGeneral(outcome.message); return; }
          if (outcome.accepted) {
            setThanks(outcome.thankYou ?? "Thank you. We have your details and will be in touch shortly.");
            return;
          }
          setGeneral("Please check the answers marked below.");
          setRefusals(Object.fromEntries(outcome.refusals.map((r) => [r.field, r.message])));
        });
      }}
    >
      {fields.map((field) => {
        const refused = refusals[field.key];
        const id = `f-${field.key}`;
        if (field.type === "honeypot") {
          return (
            <div key={field.key} aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
              <label htmlFor={id}>{field.label}</label>
              <input id={id} name={field.key} tabIndex={-1} autoComplete="off" />
            </div>
          );
        }
        if (field.type === "hidden") return null;
        return (
          <div key={field.key}>
            {field.type === "consent" ? (
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" name={field.key} value="yes" className="mt-1" />
                <span>{field.label}{field.help ? <span className="block text-xs text-ink-500">{field.help}</span> : null}</span>
              </label>
            ) : (
              <>
                <label htmlFor={id} className="text-sm font-medium text-ink-700">
                  {field.label}{field.required ? "" : " (optional)"}
                </label>
                {field.type === "long_text" ? (
                  <textarea id={id} name={field.key} rows={4} className="mt-1 w-full rounded border border-steel-300 bg-canvas p-2 text-sm" />
                ) : field.type === "choice" ? (
                  <select id={id} name={field.key} className={INPUT} defaultValue="">
                    <option value="" disabled>Choose one</option>
                    {field.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                  </select>
                ) : field.type === "multi_choice" ? (
                  <div className="mt-1 space-y-1">
                    {field.options.map((o) => (
                      <label key={o.value} className="flex items-center gap-2 text-sm">
                        <input type="checkbox" name={field.key} value={o.value} /> {o.label}
                      </label>
                    ))}
                  </div>
                ) : field.type === "service_address" ? (
                  <div className="grid gap-2 sm:grid-cols-2">
                    <input aria-label="Street" name={`${field.key}.line1`} placeholder="Street" className={INPUT} />
                    <input aria-label="City" name={`${field.key}.city`} placeholder="City" className={INPUT} />
                    <input aria-label="State" name={`${field.key}.state`} placeholder="State" maxLength={2} className={INPUT} />
                    <input aria-label="ZIP" name={`${field.key}.postalCode`} placeholder="ZIP" inputMode="numeric" className={INPUT} />
                  </div>
                ) : (
                  <input
                    id={id} name={field.key}
                    type={field.type === "email" ? "email" : field.type === "phone" ? "tel" : field.type === "number" ? "number" : field.type === "date" ? "date" : "text"}
                    className={INPUT}
                  />
                )}
                {field.help ? <p className="mt-1 text-xs text-ink-500">{field.help}</p> : null}
              </>
            )}
            {refused ? <p role="alert" className="mt-1 text-sm text-red-600">{refused}</p> : null}
          </div>
        );
      })}
      {general ? <p role="alert" className="text-sm text-red-600">{general}</p> : null}
      <button type="submit" disabled={pending}
              className="inline-flex h-10 items-center rounded bg-ink-900 px-4 text-sm font-medium text-white disabled:opacity-60">
        {pending ? "Sending" : "Send"}
      </button>
    </form>
  );
}
