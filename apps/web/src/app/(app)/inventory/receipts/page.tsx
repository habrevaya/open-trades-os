import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { landedCost } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { stockLateBillAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * STOCK THAT CAME WITHOUT AN ORDER
 *
 * Parts bought at the counter and parts a van picked up are received straight
 * onto a shelf. The carrier's bill, or the broker's duty bill, can still come
 * a week later. This lists those deliveries and puts the bill on them the
 * way an order's page does: onto the shelf or truck the parts are on, onto
 * the job that used them, or onto stock already gone.
 */
export default async function StockReceiptsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "po:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Stock received without an order" />
        <Empty title="Purchasing is not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  const receipts = await landedCost.listStockReceipts(ctx);
  const writes = can(user.actor, "po:write");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Stock received without an order" />
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        Each time stock was received with no order behind it, newest first. A freight or duty bill that comes later
        can be put on a delivery here. Stock received before this list existed is not on it.
      </p>
      {receipts.length === 0 ? (
        <Empty title="Nothing yet">Stock you receive without an order will be listed here.</Empty>
      ) : (
        <Table label="Stock received without an order" head={<><Th>Received</Th><Th>Part</Th><Th>Where</Th><Th className="text-right">How many</Th><Th className="text-right">Cost</Th><Th className="text-right">Billed later</Th></>}>
          {receipts.map((r) => (
            <tr key={r.id}>
              <Td className="text-ink-700">{formatIn(r.receivedAt, user.organizationTimezone)}</Td>
              <Td>{r.itemName} <span className="text-ink-500">({r.itemCode})</span></Td>
              <Td className="text-ink-700">{r.locationName}</Td>
              <Td className="text-right tabular-nums">{r.quantity}</Td>
              <Td className="text-right"><Money value={r.cost} /></Td>
              <Td className="text-right"><Money value={r.lateTotal} /></Td>
            </tr>
          ))}
        </Table>
      )}
      {writes && receipts.length > 0 ? (
        <section className="mt-8" aria-labelledby="stock-late-bill">
          <h2 id="stock-late-bill" className="text-base font-semibold">A freight or duty bill that came later</h2>
          <ActionForm action={stockLateBillAction} submit="Spread the bill" className="mt-3 grid gap-3 sm:grid-cols-3">
            <Select label="Delivery" name="stockReceiptId" options={receipts.map((r) => ({
              value: r.id, label: `${r.itemName}, ${r.quantity}, ${formatIn(r.receivedAt, user.organizationTimezone)}`,
            }))} />
            <TextField label="Their bill number" name="reference" />
            <Select label="Spread it by" name="basis" options={[
              { value: "value", label: "What each piece cost" }, { value: "quantity", label: "How many of each" },
            ]} />
            <TextField label="Charge" name="lateDescription" placeholder="Freight" />
            <TextField label="Amount" name="lateAmount" inputMode="decimal" />
            <div />
            <TextField label="Another charge" name="lateDescription" placeholder="Duty" />
            <TextField label="Amount" name="lateAmount" inputMode="decimal" />
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
