"use client";

import { useState } from "react";
import {
  MAX_OPTIONS, addBookLine, addOption, addTypedLine, builderProblem, builderTaxRate, decidable, draftTotals,
  findInPriceBook, formatAmount, invoiceFromEstimate, invoiceFromWork, newBuilder, optionTotal, parseAmount,
  presentationOrder, recommend, removeLine, removeOption, renameOption, setOptional,
  type Builder, type DayTask, type DayVisit, type FieldAbilities, type FieldEstimateOption, type PriceBookEntry,
} from "@opentradesos/field-client";
import { SignaturePad } from "./SignaturePad";

/**
 * SELLING AND CLOSING ON THE PAGE
 *
 * The same sale the phone app makes, from the same field client: good,
 * better and best built from the price book this page was given, turned
 * round to the customer with no cost anywhere, their choice and signature,
 * the invoice they sign for, and a question for the assistant. Every step is
 * handed to the day (`Day.tsx`), which puts it in the same queue as the rest
 * of the visit, so it is kept with no signal and sent when there is one.
 */

const button = "flex h-12 w-full items-center justify-center rounded border border-steel-300 px-4 text-base font-medium disabled:opacity-60";
const primary = "flex h-12 w-full items-center justify-center rounded bg-ink-900 px-4 text-base font-medium text-white disabled:opacity-60";
const field = "h-12 w-full rounded border border-steel-300 bg-canvas px-3 text-base";
const waitingNote = <span className="text-amber-700"> waiting to send</span>;

const STATUS: Record<string, string> = {
  draft: "Not shown yet", sent: "Sent to them", viewed: "They opened it", expired: "Past its date",
  approved: "Approved", declined: "They said no", converted: "Invoiced",
};

export interface SellHandlers {
  saveEstimate: (builder: Builder) => Promise<{ estimateId: string } | { problem: string }>;
  approve: (input: {
    estimateId: string; option: FieldEstimateOption; ticked: string[]; signerName: string; signature: string;
  }) => Promise<string | null>;
  decline: (estimateId: string, reason: string) => Promise<void>;
  raiseInvoice: (input: {
    shownTotal: string; signerName: string | null; signature: string | null;
  } & ({ source: "estimate"; estimateId: string } | { source: "work"; jobLineIds: string[] })) => Promise<string | null>;
}

/* ------------------------------------------------------------- estimates */

export function SellPanel({ visit, priceBook, abilities, handlers }: {
  visit: DayVisit; priceBook: PriceBookEntry[]; abilities: FieldAbilities; handlers: SellHandlers;
}) {
  const [mode, setMode] = useState<{ kind: "list" } | { kind: "build" } | { kind: "present"; estimateId: string }>({ kind: "list" });
  if (!abilities.writeEstimates && visit.estimates.length === 0) return null;

  if (mode.kind === "build") {
    return (
      <EstimateBuilder visit={visit} priceBook={priceBook} onCancel={() => setMode({ kind: "list" })}
                       onSave={async (builder) => {
                         const saved = await handlers.saveEstimate(builder);
                         if ("problem" in saved) return saved.problem;
                         setMode({ kind: "present", estimateId: saved.estimateId });
                         return null;
                       }} />
    );
  }
  if (mode.kind === "present") {
    const estimate = visit.estimates.find((e) => e.id === mode.estimateId);
    if (estimate) {
      return <Present visit={visit} estimateId={estimate.id} handlers={handlers} onDone={() => setMode({ kind: "list" })} />;
    }
  }

  return (
    <section aria-label="Estimates" className="space-y-2">
      <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Estimates</p>
      {visit.estimates.length === 0 && <p className="text-sm text-ink-500">No estimates on this job yet.</p>}
      {visit.estimates.map((estimate) => (
        <div key={estimate.id} className="rounded border border-steel-200 p-3">
          <p className="font-medium">
            {estimate.number ? `Estimate ${estimate.number}` : "New estimate"}{estimate.title ? `: ${estimate.title}` : ""}
          </p>
          <p className="text-sm text-ink-500">
            {STATUS[estimate.status] ?? estimate.status}
            {estimate.signerName ? `, signed by ${estimate.signerName}` : ""}
            {estimate.waiting ? waitingNote : null}
          </p>
          <p className="text-sm text-ink-700">{estimate.options.map((o) => `${o.name} ${formatAmount(o.total)}`).join(" · ")}</p>
          {abilities.presentEstimates && (
            <button type="button" className={`${button} mt-2`} onClick={() => setMode({ kind: "present", estimateId: estimate.id })}>
              Show the customer
            </button>
          )}
        </div>
      ))}
      {abilities.writeEstimates && (
        <button type="button" className={button} onClick={() => setMode({ kind: "build" })}>Build good, better, best</button>
      )}
    </section>
  );
}

