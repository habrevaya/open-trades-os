import type { ReactNode } from "react";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty } from "@/components/Table";

export interface OrderRow {
  id: string;
  sourceSystem: string;
  sourceLabel: string;
  externalId: string;
  externalNumber: string | null;
  state: string;
  externalStatus: string | null;
  externalIsSystemOfRecord: boolean;
  acceptanceIsIrreversible: boolean;
  acceptsViaInvoiceOnly: boolean;
  jobId: string | null;
  lastSyncedAt: string | null;
  pendingPush: boolean;
  lastPushError: string | null;
  weMayMoveTo: readonly string[];
}

export interface SourceRow {
  key: string;
  label: string;
  note: string;
  acceptanceIsIrreversible: boolean;
  acceptsViaInvoiceOnly: boolean;
  orders: number;
}

const STATE_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  offered: "neutral", accepted: "info", in_progress: "info", completed: "success",
  invoiced: "success", closed: "neutral", rejected: "danger",
  cancelled_by_client: "danger", reopened: "warning",
};

const STATE_LABEL: Record<string, string> = {
  offered: "Offered", accepted: "Accepted", rejected: "Declined", in_progress: "In progress",
  completed: "Completed", cancelled_by_client: "Pulled by the client", reopened: "Sent back",
  invoiced: "Invoiced", closed: "Closed",
};

const label = (state: string) => STATE_LABEL[state] ?? state.replace(/_/g, " ");

/**
 * SOMEBODY ELSE'S QUEUE, MIRRORED
 *
 * In five segments the contractor is a vendor in somebody else's software: a
 * facilities network dispatches, a warranty administrator assigns a claim, a
 * manufacturer sends a dealer a warranty job. Their system stays the system of
 * record, so this screen shows two statuses on every row and never reconciles
 * them into one.
 *
 * THEIR WORD IS SHOWN VERBATIM beside ours. It is the only thing that survives
 * them renaming a status, and "we marked it complete on the 4th and their portal
 * says it was still open on the 11th" is the dispute that decides who pays.
 *
 * WHAT WE MAY DO NEXT IS NOT GUESSED HERE. `weMayMoveTo` comes off the service,
 * which works it out from the state and the network's own flags, so a screen
 * cannot offer a move the module would refuse. On a network where acceptance is
 * final, "Accept" simply is not there after the fact.
 */
export function Orders({
  orders, controls,
}: {
  orders: OrderRow[];
  controls?: ((order: OrderRow) => ReactNode) | undefined;
}) {
  if (orders.length === 0) {
    return (
      <Empty title="No work from anybody else's system">
        Orders arrive through the API with the network&apos;s own id as the key, so a redelivery
        updates rather than duplicating. There is no adapter for any network yet: each one is a
        vendor approval rather than code.
      </Empty>
    );
  }
  return (
    <Table label="External work orders" head={
      <>
        <Th>Order</Th><Th>Where we are</Th><Th>What they say</Th><Th>Told them</Th>
        {controls ? <Th /> : null}
      </>
    }>
      {orders.map((order) => (
        <tr key={order.id}>
          <Td>
            <span className="font-medium">{order.externalNumber ?? order.externalId}</span>
            <span className="block text-xs text-ink-500">{order.sourceLabel}</span>
            {order.acceptanceIsIrreversible ? (
              /*
                On the row rather than in a dialogue, because the thing a
                contractor needs to know before clicking Accept is that on this
                network it cannot be undone, and after the fact is too late.
              */
              <span className="block text-xs text-amber-700">Accepting is final here</span>
            ) : null}
          </Td>
          <Td>
            <Chip tone={STATE_TONE[order.state] ?? "neutral"}>{label(order.state)}</Chip>
            {order.jobId ? (
              <a href={`/jobs/${order.jobId}`} className="ml-2 text-sm hover:underline">the job</a>
            ) : null}
          </Td>
          <Td>
            {/*
              Their status verbatim, never mapped into ours. A network that
              renames "Dispatched" to "Assigned" would otherwise silently become
              whatever our mapping last guessed.
            */}
            {order.externalStatus
              ? <span className="font-mono text-xs">{order.externalStatus}</span>
              : <span className="text-ink-500">Nothing yet</span>}
            {order.externalIsSystemOfRecord ? (
              <span className="block text-xs text-ink-500">Theirs is the record</span>
            ) : null}
          </Td>
          <Td>
            {order.pendingPush
              ? <span className="text-amber-700">Not yet</span>
              : <span className="text-ink-500">
                  {order.lastSyncedAt ? order.lastSyncedAt.slice(0, 10) : "Nothing to tell"}
                </span>}
            {order.lastPushError ? (
              <span className="block text-xs text-red-600">{order.lastPushError}</span>
            ) : null}
          </Td>
          {controls ? <Td>{controls(order)}</Td> : null}
        </tr>
      ))}
    </Table>
  );
}

