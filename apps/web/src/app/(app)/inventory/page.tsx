import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * WHAT IS ON THE SHELF, AND ON EACH VAN
 *
 * Three questions, in the order a person asks them: what have we got, what
 * is spoken for, and what should we buy.
 *
 * A row per item PER LOCATION rather than per item. "Is it in stock" has no
 * single answer once a van is a location, and the flattened version of this
 * screen is what produces the technician who was told yes and drove to a
 * property without the part.
 */
export default async function InventoryPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "inventory:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Inventory" />
        <Empty title="Inventory is not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const [levels, reserved, buy] = await Promise.all([
    inventory.levels(ctx),
    inventory.commitments(ctx),
    inventory.toOrder(ctx),
  ]);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Inventory" />
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        Every number here is folded from the movement history. Nothing on this
        screen is a stored total, which is why a count is recorded as the
        correction rather than as the answer.
      </p>

      {/*
        What to buy is FIRST when there is anything, because it is the only
        part of this screen somebody has to act on today. A stock list is
        reference; a shortfall is a phone call.
      */}
      {buy.length > 0 && (
        <>
          <h2 className="mt-8 text-base font-semibold">Worth ordering</h2>
          <p className="mt-1 text-sm text-ink-500">
            Counted against available plus what is already on order, so
            something on its way is not ordered twice.
          </p>
          <Table head={<><Th>Item</Th><Th>Where</Th><Th className="text-right">Available</Th><Th className="text-right">On order</Th><Th className="text-right">Point</Th><Th className="text-right">Order</Th></>}>
            {buy.map((row) => (
              <tr key={`${row.itemId}-${row.locationId}`}>
                <Td className="text-ink-700">{row.itemName}</Td>
                <Td className="text-ink-700">{row.locationName}</Td>
                <Td className="text-right font-mono tabular-nums">{row.availableNow}</Td>
                <Td className="text-right font-mono tabular-nums text-ink-500">{row.onOrder}</Td>
                <Td className="text-right font-mono tabular-nums text-ink-500">{row.reorderPoint}</Td>
                <Td className="text-right font-mono tabular-nums font-medium">{row.suggested}</Td>
              </tr>
            ))}
          </Table>
        </>
      )}

      <h2 className="mt-8 text-base font-semibold">On hand</h2>
      {levels.length === 0 ? (
        <Empty title="Nothing has moved yet">
          A level appears here the first time something is received, which is
          the only movement that establishes what stock cost.
        </Empty>
      ) : (
        <Table head={<><Th>Item</Th><Th>Where</Th><Th className="text-right">On hand</Th><Th className="text-right">Reserved</Th><Th className="text-right">Available</Th></>}>
          {levels.map((row) => (
            <tr key={`${row.itemId}-${row.locationId}`}>
              <Td>
                <span className="text-ink-700">{row.itemName}</span>
                <span className="ml-2 font-mono text-xs text-ink-500">{row.itemCode}</span>
              </Td>
              <Td className="text-ink-700">{row.locationName}</Td>
              <Td className="text-right font-mono tabular-nums">{row.onHand}</Td>
              <Td className="text-right font-mono tabular-nums text-ink-500">{row.committed}</Td>
              {/*
                Available is the number a dispatcher acts on, so it is the one
                in full ink. It is computed on every render from the other
                two and is stored nowhere.
              */}
              <Td className={`text-right font-mono tabular-nums ${
                Number(row.available) <= 0 ? "text-red-600" : "font-medium"
              }`}>
                {row.available}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <h2 className="mt-8 text-base font-semibold">Spoken for</h2>
      {reserved.length === 0 ? (
        <Empty title="Nothing is reserved">
          A reservation belongs to a job, so this is the list of parts that
          are on a shelf and already have somebody&rsquo;s name on them.
        </Empty>
      ) : (
        <Table head={<><Th>Item</Th><Th>Where</Th><Th>For</Th><Th className="text-right">Held</Th></>}>
          {reserved.map((row) => (
            <tr key={`${row.itemId}-${row.locationId}-${row.jobId}`}>
              <Td className="text-ink-700">{row.itemName}</Td>
              <Td className="text-ink-700">{row.locationName}</Td>
              <Td>
                <a href={`/jobs/${row.jobId}`} className="text-ink-700 hover:underline">
                  <span className="font-mono tabular-nums text-ink-500">{row.jobNumber}</span>{" "}
                  {row.jobSummary ?? "Untitled"}
                </a>
              </Td>
              <Td className="text-right font-mono tabular-nums">{row.quantity}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
