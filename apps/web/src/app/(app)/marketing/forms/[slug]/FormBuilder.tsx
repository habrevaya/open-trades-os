"use client";

import { useState } from "react";
import { useKeptAction } from "@/lib/use-kept-action";
import { saveForm } from "../actions";

const FIELD = "h-9 rounded border border-steel-300 bg-canvas px-2 text-sm";
const BUTTON = "inline-flex h-8 items-center rounded border border-steel-300 px-2 text-sm hover:bg-steel-100";

/** The field types core knows, in a trades owner's words. */
const TYPES: { value: string; label: string }[] = [
  { value: "text", label: "Short answer" },
  { value: "long_text", label: "Long answer" },
  { value: "phone", label: "Phone number" },
  { value: "email", label: "Email" },
  { value: "service_address", label: "Address of the work" },
  { value: "choice", label: "Pick one" },
  { value: "multi_choice", label: "Pick several" },
  { value: "number", label: "Number" },
  { value: "date", label: "Date" },
  { value: "consent", label: "Tick box to agree" },
  { value: "file", label: "Photos or PDFs" },
  { value: "hidden", label: "Hidden value" },
  { value: "honeypot", label: "Spam trap (hidden)" },
];

interface Field {
  key: string;
  label: string;
  type: string;
  required: boolean;
  help?: string | undefined;
  options?: { value: string; label: string }[] | undefined;
  consentFor?: { channel: "sms" | "email"; purpose: "marketing" | "transactional" } | undefined;
  page?: number | undefined;
}

/** The kinds a confirmation may repeat, as core's `CONFIRMATION_FIELD_TYPES` lists them. */
const REPEATABLE = new Set(["text", "email", "phone", "choice", "multi_choice", "number", "date", "service_address"]);

interface Form {
  slug: string;
  title: string;
  source: string;
  minimumFillSeconds: number | null;
  fields: Field[];
  pages: { title: string }[];
  settings: { thankYou?: string; confirmationText?: string; confirmationEmailSubject?: string; confirmationEmailBody?: string };
}

/**
 * THE FIELDS, IN ORDER
 *
 * A list somebody reorders and edits, posted whole as JSON. Nothing here
 * decides whether the form is usable: core's `checkForm` does, on save, and
 * its sentence is shown under the button. What the screen adds is a consent
 * box that cannot be saved without saying what it agrees to, because a tick
 * box with no channel and purpose records nothing.
 *
 * PAGES. A long form can be split: each page has a heading, and each question
 * says which page it is on. Moving a question to another page puts it with
 * that page's questions, so the list always reads in the order it is asked.
 */
