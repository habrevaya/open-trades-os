import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commissions } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { Crumb } from "@/components/Detail";
import { formatIn } from "@/lib/dates";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { setStanding, endStanding } from "./actions";

export const dynamic = "force-dynamic";

/**
 * PAYROLL → SHARED COMMISSION
 *
 * The invoices on jobs more than one person worked, waiting for their
 * commission to be shared and settled, and the last ones that were. A shared
 * commission used to be settled one earning at a time over the API with the
 * shares typed as numbers, so the office never saw who would get what before
 * it was owed.
 *
 * `commission:read` to look. Settling, on each invoice's own page, takes
 * `commission:configure`, as settling any commission does.
 */
export default async function SharedCommissionPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "commission:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Shared commission" />
        <Empty title="Not shown to your role">Commission needs the permission that reads it.</Empty>
      </div>
    );
  }
  const ctx = { actor: user.actor, db: getDb() };
  const { waiting, settled } = await commissions.shared(ctx);
  const standing = await commissions.standingShares(ctx);
  const configures = can(user.actor, "commission:configure");

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/payroll/commissions">Commission plans</Crumb>
      <PageHeader title="Shared commission" count={waiting.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Invoices on jobs that more than one person worked, with no commission paid out on them yet. Open one to see
        who gets what. It starts as an even split between the people on the job, or with the standing shares below
        when somebody on the job has one. You can change the shares, and if you do, you write down why, and the
        people paid see your reason on their pay statement.
      </p>

      {waiting.length === 0 ? (
        <Empty title="Nothing waiting">
          An invoice shows up here once it is sent, on a job with two or more people on its visits, made since your
          first commission plan.
        </Empty>
      ) : (
        <Table label="Waiting to be shared" head={
          <><Th>Invoice</Th><Th>Customer</Th><Th>Job</Th><Th>People on the job</Th><Th className="text-right">Revenue</Th><Th>{""}</Th></>
        }>
          {waiting.map((row) => (
            <tr key={row.invoiceId}>
              <Td>
                <span className="font-medium">{row.invoiceNumber}</span>
                <span className="block text-xs text-ink-500">{formatIn(row.issuedAt, user.organizationTimezone, { month: "short", day: "numeric", year: "numeric" })}</span>
              </Td>
              <Td>{row.customerName}</Td>
              <Td>{row.jobNumber}</Td>
              <Td>{row.people.map((p) => p.name).join(", ")}</Td>
              <Td className="text-right"><Money value={row.revenue} /></Td>
              <Td>
                <a href={`/payroll/commissions/splits/${row.invoiceId}`} className="font-medium underline underline-offset-4">
                  Share it
                </a>
              </Td>
            </tr>
          ))}
        </Table>
      )}

      <section aria-label="Standing shares" className="mt-10">
        <h2 className="text-base font-semibold">Standing shares</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          Somebody who always gets the same part of a commission they share, like the person who sells the systems
          always getting 30%. When they are on a job, the split starts with their share and the rest is shared evenly
          between the others. You can still change any split before you settle it.
        </p>
        {standing.live.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">Nobody has a standing share. Every split starts even.</p>
        ) : (
          <Table label="Standing shares" head={<><Th>Who</Th><Th>Why</Th><Th>{""}</Th></>}>
            {standing.live.map((row) => (
              <tr key={row.id}>
                <Td>{row.inWords}</Td>
                <Td className="text-ink-700">{row.reason}</Td>
                <Td>
                  {configures ? (
                    <ActionForm action={endStanding} submit="Stop" tone="quiet" className="" hidden={{ id: row.id }} />
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        {configures && standing.people.length > 0 ? (
          <ActionForm action={setStanding} submit="Set standing share" className="mt-4 grid max-w-2xl gap-3 sm:grid-cols-2">
            <Select label="Who" name="technicianId" required
                    options={standing.people.map((p) => ({ value: p.technicianId, label: p.name }))} />
            <TextField label="Their share, in percent" name="percent" inputMode="numeric" placeholder="30" required />
            <label className="flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" name="asLead" />
              <span>Only on jobs where they lead a visit</span>
            </label>
            <TextField label="Why they always get it" name="reason" placeholder="Sells the systems" required className="block sm:col-span-2" />
          </ActionForm>
        ) : null}
        {standing.ended.length > 0 ? (
          <p className="mt-3 text-xs text-ink-500">
            Stopped lately: {standing.ended.map((row) => row.inWords.replace(/\.$/, "")).join("; ")}. Commission already
            settled keeps the split it was settled with.
          </p>
        ) : null}
      </section>

      <h2 className="mt-10 text-base font-semibold">Shared lately</h2>
      {settled.length === 0 ? (
        <p className="mt-2 text-sm text-ink-500">No commission has been shared yet.</p>
      ) : (
        <Table label="Shared lately" head={
          <><Th>Invoice</Th><Th>Who got what</Th><Th className="text-right">Commission</Th><Th>Why it was shared this way</Th></>
        }>
          {settled.map((row) => (
            <tr key={row.invoiceId}>
              <Td>
                <a href={`/payroll/commissions/splits/${row.invoiceId}`} className="font-medium underline underline-offset-4">{row.invoiceNumber}</a>
              </Td>
              <Td>
                {row.parts.map((p) => (
                  <span key={p.technicianId} className="block">{p.name}: <Money value={p.amount} /></span>
                ))}
              </Td>
              <Td className="text-right"><Money value={row.total} /></Td>
              <Td className="text-ink-700">{row.splitNote ?? row.standingNote ?? "An even split."}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
