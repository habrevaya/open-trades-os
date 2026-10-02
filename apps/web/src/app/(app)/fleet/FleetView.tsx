import type { ReactNode } from "react";
import { Chip } from "@opentradesos/ui";

export interface FleetAsset {
  id: string;
  kindLabel: string;
  label: string;
  identifier: string | null;
  meterUnit: string | null;
  retired: boolean;
  heldBy: { custodianKind: string; custodianId: string; since: string } | null;
  latestReading: { value: number; unit: string; takenOn: string } | null;
  missingObligations: string[];
}

export interface ComplianceAlert {
  assetId: string; assetLabel: string; kind: string;
  status: "expired" | "act_now" | "upcoming" | "clear";
  expiresOn: string; actBy: string; explanation: string; groundsTheAsset: boolean;
}

export type MaintenanceStatus =
  | { basis: "time"; state: "scheduled"; dueOn: string; daysUntilDue: number; overdue: boolean }
  | { basis: "time"; state: "no_further_service_due"; explanation: string }
  | { basis: "meter"; state: "due_now"; unit: string; unitsOverdue: number; explanation: string }
  | { basis: "meter"; state: "projected"; unit: string; dueOn: string; unitsRemaining: number; confidence: string; caveat: string }
  | { basis: "meter"; state: "cannot_project"; unit: string; explanation: string };

export interface DuePlan {
  planId: string; assetId: string; assetLabel: string; label: string;
  lastServicedOn: string | null; status: MaintenanceStatus;
}

const KIND: Record<string, string> = {
  registration: "Registration", inspection: "Inspection", insurance: "Insurance", calibration: "Calibration",
};

const ALERT_TONE = { expired: "danger", act_now: "warning", upcoming: "info", clear: "neutral" } as const;
const ALERT_TEXT = { expired: "Expired", act_now: "Act now", upcoming: "Coming up", clear: "Clear" } as const;

/** What expires, in the order to deal with it, which is the service's order. */
export function ComplianceList({ alerts, missing }: {
  alerts: ComplianceAlert[];
  missing: { assetId: string; assetLabel: string; kind: string; explanation: string }[];
}) {
  const live = alerts.filter((a) => a.status !== "clear");
  if (live.length === 0 && missing.length === 0) {
    return <p className="mt-2 text-sm text-ink-500">Nothing expires soon and nothing is missing.</p>;
  }
  return (
    <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
      {live.map((a) => (
        <li key={`${a.assetId}-${a.kind}`} className="bg-canvas p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1"><span className="font-medium">{a.assetLabel}</span> · {KIND[a.kind] ?? a.kind}</span>
            <span className="text-ink-700">Act by {a.actBy}</span>
            <Chip tone={ALERT_TONE[a.status]}>{ALERT_TEXT[a.status]}</Chip>
          </div>
          <p className="mt-1 text-xs text-ink-500">{a.explanation}</p>
        </li>
      ))}
      {missing.map((m) => (
        <li key={`${m.assetId}-${m.kind}-missing`} className="bg-canvas p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1"><span className="font-medium">{m.assetLabel}</span> · {KIND[m.kind] ?? m.kind}</span>
            <Chip tone="warning">Nothing on file</Chip>
          </div>
          <p className="mt-1 text-xs text-ink-500">{m.explanation}</p>
        </li>
      ))}
    </ul>
  );
}

function describe(status: MaintenanceStatus): { text: string; tone: "danger" | "warning" | "neutral" | "info" } {
  switch (status.state) {
    case "scheduled":
      return status.overdue
        ? { text: `Overdue since ${status.dueOn}`, tone: "danger" }
        : { text: `Due ${status.dueOn}`, tone: status.daysUntilDue <= 14 ? "warning" : "neutral" };
    case "due_now": return { text: `Due now, ${status.unitsOverdue} ${status.unit} over`, tone: "danger" };
    case "projected": return { text: `Around ${status.dueOn} (${status.confidence} estimate)`, tone: "info" };
    case "cannot_project": return { text: "Cannot tell", tone: "warning" };
    case "no_further_service_due": return { text: "Nothing further due", tone: "neutral" };
  }
}

export function MaintenanceList({ plans, controls }: {
  plans: DuePlan[];
  controls?: (plan: DuePlan) => ReactNode;
}) {
  if (plans.length === 0) return <p className="mt-2 text-sm text-ink-500">No service plans.</p>;
  return (
    <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
      {plans.map((plan) => {
        const said = describe(plan.status);
        const why = "explanation" in plan.status ? plan.status.explanation
          : "caveat" in plan.status ? plan.status.caveat : null;
        return (
          <li key={plan.planId} className="bg-canvas p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <span className="flex-1"><span className="font-medium">{plan.assetLabel}</span> · {plan.label}</span>
              <span className="text-ink-500">{plan.lastServicedOn ? `Last done ${plan.lastServicedOn}` : "Never recorded"}</span>
              <Chip tone={said.tone}>{said.text}</Chip>
              {controls?.(plan)}
            </div>
            {why && <p className="mt-1 text-xs text-ink-500">{why}</p>}
          </li>
        );
      })}
    </ul>
  );
}

/** The register: what each thing is, who has it, and what its meter last said. */
export function Register({ assets, holderName, controls }: {
  assets: FleetAsset[];
  holderName: (kind: string, id: string) => string;
  controls?: (asset: FleetAsset) => ReactNode;
}) {
  if (assets.length === 0) return <p className="mt-2 text-sm text-ink-500">Nothing on the register yet.</p>;
  return (
    <ul className="mt-2 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
      {assets.map((asset) => (
        <li key={asset.id} className="bg-canvas p-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="flex-1">
              <span className="font-medium">{asset.label}</span>
              <span className="text-ink-500"> · {asset.kindLabel}{asset.identifier ? ` · ${asset.identifier}` : ""}</span>
            </span>
            <span className="text-ink-700">
              {asset.heldBy ? `With ${holderName(asset.heldBy.custodianKind, asset.heldBy.custodianId)} since ${asset.heldBy.since}` : "Not checked out"}
            </span>
            {asset.latestReading && (
              <span className="text-ink-500">{asset.latestReading.value.toLocaleString("en-US")} {asset.latestReading.unit}</span>
            )}
            {asset.retired && <Chip tone="neutral">Retired</Chip>}
            {asset.missingObligations.length > 0 && (
              <Chip tone="warning">No {asset.missingObligations.map((k) => (KIND[k] ?? k).toLowerCase()).join(", ")} on file</Chip>
            )}
          </div>
          {controls && <div className="mt-2">{controls(asset)}</div>}
        </li>
      ))}
    </ul>
  );
}
