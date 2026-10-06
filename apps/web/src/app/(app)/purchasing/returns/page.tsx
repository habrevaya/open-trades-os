import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory, stockReturns, stockUnits } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { createReturnAction, recordCreditAction } from "./actions";

export const dynamic = "force-dynamic";

/**
 * UNITS SENT BACK TO A VENDOR, AND WHAT THEY OWE FOR THEM
 *
 * By serial or lot number, or by how many for a part that is only counted,
 * from the shelf or truck they are on. The stock leaves, and the return waits
 * for the vendor's credit, which is expected at what a numbered part cost on
 * the order it came on, without the freight, and at what you say for a counted
 * one. A return still waiting a month later is money a vendor is holding, so
 * those are at the top.
 */
export default async function VendorReturnsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "po:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Returns to vendors" />
        <Empty title="Purchasing is not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  const sends = can(user.actor, "po:write") && can(user.actor, "inventory:adjust");
  const [returns, vendors, parts, places] = await Promise.all([
    stockReturns.vendorReturns(ctx),
    can(user.actor, "vendor:read") ? inventory.vendors(ctx) : Promise.resolve([]),
    sends ? stockUnits.stockItems(ctx) : Promise.resolve([]),
    sends ? stockUnits.stockLocations(ctx) : Promise.resolve([]),
  ]);
  const waiting = returns.filter((r) => r.status === "awaiting_credit");
  const done = returns.filter((r) => r.status === "credited");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Returns to vendors" count={returns.length} />
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        Parts tracked by serial or lot go back by their numbers, and the credit expected is what they cost on the
        order they came on, without freight, unless you say what the vendor is giving. A part that is only counted
        goes back by how many, and you say what credit the vendor promised.
      </p>

      <h2 className="mt-8 text-base font-semibold">Waiting for a credit</h2>
      {waiting.length === 0 ? (
        <Empty title="Nothing waiting">Every return so far has its credit.</Empty>
      ) : (
        <Table label="Waiting for a credit" head={<><Th>Return</Th><Th>Vendor</Th><Th>What went back</Th><Th className="text-right">Expected</Th><Th /></>}>
          {waiting.map((r) => (
            <tr key={r.id}>
              <Td className="tabular-nums">
                #{r.number}
                <div className="text-xs text-ink-500">{formatIn(r.createdAt, user.organizationTimezone)}</div>
              </Td>
              <Td>{r.vendorName}{r.reference ? <div className="text-xs text-ink-500">{r.reference}</div> : null}</Td>
              <Td className="text-ink-700">
                {r.units.map((u) => u.number === "" ? `${u.quantity} ${u.itemName}` : `${u.itemName} ${u.number}${u.quantity !== "1" ? ` (${u.quantity})` : ""}`).join(", ")}
                <div className="text-xs text-ink-500">{r.reason}</div>
              </Td>
              <Td className="text-right"><Money value={r.creditExpected} /></Td>
              <Td>
                {can(user.actor, "po:write") ? (
                  <ActionForm action={recordCreditAction} submit="Credit received" className="flex flex-wrap items-end gap-2" hidden={{ id: r.id }}>
                    <TextField label="Amount" name="amount" inputMode="decimal" className="w-28" defaultValue={String(Number(r.creditExpected))} />
                    <TextField label="Their credit memo" name="reference" className="w-32" />
                  </ActionForm>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {done.length > 0 ? (
        <>
          <h2 className="mt-8 text-base font-semibold">Credited</h2>
          <Table label="Credited" head={<><Th>Return</Th><Th>Vendor</Th><Th>What went back</Th><Th className="text-right">Expected</Th><Th className="text-right">Given</Th></>}>
            {done.map((r) => (
              <tr key={r.id}>
                <Td className="tabular-nums">#{r.number}</Td>
                <Td>{r.vendorName}</Td>
                <Td className="text-ink-700">{r.units.map((u) => u.number === "" ? `${u.quantity} ${u.itemName}` : `${u.itemName} ${u.number}`).join(", ")}</Td>
                <Td className="text-right"><Money value={r.creditExpected} /></Td>
                <Td className="text-right">
                  <Money value={r.creditReceived ?? "0"} />
                  {r.creditReceived && Number(r.creditReceived) < Number(r.creditExpected)
                    ? <div><Chip tone="warning">Short</Chip></div> : null}
                </Td>
              </tr>
            ))}
          </Table>
        </>
      ) : null}

      {sends && parts.length > 0 && vendors.length > 0 ? (
        <section className="mt-10" aria-labelledby="send-back">
          <h2 id="send-back" className="text-base font-semibold">Send back to a vendor</h2>
          <ActionForm action={createReturnAction} submit="Send back" className="mt-3 grid gap-3 sm:grid-cols-2">
            <Select label="Vendor" name="vendorId" options={vendors.map((v) => ({ value: v.id, label: v.name }))} />
            <Select label="Part" name="itemId" options={parts.map((t) => ({
              value: t.id,
              label: `${t.name} (${t.code})${t.tracking === "serial" ? ", by serial" : t.tracking === "lot" ? ", by lot" : ", counted"}`,
            }))} />
            <Select label="Where it is now" name="locationId" options={places.map((p) => ({ value: p.id, label: p.name }))} />
            <TextField label="Why it is going back" name="reason" required />
            <div className="space-y-3">
              <TextArea label="Serial or lot numbers" name="units" rows={2} />
              <TextField label="How many (a counted part only)" name="quantity" inputMode="decimal" />
            </div>
            <div className="space-y-3">
              <TextField label="Their return number" name="reference" />
              <TextField label="Credit expected (empty for what a numbered part cost)" name="creditExpected" inputMode="decimal" />
            </div>
          </ActionForm>
        </section>
      ) : null}
    </div>
  );
}
