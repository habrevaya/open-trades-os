import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { company, inventory, purchaseAcknowledgements, vendorCatalogue } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, TextField } from "@/components/ActionForm";
import { formatDay } from "@/lib/dates";
import { AddVendor, OrderBuilder, Advance, PartOrder } from "./Forms";
import { chaseAfter } from "./actions";

export const dynamic = "force-dynamic";

/**
 * BUYING MORE OF IT
 *
 * `vendor`, `purchase_order` and `purchase_order_line` were written by
 * nothing. The receiving path updated rows that could not exist, the reorder
 * engine suggested quantities nobody could act on, and this screen did not
 * exist at all.
 *
 * Three things in the order a buyer does them: who we buy from, what the
 * shelf says we need, and what is already on its way.
 */
export default async function PurchasingPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "po:read")) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
        <PageHeader title="Purchasing" />
        <Empty title="Purchasing is not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const [orders, suggestions, vendorList, parts, locations, chase] = await Promise.all([
    inventory.purchaseOrders(ctx),
    inventory.toOrder(ctx),
    inventory.vendors(ctx),
    can(user.actor, "vendor:read") ? vendorCatalogue.links(ctx, {}) : Promise.resolve([]),
    can(user.actor, "settings:read") ? company.listLocations(ctx) : Promise.resolve([]),
    purchaseAcknowledgements.getSettings(ctx),
  ]);
  const needCall = orders.filter((o) => o.followUp !== null);
  const zone = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Purchasing" />

      <h2 className="mt-6 font-medium text-ink-900">What to buy</h2>
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        Everything below its reorder point, counting what is already on order
        so the same part is not bought twice. Nothing is ticked for you: a
        reorder point is advice somebody typed once, and an order is money.
      </p>
      <OrderBuilder
        suggestions={suggestions.map((s) => ({
          itemId: s.itemId, itemName: s.itemName,
          locationId: s.locationId, locationName: s.locationName,
          suggested: s.suggested, availableNow: s.availableNow,
          reorderPoint: s.reorderPoint, onOrder: s.onOrder,
        }))}
        vendors={vendorList.map((v) => ({ id: v.id, name: v.name }))}
      />

      <h2 className="mt-10 font-medium text-ink-900">Order by part number</h2>
      <p className="mt-1 max-w-prose text-sm text-ink-500">
        Type the vendor&apos;s part number or ours, and the order is looked up: our item, their number for it, and their
        price unless you give one. Their numbers come from each item&apos;s page or from a{" "}
        <a href="/purchasing/catalogue" className="underline underline-offset-4">supplier catalogue</a>.
      </p>
      <PartOrder
        vendors={vendorList.map((v) => ({ id: v.id, name: v.name }))}
        locations={locations.map((l) => ({ id: l.id, name: l.name }))}
        parts={parts.map((p) => ({
          vendorId: p.vendorId, partNumber: p.partNumber, itemCode: p.itemCode, itemName: p.itemName, cost: p.cost,
        }))}
      />

      <section className="mt-10" aria-labelledby="needs-a-call">
        <h2 id="needs-a-call" className="font-medium text-ink-900">Orders to ring about</h2>
        <p className="mt-1 max-w-prose text-sm text-ink-500">
          Sent and not answered for {chase.acknowledgeAfterDays} {chase.acknowledgeAfterDays === 1 ? "day" : "days"}, or
          past the day the vendor promised it by with something still owed. Write down what they say on the order.
        </p>
        {needCall.length === 0 ? (
          <p className="mt-2 text-sm text-ink-700">Nothing to chase.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {needCall.map((o) => (
              <li key={o.id}>
                <a href={`/purchasing/${o.id}`} className="font-medium underline underline-offset-4">#{o.number}</a>
                {" "}{o.followUp!.sentence}
              </li>
            ))}
          </ul>
        )}
        {can(user.actor, "po:write") ? (
          <ActionForm action={chaseAfter} submit="Save" tone="quiet" className="mt-3 flex flex-wrap items-end gap-3">
            <TextField label="Ring a vendor who has not answered after this many days" name="acknowledgeAfterDays"
                       inputMode="numeric" defaultValue={String(chase.acknowledgeAfterDays)} className="block w-96" />
          </ActionForm>
        ) : null}
      </section>

      <h2 className="mt-10 font-medium text-ink-900">Orders</h2>
      {orders.length === 0 ? (
        <Empty title="No orders yet">
          An order starts from the list above. A draft counts for nothing until
          you send it, which is what stops the reorder engine going quiet about
          a part nobody actually ordered.
        </Empty>
      ) : (
        <Table head={
          <>
            <Th>Number</Th><Th>Vendor</Th><Th>Status</Th><Th>Promised</Th>
            <Th className="text-right">Lines</Th>
            <Th className="text-right">Total</Th>
            <Th>Next</Th>
          </>
        }>
          {orders.map((order) => (
            <tr key={order.id}>
              <Td className="tabular-nums">
                <a href={`/purchasing/${order.id}`} className="hover:underline">#{order.number}</a>
              </Td>
              <Td>{order.vendorName}</Td>
              <Td className="text-ink-500">{order.status.replace(/_/g, " ")}</Td>
              <Td className={order.followUp?.kind === "past_promise" ? "text-amber-700" : "text-ink-500"}>
                {order.promisedOn ? formatDay(order.promisedOn, zone) : order.followUp ? "No answer" : ""}
              </Td>
              <Td className="text-right tabular-nums">{order.lineCount}</Td>
              <Td className="text-right tabular-nums">${Number(order.total).toFixed(2)}</Td>
              <Td><Advance id={order.id} status={order.status} /></Td>
            </tr>
          ))}
        </Table>
      )}

      <h2 className="mt-10 font-medium text-ink-900">Who we buy from</h2>
      {vendorList.length > 0 && (
        <Table head={<><Th>Name</Th><Th>Account</Th><Th>Phone</Th><Th>Orders email</Th></>}>
          {vendorList.map((vendor) => (
            <tr key={vendor.id}>
              <Td>{vendor.name}</Td>
              <Td className="text-ink-500">{vendor.accountNumber ?? ""}</Td>
              <Td className="text-ink-500">{vendor.phone ?? ""}</Td>
              <Td className="text-ink-500">{vendor.email ?? ""}</Td>
            </tr>
          ))}
        </Table>
      )}
      <AddVendor />
    </div>
  );
}
