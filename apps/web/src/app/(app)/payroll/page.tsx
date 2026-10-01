import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { payroll } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { DeclarePeriod } from "./Forms";

export const dynamic = "force-dynamic";

/**
 * PAYROLL
 *
 * Pay periods, each a start date and whole workweeks, because overtime is
 * measured over a week and a period that cuts one in half cannot be settled.
 * The product does not run payroll; it produces the file the bureau takes,
 * from hours somebody can check line by line first.
 */
export default async function PayrollPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "payroll:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Payroll" />
        <Empty title="Not shown to your role">What people are paid needs the payroll permission.</Empty>
      </div>
    );
  }

  const periods = await payroll.periods(ctx);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Payroll" count={periods.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Close a period once its hours are in, check the register, and export the file your payroll
        provider imports. Commissions earned on paid invoices are on the same register.
      </p>

      {can(user.actor, "payroll:configure") && <DeclarePeriod />}

      {periods.length === 0 ? (
        <Empty title="No pay periods yet">Add the first one above.</Empty>
      ) : (
        <ul className="mt-6 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {periods.map((period) => (
            <li key={period.id}>
              <Link href={`/payroll/${period.id}`} className="flex items-center gap-4 bg-canvas p-4 hover:bg-steel-100">
                <span className="flex-1 font-medium">{period.label}</span>
                <span className="text-sm text-ink-500">
                  From {period.startDate}, {period.weeks} {period.weeks === 1 ? "week" : "weeks"}
                </span>
                {period.closedAt
                  ? <Chip tone="success">Closed {formatIn(period.closedAt, user.organizationTimezone, { dateStyle: "medium" })}</Chip>
                  : <Chip tone="neutral">Open</Chip>}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
