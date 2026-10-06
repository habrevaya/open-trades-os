import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { payroll, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Crumb } from "@/components/Detail";
import { formatIn } from "@/lib/dates";
import { Register } from "../Register";
import { ClosePeriod, ExportCsv, PayCommissions, PayTips, ReopenPeriod } from "../Forms";

export const dynamic = "force-dynamic";

/**
 * One pay period: the register, then what can be done with it.
 *
 * Open: the register is live and can only be closed. Closed: it is frozen at
 * the close, and the export and the commission payout become possible. The
 * export refuses if a punch moved after the close, which is what makes an
 * edit after the fact visible rather than a quietly different file.
 */
export default async function PayPeriodPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "payroll:read")) notFound();

  const register = await payroll.register(ctx, { periodId: id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const exports = await payroll.exportsFor(ctx, { periodId: id });
  const exportsAllowed = can(user.actor, "payroll:export");
  const tz = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/payroll">Payroll</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline gap-3">
        <h1 className="text-xl font-semibold">{register.label}</h1>
        {register.closedAt ? <Chip tone="success">Closed</Chip> : <Chip tone="neutral">Open</Chip>}
      </div>
      <p className="mt-1 text-sm text-ink-500">
        {formatIn(register.periodStart, tz, { dateStyle: "medium" })} to{" "}
        {formatIn(register.periodEnd, tz, { dateStyle: "medium" })}
        {register.closedAt && <>, closed {formatIn(register.closedAt, tz)}</>}
      </p>

      {exportsAllowed && (
        <div className="mt-4 flex flex-wrap items-start gap-3">
          {register.closedAt ? (
            <>
              <ExportCsv periodId={id} label={register.label} />
              <PayCommissions periodId={id} />
              <PayTips periodId={id} />
              <ReopenPeriod periodId={id} />
            </>
          ) : (
            <ClosePeriod periodId={id} />
          )}
        </div>
      )}

      <Register data={register} />

      {exports.length > 0 && (
        <section className="mt-8">
          <h2 className="text-base font-semibold">Exports</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {exports.map((e) => (
              <li key={e.id} className="flex flex-wrap gap-3">
                <span>{formatIn(e.generatedAt, tz)}</span>
                <span className="text-ink-500">{e.rowCount} rows</span>
                <span className="tabular-nums"><Money value={e.grossTotal} /></span>
                <code className="font-mono text-xs text-ink-500">{e.checksum.slice(0, 12)}</code>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
