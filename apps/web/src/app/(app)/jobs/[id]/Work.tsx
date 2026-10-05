import { Money } from "@opentradesos/ui";
import { ActionForm, TextArea } from "@/components/ActionForm";
import { Table, Th, Td } from "@/components/Table";
import type { FormState } from "@/lib/actions";
import { PART_ROWS } from "./parts";

/**
 * The server actions are passed in rather than imported, so these render in
 * a test without a request to sign anybody in from.
 */
type Action = (previous: FormState, form: FormData) => Promise<FormState>;

/** A visit that still has work to do. Anything else is finished or called off. */
export const OPEN_VISIT = ["unassigned", "scheduled", "dispatched", "en_route", "working"] as const;

export interface UsedLine {
  id: string;
  name: string;
  quantity: string;
  unitPrice: string;
  invoiceLineId: string | null;
  nonBillableReason: string | null;
}

/**
 * Finishing a visit from the office: what was done, and what was used.
 *
 * Parts are picked from the price book rather than typed, because the job
 * line keeps the version it was priced from, and a typed name is a line
 * nobody can trace back to what it cost.
 */
export function CompleteVisit({
  action, jobId, visit, items,
}: {
  action: Action;
  jobId: string;
  visit: { id: string; sequence: number };
  items: { id: string; name: string; price: string }[];
}) {
  return (
    <details className="mt-3 rounded-md border border-steel-200 p-4">
      <summary className="cursor-pointer text-sm font-medium">Complete visit {visit.sequence}</summary>
      <ActionForm action={action} submit={`Complete visit ${visit.sequence}`}
                  hidden={{ jobId, visitId: visit.id }} className="mt-3 space-y-4">
        <TextArea label={`What was done on visit ${visit.sequence}`} name="technicianNotes" maxLength={10000} />
        {items.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-ink-700">Used</legend>
            {Array.from({ length: PART_ROWS }, (_, i) => (
              <div key={i} className="flex flex-wrap gap-2">
                <select name={`partItem${i}`} aria-label={`Used, line ${i + 1}`} defaultValue=""
                        className="h-10 min-w-64 flex-1 rounded border border-steel-300 bg-canvas px-3 text-sm">
                  <option value="">Nothing</option>
                  {items.map((item) => (
                    <option key={item.id} value={item.id}>{item.name} (${Number(item.price).toFixed(2)})</option>
                  ))}
                </select>
                <input name={`partQuantity${i}`} aria-label={`Quantity, line ${i + 1}`} defaultValue="1"
                       inputMode="decimal" className="h-10 w-24 rounded border border-steel-300 bg-canvas px-3 text-sm" />
              </div>
            ))}
          </fieldset>
        )}
      </ActionForm>
    </details>
  );
}

/**
 * Moving the job, not a visit: finishing one with nothing left open, and
 * reopening a finished one.
 */
export function JobLifecycle({
  action, jobId, status, openVisits,
}: { action: Action; jobId: string; status: string; openVisits: number }) {
  if (status === "completed") {
    return (
      <ActionForm action={action} submit="Reopen job" tone="quiet"
                  hidden={{ jobId, status: "in_progress" }} className="mt-4">
        <p className="text-sm text-ink-700">
          Finished. Reopen it if the customer calls back about this work, then add a visit.
        </p>
      </ActionForm>
    );
  }
  if (openVisits === 0 && ["lead", "scheduled", "in_progress", "on_hold"].includes(status)) {
    return (
      <ActionForm action={action} submit="Mark job complete" tone="quiet"
                  hidden={{ jobId, status: "completed" }} className="mt-4">
        <p className="text-sm text-ink-700">No visit on this job is still open.</p>
      </ActionForm>
    );
  }
  return null;
}

/**
 * Calling the whole job off. The visits still to come are offered with it,
 * ticked, for somebody who may cancel visits: a job cancelled with its
 * visits left on the board sends a van to work nobody wants. Visits already
 * under way are named and left, because the person on one is the one to
 * ring.
 */
export function CancelJob({
  action, jobId, status, toCome, underWay, mayCancelVisits,
}: {
  action: Action; jobId: string; status: string;
  /** Visits not started whose window has not passed. */
  toCome: number;
  /** Visits somebody is on the way to or working. */
  underWay: number;
  mayCancelVisits: boolean;
}) {
  if (!["lead", "estimating", "scheduled", "in_progress", "on_hold", "completed"].includes(status)) return null;
  return (
    <details className="mt-4 rounded-md border border-steel-200 p-4">
      <summary className="cursor-pointer text-sm font-medium">Cancel this job</summary>
      <ActionForm action={action} submit="Cancel the job" tone="danger"
                  hidden={{ jobId, status: "cancelled" }} className="mt-3 space-y-3">
        <p className="text-sm text-ink-700">The job stays on record as cancelled. Nothing is deleted.</p>
        {toCome > 0 && mayCancelVisits && (
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" name="cancelVisits" value="1" defaultChecked className="mt-0.5 h-4 w-4" />
            <span>
              Also cancel its {toCome === 1 ? "visit" : `${toCome} visits`} still to come, and tell the
              technicians on {toCome === 1 ? "it" : "them"} not to go
            </span>
          </label>
        )}
        {toCome > 0 && !mayCancelVisits && (
          <p className="text-sm text-amber-700">
            Its {toCome === 1 ? "visit" : `${toCome} visits`} still to come stay on the board. Ask somebody who
            reschedules visits to cancel {toCome === 1 ? "it" : "them"}.
          </p>
        )}
        {underWay > 0 && (
          <p className="text-sm text-amber-700">
            {underWay === 1 ? "One visit is" : `${underWay} visits are`} already under way and{" "}
            {underWay === 1 ? "is" : "are"} left as {underWay === 1 ? "it is" : "they are"}. Call whoever is on{" "}
            {underWay === 1 ? "it" : "them"}.
          </p>
        )}
      </ActionForm>
    </details>
  );
}

/** What was used on the job, and whether each one has been billed. */
export function UsedOnJob({ lines }: { lines: UsedLine[] }) {
  if (lines.length === 0) return null;
  return (
    <section aria-label="Used on this job">
      <h2 className="mt-10 text-base font-semibold">Used on this job</h2>
      <Table head={<><Th>Item</Th><Th className="text-right">Qty</Th><Th className="text-right">Price</Th><Th>Billed</Th></>}>
        {lines.map((line) => (
          <tr key={line.id}>
            <Td className="font-medium">{line.name}</Td>
            <Td className="text-right font-mono tabular-nums">{Number(line.quantity)}</Td>
            <Td className="text-right"><Money value={line.unitPrice} /></Td>
            <Td className="text-ink-700">
              {line.nonBillableReason ? `Not billed: ${line.nonBillableReason}`
                : line.invoiceLineId ? "On an invoice" : "Not yet"}
            </Td>
          </tr>
        ))}
      </Table>
    </section>
  );
}
