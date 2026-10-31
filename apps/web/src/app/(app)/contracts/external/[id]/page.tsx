import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, externalWork, externalWorkCodes, jobs } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Empty, Table, Th, Td } from "@/components/Table";
import { acceptAsProposed, saveClient } from "../actions";

export const dynamic = "force-dynamic";

const money = (value: string) => Number(value).toFixed(2);

/**
 * ONE ORDER FROM ANOTHER SYSTEM, AND THE JOB ITS CODES ADD UP TO
 *
 * The client writes its own codes on the order. Read against that client's list
 * (`/contracts/external/codes/{customerId}`), they propose the job: the kind of
 * work, a line per mapped item priced the way the client's card will price it,
 * and every code nobody mapped named in words. Nothing is put on a job until
 * somebody presses **Accept and make the job**, which sends the proposal's key,
 * so a list changed in between is refused rather than used. Accepting by hand,
 * with or without a job, stays on the list page.
 */
export default async function ExternalOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { id } = await params;

  if (!can(user.actor, "contract:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <h1 className="text-xl font-semibold">Work order</h1>
        <Empty title="Not shown to your role">This needs the permission that reads contracts.</Empty>
      </div>
    );
  }

  const [order, shown] = await Promise.all([
    externalWork.get(ctx, { id }),
    externalWorkCodes.proposal(ctx, { id }),
  ]);
  const writes = can(user.actor, "contract:write");
  const makesJobs = writes && can(user.actor, "job:write");
  const [people, types] = await Promise.all([
    writes && !order.jobId && can(user.actor, "customer:read")
      ? customers.list(ctx, { limit: 200, includeInactive: false }) : { data: [] },
    makesJobs && can(user.actor, "job:read") ? jobs.listTypes(ctx, { includeInactive: false }) : { data: [] },
  ]);
  const clientOptions = people.data
    .map((c) => ({ value: c.id as string, label: c.name as string }))
    .sort((a, b) => a.label.localeCompare(b.label));
  const typeOptions = [{ value: "", label: "No kind of work" }, ...types.data.map((t) => ({ value: t.id, label: t.name }))];

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/contracts/external">Work from other systems</Crumb>
      <h1 className="mt-1 text-xl font-semibold">
        {order.sourceLabel} order {order.externalNumber ?? order.externalId}
      </h1>
      <p className="mt-1 text-sm text-ink-700">
        They say <span className="font-mono">{order.externalStatus ?? "nothing yet"}</span>.
        {" "}{order.jobId ? <a href={`/jobs/${order.jobId}`} className="underline">Open the job</a> : "No job yet."}
      </p>

      <section aria-label="Who it is for" className="mt-6">
        <h2 className="text-base font-semibold">Who it is for</h2>
        {order.customerId ? (
          <p className="mt-1 text-sm">
            {order.clientName}.{" "}
            <a href={`/contracts/external/codes/${order.customerId}`} className="underline">
              {order.clientName}&apos;s codes
            </a>
          </p>
        ) : (
          <p className="mt-1 text-sm text-ink-700">Nobody has said yet. Their codes mean nothing until somebody does.</p>
        )}
        {writes && !order.jobId && clientOptions.length > 0 ? (
          <ActionForm action={saveClient} submit="Save the client" tone="quiet" className="mt-2 flex flex-wrap items-end gap-3"
                      hidden={{ id: order.id }}>
            <Select label="This order is for" name="customerId" options={clientOptions}
                    defaultValue={order.customerId ?? ""} />
          </ActionForm>
        ) : null}
      </section>

      <section aria-label="Their codes" className="mt-8">
        <h2 className="text-base font-semibold">Their codes, and what they add up to</h2>
        {shown.codes.length === 0 ? (
          <p className="mt-1 text-sm text-ink-700">The order carries no codes.</p>
        ) : (
          <ul className="mt-2 space-y-1 text-sm">
            {shown.codes.map((c, i) => (
              <li key={`${c.code}-${i}`} className={c.unmapped ? "text-amber-700" : "text-ink-900"}>
                <span className="font-mono">{c.code}</span>{c.quantity ? ` x ${c.quantity}` : ""}: {c.words}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-label="Make the job from their codes" className="mt-8">
        <h2 className="text-base font-semibold">Make the job from their codes</h2>
        {shown.refusal ? (
          <p className="mt-1 text-sm text-ink-700">{shown.refusal}</p>
        ) : (
          <>
            {shown.lines.length === 0 ? (
              <p className="mt-1 text-sm text-ink-700">None of the codes adds a line. The job is made with no lines.</p>
            ) : (
              <Table label="Lines the codes add" head={
                <><Th>Their code</Th><Th>Item</Th><Th>How many</Th><Th>Our price</Th><Th>Charged at</Th></>
              }>
                {shown.lines.map((line, i) => (
                  <tr key={`${line.code}-${i}`}>
                    <Td className="font-mono">{line.code}</Td>
                    <Td>{line.name}</Td>
                    <Td>{line.quantity}</Td>
                    <Td>{money(line.ourPrice)}</Td>
                    <Td>
                      {money(line.unitPrice)}
                      <span className="block text-xs text-ink-500">{line.pricedBy}{line.note ? `. ${line.note}` : ""}</span>
                      {line.outOfScope ? (
                        <Chip tone="warning">Not on their card. Agree it with them first.</Chip>
                      ) : null}
                    </Td>
                  </tr>
                ))}
              </Table>
            )}
            <p className="mt-2 text-xs text-ink-500">
              The job records our price. When it is billed, {shown.clientName}&apos;s card prices each line again,
              by our item or by their code.
            </p>
            {shown.unmapped.length > 0 ? (
              <div className="mt-3 rounded border border-amber-700 bg-amber-tint p-3 text-sm" role="note">
                <p className="font-medium">Nothing is added for these. They go in the job&apos;s notes.</p>
                <ul className="mt-1 list-disc pl-5">
                  {shown.unmapped.map((words) => <li key={words}>{words}</li>)}
                </ul>
              </div>
            ) : null}

            {makesJobs ? (
              shown.places.length === 0 ? (
                <p className="mt-3 text-sm text-ink-700">
                  {shown.clientName} has no address to put the job at. Add one on their customer page first.
                </p>
              ) : (
                <ActionForm action={acceptAsProposed} submit="Accept and make the job"
                            hidden={{ id: order.id, key: shown.key, formKey: crypto.randomUUID() }}>
                  <div className="grid gap-3 sm:grid-cols-3">
                    <Select label="Where" name="propertyId" options={shown.places.map((p) => ({
                      value: p.propertyId, label: p.siteNumber ? `${p.label} (site ${p.siteNumber})` : p.label,
                    }))} />
                    <Select label="Kind of work" name="jobTypeId" options={typeOptions}
                            defaultValue={shown.jobTypeId ?? ""} />
                    <TextField label="Summary" name="summary"
                               placeholder={`${order.sourceLabel} order ${order.externalNumber ?? order.externalId}`} />
                  </div>
                  {shown.jobTypeNote ? <p className="text-sm text-amber-700">{shown.jobTypeNote}</p> : null}
                  {order.acceptanceIsIrreversible ? (
                    <p className="text-sm text-amber-700">Accepting is final on this network.</p>
                  ) : null}
                </ActionForm>
              )
            ) : (
              <p className="mt-3 text-sm text-ink-700">Making the job needs the permissions to change contracts and jobs.</p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
