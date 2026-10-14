import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commissions } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { Crumb } from "@/components/Detail";
import { ActionForm, TextArea } from "@/components/ActionForm";
import { settleShared } from "../actions";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const box = "h-9 w-24 rounded border border-steel-300 bg-canvas px-2 text-right text-sm";

/**
 * ONE SHARED COMMISSION, WORKED OUT AND SETTLED
 *
 * The even split between the people on the job is shown first with what each
 * would be paid, worked out by core under the plan. "Work it out" shows a
 * changed split the same way, through the same code settling uses, so what is
 * on the screen is what will be owed. Settling a split that is not the even
 * one asks why, and the reason goes on each person's part, where they read it
 * on their pay statement.
 *
 * The shares travel in the address while somebody works one out (`w.` and a
 * person's id), so "Work it out" is a plain form with nothing to lose.
 */
export default async function SplitPage({
  params, searchParams,
}: {
  params: Promise<{ invoiceId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSetupUser();
  const { invoiceId } = await params;
  if (!UUID.test(invoiceId)) notFound();
  if (!can(user.actor, "commission:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Shared commission" />
        <Empty title="Not shown to your role">Commission needs the permission that reads it.</Empty>
      </div>
    );
  }

  const query = await searchParams;
  const text = (name: string) => (typeof query[name] === "string" ? (query[name] as string).trim() : "");
  const asked = Object.entries(query)
    .filter((entry): entry is [string, string] => entry[0].startsWith("w.") && typeof entry[1] === "string" && UUID.test(entry[0].slice(2)))
    .map(([key, value]) => ({ technicianId: key.slice(2), weight: value.trim() === "" ? "0" : value.trim() }));
  const add = text("add");
  if (UUID.test(add) && !asked.some((s) => s.technicianId === add)) asked.push({ technicianId: add, weight: text("addWeight") || "1" });
  const planId = UUID.test(text("plan")) ? text("plan") : "";

  const ctx = { actor: user.actor, db: getDb() };
  const proposal = await commissions.proposal(ctx, {
    invoiceId, ...(planId ? { planId } : {}), ...(asked.length > 0 ? { shares: asked } : {}),
  }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "NotFoundError") notFound();
    throw error;
  });
  const configures = can(user.actor, "commission:configure");
  /** The people the split pays, for the sentence above the button. */
  const paid = proposal.people.filter((p) => p.amount !== null && Number(p.amount) > 0);
  const encoded = proposal.people.map((p) => `${p.technicianId}:${p.weight}`).join(",");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/payroll/commissions/splits">Shared commission</Crumb>
      <PageHeader title={`Commission on invoice ${proposal.invoice.number}`} />
      <p className="mt-1 text-sm text-ink-700">
        {proposal.invoice.customerName}
        {proposal.invoice.jobNumber ? <>, job {proposal.invoice.jobNumber}</> : null}
      </p>

      {proposal.settled ? (
        <section aria-label="How it was shared" className="mt-6">
          <p className="text-sm text-ink-700">
            This commission has been paid out: <Money value={proposal.settled.total} /> in all.
            {" "}{proposal.settled.splitNote ? <>Why it was shared this way: {proposal.settled.splitNote}</> : "An even split."}
          </p>
          <Table label="How it was shared" head={<><Th>Who</Th><Th className="text-right">Share</Th><Th className="text-right">Paid</Th></>}>
            {proposal.settled.parts.map((p) => (
              <tr key={p.technicianId}>
                <Td>{p.name}</Td>
                <Td className="text-right font-mono tabular-nums">{p.weight === null ? "" : Number(p.weight)}</Td>
                <Td className="text-right"><Money value={p.amount} /></Td>
              </tr>
            ))}
          </Table>
        </section>
      ) : (
        <>
          {proposal.refusal ? (
            <p role="alert" className="mt-4 rounded border border-red-600 bg-red-tint px-3 py-2 text-sm text-red-600">{proposal.refusal}</p>
          ) : (
            <p className="mt-4 text-sm text-ink-700" data-testid="split-total">
              Under {proposal.planLabel}, this invoice earns <strong><Money value={proposal.total ?? "0"} /></strong> in
              commission. That total is the plan&apos;s and does not change here: the shares only decide who gets
              how much of it.
            </p>
          )}

          <form method="get" action={`/payroll/commissions/splits/${invoiceId}`} className="mt-4">
            {proposal.plans.length > 1 ? (
              <label className="mb-3 block text-sm">
                <span className="font-medium text-ink-700">Plan</span>
                <select name="plan" defaultValue={proposal.planId ?? ""} className="mt-1 block h-9 rounded border border-steel-300 bg-canvas px-2">
                  <option value="">Choose a plan</option>
                  {proposal.plans.map((p) => <option key={p.id} value={p.id}>{p.label}</option>)}
                </select>
              </label>
            ) : null}
            <Table label="Who gets what" head={
              <><Th>Who</Th><Th className="text-right">Even split</Th><Th className="text-right">Share</Th><Th className="text-right">Gets</Th></>
            }>
              {proposal.people.map((p) => (
                <tr key={p.technicianId}>
                  <Td>
                    <span className="font-medium">{p.name}</span>
                    <span className="block text-xs text-ink-500">{p.onJob ? "On the job" : "Added by the office"}</span>
                  </Td>
                  <Td className="text-right font-mono tabular-nums">{Number(p.proposedWeight)}</Td>
                  <Td className="text-right">
                    <input name={`w.${p.technicianId}`} aria-label={`Share for ${p.name}`} defaultValue={Number(p.weight).toString()}
                           inputMode="decimal" className={box} />
                  </Td>
                  <Td className="text-right">{p.amount === null ? "" : <Money value={p.amount} />}</Td>
                </tr>
              ))}
            </Table>
            <div className="mt-3 flex flex-wrap items-end gap-3">
              {proposal.others.length > 0 ? (
                <>
                  <label className="text-sm">
                    <span className="block font-medium text-ink-700">Add someone</span>
                    <select name="add" defaultValue="" className="mt-1 h-9 rounded border border-steel-300 bg-canvas px-2">
                      <option value="">Nobody</option>
                      {proposal.others.map((p) => <option key={p.technicianId} value={p.technicianId}>{p.name}</option>)}
                    </select>
                  </label>
                  <label className="text-sm">
                    <span className="block font-medium text-ink-700">Their share</span>
                    <input name="addWeight" inputMode="decimal" placeholder="1" className={`${box} mt-1`} />
                  </label>
                </>
              ) : null}
              <button type="submit" className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
                Work it out
              </button>
            </div>
            <p className="mt-2 max-w-2xl text-xs text-ink-500">
              A share is a part of the whole, not a percent: 2 and 1 is two thirds and one third. Put 0 to leave
              somebody out. When the cents do not divide evenly, the odd cent goes to the biggest share.
            </p>
          </form>

          {configures && !proposal.refusal ? (
            <section aria-label="Settle it" className="mt-8 rounded-md border border-steel-200 p-4">
              <h2 className="text-base font-semibold">Settle it</h2>
              <p className="mt-1 text-sm text-ink-700">
                {paid.map((p, i, all) => (
                  <span key={p.technicianId}>{i > 0 ? (i === all.length - 1 ? " and " : ", ") : ""}{p.name} <Money value={p.amount!} /></span>
                ))}. Once settled, this is owed to them and goes on their next pay run.
                {proposal.changed ? " This is not an even split between the people on the job, so say why. They will read it on their pay statement." : null}
              </p>
              <ActionForm action={settleShared} submit="Settle this split" className="mt-3 space-y-3"
                          hidden={{ invoiceId, shares: encoded, ...(proposal.planId ? { planId: proposal.planId } : {}) }}>
                {proposal.changed ? (
                  <TextArea label="Why it is shared this way" name="reason" rows={2} required maxLength={500}
                            placeholder="Ray sold the system on the first visit." />
                ) : null}
              </ActionForm>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
