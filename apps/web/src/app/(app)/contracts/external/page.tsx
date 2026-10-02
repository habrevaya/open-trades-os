import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { externalWork } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { Orders, Queue, Sources } from "./ExternalWorkView";
import { ActionForm } from "./ActionForm";

export const dynamic = "force-dynamic";

const input = "h-8 rounded border border-steel-300 px-2 text-sm";

const MOVE_LABEL: Record<string, string> = {
  accepted: "Accept", rejected: "Decline", in_progress: "Start",
  completed: "Complete", invoiced: "Invoiced", closed: "Close",
};

/**
 * SOMEBODY ELSE'S QUEUE
 *
 * The last service in this product that had no screen. In five segments the
 * contractor is a vendor in somebody else's software: a facilities network
 * dispatches, a warranty administrator assigns a claim, a manufacturer sends a
 * dealer a warranty job. Their system stays the system of record.
 *
 * TWO STATUSES ON EVERY ROW, never reconciled into one. Their word is kept
 * verbatim, because it is the only thing that survives them renaming a status, and
 * "we marked it complete on the 4th and their portal says it was still open on the
 * 11th" is the dispute that decides who pays.
 *
 * THE BUTTONS COME FROM `weMayMoveTo`, which the service works out from the state
 * and the network's flags. The screen does not know the transition table and
 * cannot offer a move the module would refuse: on a network where acceptance is
 * final there is no Accept after the fact, and nowhere is there a button for
 * "the client cancelled it", because that is not ours to declare.
 *
 * `contract:read` to look and `contract:write` to move, which is the service's own
 * split.
 */
export default async function ExternalWorkPage(
  { searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> },
) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "contract:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Work from other systems" />
        <Empty title="Not shown to your role">
          This needs the permission that reads contracts.
        </Empty>
      </div>
    );
  }

  const params = await searchParams;
  const one = (key: string) => {
    const value = params[key];
    return Array.isArray(value) ? value[0] : value;
  };
  const filter = one("state");

  const [all, owed, sources] = await Promise.all([
    externalWork.list(ctx, { limit: 200, ...(filter ? { state: filter } : {}) })
      .catch(() => ({ data: [] })),
    externalWork.pending(ctx, { limit: 200 }),
    externalWork.sources(ctx, {}),
  ]);

  const writes = can(user.actor, "contract:write");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Work from other systems" count={all.data.length} />

      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Orders mirrored from a facilities network, a warranty administrator or a manufacturer&apos;s
        dealer system. Theirs stays the system of record, so what they say sits beside what we say
        rather than replacing it. No adapter for any network yet: each one is a vendor approval
        rather than code, and one written against documentation without a sandbox looks finished and
        has never run.
      </p>

      <h2 className="mt-8 text-base font-semibold">What they have not been told</h2>
      <Queue orders={owed.data} />

      <h2 className="mt-8 text-base font-semibold">Orders</h2>
      <Orders
        orders={all.data}
        controls={writes ? (order) => (
          <div className="flex flex-wrap gap-2">
            {/*
              Only the moves the service says are possible. `weMayMoveTo` is
              computed from the state and the network's flags, so this list is
              never a guess and never offers something that would be refused.
            */}
            {order.weMayMoveTo.map((to) => (
              to === "accepted" ? (
                <ActionForm key={to} op="move" label={MOVE_LABEL[to] ?? to} quiet
                            hidden={{ id: order.id, to }}>
                  {/*
                    The job id is offered only on accept. A declined order must
                    never carry a job: half of what arrives on a facilities
                    network is declined, and a job on a declined order is work
                    nobody is doing sitting on the board.
                  */}
                  <input name="jobId" placeholder="Job id, if there is one"
                         aria-label="The job this is being done as"
                         className={`${input} w-44`} />
                </ActionForm>
              ) : (
                <ActionForm key={to} op="move" label={MOVE_LABEL[to] ?? to} quiet
                            hidden={{ id: order.id, to }} />
              )
            ))}
            {order.acceptsViaInvoiceOnly && order.state === "completed" && (
              /*
                Some networks have no accept call at all, and raising the invoice
                IS the acceptance. Offered only where the row says so, because on
                a network that has an accept call the service refuses this with a
                sentence about held payments.
              */
              <ActionForm op="invoice" label="Invoice is the acceptance" quiet
                          hidden={{ id: order.id }}>
                <input name="invoiceId" required placeholder="Invoice id"
                       aria-label="The invoice" className={`${input} w-44`} />
              </ActionForm>
            )}
            {order.pendingPush && (
              <>
                <ActionForm op="pushed" label="Told them" quiet hidden={{ id: order.id }} />
                <ActionForm op="push-failed" label="Push failed" quiet hidden={{ id: order.id }}>
                  <input name="error" required placeholder="What went wrong"
                         aria-label="Why the push failed" className={`${input} w-44`} />
                </ActionForm>
              </>
            )}
          </div>
        ) : undefined}
      />

      <h2 className="mt-10 text-base font-semibold">The networks, and what to know first</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        On the screen rather than in a help article, because a contractor needs to know that a
        warranty administrator&apos;s acceptance is final before they accept, not after.
      </p>
      <Sources sources={sources.data} unprofiled={sources.unprofiled} />
    </div>
  );
}
