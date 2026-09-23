import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { inventory } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { AddVendor, OrderBuilder, Advance } from "./Forms";

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

  const [orders, suggestions, vendorList] = await Promise.all([
    inventory.purchaseOrders(ctx),
    inventory.toOrder(ctx),
    inventory.vendors(ctx),
  ]);

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
            <Th>Number</Th><Th>Vendor</Th><Th>Status</Th>
            <Th className="text-right">Lines</Th>
            <Th className="text-right">Total</Th>
            <Th>Next</Th>
          </>
        }>
          {orders.map((order) => (
            <tr key={order.id}>
              <Td className="tabular-nums">#{order.number}</Td>
              <Td>{order.vendorName}</Td>
              <Td className="text-ink-500">{order.status.replace(/_/g, " ")}</Td>
              <Td className="text-right tabular-nums">{order.lineCount}</Td>
              <Td className="text-right tabular-nums">${Number(order.total).toFixed(2)}</Td>
              <Td><Advance id={order.id} status={order.status} /></Td>
            </tr>
          ))}
        </Table>
      )}

      <h2 className="mt-10 font-medium text-ink-900">Who we buy from</h2>
      {vendorList.length > 0 && (
        <Table head={<><Th>Name</Th><Th>Account</Th><Th>Phone</Th></>}>
          {vendorList.map((vendor) => (
            <tr key={vendor.id}>
              <Td>{vendor.name}</Td>
              <Td className="text-ink-500">{vendor.accountNumber ?? ""}</Td>
              <Td className="text-ink-500">{vendor.phone ?? ""}</Td>
            </tr>
          ))}
        </Table>
      )}
      <AddVendor />
    </div>
  );
}
