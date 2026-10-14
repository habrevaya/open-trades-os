"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { marketing as mk } from "@opentradesos/core";
import { toBase64 } from "@opentradesos/field-client";
import { smallerPicture } from "@/lib/photo";
import { submitHosted } from "./actions";

export interface Uploads {
  maxFiles: number;
  maxFileMegabytes: number;
  maxTotalMegabytes: number;
  types: string[];
}

const INPUT = "mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm";
const BUTTON = "inline-flex h-10 items-center rounded px-4 text-sm font-medium disabled:opacity-60";
const MB = 1024 * 1024;

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
 *
 * IN PAGES, when the office split it. Every page is on the page from the
 * start and only the current one is shown, so the browser keeps what was typed
 * on a page somebody went Back from. Next checks the page with core's own
 * field checks (`checkPage`), so it says what Send would have said while the
 * answer can still be fixed where it is; nothing is posted until the end, and
 * the server checks the whole form again. A refusal from the server on an
 * earlier page takes the person back to that page.
 *
 * FILES go in the same post. A photograph is made smaller first, the way the
 * technician's camera does it, and the size is checked here before anything
 * is sent, because a post too large for the server would fail with nothing
 * useful to say. The server holds every file to its own rules regardless.
 */
export function HostedForm({ organizationSlug, formSlug, fields, pages, uploads }: {
  organizationSlug: string; formSlug: string; fields: mk.FormField[]; pages: mk.FormPage[]; uploads: Uploads;
}) {
  const definition: mk.FormDefinition = { key: formSlug, title: "", fields, ...(pages.length > 1 ? { pages } : {}) };
  const layout = mk.pagesOf(definition);
  const started = useRef(new Date().toISOString());
  const arrival = useRef<{ visitorId?: string | undefined; landingQuery?: string | undefined; referrer?: string | undefined }>({});
  const top = useRef<HTMLFormElement>(null);
  const [page, setPage] = useState(0);
  const [refusals, setRefusals] = useState<Record<string, string>>({});
  const [general, setGeneral] = useState<string | null>(null);
  const [thanks, setThanks] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const last = page === layout.length - 1;

  useEffect(() => {
    arrival.current = {
      visitorId: visitorId(),
      landingQuery: window.location.search.replace(/^\?/, "") || undefined,
      referrer: document.referrer || undefined,
    };
  }, []);

  /** What the form holds, as core reads it: a file field is the names of the files picked. */
  function valuesOf(form: HTMLFormElement): Record<string, unknown> {
    const data = new FormData(form);
    const values: Record<string, unknown> = {};
    for (const field of fields) {
      if (field.type === "consent") values[field.key] = data.get(field.key) === "yes";
      else if (field.type === "multi_choice") values[field.key] = data.getAll(field.key).map(String);
      else if (field.type === "file") {
        const names = picked(data, field.key).map((f) => f.name);
        if (names.length > 0) values[field.key] = names;
      } else if (field.type === "service_address") {
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

  function show(at: number, said: Record<string, string>, sentence: string | null) {
    setRefusals(said);
    setGeneral(sentence);
    setPage(at);
    top.current?.scrollIntoView({ block: "start" });
  }

  /** This page's refusals from core, or none, before the person moves on. */
  function checkHere(form: HTMLFormElement): boolean {
    const found = mk.checkPage(definition, page, valuesOf(form));
    if (found.length === 0) return true;
    show(page, Object.fromEntries(found.map((r) => [r.field, r.message])), "Please check the answers marked below.");
    return false;
  }

  /** The files, made ready to post, or the sentence that says why they cannot go. */
  async function filesOf(form: HTMLFormElement): Promise<{ files: { field: string; fileName: string; contentType: string; bytes: string }[] } | { refused: Record<string, string> }> {
    const data = new FormData(form);
    const out: { field: string; fileName: string; contentType: string; bytes: string }[] = [];
    const refused: Record<string, string> = {};
    let total = 0;
    for (const field of fields.filter((f) => f.type === "file")) {
      for (const file of picked(data, field.key)) {
        if (out.length >= uploads.maxFiles) {
          refused[field.key] = `You can send up to ${uploads.maxFiles} files with this form.`;
          break;
        }
        const ready = file.type.startsWith("image/")
          ? await smallerPicture(file)
          : { bytes: new Uint8Array(await file.arrayBuffer()), contentType: file.type };
        if (ready.bytes.length > uploads.maxFileMegabytes * MB) {
          refused[field.key] = `${file.name} is too large. A file can be up to ${uploads.maxFileMegabytes} MB.`;
          continue;
        }
        total += ready.bytes.length;
        if (total > uploads.maxTotalMegabytes * MB) {
          refused[field.key] = `The files come to more than ${uploads.maxTotalMegabytes} MB in all. Send fewer, or call us.`;
          continue;
        }
        out.push({ field: field.key, fileName: file.name, contentType: ready.contentType, bytes: toBase64(ready.bytes) });
      }
    }
    return Object.keys(refused).length > 0 ? { refused } : { files: out };
  }

  if (thanks !== null) {
    return (
      <div role="status" className="rounded-md border border-steel-200 bg-canvas p-6 text-center text-sm">
        {thanks}
      </div>
    );
  }

  const fieldOf = (field: mk.FormField) => {
    const refused = refusals[field.key];
    const id = `f-${field.key}`;
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
                {(field.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            ) : field.type === "multi_choice" ? (
              <div className="mt-1 space-y-1">
                {(field.options ?? []).map((o) => (
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
            ) : field.type === "file" ? (
              <>
                <input id={id} name={field.key} type="file" multiple accept={uploads.types.join(",")} className="mt-1 block text-sm" />
                <p className="mt-1 text-xs text-ink-500">
                  Photos or PDFs, up to {uploads.maxFiles} files and {uploads.maxTotalMegabytes} MB in all.
                </p>
              </>
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
  };

  return (
    <form
      ref={top}
      noValidate
      className="space-y-4 rounded-md border border-steel-200 bg-canvas p-6"
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        if (!checkHere(form)) return;
        if (!last) { show(page + 1, {}, null); return; }
        const values = valuesOf(form);
        start(async () => {
          const ready = await filesOf(form);
          if ("refused" in ready) {
            const at = mk.firstPageWith(definition, Object.keys(ready.refused)) ?? page;
            show(at, ready.refused, "Please check the files marked below.");
            return;
          }
          const outcome = await submitHosted({
            organizationSlug, formSlug, values, startedAt: started.current, ...arrival.current,
            ...(ready.files.length > 0 ? { files: ready.files } : {}),
          }).catch(() => ({ ok: false as const, message: "That did not go through. Please give us a call instead." }));
          if (!outcome.ok) { setGeneral(outcome.message); return; }
          if (outcome.accepted) {
            setThanks(outcome.thankYou ?? "Thank you. We have your details and will be in touch shortly.");
            return;
          }
          const fieldsRefused = outcome.refusals.map((r) => r.field);
          show(mk.firstPageWith(definition, fieldsRefused) ?? page,
            Object.fromEntries(outcome.refusals.map((r) => [r.field, r.message])),
            "Please check the answers marked below.");
        });
      }}
    >
      {layout.length > 1 ? (
        <p className="text-xs text-ink-500">Page {page + 1} of {layout.length}</p>
      ) : null}
      {fields.filter((f) => f.type === "honeypot").map((field) => (
        <div key={field.key} aria-hidden="true" style={{ position: "absolute", left: "-10000px", width: 1, height: 1, overflow: "hidden" }}>
          <label htmlFor={`f-${field.key}`}>{field.label}</label>
          <input id={`f-${field.key}`} name={field.key} tabIndex={-1} autoComplete="off" />
        </div>
      ))}
      {layout.map((shown, i) => (
        <fieldset key={i} hidden={i !== page} className="space-y-4">
          {shown.title ? <legend className="mb-2 text-base font-semibold">{shown.title}</legend> : null}
          {shown.keys.map((key) => fields.find((f) => f.key === key)).filter((f): f is mk.FormField => f !== undefined).map(fieldOf)}
        </fieldset>
      ))}
      {general ? <p role="alert" className="text-sm text-red-600">{general}</p> : null}
      <div className="flex gap-2">
        {page > 0 ? (
          <button type="button" onClick={() => show(page - 1, refusals, null)} disabled={pending}
                  className={`${BUTTON} border border-steel-300 hover:bg-steel-100`}>
            Back
          </button>
        ) : null}
        <button type="submit" disabled={pending} className={`${BUTTON} bg-ink-900 text-white`}>
          {pending ? "Sending" : last ? "Send" : "Next"}
        </button>
      </div>
    </form>
  );
}

/** The files picked in one file field, leaving out the empty entry a browser sends when none were. */
function picked(data: FormData, key: string): File[] {
  return data.getAll(key).filter((v): v is File => typeof v !== "string" && v.size > 0);
}
