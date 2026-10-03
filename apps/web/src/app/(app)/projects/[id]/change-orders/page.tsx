import Link from "next/link";
import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects, projectChangeOrders, NotFoundError } from "@opentradesos/api/services";
import { can, money } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { Empty } from "@/components/Table";
import { TextArea, TextField } from "@/components/ActionForm";
import { ProjectTabs } from "../../ProjectTabs";
import { ChangeOrderForm } from "../../ChangeOrderForms";
import { CHANGE_ORDER_STATUS, CHANGE_ORDER_TONE } from "../../ChangeOrderLabels";

export const dynamic = "force-dynamic";

/**
 * THE CHANGE ORDER LOG
 *
 * Every change on the project in the order it was raised, what it did to the
 * contract once agreed, and what is still waiting on the customer. The
 * contract before and after each agreed change is printed rather than worked
 * out, because those two numbers are the ones somebody argues about at the
 * end of a job and they should say what they said on the day.
 */
export default async function ChangeOrdersPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  const project = await projects.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const log = await projectChangeOrders.list(ctx, { projectId: id });
  const agreed = log.filter((c) => c.status === "approved");
  const net = money.sum(agreed.map((c) => money.money(c.amount)));
  const waiting = log.filter((c) => c.status === "sent" || c.status === "priced" || c.status === "requested");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href={`/projects/${id}`}>{project.name}</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Change orders</h1>
      <ProjectTabs projectId={id} current="change-orders" money={can(user.actor, "invoice:read")} />

      <dl className="mt-4 flex flex-wrap gap-x-8 gap-y-2 text-sm">
        <div><dt className="text-ink-500">Contract now</dt><dd>{project.contractValue ? <Money value={project.contractValue} /> : "Not set"}</dd></div>
        <div><dt className="text-ink-500">Agreed changes</dt><dd><Money value={money.toString(net)} /> over {agreed.length}</dd></div>
        <div><dt className="text-ink-500">Not yet agreed</dt><dd>{waiting.length}</dd></div>
      </dl>

      {log.length === 0 ? (
        <Empty title="No change orders yet">
          Log a change when the customer asks for something that was not in the contract. Nothing
          changes on the contract until they sign it.
        </Empty>
      ) : (
        <div className="mt-6 overflow-x-auto rounded-md border border-steel-200">
          <table className="w-full text-sm">
            <thead className="bg-steel-100 text-left text-ink-700">
              <tr>
                <th className="px-3 py-2 font-medium">No.</th>
                <th className="px-3 py-2 font-medium">Change</th>
                <th className="px-3 py-2 font-medium">Phase</th>
                <th className="px-3 py-2 text-right font-medium">Amount</th>
                <th className="px-3 py-2 font-medium">Status</th>
                <th className="px-3 py-2 text-right font-medium">Contract after</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-steel-200 bg-canvas">
              {log.map((order) => (
                <tr key={order.id}>
                  <td className="px-3 py-2 tabular-nums">{order.number}</td>
                  <td className="px-3 py-2">
                    <Link href={`/projects/${id}/change-orders/${order.id}`} className="font-medium underline underline-offset-4">
                      {order.title}
                    </Link>
                    {order.requestedBy && <span className="block text-xs text-ink-500">Asked for by {order.requestedBy}</span>}
                  </td>
                  <td className="px-3 py-2 text-ink-700">{order.phaseName ?? "Its own line"}</td>
                  <td className="px-3 py-2 text-right tabular-nums"><Money value={order.amount} /></td>
                  <td className="px-3 py-2"><Chip tone={CHANGE_ORDER_TONE[order.status] ?? "neutral"}>{CHANGE_ORDER_STATUS[order.status] ?? order.status}</Chip></td>
                  <td className="px-3 py-2 text-right tabular-nums">
                    {order.contractValueAfter ? <Money value={order.contractValueAfter} /> : <span className="text-ink-500">Not agreed</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {can(user.actor, "job:write") && (
        <section className="mt-8 max-w-2xl" aria-label="Log a change">
          <h2 className="text-base font-semibold">Log a change</h2>
          <p className="mt-1 text-sm text-ink-500">
            What the customer asked for. Price it on the next page, then send it to them to sign.
          </p>
          <ChangeOrderForm submit="Log change" hidden={{ op: "request", projectId: id }}>
            <TextField label="What is the change" name="title" required placeholder="Two more circuits in the kitchen" />
            <TextArea label="What the work is, for the customer" name="description" />
            <div className="grid gap-4 sm:grid-cols-2">
              <TextField label="Asked for by" name="requestedBy" placeholder="Owner, architect, inspector" />
              <TextField label="Why" name="reason" placeholder="New appliances" />
              <label className="block">
                <span className="text-sm font-medium text-ink-700">Phase it lands on</span>
                <select name="phaseId" defaultValue="" className="mt-1 h-10 w-full rounded border border-steel-300 bg-canvas px-3 text-sm">
                  <option value="">Its own line on the schedule of values</option>
                  {project.phaseList.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </label>
              <TextField label="Days it adds to the job" name="scheduleDays" inputMode="numeric" placeholder="0" />
            </div>
          </ChangeOrderForm>
        </section>
      )}
    </div>
  );
}
