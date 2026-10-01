import { and, eq, isNull, sql } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import type { z } from "zod";
import { type ServiceContext, guardedRead } from "./context";
import type { listPeople } from "../contracts/people";

/**
 * WHO WORKS HERE
 *
 * Memberships, the person behind each, and the technician record a visit
 * names. The person's name and email come through
 * `app.organization_people()`, because the user table is visible to its own
 * user and nobody else, and a join to it from inside the tenant answered
 * with the caller alone. The function returns this company's members and
 * nothing more.
 */
export async function list(ctx: ServiceContext, input: z.infer<typeof listPeople.input>) {
  return guardedRead(ctx, "user:read", async (tx) => {
    const people = await tx.execute<{ membership_id: string; user_id: string; name: string | null; email: string }>(
      sql`select * from app.organization_people()`,
    );
    const byMembership = new Map(people.map((p) => [p.membership_id, p]));

    const rows = await tx.select({
      membership: schema.membership,
      roleName: schema.role.name,
      technicianId: schema.technician.id,
      technicianName: schema.technician.displayName,
      technicianActive: schema.technician.active,
    })
      .from(schema.membership)
      .leftJoin(schema.role, and(eq(schema.role.id, schema.membership.roleId), isNull(schema.role.deletedAt)))
      .leftJoin(schema.technician, eq(schema.technician.membershipId, schema.membership.id))
      .where(input.includeInactive ? undefined : eq(schema.membership.active, true));

    const wanted = input.email?.toLowerCase();
    return {
      data: rows
        .map((r) => {
          const person = byMembership.get(r.membership.id);
          return {
            membershipId: r.membership.id,
            userId: r.membership.userId,
            name: person?.name ?? null,
            email: person?.email ?? "",
            role: r.roleName ?? r.membership.role,
            active: r.membership.active,
            technicianId: r.technicianId,
            technicianName: r.technicianName,
            technicianActive: r.technicianActive,
          };
        })
        .filter((p) => wanted === undefined || p.email.toLowerCase() === wanted)
        .sort((a, b) => (a.name ?? a.email).localeCompare(b.name ?? b.email)),
    };
  });
}
