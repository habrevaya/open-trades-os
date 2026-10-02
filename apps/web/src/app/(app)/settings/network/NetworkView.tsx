import type { ReactNode } from "react";
import type { network } from "@opentradesos/api/services";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty } from "@/components/Table";

type MembershipView = network.MembershipView;
type MemberRow = network.MemberRow;
type RollupRow = network.RollupRow;

/**
 * WHAT THIS COMPANY HAS AGREED TO SHOW THE GROUP
 *
 * One row per aggregate, shared and not shared in one list, because a screen
 * that only lists what is on is a screen of facts and this has to be a screen of
 * choices. Somebody deciding whether to let a franchisor see their ledger totals
 * needs to see that they currently do not.
 *
 * The description is the whole decision, so it is the service's own words rather
 * than this component's. "gl_summary" is not a label a person consents to.
 */
export function Sharing({
  view, control,
}: {
  view: MembershipView;
  control?: ((aggregate: string, sharing: boolean) => ReactNode) | undefined;
}) {
  const rows = [
    ...view.sharing.map((row) => ({ ...row, sharing: true })),
    ...view.notSharing.map((row) => ({ ...row, grantedAt: null, sharing: false })),
  ];
  return (
    <ul className="mt-3 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
      {rows.map((row) => (
        <li key={row.aggregate} className="flex flex-wrap items-start justify-between gap-3 bg-canvas p-4">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-medium">{title(row.aggregate)}</span>
              {row.sharing
                ? <Chip tone="success">Shared</Chip>
                : <Chip tone="neutral">Not shared</Chip>}
            </div>
            <p className="mt-1 text-sm text-ink-700">{row.description}</p>
            {row.sharing && row.grantedAt ? (
              <p className="mt-1 text-xs text-ink-500">Agreed {row.grantedAt.slice(0, 10)}</p>
            ) : null}
          </div>
          {control ? control(row.aggregate, row.sharing) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * The roster, including the members sharing nothing.
 *
 * Showing the silent ones is the point. A roster of only the sharing members
 * makes the missing numbers look like zeros, and that is the difference between
 * chasing a franchisee and writing off a market.
 */
export function Roster({ members }: { members: MemberRow[] }) {
  if (members.length === 0) {
    return <Empty title="Nobody in the group yet">A company joins from the operator API.</Empty>;
  }
  return (
    <Table head={<><Th>Company</Th><Th>Code</Th><Th>Sharing</Th></>}>
      {members.map((member) => (
        <tr key={member.organizationId}>
          <Td>
            <span className="font-medium">{member.name}</span>
            {member.suspended ? <Chip tone="danger" className="ml-2">Suspended</Chip> : null}
          </Td>
          <Td><span className="font-mono text-xs">{member.memberCode ?? ""}</span></Td>
          <Td>
            {member.aggregates.length === 0 ? (
              /*
                Said in words rather than left blank. An empty cell reads as a
                rendering fault; "nothing yet" reads as a conversation to have.
              */
              <span className="text-ink-500">Nothing yet</span>
            ) : (
              <span className="flex flex-wrap gap-1">
                {member.aggregates.map((aggregate) => (
                  <Chip key={aggregate} tone="info">{title(aggregate)}</Chip>
                ))}
              </span>
            )}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

/**
 * The consolidated numbers, by member and period.
 *
 * Money stays a string all the way to the formatter. A total that has been
 * through `parseFloat` is not money, and a franchise roll up is exactly where
 * somebody would notice a cent.
 */
export function Rollup({ rows, names }: { rows: RollupRow[]; names: Map<string, string> }) {
  if (rows.length === 0) {
    return (
      <Empty title="No numbers in this window">
        A member who has not agreed to this aggregate contributes nothing, silently. The roster
        above says who that is.
      </Empty>
    );
  }
  return (
    <Table head={<><Th>Company</Th><Th>Period</Th><Th>Measure</Th><Th className="text-right">Value</Th></>}>
      {rows.map((row, index) => (
        <tr key={`${row.organizationId}-${row.period}-${row.metric}-${index}`}>
          <Td>{names.get(row.organizationId) ?? row.memberCode ?? "a member"}</Td>
          <Td className="tabular-nums">{row.period}</Td>
          <Td>{title(row.metric)}</Td>
          <Td className="text-right">
            {isMoney(row.metric)
              ? <Money value={row.value} />
              : <span className="tabular-nums">{row.value}</span>}
          </Td>
        </tr>
      ))}
    </Table>
  );
}

/**
 * Which metrics are money, so a count is not rendered with a dollar sign.
 *
 * A list rather than a guess at the name, because `invoice_count` and
 * `invoiced` differ by one word and formatting the first as currency would make
 * eleven invoices read as eleven dollars.
 */
const MONEY = new Set([
  "invoiced", "collected", "revenue", "expense", "asset", "liability", "equity",
]);
const isMoney = (metric: string) => MONEY.has(metric);

/**
 * The label for an aggregate or a metric.
 *
 * A map rather than a prettifier, because the naive one turns `gl_summary` into
 * "Gl summary" and `kpi_scorecard` into "Kpi scorecard". On a screen whose whole
 * job is informed consent, a label that looks like a variable name is the thing
 * that makes somebody click away. Anything not named here falls back to the
 * prettifier, which is right for the ledger classes.
 */
const LABELS: Record<string, string> = {
  job_counts: "Job counts",
  revenue_summary: "Revenue summary",
  kpi_scorecard: "KPI scorecard",
  gl_summary: "Ledger totals by class",
  jobs_completed: "Jobs completed",
  invoiced: "Invoiced",
  collected: "Collected",
  invoices: "Invoices raised",
};

export const labelFor = (value: string): string =>
  LABELS[value] ?? value.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

const title = labelFor;
