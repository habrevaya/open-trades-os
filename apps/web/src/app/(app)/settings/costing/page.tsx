import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { costing } from "@opentradesos/api/services";
import { can, costing as rules } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { formatDay } from "@/lib/dates";
import { addRate, removeRate, setOverhead } from "./actions";

export const dynamic = "force-dynamic";

const COMPONENTS = rules.COMPONENTS.map((c) => ({ value: c, label: rules.COMPONENT_LABEL[c] }));
const BASES = rules.BASES.map((b) => ({ value: b, label: rules.BASIS_LABEL[b] }));

const PER: Record<"per_hour" | "per_job" | "per_visit" | "per_truck", string> = {
  per_hour: "per paid hour", per_job: "per job", per_visit: "per visit", per_truck: "per truck day",
};

/** One part of the overhead in words: "$12.00 per paid hour", "3% of revenue". */
function partText(basis: rules.OverheadBasis, rate: string): string {
  if (basis === "percent_of_revenue") return `${rate}% of revenue`;
  if (basis === "percent_of_material") return `${rate}% of material cost`;
  return `$${Number(rate).toFixed(2)} ${PER[basis]}`;
}

/** Today's figure for a part, to start the form from, so changing one part does not drop the others. */
function currentPart(now: { parts: { basis: string; rate: string }[] } | null, basis: rules.OverheadBasis): string {
  return now?.parts.find((p) => p.basis === basis)?.rate ?? "";
}

/**
 * SETTINGS → COSTING
 *
 * The rates that turn the direct margin on every job into a fully loaded one
 * beside it: the employer's payroll taxes, benefits and workers'
 * compensation on each paid hour, and overhead spread across jobs. Each is a
 * dated history, so a change applies from its day and the past keeps the rate
 * it was costed at.
 *
 * Read with job cost (`job.cost:read`), changed by finance
 * (`finance:configure`).
 */
