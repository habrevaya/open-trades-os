import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { labor } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * A WEEK OF HOURS, AND WHAT THEY COST
 *
 * Four numbers per person: regular, overtime, double time, and the money.
 * The money is the one that did not exist. Every timeclock entry carried
 * three applied rate columns under a comment saying they were frozen at
 * close, and nothing wrote them, so labour contributed nothing to job
 * costing and every margin on every other screen in this product was
 * missing its largest expense.
 *
 * NOTHING HERE IS STORED. The overtime split is derived from the entries
 * every time this page loads, for the same reason a stock level is: a stored
 * overtime total is a number somebody can edit, and a payroll figure nobody
 * can explain is worse than a wrong one. What IS stored is the rate each
 * entry was frozen at, which is a fact about a day rather than a conclusion
 * about a week.
 */
export default async function TimesheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ week?: string }>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const params = await searchParams;

  if (!can(user.actor, "timesheet:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Timesheets" />
        <Empty title="Timesheets are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const weekOf = params.week ?? new Date().toISOString().slice(0, 10);

  let result: Awaited<ReturnType<typeof labor.week>> | null = null;
  let refusal: string | null = null;
  try {
    result = await labor.week(ctx, { weekOf });
  } catch (error) {
    /**
     * The refusal is SHOWN, not swallowed into an empty table.
     *
     * The only thing this can refuse for is a company with no overtime policy
     * set, and that refusal is the entire safety property: there is no
     * default that is not a legal position on somebody's wages. An empty
     * table here would read as "nobody worked this week".
     */
    refusal = error instanceof Error ? error.message : "Could not read the week.";
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Timesheets" />

      {refusal ? (
        <Empty title="No overtime policy is set">
          {refusal}
        </Empty>
      ) : (
        <>
          <p className="mt-1 max-w-prose text-sm text-ink-500">
            Week of {result!.weekStart}, under {result!.policy.label}.{" "}
            {result!.policy.note}
          </p>

          {result!.rows.length === 0 ? (
            <Empty title="Nobody was on the clock this week">
              Hours arrive when technicians punch in and out from the field app.
            </Empty>
          ) : (
            <Table
              head={
                <>
                  <Th>Person</Th>
                  <Th>Classification</Th>
                  <Th className="text-right">Regular</Th>
                  <Th className="text-right">Overtime</Th>
                  <Th className="text-right">Double</Th>
                  <Th className="text-right">Total</Th>
                  <Th className="text-right">Cost</Th>
                </>
              }
            >
                {result!.rows.map((row) => (
                  <tr key={row.technicianId}>
                    <Td>
                      {row.technicianName}
                      {row.openEntries > 0 && (
                        /*
                          An open punch is named rather than folded into the
                          total. Core refuses to classify a week containing
                          one, because an entry still running is worth an
                          unknown amount and paying an unknown amount as zero
                          is exactly the failure it exists to prevent. Saying
                          so is what lets a supervisor go and fix it.
                        */
                        <span className="ml-2 rounded bg-amber-tint px-1.5 py-0.5 text-xs text-amber-700">
                          {row.openEntries} still running
                        </span>
                      )}
                    </Td>
                    <Td>{row.classification ?? "Not set"}</Td>
                    <Td className="text-right tabular-nums">{row.regularHours}</Td>
                    <Td className="text-right tabular-nums">{row.overtimeHours}</Td>
                    <Td className="text-right tabular-nums">{row.doubleTimeHours}</Td>
                    <Td className="text-right tabular-nums">{row.totalHours}</Td>
                    <Td className="text-right tabular-nums">
                      {row.cost
                        ? `$${Number(row.cost).toFixed(2)}`
                        : (
                          /*
                            Blank, not zero. One entry with no frozen rate
                            makes the whole row unknown, and a partial total
                            that looks complete is worse than an empty cell:
                            nobody questions a number, and everybody
                            questions a blank.
                          */
                          <span className="text-ink-500">Not priced</span>
                        )}
                    </Td>
                  </tr>
                ))}
            </Table>
          )}
        </>
      )}
    </div>
  );
}
