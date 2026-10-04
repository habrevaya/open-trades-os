import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { ServiceAreaSection } from "./ServiceAreaSection";

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

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Service area" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        A territory is a set of postal codes and what it costs to send somebody there. An address is
        matched to one when a property is created, so a code in no territory is an address with no
        area and no trip charge. One code belongs to at most one territory, and drawing an overlap is
        refused at the moment you can see both.
      </p>

      <ServiceAreaSection ctx={ctx} />
    </div>
  );
}
