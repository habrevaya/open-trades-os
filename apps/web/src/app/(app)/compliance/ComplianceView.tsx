import type { ReactNode } from "react";
import { Chip } from "@opentradesos/ui";

export interface DocumentRow {
  id: string; kind: string; name: string; reference: string | null; issuerName: string | null;
  expiresOn: string | null; requiredForWork: boolean;
  standing: "expired" | "act_now" | "upcoming" | "current" | "no_expiry";
  actBy: string | null; statement: string;
}

export interface SubmissionRow {
  id: string; kind: string; authorityName: string; periodStart: string | null; periodEnd: string | null;
  state: string; dueOn: string | null; overdue: boolean; acknowledgementReference: string | null;
  rejectionReason: string | null; statement: string;
}

const STANDING = {
  expired: ["danger", "Expired"], act_now: ["warning", "Renew now"], upcoming: ["info", "Coming up"],
  current: ["success", "Current"], no_expiry: ["neutral", "Does not expire"],
} as const;

const STATE: Record<string, string> = {
  due: "Owed", prepared: "Prepared", submitted: "Submitted", acknowledged: "Acknowledged",
  rejected: "Rejected", resubmitted: "Resubmitted", waived: "Waived", superseded: "Replaced",
};

/**
 * Counts and no verdict, which is the module's own position: a single
 * "compliant" word assembled from these would claim the set is complete, and
 * nothing here knows what the set should be.
 */
export function Counts({ summary }: {
  summary: { expired: number; actNow: number; upcoming: number; noExpiry: number; expiredAndRequiredForWork: number };
}) {
  return (
    <dl className="mt-3 grid grid-cols-2 gap-3 rounded-md border border-steel-200 bg-canvas p-4 text-sm sm:grid-cols-4">
      <div><dt className="text-ink-500">Expired</dt><dd className={summary.expired > 0 ? "font-semibold text-red-600" : "font-semibold"}>{summary.expired}</dd></div>
      <div><dt className="text-ink-500">Renew now</dt><dd className="font-semibold">{summary.actNow}</dd></div>
      <div><dt className="text-ink-500">Coming up</dt><dd className="font-semibold">{summary.upcoming}</dd></div>
      <div><dt className="text-ink-500">Expired and needed for work</dt><dd className={summary.expiredAndRequiredForWork > 0 ? "font-semibold text-red-600" : "font-semibold"}>{summary.expiredAndRequiredForWork}</dd></div>
      <p className="col-span-full text-xs text-ink-500">
        What is on file, not whether it is everything you need: that depends on your trade, state, contracts and insurer.
      </p>
    </dl>
  );
}

export function Documents({ rows, controls }: { rows: DocumentRow[]; controls?: (row: DocumentRow) => ReactNode }) {
  if (rows.length === 0) return <p className="mt-2 text-sm text-ink-500">Nothing on file.</p>;
  return (
    <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
      {rows.map((d) => {
        const [tone, text] = STANDING[d.standing];
        return (
          <li key={d.id} className="bg-canvas p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1">
                <span className="font-medium">{d.name}</span>
                <span className="text-ink-500"> · {d.kind}{d.reference ? ` · ${d.reference}` : ""}{d.issuerName ? ` · ${d.issuerName}` : ""}</span>
              </span>
              {d.requiredForWork && <Chip tone="neutral">Needed for work</Chip>}
              {d.expiresOn && <span className="text-ink-700">Until {d.expiresOn}</span>}
              <Chip tone={tone}>{text}</Chip>
            </div>
            <p className="mt-1 text-xs text-ink-500">{d.statement}</p>
            {controls && <div className="mt-2">{controls(d)}</div>}
          </li>
        );
      })}
    </ul>
  );
}

export function Filings({ rows, controls }: { rows: SubmissionRow[]; controls?: (row: SubmissionRow) => ReactNode }) {
  if (rows.length === 0) return <p className="mt-2 text-sm text-ink-500">Nothing owed.</p>;
  return (
    <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
      {rows.map((s) => (
        <li key={s.id} className="bg-canvas p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1">
              <span className="font-medium">{s.kind}</span>
              <span className="text-ink-500"> · {s.authorityName}{s.periodStart ? ` · ${s.periodStart} to ${s.periodEnd ?? "?"}` : ""}</span>
            </span>
            {s.dueOn && <span className={s.overdue ? "text-red-600" : "text-ink-700"}>Due {s.dueOn}</span>}
            {s.overdue && <Chip tone="danger">Late</Chip>}
            <Chip tone={s.state === "acknowledged" ? "success" : s.state === "rejected" ? "danger" : "neutral"}>{STATE[s.state] ?? s.state}</Chip>
          </div>
          <p className="mt-1 text-xs text-ink-500">
            {s.statement}
            {s.acknowledgementReference && <> Reference {s.acknowledgementReference}.</>}
            {s.rejectionReason && <> Rejected: {s.rejectionReason}</>}
          </p>
          {controls && <div className="mt-2">{controls(s)}</div>}
        </li>
      ))}
    </ul>
  );
}
