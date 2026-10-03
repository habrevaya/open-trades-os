import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { stockUnits, NotFoundError } from "@opentradesos/api/services";
import { Money } from "@opentradesos/ui";
import { Crumb, Fact, Facts } from "@/components/Detail";
import { Table, Th, Td } from "@/components/Table";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

/**
 * ONE SERIAL OR LOT, FROM THE ORDER TO THE CUSTOMER
 *
 * Everything that happened to it, oldest first, and the customer's equipment
 * record it became. This is the page that answers "which compressor is in my
 * house, where did it come from, and is it the one on the recall".
 */
export default async function TracePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const trace = await stockUnits.trace({ actor: user.actor, db: getDb() }, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError || (error as Error).name === "NotFoundError") notFound();
    throw error;
  });
  const { unit, equipment } = trace;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/inventory/serials">Serials and lots</Crumb>
      <h1 className="mt-1 text-xl font-semibold">
        {unit.mode === "serial" ? "Serial" : "Lot"} <span className="font-mono">{unit.number}</span>
      </h1>
      <Facts>
        <Fact label="Part">{`${unit.itemName} (${unit.itemCode})`}</Fact>
        <Fact label="Now">
          {unit.state === "in_stock"
            ? unit.where.map((w) => unit.mode === "lot" ? `${w.locationName}, ${w.quantity}` : w.locationName).join("; ")
            : unit.state === "used" ? `Used on job ${unit.jobNumber ?? ""}` : "Written off"}
        </Fact>
        <Fact label="Use by">{unit.expiresOn}</Fact>
      </Facts>

      <section className="mt-6" aria-labelledby="installed">
        <h2 id="installed" className="text-base font-semibold">Where it went</h2>
        {equipment ? (
          <div className="mt-2 rounded-md border border-steel-200 bg-canvas p-4 text-sm">
            <p className="font-medium">
              {[equipment.manufacturer, equipment.model].filter(Boolean).join(" ") || equipment.category}
              {equipment.tag ? <span className="ml-2 text-ink-500">{equipment.tag}</span> : null}
            </p>
            <p className="mt-1 text-ink-700">
              {equipment.category} at {equipment.address}
              {equipment.customerName ? (
                <> for <a href={`/customers/${equipment.customerId}`} className="underline underline-offset-4">{equipment.customerName}</a></>
              ) : null}
            </p>
            {equipment.serialNumber ? <p className="mt-1 font-mono text-xs text-ink-500">Serial on the record: {equipment.serialNumber}</p> : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-ink-500">
            {unit.state === "used"
              ? "Used on a job without saying which of the customer's units it is, or you cannot see the customer's equipment."
              : "Not installed anywhere."}
          </p>
        )}
      </section>

      <h2 className="mt-8 text-base font-semibold">What happened to it</h2>
      <Table label="History" head={<><Th>When</Th><Th>What</Th><Th>Where</Th><Th>For</Th><Th className="text-right">Qty</Th><Th className="text-right">Cost</Th></>}>
        {trace.steps.map((step, i) => (
          <tr key={i}>
            <Td className="tabular-nums">{formatIn(step.at, user.organizationTimezone)}</Td>
            <Td>{step.label}</Td>
            <Td className="text-ink-700">{step.locationName}</Td>
            <Td>
              {step.purchaseOrderId ? (
                <a href={`/purchasing/${step.purchaseOrderId}`} className="hover:underline">
                  Order {step.purchaseOrderNumber}{step.vendorName ? ` from ${step.vendorName}` : ""}
                </a>
              ) : null}
              {step.jobId ? <a href={`/jobs/${step.jobId}`} className="hover:underline">Job {step.jobNumber}</a> : null}
            </Td>
            <Td className="text-right tabular-nums">{step.quantity}</Td>
            <Td className="text-right">{step.cost ? <Money value={step.cost} /> : null}</Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
