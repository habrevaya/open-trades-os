"use client";

import { useState } from "react";
import { marketing as mk } from "@opentradesos/core";
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
  rule?: mk.ShowRule | undefined;
}

/** The kinds a confirmation may repeat, as core's `CONFIRMATION_FIELD_TYPES` lists them. */
const REPEATABLE = new Set(["text", "email", "phone", "choice", "multi_choice", "number", "date", "service_address"]);

interface Form {
  slug: string;
  title: string;
  source: string;
  minimumFillSeconds: number | null;
  fields: Field[];
  pages: Page[];
  settings: {
    thankYou?: string; confirmationText?: string; confirmationEmailSubject?: string; confirmationEmailBody?: string;
    firstNameFallback?: string;
  };
}

/** A page, and when it has one the earlier question it waits for and the options that bring people to it. */
interface Page {
  title: string;
  showWhen?: { field: string; oneOf: string[] } | undefined;
  rule?: mk.ShowRule | undefined;
}

/** A question a rule can wait for: a pick one, pick several, number or typed answer. */
const ruleable = (f: Field) => (mk.RULE_OPERATORS_FOR[f.type as mk.FieldType] ?? []).length > 0;

/** A fresh condition on a question, with the comparison that kind of question usually wants. */
function conditionFor(f: Field): mk.RuleCondition {
  if (f.type === "choice" || f.type === "multi_choice") return { field: f.key, op: "one_of", values: [] };
  if (f.type === "number") return { field: f.key, op: "greater_than", value: 0 };
  return { field: f.key, op: "contains", value: "" };
}

/** A condition moved to another comparison, with a value that comparison reads. */
function withOp(c: mk.RuleCondition, op: mk.RuleOperator, f: Field | undefined): mk.RuleCondition {
  if (op === "one_of") return { field: c.field, op, values: [] };
  if (f?.type === "number" || op === "greater_than" || op === "less_than") return { field: c.field, op, value: 0 };
  if (f?.type === "choice" || f?.type === "multi_choice") return { field: c.field, op, value: f.options?.[0]?.value ?? "" };
  return { field: c.field, op, value: "" };
}

/**
 * A RULE OVER SEVERAL EARLIER ANSWERS, for a page or one question: show it or
 * hide it, when all of the conditions hold or any one, each naming an earlier
 * question and what its answer is. Nothing here decides whether the rule is
 * sound: core does when the form is saved, and says why in words.
 */
