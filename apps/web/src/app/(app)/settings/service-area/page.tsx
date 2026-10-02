import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { company } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { Territories, Coverage } from "./ServiceAreaView";
import { NewTerritory, EditTerritory, SetActive } from "./ActionForm";

export const dynamic = "force-dynamic";

/**
 * WHERE THE COMPANY WORKS
 *
 * Territories were in the schema, in the service and on the API from phase 0,
 * and the setup wizard's third step asked for them with nowhere to go. A
 * service area is not a nicety: `services/properties.ts` resolves a property's
 * territory by postal code, and that resolution is what attaches a trip charge
 * and what lets a day be planned by area. With no territories declared, every
 * address the company has is in none of them.
 *
 * Retired rather than deleted, because a territory is on properties already
 * created and removing the row would orphan them. A retired one keeps its codes
 * so nothing silently re-matches somewhere else.
 */
export default async function ServiceAreaPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Service area" />
        <Empty title="Settings are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }

  const rows = await company.listTerritories(ctx);
  const writes = can(user.actor, "settings:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Service area" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        A territory is a set of postal codes and what it costs to send somebody there. An address is
        matched to one when a property is created, so a code in no territory is an address with no
        area and no trip charge. One code belongs to at most one territory, and drawing an overlap is
        refused at the moment you can see both.
      </p>

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
    </div>
  );
}