export default async function CostingPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "job.cost:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Costing" />
        <Empty title="Not shown to your role">Burden and overhead rates are costs, and need the job cost permission.</Empty>
      </div>
    );
  }

  const { rates, today, overheadNow } = await costing.list(ctx);
  const writes = can(user.actor, "finance:configure");
  const hour = await costing.hour(ctx, { baseRate: "30" });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Costing" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Job costing shows two margins. The direct margin is revenue less materials, hours at each
        person&rsquo;s loaded wage and card fees. The fully loaded margin also takes off what you set here:
        labour burden on every paid hour, and overhead spread across jobs. With nothing set, the two are the
        same. A percentage of wages is of the base wage on each punch.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        An overhead allocation is a choice, not a measurement. By revenue, every job keeps the margin
        percentage it already had; by the hour, a job that ran long is charged twice for the same overrun;
        per job, a quick call carries as much as an install; by material cost, a job heavy on parts carries
        more; per visit, a second trip is charged again; per truck day, each truck that went out on the job
        is charged once for each day, as your vehicle register says who had it. You can mix them, and each
        job shows what each part charged it.
      </p>

      <p className="mt-4 text-sm text-ink-700">
        Today, an hour at a $30.00 wage costs <strong>${Number(hour.total).toFixed(2)}</strong>: the wage,
        ${Number(hour.burden).toFixed(2)} of burden{Number(hour.overhead) > 0 ? ` and $${Number(hour.overhead).toFixed(2)} of overhead` : ""}.
      </p>

      <p className="mt-2 text-sm text-ink-700" data-testid="overhead-now">
        {overheadNow
          ? <>Overhead today, set from {formatDay(overheadNow.effectiveFrom, user.organizationTimezone)}: {overheadNow.parts.map((p, i) => (
            <span key={p.basis}>{i > 0 ? (i === overheadNow.parts.length - 1 ? " and " : ", ") : ""}<strong>{partText(p.basis, p.rate)}</strong></span>
          ))}.</>
          : "No overhead is charged to jobs today."}
      </p>

      {rates.length === 0 ? (
        <Empty title="No rates set">The fully loaded margin equals the direct margin until you add one.</Empty>
      ) : (
        <Table label="Costing rates" head={
          <><Th>What</Th><Th>Charged</Th><Th className="text-right">Rate</Th><Th>From</Th><Th>{""}</Th></>
        }>
          {rates.map((r) => (
            <tr key={r.id}>
              <Td>
                <span className="font-medium">{r.componentLabel}</span>
                {r.current ? <Chip tone="success" className="ml-2">In effect</Chip> : r.effectiveFrom > today ? <Chip tone="info" className="ml-2">Scheduled</Chip> : null}
                {r.note ? <span className="block text-xs text-ink-500">{r.note}</span> : null}
              </Td>
              <Td className="text-ink-700">{r.basisLabel}</Td>
              <Td className="text-right font-mono tabular-nums">
                {rules.isPercent(r.basis) ? `${r.rate}%` : `$${Number(r.rate).toFixed(2)}`}
              </Td>
              <Td>{formatDay(r.effectiveFrom, user.organizationTimezone)}</Td>
              <Td>
                {writes ? (
                  <ActionForm action={removeRate} submit="Remove" tone="quiet" hidden={{ id: r.id }} className="flex items-center gap-2" />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <section aria-label="Overhead from a date" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-base font-semibold">Overhead from a date</h2>
          <p className="mt-1 text-sm text-ink-700">
            Fill in one part or several. Whatever you set here is all of your overhead from that day: a part you
            leave empty is not charged from then, even if it was before. Jobs before the day keep the overhead
            of their own day. Put 0 in one box to stop charging overhead.
          </p>
          <ActionForm action={setOverhead} submit="Set overhead" className="mt-3 grid gap-3 sm:grid-cols-3">
            <TextField label="Per paid hour ($)" name="perHour" inputMode="decimal" placeholder="12.00"
                       defaultValue={currentPart(overheadNow, "per_hour")} />
            <TextField label="Per job ($)" name="perJob" inputMode="decimal" placeholder="25.00"
                       defaultValue={currentPart(overheadNow, "per_job")} />
            <TextField label="Share of revenue (%)" name="percentOfRevenue" inputMode="decimal" placeholder="3"
                       defaultValue={currentPart(overheadNow, "percent_of_revenue")} />
            <TextField label="Share of material cost (%)" name="percentOfMaterial" inputMode="decimal" placeholder="10"
                       defaultValue={currentPart(overheadNow, "percent_of_material")} />
            <TextField label="Per visit ($)" name="perVisit" inputMode="decimal" placeholder="15.00"
                       defaultValue={currentPart(overheadNow, "per_visit")} />
            <TextField label="Per truck day ($)" name="perTruck" inputMode="decimal" placeholder="40.00"
                       defaultValue={currentPart(overheadNow, "per_truck")} />
            <TextField label="From" name="effectiveFrom" type="date" defaultValue={today} required />
            <TextField label="Note (optional)" name="note" className="sm:col-span-2" />
          </ActionForm>
        </section>
      ) : null}

      {writes ? (
        <section aria-label="Add a rate" className="mt-8 rounded-md border border-steel-200 p-4">
          <h2 className="text-base font-semibold">Add a rate</h2>
          <p className="mt-1 text-sm text-ink-700">
            Burden is a percent of base wages or an amount per paid hour. Overhead is per paid hour, per job, a
            percent of the job&rsquo;s revenue or material cost, per visit or per truck day; an overhead rate on a day that already has overhead another way
            is added to that day&rsquo;s mix. A zero switches one off from its date.
          </p>
          <ActionForm action={addRate} submit="Add rate" className="mt-3 grid gap-3 sm:grid-cols-2">
            <Select label="What" name="component" options={COMPONENTS} />
            <Select label="Charged" name="basis" options={BASES} />
            <TextField label="Rate (a percent or an amount)" name="rate" inputMode="decimal" placeholder="7.65" required />
            <TextField label="From" name="effectiveFrom" type="date" defaultValue={today} required />
            <TextField label="Note (optional)" name="note" className="sm:col-span-2" />
          </ActionForm>
        </section>
      ) : (
        <p className="mt-6 text-sm text-ink-500">Changing these needs the Set labour burden, overhead rates and the company budget permission.</p>
      )}
    </div>
  );
}
