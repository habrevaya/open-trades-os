import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects, projectLiens, NotFoundError } from "@opentradesos/api/services";
import { can, time } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { Empty } from "@/components/Table";
import { TextArea, TextField } from "@/components/ActionForm";
import { ProjectTabs } from "../../ProjectTabs";
import { LienForm } from "../../ChangeOrderForms";

export const dynamic = "force-dynamic";

const select = "mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm";

/**
 * NOTICES AND WAIVERS
 *
 * The paper that decides whether somebody gets paid, kept against the
 * payments it is about: notices sent and received, and conditional and
 * unconditional waivers for progress and final payments, with the scanned
 * copy. Beside them, a checklist per payment that says only what is on
 * file. It does not know any state's lien law and says so where the list
 * is read, because a checklist that looked like advice would be trusted as
 * advice.
 */
export default async function LiensPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  if (!can(user.actor, "invoice:read")) notFound();
  const ctx = { actor: user.actor, db: getDb() };
  const project = await projects.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const { records, checklist, disclaimer } = await projectLiens.list(ctx, { projectId: id });
  const byId = new Map(records.map((r) => [r.id, r]));
  const writes = can(user.actor, "invoice:write");
  const today = time.dateIn(new Date(), user.organizationTimezone);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href={`/projects/${id}`}>{project.name}</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Notices and waivers</h1>
      <ProjectTabs projectId={id} current="liens" money />
      <p className="mt-4 rounded-md border border-steel-200 bg-steel-100 p-3 text-sm text-ink-700">{disclaimer} Ask your lawyer what yours require.</p>

      <h2 className="mt-8 text-base font-semibold">Each payment</h2>
      {checklist.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">Nothing has been billed on this project yet.</p>
      ) : (
        <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {checklist.map((row) => (
            <li key={row.invoiceId} className="bg-canvas p-3 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{row.label}</span>
                <span className="tabular-nums"><Money value={row.amount} /></span>
                <Chip tone={row.paid ? "success" : "neutral"}>{row.paid ? "Paid" : "Not paid yet"}</Chip>
                <Chip tone={row.conditional.length > 0 ? "info" : "neutral"}>Conditional waiver {row.conditional.length > 0 ? "on file" : "none"}</Chip>
                <Chip tone={row.unconditional.length > 0 ? "info" : "neutral"}>Unconditional waiver {row.unconditional.length > 0 ? "on file" : "none"}</Chip>
              </div>
              {row.notes.length > 0 && (
                <ul className="mt-1 list-disc pl-5 text-ink-700">{row.notes.map((n) => <li key={n}>{n}</li>)}</ul>
              )}
              {[...row.conditional, ...row.unconditional].map((rid) => byId.get(rid)).filter(Boolean).length > 0 && (
                <p className="mt-1 text-xs text-ink-500">
                  {[...row.conditional, ...row.unconditional].map((rid) => byId.get(rid)!).map((r) => `${r.title}, ${r.onDate}`).join("; ")}
                </p>
              )}
            </li>
          ))}
        </ul>
      )}

      <h2 className="mt-8 text-base font-semibold">On file</h2>
      {records.length === 0 ? (
        <Empty title="Nothing recorded yet">Record each notice and waiver as it is sent or received, with the copy.</Empty>
      ) : (
        <div className="mt-2 overflow-x-auto rounded-md border border-steel-200">
          <table className="w-full text-sm">
            <thead className="bg-steel-100 text-left text-ink-700">
              <tr>
                <th className="px-3 py-2 font-medium">Date</th>
                <th className="px-3 py-2 font-medium">Document</th>
                <th className="px-3 py-2 font-medium">Party</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Payment</th>
                <th className="px-3 py-2 font-medium">Copy</th>
                {writes && <th className="px-3 py-2"><span className="sr-only">Remove</span></th>}
              </tr>
            </thead>
            <tbody className="divide-y divide-steel-200 bg-canvas">
              {records.map((r) => (
                <tr key={r.id}>
                  <td className="px-3 py-2 tabular-nums">{r.onDate}</td>
                  <td className="px-3 py-2">
                    {r.title}
                    <span className="block text-xs text-ink-500">
                      {r.kind === "waiver" ? `${r.condition} ${r.scope} waiver` : "Notice"}, {r.direction}
                      {r.throughDate ? `, through ${r.throughDate}` : ""}
                    </span>
                  </td>
                  <td className="px-3 py-2">{r.partyName}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.amount ? <Money value={r.amount} /> : ""}</td>
                  <td className="px-3 py-2">{r.invoiceNumber ? <a href={`/invoices/${r.invoiceId}`} className="underline underline-offset-4">Invoice {r.invoiceNumber}</a> : ""}</td>
                  <td className="px-3 py-2">
                    {r.documents.map((d) => (
                      <a key={d.id} href={`/files/${d.storageKey}`} className="block underline underline-offset-4">{d.fileName ?? "Copy"}</a>
                    ))}
                  </td>
                  {writes && (
                    <td className="px-3 py-2">
                      <LienForm submit="Remove" tone="quiet" className="" hidden={{ op: "delete", projectId: id, recordId: r.id }} />
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {writes && (
        <section className="mt-8 max-w-2xl" aria-label="Record a notice or waiver">
          <h2 className="text-base font-semibold">Record a notice or waiver</h2>
          <LienForm submit="Record" hidden={{ op: "record", projectId: id }}>
            <div className="grid gap-4 sm:grid-cols-2">
              <label className="block"><span className="text-sm font-medium text-ink-700">What it is</span>
                <select name="kind" className={select} defaultValue="waiver">
                  <option value="waiver">A waiver</option>
                  <option value="notice">A notice</option>
                </select>
              </label>
              <label className="block"><span className="text-sm font-medium text-ink-700">Sent or received</span>
                <select name="direction" className={select} defaultValue="sent">
                  <option value="sent">We sent or gave it</option>
                  <option value="received">We received it</option>
                </select>
              </label>
              <label className="block"><span className="text-sm font-medium text-ink-700">Waiver: conditional or not</span>
                <select name="condition" className={select} defaultValue="conditional">
                  <option value="conditional">Conditional</option>
                  <option value="unconditional">Unconditional</option>
                </select>
              </label>
              <label className="block"><span className="text-sm font-medium text-ink-700">Waiver: which payment</span>
                <select name="scope" className={select} defaultValue="progress">
                  <option value="progress">A progress payment</option>
                  <option value="final">The final payment</option>
                </select>
              </label>
              <TextField label="Title on the document" name="title" required placeholder="Conditional waiver on progress payment" />
              <TextField label="Sent to or received from" name="partyName" required defaultValue="" />
              <TextField label="Date sent, received or signed" name="onDate" type="date" required defaultValue={today} />
              <TextField label="Covers work through" name="throughDate" type="date" />
              <TextField label="Amount" name="amount" inputMode="decimal" />
              <label className="block"><span className="text-sm font-medium text-ink-700">Against payment</span>
                <select name="invoiceId" className={select} defaultValue="">
                  <option value="">None</option>
                  {checklist.map((row) => <option key={row.invoiceId} value={row.invoiceId}>{row.label}</option>)}
                </select>
              </label>
            </div>
            <label className="block"><span className="text-sm font-medium text-ink-700">The copy (PDF or photo)</span>
              <input type="file" name="document" accept="application/pdf,image/*" className="mt-1 block text-sm" />
            </label>
            <TextArea label="Notes" name="notes" />
            <p className="text-xs text-ink-500">The condition and payment apply to a waiver only; a notice ignores them.</p>
          </LienForm>
        </section>
      )}
    </div>
  );
}
