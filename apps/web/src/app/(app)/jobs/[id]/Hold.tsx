import { work } from "@opentradesos/core";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import type { FormState } from "@/lib/actions";

/**
 * The server actions are passed in rather than imported, as in `Work.tsx`, so
 * these render in a test without a request to sign anybody in from.
 */
type Action = (previous: FormState, form: FormData) => Promise<FormState>;

export interface HoldRow {
  id: string;
  reason: string;
  reasonLabel: string;
  purchaseOrderId: string | null;
  purchaseOrderNumber: number | null;
  purchaseOrderStatus: string | null;
  note: string | null;
  placedAt: string;
  placedByName: string | null;
  releasedAt: string | null;
}

/** A purchase order the part could be on. */
export interface OrderChoice { id: string; number: number; vendorName: string; status: string }

const ORDER_STATUS: Record<string, string> = {
  draft: "not sent yet", submitted: "sent", acknowledged: "confirmed", partially_received: "part received", received: "received",
};

/**
 * WHY THE JOB IS WAITING
 *
 * On hold with the reason, what it is waiting for and since when, and the
 * button to take it off; or the form that puts it on hold. A part hold names
 * the order the part is on, which is what makes "held for a part order" a
 * fact the first time fix rate can leave out, so the order list is the
 * company's open orders and a part with no order yet is sent to Purchasing
 * first. Shown to whoever may change the job.
 */
export function JobHoldPanel({
  jobId, status, holds, orders, mayNameOrder, timezone, place, release,
}: {
  jobId: string;
  status: string;
  holds: HoldRow[];
  /** Open purchase orders, or empty for somebody who may not read them. */
  orders: OrderChoice[];
  mayNameOrder: boolean;
  timezone: string;
  place: Action;
  release: Action;
}) {
  const open = holds.find((h) => h.releasedAt === null) ?? null;
  const holdable = ["scheduled", "in_progress", "on_hold"].includes(status);
  if (!open && !holdable) return null;

  if (open) {
    return (
      <section aria-label="On hold" className="mt-6 rounded-md border border-amber-700 bg-amber-tint p-4 text-sm">
        <p><span className="font-medium">On hold:</span> {open.reasonLabel}{open.note ? `. ${open.note}` : ""}</p>
        {open.purchaseOrderId ? (
          <p className="mt-1">
            The part is on{" "}
            {open.purchaseOrderNumber !== null ? (
              <a href={`/purchasing/${open.purchaseOrderId}`} className="underline underline-offset-4">
                purchase order {open.purchaseOrderNumber}
              </a>
            ) : "a purchase order"}
            {open.purchaseOrderStatus && ORDER_STATUS[open.purchaseOrderStatus]
              ? <>, {ORDER_STATUS[open.purchaseOrderStatus]}</> : null}.
          </p>
        ) : null}
        <p className="mt-1 text-xs text-ink-700">
          Since {formatIn(open.placedAt, timezone)}{open.placedByName ? `, by ${open.placedByName}` : ""}.
        </p>
        <ActionForm action={release} submit="Take off hold" tone="quiet" className="mt-3"
                    hidden={{ jobId, holdId: open.id }} />
      </section>
    );
  }

  return (
    <details className="mt-4 rounded-md border border-steel-200 p-4">
      <summary className="cursor-pointer text-sm font-medium">Put on hold</summary>
      <ActionForm action={place} submit="Put on hold" hidden={{ jobId }} className="mt-3 space-y-4">
        <Select label="Why is the job waiting?" name="reason" required defaultValue=""
                options={[{ value: "", label: "Choose a reason" }, ...work.HOLD_REASONS]} />
        {mayNameOrder ? (
          <Select label="For a part: the purchase order it is on" name="purchaseOrderId" defaultValue=""
                  options={[
                    { value: "", label: orders.length === 0 ? "No open orders. Write one under Purchasing first." : "Choose the order" },
                    ...orders.map((o) => ({
                      value: o.id,
                      label: `Order ${o.number}, ${o.vendorName}${ORDER_STATUS[o.status] ? ` (${ORDER_STATUS[o.status]})` : ""}`,
                    })),
                  ]} />
        ) : (
          <p className="text-sm text-ink-700">
            A part hold names the purchase order the part is on. Ask somebody who sees purchase orders to put it on hold for a part.
          </p>
        )}
        <TextField label="What it is waiting for (which part, which inspection)" name="note" maxLength={2000} />
        <p className="text-xs text-ink-500">
          A job held for a part on an order that went to the supplier, or (for electrical work) for an inspection,
          is left out of the first time fix rate.
        </p>
      </ActionForm>
    </details>
  );
}

/**
 * PLANNED FOR MORE THAN ONE VISIT
 *
 * Said before the work and not after: once anybody has arrived at a visit on
 * the job the service refuses it, and the screen stops offering it, because a
 * plan written after the first visit is a return visit described kindly.
 * Taking the plan off is always offered.
 */
export function PlannedVisits({
  jobId, plannedAt, started, writes, timezone, action,
}: {
  jobId: string;
  plannedAt: Date | string | null;
  /** Somebody has arrived at, or finished, a visit on the job. */
  started: boolean;
  writes: boolean;
  timezone: string;
  action: Action;
}) {
  if (plannedAt) {
    return (
      <div className="mt-4 text-sm">
        <p>
          <span className="font-medium">Planned for more than one visit</span>
          <span className="text-ink-500"> since {formatIn(plannedAt, timezone)}. Left out of the first time fix rate.</span>
        </p>
        {writes ? (
          <ActionForm action={action} submit="It is not planned for more than one visit" tone="quiet" className="mt-2"
                      hidden={{ jobId, planned: "0" }} />
        ) : null}
      </div>
    );
  }
  if (!writes || started) return null;
  return (
    <ActionForm action={action} submit="Planned for more than one visit" tone="quiet" className="mt-4"
                hidden={{ jobId, planned: "1" }}>
      <p className="text-sm text-ink-700">
        Is this work planned to take more than one visit, like a two day install? Say so before anybody goes out,
        and it is left out of the first time fix rate.
      </p>
    </ActionForm>
  );
}
