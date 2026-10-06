import { eq, inArray } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";

/**
 * A VISIT'S SHOP
 *
 * `visit.location_id` sat in the schema from the first migration with
 * nothing writing it, so the shop a visit went out from had to be worked out
 * each time from whoever was on it, and a technician who moved shops took
 * their whole history with them. It is written here, from the people the
 * visit is given to, at the moment it is booked with somebody or assigned:
 *
 *   people  the lead's shop: where their day starts (`technician.home_location_id`),
 *           otherwise the shop their membership names
 *   crew    where the crew is based, otherwise its lead's shop the same way
 *
 * Nobody with a shop, or nobody on it at all, writes none. Written again
 * whenever the people change, so it is the shop of whoever has the visit
 * now, and never worked out again for a visit already done: the shop a job
 * was served from stays what it was when the work was given out.
 *
 * Visits booked before this was written carry none and were not filled in
 * afterwards; the shop scope reads those through their people and crews as
 * it did before (`services/scope.ts`).
 */

/** The shop of the people a visit is given to, the lead first. */
export async function shopOfPeople(
  tx: Database, technicianIds: readonly string[], leadTechnicianId?: string | null,
): Promise<string | null> {
  const lead = leadTechnicianId ?? technicianIds[0];
  if (!lead) return null;
  const [row] = await tx.select({
    home: schema.technician.homeLocationId,
    based: schema.membership.locationId,
  }).from(schema.technician)
    .leftJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
    .where(eq(schema.technician.id, lead)).limit(1);
  return row?.home ?? row?.based ?? null;
}

/** The shop of a crew: where it is based, otherwise its lead's. */
export async function shopOfCrew(tx: Database, crewId: string): Promise<string | null> {
  const [crew] = await tx.select({ home: schema.crew.homeLocationId }).from(schema.crew)
    .where(eq(schema.crew.id, crewId)).limit(1);
  if (crew?.home) return crew.home;
  const members = await tx.select({
    technicianId: schema.crewMember.technicianId, isLead: schema.crewMember.isLead,
  }).from(schema.crewMember).where(eq(schema.crewMember.crewId, crewId));
  const lead = members.find((m) => m.isLead) ?? null;
  return lead ? shopOfPeople(tx, [lead.technicianId]) : null;
}

/** The shop names for a set of visits, for a screen that shows them. */
export async function shopNames(tx: Database, locationIds: readonly (string | null)[]): Promise<Map<string, string>> {
  const ids = [...new Set(locationIds.filter((id): id is string => id !== null))];
  if (ids.length === 0) return new Map();
  const rows = await tx.select({ id: schema.location.id, name: schema.location.name })
    .from(schema.location).where(inArray(schema.location.id, ids));
  return new Map(rows.map((r) => [r.id, r.name]));
}