/**
 * Good, better and best from the price book on the page, searched with no
 * signal, each line at the book's price with the member's discount shown as
 * it will be charged. No cost: the next screen faces the customer.
 */
function EstimateBuilder({ visit, priceBook, onSave, onCancel }: {
  visit: DayVisit; priceBook: PriceBookEntry[];
  onSave: (builder: Builder) => Promise<string | null>; onCancel: () => void;
}) {
  const newId = () => crypto.randomUUID();
  const [builder, setBuilder] = useState<Builder>(() => newBuilder(newId, visit.summary));
  const [query, setQuery] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [price, setPrice] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const taxRate = builderTaxRate(builder) ?? "0";
  const active = builder.options[builder.active]!;
  const matches = findInPriceBook(priceBook, query);

  const added = (result: { ok: true; builder: Builder } | { ok: false; problem: string }) => {
    if (!result.ok) { setProblem(result.problem); return; }
    setProblem(null);
    setBuilder(result.builder);
    setQuery("");
    setQuantity("1");
    setPrice("");
  };

  return (
    <section aria-label="New estimate" className="space-y-3 rounded border border-steel-300 p-3">
      <p className="font-medium">New estimate for {visit.customer.name}</p>
      {visit.member && (
        <p className="rounded bg-green-tint px-3 py-2 text-sm text-green-700">
          {visit.member.planName} member. Their discount is taken off as you build.
        </p>
      )}
      <div role="tablist" aria-label="Options" className="flex flex-wrap gap-2">
        {builder.options.map((option, i) => (
          <button key={option.id} type="button" role="tab" aria-selected={i === builder.active}
                  onClick={() => setBuilder({ ...builder, active: i })}
                  className={`h-14 min-w-24 rounded border px-3 text-sm font-medium ${i === builder.active ? "border-ink-900 bg-ink-900 text-white" : "border-steel-300"}`}>
            <span className="block">{option.name || "Unnamed"}</span>
            <span className="block tabular-nums">{formatAmount(draftTotals(option, visit.member, taxRate).totals.total)}</span>
          </button>
        ))}
        {builder.options.length < MAX_OPTIONS && (
          <button type="button" className="h-14 rounded border border-steel-300 px-3 text-sm font-medium"
                  onClick={() => setBuilder(addOption(builder, newId))}>
            Add an option
          </button>
        )}
      </div>

      <label className="block">
        <span className="text-sm font-medium">Option name</span>
        <input value={active.name} onChange={(e) => setBuilder(renameOption(builder, builder.active, e.target.value))} className={field} />
      </label>
      <div className="flex gap-2">
        <button type="button" className={button} onClick={() => setBuilder(recommend(builder, builder.active))}>
          {active.isRecommended ? "Recommended" : "Recommend this one"}
        </button>
        {builder.options.length > 1 && (
          <button type="button" className={button} onClick={() => setBuilder(removeOption(builder, builder.active))}>Remove option</button>
        )}
      </div>

      <ul className="space-y-2">
        {active.lines.length === 0 && <li className="text-sm text-ink-500">Nothing on it yet. Find something below.</li>}
        {active.lines.map((line) => {
          const priced = draftTotals({ ...active, lines: [line] }, visit.member, taxRate).lines[0]!;
          return (
            <li key={line.id} className="rounded border border-steel-200 p-2">
              <p className="font-medium">{Number(line.quantity)} x {line.name}</p>
              {line.description && <p className="text-sm text-ink-500">{line.description}</p>}
              <p className="text-sm tabular-nums">
                {formatAmount(priced.gross)}
                {/[1-9]/.test(priced.memberDiscount) ? `, member saves ${formatAmount(priced.memberDiscount)}` : ""}
              </p>
              <div className="mt-2 flex gap-2">
                <button type="button" className={button} onClick={() => setBuilder(setOptional(builder, line.id, !line.isOptional))}>
                  {line.isOptional ? "Optional extra" : "Make it optional"}
                </button>
                <button type="button" className={button} onClick={() => setBuilder(removeLine(builder, line.id))}>Remove</button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="flex gap-2">
        <label className="flex-[3]">
          <span className="sr-only">Find in the price book</span>
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find an item or a kit" className={field}
                 aria-label="Find in the price book" />
        </label>
        <label className="flex-1">
          <span className="sr-only">How many</span>
          <input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="decimal" className={field} aria-label="How many" />
        </label>
      </div>
      {matches.length > 0 && (
        <ul className="divide-y divide-steel-200 rounded border border-steel-200">
          {matches.map((entry) => (
            <li key={entry.versionId}>
              <button type="button" className="flex min-h-12 w-full items-center justify-between gap-2 px-3 text-left"
                      aria-label={`Add ${entry.name}`}
                      onClick={() => added(addBookLine(builder, entry, quantity, newId))}>
                <span>
                  <span className="block">{entry.code ? `${entry.code} ` : ""}{entry.name}</span>
                  {(entry.components ?? []).length > 0 && (
                    <span className="block text-sm text-ink-500">Kit: {(entry.components ?? []).map((c) => c.name).join(", ")}</span>
                  )}
                </span>
                <span className="tabular-nums text-ink-700">{formatAmount(entry.unitPrice)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {query.trim() !== "" && (
        <div className="flex gap-2">
          <input value={price} onChange={(e) => setPrice(e.target.value)} inputMode="decimal" placeholder="Price" className={`${field} flex-1`}
                 aria-label="Price" />
          <button type="button" className={`${button} flex-[2]`} onClick={() => added(addTypedLine(builder, query, price, quantity, newId))}>
            Add &ldquo;{query.trim()}&rdquo;
          </button>
        </div>
      )}

      <label className="block">
        <span className="text-sm font-medium">Sales tax, percent</span>
        <input value={builder.taxPercent} onChange={(e) => setBuilder({ ...builder, taxPercent: e.target.value })} inputMode="decimal"
               placeholder="Leave empty for none" className={field} />
      </label>

      {problem && <p role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{problem}</p>}
      <button type="button" className={primary} disabled={saving} onClick={async () => {
        const wrong = builderProblem(builder);
        if (wrong) { setProblem(wrong); return; }
        setSaving(true);
        setProblem(await onSave(builder));
        setSaving(false);
      }}>
        {saving ? "Saving" : "Save and show the customer"}
      </button>
      <button type="button" className={button} onClick={onCancel}>Cancel</button>
    </section>
  );
}

/**
 * The customer's screen: the options in the order a proposal uses, each line
 * at its price with the member's saving said, the extras to tick, and the
 * total for what is ticked. Their signature goes with the figure they saw,
 * and the server checks the two before it records a yes.
 */
function Present({ visit, estimateId, handlers, onDone }: {
  visit: DayVisit; estimateId: string; handlers: SellHandlers; onDone: () => void;
}) {
  const estimate = visit.estimates.find((e) => e.id === estimateId)!;
  const [chosen, setChosen] = useState<string | null>(null);
  const [ticked, setTicked] = useState<string[]>([]);
  const [stage, setStage] = useState<"choose" | "sign" | "decline">("choose");
  const [name, setName] = useState(visit.customer.name);
  const [reason, setReason] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const options = presentationOrder(estimate.options);
  const option = options.find((o) => o.id === chosen) ?? null;
  const open = decidable(estimate);

  return (
    <section aria-label="Your options" className="space-y-3 rounded border border-ink-900 p-3">
      <p className="text-lg font-semibold">{estimate.title ?? "Your options"}</p>
      <p className="text-sm text-ink-500">For {visit.customer.name}{visit.member ? `, ${visit.member.planName} member pricing` : ""}</p>
      {!open && (
        <p role="status" className="rounded bg-green-tint px-3 py-2 text-sm text-green-700">
          {estimate.status === "declined" ? "They said no to this one." : `Chosen${estimate.signerName ? ` and signed by ${estimate.signerName}` : ""}.`}
          {estimate.waiting ? " Waiting to send." : ""}
        </p>
      )}

      {stage === "choose" && (
        <div role="radiogroup" aria-label="Options" className="space-y-3">
          {options.map((o) => {
            const picked = o.id === chosen || (!open && estimate.selectedOptionId === o.id);
            const total = optionTotal(o, o.id === chosen ? ticked : o.lines.filter((l) => l.isOptional && l.isSelected).map((l) => l.id));
            return (
              <div key={o.id} role="radio" aria-checked={picked} aria-label={`${o.name}, ${formatAmount(total)}`} tabIndex={0}
                   onClick={open ? () => { setChosen(o.id); setTicked([]); } : undefined}
                   onKeyDown={(e) => { if (open && (e.key === "Enter" || e.key === " ")) { setChosen(o.id); setTicked([]); } }}
                   className={`cursor-pointer rounded border-2 p-3 ${picked ? "border-ink-900" : "border-steel-200"}`}>
                <div className="flex items-baseline justify-between gap-2">
                  <p className="font-medium">{o.name}{o.isRecommended ? " (recommended)" : ""}</p>
                  <p className="text-xl font-semibold tabular-nums">{formatAmount(total)}</p>
                </div>
                {o.description && <p className="text-sm text-ink-500">{o.description}</p>}
                <ul className="mt-2 divide-y divide-steel-200">
                  {o.lines.map((line) => {
                    const included = !line.isOptional || (o.id === chosen ? ticked.includes(line.id) : line.isSelected);
                    return (
                      <li key={line.id} className="py-2 text-sm">
                        <div className="flex justify-between gap-2">
                          <span>{Number(line.quantity) === 1 ? "" : `${Number(line.quantity)} x `}{line.name}
                            {line.isOptional ? (included ? " (added)" : " (optional)") : ""}</span>
                          <span className="tabular-nums">{formatAmount(line.unitPrice)}</span>
                        </div>
                        {/[1-9]/.test(line.memberDiscountAmount) && (
                          <p className="text-green-700">Member saves {formatAmount(line.memberDiscountAmount)}</p>
                        )}
                        {line.isOptional && open && o.id === chosen && (
                          <button type="button" className={`${button} mt-1`}
                                  onClick={(e) => { e.stopPropagation(); setTicked((t) => (t.includes(line.id) ? t.filter((x) => x !== line.id) : [...t, line.id])); }}>
                            {included ? "Take it off" : `Add ${line.name}`}
                          </button>
                        )}
                      </li>
                    );
                  })}
                </ul>
              </div>
            );
          })}
        </div>
      )}

      {estimate.terms && stage !== "decline" && (
        <details className="rounded border border-steel-200 p-3 text-sm">
          <summary className="cursor-pointer font-medium">Terms</summary>
          <p className="mt-2 whitespace-pre-line text-ink-700">{estimate.terms}</p>
        </details>
      )}

      {open && stage === "choose" && (
        <div className="space-y-2">
          <button type="button" className={primary} disabled={!option} onClick={() => setStage("sign")}>
            {option ? `Choose ${option.name}: ${formatAmount(optionTotal(option, ticked))}` : "Tap an option to choose it"}
          </button>
          <button type="button" className={button} onClick={() => setStage("decline")}>Not today</button>
        </div>
      )}

      {stage === "sign" && option && (
        <div className="space-y-2">
          <p className="font-medium">{option.name}: <span className="tabular-nums">{formatAmount(optionTotal(option, ticked))}</span></p>
          <p className="text-sm text-ink-500">Signing approves this option and its price.</p>
          <label className="block">
            <span className="text-sm font-medium">Name of the person signing</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
          </label>
          <SignaturePad label="Customer's signature" pending={pending} onSign={async (png) => {
            if (name.trim() === "") { setProblem("Their name, please."); return; }
            setPending(true);
            const failed = await handlers.approve({ estimateId, option, ticked, signerName: name.trim(), signature: png });
            setPending(false);
            setProblem(failed);
            if (!failed) onDone();
          }} />
          <button type="button" className={button} onClick={() => setStage("choose")}>Back to the options</button>
        </div>
      )}

      {stage === "decline" && (
        <div className="space-y-2">
          <label className="block">
            <span className="text-sm font-medium">What did they say?</span>
            <textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={2}
                      className="w-full rounded border border-steel-300 p-3 text-base" placeholder="Getting another quote, too dear, not now" />
          </label>
          <button type="button" className={button} onClick={async () => { await handlers.decline(estimateId, reason); onDone(); }}>
            Record that they said no
          </button>
          <button type="button" className={button} onClick={() => setStage("choose")}>Back to the options</button>
        </div>
      )}

      {problem && <p role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{problem}</p>}
      {stage === "choose" && <button type="button" className={button} onClick={onDone}>Close</button>}
    </section>
  );
}

/* --------------------------------------------------------------- invoice */

/**
 * The invoice, for the option the customer signed for or for the parts and
 * charges recorded, never both, shown at the figure the server will write
 * and signed for. A figure the office's prices disagree with is kept as a
 * draft by the server rather than issued, and the day says so.
 */
export function InvoicePanel({ visit, abilities, handlers }: { visit: DayVisit; abilities: FieldAbilities; handlers: SellHandlers }) {
  const [source, setSource] = useState<string | null>(null);
  const [leftOut, setLeftOut] = useState<string[]>([]);
  const [stage, setStage] = useState<"list" | "choose" | "show">("list");
  const [name, setName] = useState(visit.customer.name);
  const [problem, setProblem] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  if (!abilities.raiseInvoices) return null;

  const signedFor = visit.estimates
    .filter((e) => e.status === "approved" && (e.jobId === null || e.jobId === visit.jobId))
    .map((e) => ({ estimate: e, invoice: invoiceFromEstimate(e) }))
    .filter((x) => x.invoice !== null);
  const work = visit.billable.filter((b) => !leftOut.includes(b.id));
  const priced = invoiceFromWork(work, visit.member);
  const chosen = signedFor.find((x) => x.estimate.id === source) ?? null;
  const total = chosen ? chosen.invoice!.total : priced.totals.total;
  const canBill = signedFor.length > 0 || visit.billable.length > 0;

  const raise = async (signature: string | null) => {
    setPending(true);
    const signerName = signature ? name.trim() : null;
    const failed = chosen
      ? await handlers.raiseInvoice({ source: "estimate", estimateId: chosen.estimate.id, shownTotal: total, signerName, signature })
      : await handlers.raiseInvoice({ source: "work", jobLineIds: work.map((w) => w.id), shownTotal: total, signerName, signature });
    setPending(false);
    setProblem(failed);
    if (!failed) { setStage("list"); setSource(null); }
  };

  return (
    <section aria-label="Invoice" className="space-y-2">
      <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Invoice</p>
      {visit.invoices.map((invoice) => (
        <p key={invoice.id} className="text-sm text-ink-700">
          {invoice.number ? `Invoice ${invoice.number}` : "Invoice raised here"}: {formatAmount(invoice.total)},{" "}
          {invoice.status === "paid" ? "paid" : `${formatAmount(invoice.balance)} owing`}
          {invoice.waiting ? waitingNote : null}
        </p>
      ))}
      {stage === "list" && (canBill
        ? <button type="button" className={button} onClick={() => setStage("choose")}>Raise the invoice</button>
        : visit.invoices.length === 0 && <p className="text-sm text-ink-500">Nothing to bill yet: add the parts used, or have the customer choose an option.</p>)}

      {stage === "choose" && (
        <div role="radiogroup" aria-label="What to bill" className="space-y-2">
          {signedFor.map(({ estimate, invoice }) => (
            <label key={estimate.id} className={`flex cursor-pointer gap-2 rounded border-2 p-3 ${source === estimate.id ? "border-ink-900" : "border-steel-200"}`}>
              <input type="radio" name={`bill-${visit.id}`} checked={source === estimate.id} onChange={() => setSource(estimate.id)} />
              <span>
                <span className="block font-medium">The option they signed for: {invoice!.option.name}</span>
                <span className="block text-sm tabular-nums">{formatAmount(invoice!.total)}, as signed</span>
              </span>
            </label>
          ))}
          {visit.billable.length > 0 && (
            <label className={`flex cursor-pointer gap-2 rounded border-2 p-3 ${source === "work" ? "border-ink-900" : "border-steel-200"}`}>
              <input type="radio" name={`bill-${visit.id}`} checked={source === "work"} onChange={() => setSource("work")} />
              <span>
                <span className="block font-medium">The parts and charges recorded</span>
                <span className="block text-sm tabular-nums">{formatAmount(invoiceFromWork(visit.billable, visit.member).totals.total)}</span>
              </span>
            </label>
          )}
          {source === "work" && visit.billable.map((b) => (
            <label key={b.id} className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={!leftOut.includes(b.id)}
                     onChange={() => setLeftOut((l) => (l.includes(b.id) ? l.filter((x) => x !== b.id) : [...l, b.id]))} />
              {Number(b.quantity)} x {b.name}
            </label>
          ))}
          {signedFor.length > 0 && visit.billable.length > 0 && (
            <p className="text-sm text-ink-500">Parts used for an option they signed for are usually covered by its price. Leave them for the office.</p>
          )}
          <button type="button" className={primary} disabled={source === null || (source === "work" && work.length === 0)}
                  onClick={() => setStage("show")}>
            Show the customer
          </button>
          <button type="button" className={button} onClick={() => setStage("list")}>Cancel</button>
        </div>
      )}

      {stage === "show" && (
        <div className="space-y-2 rounded border border-ink-900 p-3">
          <ul className="divide-y divide-steel-200 text-sm">
            {(chosen
              ? chosen.invoice!.lines.map((l) => ({ id: l.id, name: l.name, quantity: l.quantity, price: l.unitPrice, saved: l.memberDiscountAmount }))
              : priced.lines.map((l) => ({ id: l.id, name: l.name, quantity: l.quantity, price: l.unitPrice, saved: l.memberDiscount }))
            ).map((l) => (
              <li key={l.id} className="py-2">
                <div className="flex justify-between gap-2">
                  <span>{Number(l.quantity) === 1 ? "" : `${Number(l.quantity)} x `}{l.name}</span>
                  <span className="tabular-nums">{formatAmount(l.price)}</span>
                </div>
                {/[1-9]/.test(l.saved) && <p className="text-green-700">Member saves {formatAmount(l.saved)}</p>}
              </li>
            ))}
          </ul>
          <p className="flex justify-between text-lg font-semibold"><span>Total</span><span className="tabular-nums">{formatAmount(total)}</span></p>
          <label className="block">
            <span className="text-sm font-medium">Name of the person signing</span>
            <input value={name} onChange={(e) => setName(e.target.value)} className={field} />
          </label>
          <SignaturePad label="Customer's signature on the invoice" pending={pending} onSign={(png) => {
            if (name.trim() === "") { setProblem("Their name, please."); return; }
            void raise(png);
          }} />
          <button type="button" className={button} disabled={pending} onClick={() => void raise(null)}>
            The customer is not here: raise it unsigned
          </button>
          <button type="button" className={button} onClick={() => setStage("choose")}>Back</button>
        </div>
      )}
      {problem && <p role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{problem}</p>}
    </section>
  );
}

/* ---------------------------------------------------------- a cash tip */

/**
 * Cash a customer handed the technician for themselves, kept, and recorded
 * for their pay statement, where a tip a person keeps is reported as pay.
 */
export function CashTip({ visit, onRecord }: { visit: DayVisit; onRecord: (amount: string) => Promise<void> }) {
  const [amount, setAmount] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <section aria-label="A cash tip for you" className="space-y-2">
      <p className="text-xs uppercase tracking-[0.08em] text-ink-500">A cash tip for you</p>
      <p className="text-sm text-ink-500">Kept by you. Recorded for your pay statement, where tips are reported.</p>
      <div className="flex gap-2">
        <input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Cash tip, in dollars"
               placeholder="0.00" className={`${field} flex-1`} />
        <button type="button" className={`${button} flex-1`} onClick={async () => {
          const parsed = parseAmount(amount);
          if (!parsed) { setProblem("Enter the tip, like 20 or 20.50."); return; }
          setProblem(null);
          await onRecord(parsed);
          setAmount("");
        }}>Record tip</button>
      </div>
      {problem && <p role="alert" className="rounded bg-red-tint px-3 py-2 text-sm text-red-600">{problem}</p>}
      {visit.cashTips.map((tip) => (
        <p key={tip.clientId} className="text-sm text-ink-700">Cash tip {formatAmount(tip.amount)}{tip.waiting ? waitingNote : ", recorded"}</p>
      ))}
    </section>
  );
}

/* ----------------------------------------------------------------- tasks */

/** The office's queue on the day: take a task, finish your own. */
export function TasksPanel({ tasks, zone, onClaim, onDone }: {
  tasks: DayTask[]; zone: string;
  onClaim: (taskId: string) => void; onDone: (taskId: string, outcome: string) => void;
}) {
  const [outcomes, setOutcomes] = useState<Record<string, string>>({});
  const open = tasks.filter((t) => !t.done || t.waiting);
  if (open.length === 0) return null;
  return (
    <section aria-label="Tasks" className="space-y-2 rounded-md border border-steel-200 p-3">
      <p className="text-sm font-medium">Tasks</p>
      {open.map((task) => {
        const due = task.dueAt
          ? new Date(task.dueAt).toLocaleString("en-US", { timeZone: zone, weekday: "short", hour: "numeric", minute: "2-digit" })
          : null;
        const checklist = task.checklistTotal > 0;
        return (
          <div key={task.id} className="rounded border border-steel-200 p-2">
            <p className="font-medium">{task.title}</p>
            {task.body && <p className="text-sm text-ink-500">{task.body}</p>}
            <p className={`text-sm ${task.overdue ? "text-red-600" : "text-ink-500"}`}>
              {[due ? `Due ${due}` : null, task.overdue ? "late" : null, task.mine ? "yours" : "nobody has it",
                checklist ? `${task.checklistDone} of ${task.checklistTotal} ticked` : null].filter(Boolean).join(", ")}
              {task.waiting ? waitingNote : null}
            </p>
            {task.done && <p className="text-sm text-green-700">Done here.</p>}
            {!task.mine && !task.done && <button type="button" className={`${button} mt-2`} onClick={() => onClaim(task.id)}>Take it</button>}
            {task.mine && !task.done && !checklist && (
              <div className="mt-2 flex gap-2">
                <input value={outcomes[task.id] ?? ""} onChange={(e) => setOutcomes({ ...outcomes, [task.id]: e.target.value })}
                       placeholder="What happened" aria-label={`What happened, ${task.title}`} className={`${field} flex-[2]`} />
                <button type="button" className={`${button} flex-1`} onClick={() => onDone(task.id, outcomes[task.id] ?? "")}>Done</button>
              </div>
            )}
            {task.mine && !task.done && checklist && (
              <a href={`/tasks/${task.id}`} className="mt-2 block text-sm text-blue-600 underline underline-offset-4">Tick its checklist and finish it</a>
            )}
          </div>
        );
      })}
    </section>
  );
}

/* -------------------------------------------------------------- the assistant */

/**
 * A question for the field assistant, answered from the company's records.
 * Needs a signal: it asks a model, and nothing about it is queued.
 */
export function Ask({ onAsk }: {
  onAsk: (question: string) => Promise<{ ok: true; answered: boolean; text: string; sources: Array<{ kind: string; title: string }> } | { ok: false; message: string }>;
}) {
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [reply, setReply] = useState<{ text: string; from: string | null; problem: boolean } | null>(null);
  return (
    <section aria-label="Ask about this job" className="space-y-2">
      <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Ask about this job</p>
      <textarea value={question} onChange={(e) => setQuestion(e.target.value)} rows={2} aria-label="Your question"
                placeholder="When was this unit last serviced?" className="w-full rounded border border-steel-300 p-3 text-base" />
      <button type="button" className={button} disabled={busy || question.trim().length < 3} onClick={async () => {
        setBusy(true);
        try {
          const answer = await onAsk(question.trim());
          setReply(answer.ok
            ? { text: answer.text, from: answer.sources.length > 0 ? answer.sources.map((s) => s.title).join("; ") : null, problem: false }
            : { text: answer.message, from: null, problem: true });
        } catch {
          setReply({ text: "No signal, so the assistant cannot look. Try again when you have a signal.", from: null, problem: true });
        } finally {
          setBusy(false);
        }
      }}>{busy ? "Looking" : "Ask"}</button>
      {reply && (
        <div role="status" className={`rounded px-3 py-2 text-sm ${reply.problem ? "bg-red-tint text-red-600" : "bg-steel-100 text-ink-900"}`}>
          <p>{reply.text}</p>
          {reply.from && <p className="mt-1 text-ink-500">From: {reply.from}</p>}
        </div>
      )}
    </section>
  );
}
