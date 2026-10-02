import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { assets, people } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "./ActionForm";
import { ComplianceList, MaintenanceList, Register, type DuePlan } from "./FleetView";

export const dynamic = "force-dynamic";

const input = "h-8 rounded border border-steel-300 px-2 text-sm";
const KINDS = ["vehicle", "trailer", "powered_tool", "hand_tool", "instrument", "equipment"] as const;
const KIND_LABEL: Record<string, string> = {
  vehicle: "Vehicle", trailer: "Trailer", powered_tool: "Power tool", hand_tool: "Hand tool",
  instrument: "Instrument", equipment: "Equipment",
};

/**
 * THE FLEET
 *
 * The vans, trailers, drills and meters the company owns: who has each one,
 * what its meter says, what service is due, and which registration,
 * inspection, insurance or calibration runs out next, in the order somebody
 * has to act on them.
 */
export default async function FleetPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "asset:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Fleet" />
        <Empty title="Not shown to your role">The fleet needs the view company assets permission.</Empty>
      </div>
    );
  }

  const [register, due, outlook] = await Promise.all([
    assets.handlers.listAssets(ctx, {}),
    assets.handlers.getAssetMaintenanceDue(ctx, {}),
    assets.handlers.getAssetComplianceOutlook(ctx, {}),
  ]);
  const crew = can(user.actor, "user:read")
    ? (await people.handlers.listPeople(ctx, {})).people.filter((p) => p.technicianId && p.active)
    : [];
  const techName = new Map(crew.map((p) => [p.technicianId!, p.displayName ?? p.name ?? p.email]));
  const holderName = (kind: string, id: string) =>
    kind === "technician" ? techName.get(id) ?? "a technician" : kind === "location" ? "a location" : "a job";

  const writes = can(user.actor, "asset:write");
  const checkouts = can(user.actor, "asset:checkout");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Fleet" count={register.assets.length} />

      <h2 className="mt-6 text-base font-semibold">Expiring</h2>
      <ComplianceList alerts={outlook.alerts} missing={outlook.missing} />

      <h2 className="mt-8 text-base font-semibold">Service due</h2>
      <MaintenanceList
        plans={due.due as DuePlan[]}
        controls={writes ? (plan) => (
          <ActionForm op="serviced" label="Done today" quiet hidden={{ planId: plan.planId }} className="inline-flex" />
        ) : undefined}
      />

      <h2 className="mt-8 text-base font-semibold">Register</h2>
      <Register
        assets={register.assets}
        holderName={holderName}
        controls={writes || checkouts ? (asset) => (
          <div className="flex flex-wrap gap-2">
            {checkouts && (asset.heldBy
              ? <ActionForm op="check-in" label="Check in" quiet hidden={{ assetId: asset.id }} />
              : crew.length > 0 && (
                <ActionForm op="check-out" label="Check out" quiet hidden={{ assetId: asset.id }}>
                  <select name="custodianId" className={input}>
                    {crew.map((p) => <option key={p.technicianId!} value={p.technicianId!}>{techName.get(p.technicianId!)}</option>)}
                  </select>
                </ActionForm>
              ))}
            {writes && asset.meterUnit && (
              <ActionForm op="reading" label="Record reading" quiet hidden={{ assetId: asset.id }}>
                <input name="value" required inputMode="numeric" placeholder={asset.meterUnit} className={`${input} w-28`} />
              </ActionForm>
            )}
            {writes && (
              <ActionForm op="obligation" label="Set expiry" quiet hidden={{ assetId: asset.id }}>
                <select name="kind" className={input}>
                  <option value="registration">Registration</option>
                  <option value="inspection">Inspection</option>
                  <option value="insurance">Insurance</option>
                  <option value="calibration">Calibration</option>
                </select>
                <input name="expiresOn" type="date" required className={input} />
              </ActionForm>
            )}
            {writes && !asset.heldBy && (
              <ActionForm op="retire" label="Retire" quiet hidden={{ assetId: asset.id }} />
            )}
          </div>
        ) : undefined}
      />

      {writes && (
        <section className="mt-8">
          <h2 className="text-base font-semibold">Add to the register</h2>
          <ActionForm op="register" label="Add" className="mt-2 flex flex-wrap items-end gap-2">
            <select name="kind" className={input}>
              {KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
            </select>
            <input name="label" required placeholder="Van 3" className={input} />
            <input name="identifier" placeholder="Plate, serial or VIN" className={input} />
            <select name="meterUnit" defaultValue="" className={input}>
              <option value="">No meter</option>
              <option value="miles">Miles</option>
              <option value="kilometres">Kilometres</option>
              <option value="hours">Hours</option>
              <option value="cycles">Cycles</option>
            </select>
            <input name="acquiredOn" type="date" className={input} />
          </ActionForm>
        </section>
      )}
    </div>
  );
}