function RuleEditor({ name, rule, candidates, onChange }: {
  name: string; rule: mk.ShowRule; candidates: Field[]; onChange: (rule: mk.ShowRule) => void;
}) {
  const setCondition = (k: number, next: mk.RuleCondition) =>
    onChange({ ...rule, conditions: rule.conditions.map((c, j) => (j === k ? next : c)) });
  return (
    <div className="basis-full space-y-2 rounded border border-steel-200 p-2 text-xs text-ink-500">
      <div className="flex flex-wrap items-center gap-2">
        <select aria-label={`${name} show or hide`} value={rule.action} className={FIELD}
                onChange={(e) => onChange({ ...rule, action: e.target.value === "hide" ? "hide" : "show" })}>
          <option value="show">Show it</option>
          <option value="hide">Hide it</option>
        </select>
        <span>when</span>
        <select aria-label={`${name} all or any`} value={rule.match} className={FIELD}
                onChange={(e) => onChange({ ...rule, match: e.target.value === "any" ? "any" : "all" })}>
          <option value="all">all of these are true</option>
          <option value="any">any one of these is true</option>
        </select>
      </div>
      <ol className="space-y-2">
        {rule.conditions.map((c, k) => {
          const source = candidates.find((f) => f.key === c.field);
          const ops = source ? mk.RULE_OPERATORS_FOR[source.type as mk.FieldType] ?? [] : [];
          const label = `${name} condition ${k + 1}`;
          return (
            <li key={k} className="flex flex-wrap items-center gap-2">
              <select aria-label={`${label} question`} value={c.field} className={FIELD}
                      onChange={(e) => {
                        const next = candidates.find((f) => f.key === e.target.value);
                        if (next) setCondition(k, conditionFor(next));
                      }}>
                {source ? null : <option value={c.field}>{c.field} (no longer on the form)</option>}
                {candidates.map((f) => <option key={f.key} value={f.key}>{f.label || f.key}</option>)}
              </select>
              <select aria-label={`${label} test`} value={c.op} className={FIELD}
                      onChange={(e) => setCondition(k, withOp(c, e.target.value as mk.RuleOperator, source))}>
                {ops.map((op) => <option key={op} value={op}>{mk.RULE_OPERATOR_WORDS[op]}</option>)}
              </select>
              {c.op === "one_of" ? (
                <span className="flex flex-wrap gap-3">
                  {(source?.options ?? []).map((o) => (
                    <label key={o.value} className="flex items-center gap-1 text-sm text-ink-700">
                      <input type="checkbox" aria-label={`${label} ${o.label}`} checked={(c.values ?? []).includes(o.value)}
                             onChange={(e) => setCondition(k, {
                               ...c, values: e.target.checked ? [...(c.values ?? []), o.value] : (c.values ?? []).filter((v) => v !== o.value),
                             })} />
                      {o.label}
                    </label>
                  ))}
                </span>
              ) : source?.type === "choice" || source?.type === "multi_choice" ? (
                <select aria-label={`${label} answer`} value={String(c.value ?? "")} className={FIELD}
                        onChange={(e) => setCondition(k, { ...c, value: e.target.value })}>
                  {(source.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : source?.type === "number" ? (
                <input type="number" aria-label={`${label} answer`} className={`w-24 ${FIELD}`}
                       value={typeof c.value === "number" ? c.value : ""}
                       onChange={(e) => setCondition(k, { ...c, value: e.target.value === "" ? undefined : Number(e.target.value) })} />
              ) : (
                <input aria-label={`${label} answer`} className={`w-56 ${FIELD}`} maxLength={mk.MAX_RULE_TEXT}
                       value={typeof c.value === "string" ? c.value : ""}
                       onChange={(e) => setCondition(k, { ...c, value: e.target.value })} />
              )}
              {rule.conditions.length > 1 ? (
                <button type="button" className={BUTTON} aria-label={`Remove ${label}`}
                        onClick={() => onChange({ ...rule, conditions: rule.conditions.filter((_, j) => j !== k) })}>Remove</button>
              ) : null}
            </li>
          );
        })}
      </ol>
      {rule.conditions.length < mk.MAX_RULE_CONDITIONS && candidates.length > 0 ? (
        <button type="button" className={BUTTON} aria-label={`${name} add a condition`}
                onClick={() => onChange({ ...rule, conditions: [...rule.conditions, conditionFor(candidates[0]!)] })}>
          Add a condition
        </button>
      ) : null}
    </div>
  );
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
  const [pages, setPages] = useState<Page[]>(form.pages);
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

  /** The pick questions on pages before this one: the only answers a page can wait for. */
  const askedBefore = (at: number) => fields.filter((f) => (f.type === "choice" || f.type === "multi_choice") && (f.page ?? 0) < at);
  const setRule = (at: number, showWhen: Page["showWhen"]) =>
    setPages((all) => all.map((x, j) => {
      if (j !== at) return x;
      const { showWhen: _before, rule: _rule, ...rest } = x;
      return showWhen ? { ...rest, showWhen } : rest;
    }));
  /** The questions a page's rule over several answers can wait for: any that a rule reads, on pages before it. */
  const ruleableBefore = (at: number) => fields.filter((f) => ruleable(f) && (f.page ?? 0) < at);
  const setPageRule = (at: number, rule: mk.ShowRule | undefined) =>
    setPages((all) => all.map((x, j) => {
      if (j !== at) return x;
      const { showWhen: _before, rule: _rule, ...rest } = x;
      return rule ? { ...rest, rule } : rest;
    }));

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
                           onChange={(e) => setPages((all) => all.map((x, j) => (j === at ? { ...x, title: e.target.value } : x)))}
                           className={`mt-1 block w-72 ${FIELD}`} />
                  </label>
                  {at > 0 ? (
                    <label className="text-xs text-ink-500">Who sees page {at + 1}
                      <select aria-label={`Who sees page ${at + 1}`} value={p.rule ? "rule" : p.showWhen ? "when" : "all"}
                              onChange={(e) => {
                                if (e.target.value === "rule") {
                                  const first = ruleableBefore(at)[0];
                                  setPageRule(at, first ? { action: "show", match: "all", conditions: [conditionFor(first)] } : undefined);
                                  return;
                                }
                                const first = askedBefore(at)[0];
                                setRule(at, e.target.value === "when" && first ? { field: first.key, oneOf: [] } : undefined);
                              }}
                              className={`mt-1 block ${FIELD}`}>
                        <option value="all">Everybody</option>
                        <option value="when" disabled={askedBefore(at).length === 0}>Only some answers</option>
                        <option value="rule" disabled={ruleableBefore(at).length === 0}>Answers that match a rule</option>
                      </select>
                    </label>
                  ) : null}
                  <button type="button" className={BUTTON} onClick={() => removePage(at)} aria-label={`Remove page ${at + 1}`}>Remove</button>
                  {p.rule ? (
                    <RuleEditor name={`Page ${at + 1}`} rule={p.rule} candidates={ruleableBefore(at)}
                                onChange={(rule) => setPageRule(at, rule)} />
                  ) : null}
                  {p.showWhen ? (
                    <div className="basis-full space-y-1 pl-2 text-xs text-ink-500">
                      <label>Shown when the answer to
                        <select aria-label={`Page ${at + 1} waits for`} value={p.showWhen.field}
                                onChange={(e) => setRule(at, { field: e.target.value, oneOf: [] })}
                                className={`ml-2 ${FIELD}`}>
                          {askedBefore(at).map((f) => <option key={f.key} value={f.key}>{f.label || f.key}</option>)}
                        </select>
                      </label>
                      <fieldset className="flex flex-wrap gap-3">
                        <legend className="sr-only">Answers that show page {at + 1}</legend>
                        <span>is</span>
                        {(fields.find((f) => f.key === p.showWhen?.field)?.options ?? []).map((o) => (
                          <label key={o.value} className="flex items-center gap-1 text-sm text-ink-700">
                            <input type="checkbox" checked={p.showWhen!.oneOf.includes(o.value)}
                                   aria-label={`Show page ${at + 1} for ${o.label}`}
                                   onChange={(e) => setRule(at, {
                                     field: p.showWhen!.field,
                                     oneOf: e.target.checked
                                       ? [...p.showWhen!.oneOf, o.value] : p.showWhen!.oneOf.filter((v) => v !== o.value),
                                   })} />
                            {o.label}
                          </label>
                        ))}
                      </fieldset>
                    </div>
                  ) : null}
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
            {f.type !== "hidden" && f.type !== "honeypot" ? (
              <div className="mt-2 flex flex-wrap items-end gap-2">
                <label className="text-xs text-ink-500">Who is asked
                  <select aria-label={`Who is asked field ${i + 1}`} value={f.rule ? "rule" : "all"} className={`mt-1 block ${FIELD}`}
                          onChange={(e) => {
                            const first = fields.slice(0, i).filter(ruleable)[0];
                            const { rule: _rule, ...rest } = f;
                            setFields((all) => all.map((x, j) => (j !== i ? x
                              : e.target.value === "rule" && first ? { ...rest, rule: { action: "show", match: "all", conditions: [conditionFor(first)] } } : rest)));
                          }}>
                    <option value="all">Everybody who reaches it</option>
                    <option value="rule" disabled={fields.slice(0, i).filter(ruleable).length === 0}>Answers that match a rule</option>
                  </select>
                </label>
                {f.rule ? (
                  <RuleEditor name={`Field ${i + 1}`} rule={f.rule} candidates={fields.slice(0, i).filter(ruleable)}
                              onChange={(rule) => set(i, { rule })} />
                ) : null}
              </div>
            ) : null}
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
            ? <>Any of these can repeat a short answer: {[
              ...fields.filter((f) => REPEATABLE.has(f.type)).map((f) => `{{ ${f.key} }}`),
              ...(fields.some((f) => f.key === "name" || (f.type === "text" && /name/i.test(`${f.key} ${f.label}`))) ? ["{{ firstName }}"] : []),
            ].join(", ")}. In a text or an email an answer is cut short, and one with a web address in it is left out.</>
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
        <label className="block text-sm">When they gave no name, {"{{ firstName }}"} says
          <input name="firstNameFallback" defaultValue={form.settings.firstNameFallback ?? ""} maxLength={40} placeholder="there"
                 className={`mt-1 block w-72 ${FIELD}`} />
          <span className="mt-1 block text-xs text-ink-500">{"{{ firstName }}"} is the first word of their name. Left empty, this reads as "there".</span>
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