export function FormBuilder({ form, sources, writes }: {
  form: Form; sources: { value: string; label: string }[]; writes: boolean;
}) {
  const [fields, setFields] = useState<Field[]>(form.fields);
  const [pages, setPages] = useState<{ title: string }[]>(form.pages);
  const [state, action, pending] = useKeptAction(saveForm, null);
  const split = pages.length > 1;

  /** A question moved to another page goes after that page's questions, keeping everything else in its order. */
  const onPage = (i: number, page: number) => setFields((all) => {
    const moved = all.map((f, j) => (j === i ? { ...f, page } : f));
    return moved.map((f, j) => ({ f, j })).sort((a, b) => ((a.f.page ?? 0) - (b.f.page ?? 0)) || (a.j - b.j)).map((x) => x.f);
  });
  const addPage = () => setPages((all) => (all.length === 0
    ? [{ title: "About you" }, { title: "The work" }]
    : [...all, { title: `Page ${all.length + 1}` }]));
  const removePage = (at: number) => {
    setPages((all) => {
      const left = all.filter((_, j) => j !== at);
      return left.length > 1 ? left : [];
    });
    setFields((all) => all.map((f) => {
      const page = f.page ?? 0;
      return { ...f, page: page > at ? page - 1 : page === at ? Math.max(0, at - 1) : page };
    }));
  };

  const set = (i: number, patch: Partial<Field>) =>
    setFields((all) => all.map((f, j) => (j === i ? { ...f, ...patch } : f)));
  const move = (i: number, by: number) => setFields((all) => {
    const next = [...all];
    const [taken] = next.splice(i, 1);
    next.splice(Math.max(0, Math.min(next.length, i + by)), 0, taken!);
    return next;
  });

  return (
    <form {...action} className="mt-6 space-y-6">
      <input type="hidden" name="slug" value={form.slug} />
      <input type="hidden" name="fields" value={JSON.stringify(split ? fields : fields.map(({ page: _page, ...f }) => f))} />
      <input type="hidden" name="pages" value={JSON.stringify(split ? pages : [])} />
      <div className="flex flex-wrap gap-3">
        <label className="text-sm">Title
          <input name="title" defaultValue={form.title} required className={`mt-1 block ${FIELD}`} />
        </label>
        <label className="text-sm">Leads count as
          <select name="source" defaultValue={form.source} className={`mt-1 block ${FIELD}`}>
            {sources.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
          </select>
        </label>
        <label className="text-sm">Too fast to be a person (seconds)
          <input name="minimumFillSeconds" type="number" min={0} max={300} defaultValue={form.minimumFillSeconds ?? ""} className={`mt-1 block w-24 ${FIELD}`} />
        </label>
      </div>

      <fieldset className="space-y-2 rounded-md border border-steel-200 p-3">
        <legend className="px-1 text-sm font-medium">Pages</legend>
        {split ? (
          <>
            <p className="text-xs text-ink-500">
              People see one page at a time, with Back and Next. Each page is checked before they move on, and nothing is sent
              until the last page.
            </p>
            <ol className="space-y-2">
              {pages.map((p, at) => (
                <li key={at} className="flex flex-wrap items-end gap-2">
                  <label className="text-xs text-ink-500">Page {at + 1} heading
                    <input value={p.title} aria-label={`Page ${at + 1} heading`}
                           onChange={(e) => setPages((all) => all.map((x, j) => (j === at ? { title: e.target.value } : x)))}
                           className={`mt-1 block w-72 ${FIELD}`} />
                  </label>
                  <button type="button" className={BUTTON} onClick={() => removePage(at)} aria-label={`Remove page ${at + 1}`}>Remove</button>
                </li>
              ))}
            </ol>
          </>
        ) : (
          <p className="text-xs text-ink-500">The whole form is on one page.</p>
        )}
        <button type="button" className={BUTTON} onClick={addPage}>{split ? "Add a page" : "Split into pages"}</button>
      </fieldset>

      <ol className="space-y-3">
        {fields.map((f, i) => (
          <li key={i} className="rounded-md border border-steel-200 p-3">
            <div className="flex flex-wrap items-end gap-2">
              <label className="text-xs text-ink-500">Question
                <input value={f.label} onChange={(e) => set(i, { label: e.target.value })} aria-label={`Field ${i + 1} question`} className={`mt-1 block w-72 ${FIELD}`} />
              </label>
              <label className="text-xs text-ink-500">Key
                <input value={f.key} onChange={(e) => set(i, { key: e.target.value })} aria-label={`Field ${i + 1} key`} className={`mt-1 block w-32 ${FIELD}`} />
              </label>
              <label className="text-xs text-ink-500">Kind
                <select value={f.type} onChange={(e) => set(i, { type: e.target.value })} aria-label={`Field ${i + 1} kind`} className={`mt-1 block ${FIELD}`}>
                  {TYPES.map((t) => <option key={t.value} value={t.value}>{t.label}</option>)}
                </select>
              </label>
              <label className="flex items-center gap-1 text-sm">
                <input type="checkbox" checked={f.required} onChange={(e) => set(i, { required: e.target.checked })} /> Required
              </label>
              {split && f.type !== "hidden" && f.type !== "honeypot" && (
                <label className="text-xs text-ink-500">Page
                  <select value={f.page ?? 0} onChange={(e) => onPage(i, Number(e.target.value))} aria-label={`Field ${i + 1} page`} className={`mt-1 block ${FIELD}`}>
                    {pages.map((p, at) => <option key={at} value={at}>{at + 1}. {p.title || "No heading"}</option>)}
                  </select>
                </label>
              )}
              <button type="button" className={BUTTON} onClick={() => move(i, -1)} aria-label={`Move field ${i + 1} up`}>Up</button>
              <button type="button" className={BUTTON} onClick={() => move(i, 1)} aria-label={`Move field ${i + 1} down`}>Down</button>
              <button type="button" className={BUTTON} onClick={() => setFields((all) => all.filter((_, j) => j !== i))} aria-label={`Remove field ${i + 1}`}>Remove</button>
            </div>
            <label className="mt-2 block text-xs text-ink-500">Help shown under it
              <input value={f.help ?? ""} onChange={(e) => set(i, { help: e.target.value || undefined })} className={`mt-1 block w-full ${FIELD}`} />
            </label>
            {(f.type === "choice" || f.type === "multi_choice") && (
              <label className="mt-2 block text-xs text-ink-500">Options, one per line
                <textarea
                  rows={3}
                  value={(f.options ?? []).map((o) => o.label).join("\n")}
                  onChange={(e) => set(i, {
                    options: e.target.value.split("\n").map((l) => l.trim()).filter(Boolean)
                      .map((l) => ({ value: l.toLowerCase().replace(/[^a-z0-9]+/g, "_"), label: l })),
                  })}
                  className="mt-1 block w-full rounded border border-steel-300 p-2 text-sm"
                />
              </label>
            )}
            {f.type === "consent" && (
              <div className="mt-2 flex flex-wrap gap-3 text-sm">
                <span className="text-xs text-ink-500">Ticking it agrees to</span>
                <select
                  value={f.consentFor ? `${f.consentFor.channel}:${f.consentFor.purpose}` : ""}
                  onChange={(e) => {
                    const [channel, purpose] = e.target.value.split(":") as ["sms" | "email", "marketing" | "transactional"];
                    set(i, { consentFor: e.target.value ? { channel, purpose } : undefined });
                  }}
                  aria-label={`What field ${i + 1} agrees to`}
                  className={FIELD}
                >
                  <option value="">Nothing recorded</option>
                  <option value="sms:marketing">Texts about offers</option>
                  <option value="email:marketing">Emails about offers</option>
                  <option value="sms:transactional">Texts about their work</option>
                  <option value="email:transactional">Emails about their work</option>
                </select>
                <span className="text-xs text-ink-500">The question and its help are kept as the exact words they agreed to.</span>
              </div>
            )}
          </li>
        ))}
      </ol>
      <button type="button" className={BUTTON}
              onClick={() => setFields((all) => [...all, {
                key: `field_${all.length + 1}`, label: "", type: "text", required: false,
                ...(split ? { page: pages.length - 1 } : {}),
              }])}>
        Add a field
      </button>

      <fieldset className="space-y-3 rounded-md border border-steel-200 p-3">
        <legend className="px-1 text-sm font-medium">After a good submission</legend>
        <p className="text-xs text-ink-500">
          {fields.some((f) => REPEATABLE.has(f.type))
            ? <>Any of these can repeat a short answer: {fields.filter((f) => REPEATABLE.has(f.type)).map((f) => `{{ ${f.key} }}`).join(", ")}. In a text or an email an answer is cut short, and one with a web address in it is left out.</>
            : "Add a short answer to repeat it here."}
        </p>
        <label className="block text-sm">What the page says
          <input name="thankYou" defaultValue={form.settings.thankYou ?? ""} placeholder="Thanks, we will ring you within the hour." className={`mt-1 block w-full ${FIELD}`} />
        </label>
        <label className="block text-sm">A text to them (blank for none)
          <input name="confirmationText" defaultValue={form.settings.confirmationText ?? ""} maxLength={320} className={`mt-1 block w-full ${FIELD}`} />
        </label>
        <label className="block text-sm">An email subject (blank for none)
          <input name="confirmationEmailSubject" defaultValue={form.settings.confirmationEmailSubject ?? ""} className={`mt-1 block w-full ${FIELD}`} />
        </label>
        <label className="block text-sm">The email
          <textarea name="confirmationEmailBody" rows={3} defaultValue={form.settings.confirmationEmailBody ?? ""} className="mt-1 block w-full rounded border border-steel-300 p-2 text-sm" />
        </label>
      </fieldset>

      {writes && (
        <button type="submit" disabled={pending} className="inline-flex h-9 items-center rounded bg-ink-900 px-3.5 text-sm font-medium text-white hover:bg-ink-700 disabled:opacity-60">
          {pending ? "Saving" : "Save form"}
        </button>
      )}
      {state?.done && state.message ? <p role="status" className="text-sm text-ink-700">{state.message}</p> : null}
      {state?.error ? <p role="alert" className="text-sm text-red-600">{state.error}</p> : null}
    </form>
  );
}