/**
 * What they have not been told.
 *
 * The queue the index on `(organization, pending_push)` exists for and which
 * nothing read before the service was written. A status changed and never pushed
 * is a contractor whose scorecard says they never responded, and the scorecard
 * decides the next dispatch: the cost of this list being empty when it should not
 * be is work, not tidiness.
 */
export function Queue({ orders }: { orders: OrderRow[] }) {
  if (orders.length === 0) {
    return (
      <p className="mt-3 text-sm text-ink-700">
        Nothing owed. Every change we have made has been pushed.
      </p>
    );
  }
  return (
    <>
      <p className="mt-3 text-sm text-amber-700">
        {orders.length} {orders.length === 1 ? "order has" : "orders have"} a change their system has
        not been told about. On a scored network a late push costs the next dispatch rather than this
        one.
      </p>
      <ul className="mt-2 space-y-1 text-sm">
        {orders.map((order) => (
          <li key={order.id}>
            <span className="font-medium">{order.externalNumber ?? order.externalId}</span>
            <span className="text-ink-700"> at {order.sourceLabel}, now {label(order.state)}</span>
            {order.lastPushError ? (
              <span className="block text-xs text-red-600">
                Last attempt failed: {order.lastPushError}
              </span>
            ) : null}
          </li>
        ))}
      </ul>
    </>
  );
}

/**
 * The networks this is built for, and what to know about each before clicking.
 *
 * Shown rather than kept for a help page, for the same reason the commission
 * bases publish their caveats: a contractor needs to know that a warranty
 * administrator's acceptance is final BEFORE they accept, not after.
 *
 * A network with no profile here is listed too. This list is documentation rather
 * than a gate, and a regional warranty administrator nobody has heard of is as
 * real as Corrigo.
 */
export function Sources({
  sources, unprofiled,
}: {
  sources: SourceRow[];
  /** Networks this company works that no profile has been written for. */
  unprofiled: { key: string; orders: number }[];
}) {
  return (
    <>
      <ul className="mt-3 space-y-2">
        {sources.map((source) => (
          <li key={source.key} className="rounded-md border border-steel-200 bg-canvas p-3">
            <p className="text-sm font-medium">
              {source.label}
              {source.orders > 0 ? (
                <span className="ml-2 text-xs font-normal text-ink-500">
                  {source.orders} {source.orders === 1 ? "order" : "orders"}
                </span>
              ) : null}
            </p>
            <p className="mt-1 text-sm text-ink-700">{source.note}</p>
            {source.acceptanceIsIrreversible ? (
              <p className="mt-1 text-sm text-amber-700">Accepting cannot be undone.</p>
            ) : null}
            {source.acceptsViaInvoiceOnly ? (
              <p className="mt-1 text-sm text-amber-700">
                No accept call at all: raising the invoice is the acceptance.
              </p>
            ) : null}
          </li>
        ))}
      </ul>
      {unprofiled.length > 0 ? (
        <p className="mt-3 text-sm text-ink-700">
          Also seen here, with no profile written for them yet:{" "}
          {unprofiled.map((row) => `${row.key} (${row.orders})`).join(", ")}. They work exactly the
          same way; the profiles above are notes rather than a list of what is allowed, and an
          unprofiled network gets the cautious defaults.
        </p>
      ) : null}
    </>
  );
}
