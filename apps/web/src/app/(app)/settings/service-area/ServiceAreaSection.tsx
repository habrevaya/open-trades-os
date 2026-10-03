import { company, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Territories, Coverage } from "./ServiceAreaView";
import { NewTerritory, EditTerritory, SetActive } from "./ActionForm";

/**
 * The territories, the codes they cover and the form to add one. Drawn on
 * Settings, Service area and on the setup wizard's service area step, so the
 * two are one screen rather than two that drift.
 */
export async function ServiceAreaSection({ ctx }: { ctx: ServiceContext }) {
  const rows = await company.listTerritories(ctx);
  const writes = can(ctx.actor, "settings:write");

  return (
    <>
      <Coverage rows={rows} />

      <h2 className="mt-8 text-sm font-medium text-ink-700">Territories</h2>
      <Territories
        rows={rows}
        {...(writes
          ? {
              control: (row) => (
                <span className="flex flex-wrap items-center gap-2">
                  <EditTerritory
                    id={row.id}
                    name={row.name}
                    postalCodes={row.postalCodes.join(", ")}
                    travelFee={row.travelFee ?? ""}
                  />
                  <SetActive id={row.id} active={row.active} name={row.name} />
                </span>
              ),
            }
          : {})}
      />

      {writes ? (
        <>
          <h2 className="mt-10 text-sm font-medium text-ink-700">Add a territory</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">
            Codes separated by commas, spaces or new lines. A trip charge left empty means the
            company default applies, which is not the same as free.
          </p>
          <div className="mt-3">
            <NewTerritory />
          </div>
        </>
      ) : (
        <p className="mt-4 text-sm text-ink-500">
          Changing the service area needs the permission that writes settings, not the one that
          reads them.
        </p>
      )}
    </>
  );
}
