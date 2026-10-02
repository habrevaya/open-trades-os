import type { ReactNode } from "react";
import { Chip } from "@opentradesos/ui";

export interface Holding {
  id: string;
  technicianId: string;
  technicianName: string;
  name: string;
  authority: string | null;
  grantsSkills: string[];
  reference: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  status: string;
  statusReason: string | null;
  current: boolean;
  lapseReason: "expired" | "suspended" | "revoked" | null;
  verifiedAt: Date | string | null;
}

export interface Expiring extends Holding {
  daysRemaining: number;
}

const LAPSE: Record<string, string> = { expired: "Expired", suspended: "Suspended", revoked: "Revoked" };

/**
 * What is about to run out, first, because that is the list somebody acts
 * on this week. Already expired rows stay on it: a renewal list that drops a
 * licence the day it lapses is empty exactly when it was needed.
 */
export function ExpiringList({ rows }: { rows: Expiring[] }) {
  if (rows.length === 0) return <p className="mt-2 text-sm text-ink-500">Nothing is due for renewal.</p>;
  return (
    <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
      {rows.map((r) => (
        <li key={r.id} className="flex flex-wrap items-center gap-3 bg-canvas p-3 text-sm">
          <span className="flex-1"><span className="font-medium">{r.technicianName}</span> · {r.name}</span>
          <span className="text-ink-700">{r.expiresOn}</span>
          {r.daysRemaining < 0
            ? <Chip tone="danger">Expired {-r.daysRemaining} {r.daysRemaining === -1 ? "day" : "days"} ago</Chip>
            : <Chip tone="warning">{r.daysRemaining} {r.daysRemaining === 1 ? "day" : "days"} left</Chip>}
        </li>
      ))}
    </ul>
  );
}

/**
 * Everything held, grouped by person, the lapsed and revoked included:
 * "was this person certified the day they did that work" is the question
 * these rows exist to answer, and a list of only what is current loses it.
 */
export function HoldingsByPerson({ rows, controls }: {
  rows: Holding[];
  controls?: (row: Holding) => ReactNode;
}) {
  const byPerson = new Map<string, Holding[]>();
  for (const row of rows) byPerson.set(row.technicianName, [...(byPerson.get(row.technicianName) ?? []), row]);
  if (rows.length === 0) return <p className="mt-2 text-sm text-ink-500">Nobody has a certification recorded.</p>;
  return (
    <div className="mt-2 space-y-4">
      {[...byPerson.entries()].map(([person, held]) => (
        <section key={person} className="rounded-md border border-steel-200 bg-canvas p-3">
          <h3 className="font-medium">{person}</h3>
          <ul className="mt-1 divide-y divide-steel-200">
            {held.map((h) => (
              <li key={h.id} className="py-2 text-sm">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="flex-1">
                    {h.name}
                    {h.reference && <span className="text-ink-500"> · {h.reference}</span>}
                    {h.grantsSkills.length > 0 && <span className="block text-xs text-ink-500">Unlocks {h.grantsSkills.join(", ")}</span>}
                  </span>
                  <span className="text-ink-700">{h.expiresOn ? `Until ${h.expiresOn}` : "Does not expire"}</span>
                  {h.current ? <Chip tone="success">Current</Chip> : <Chip tone="danger">{LAPSE[h.lapseReason ?? ""] ?? "Not current"}</Chip>}
                  {h.verifiedAt ? <Chip tone="neutral">Card seen</Chip> : <Chip tone="warning">Not verified</Chip>}
                </div>
                {h.statusReason && <p className="mt-1 text-xs text-ink-500">{h.statusReason}</p>}
                {controls && <div className="mt-2">{controls(h)}</div>}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
