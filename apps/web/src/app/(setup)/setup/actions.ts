"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { requireUser } from "@/lib/auth";
import { assertCan } from "@opentradesos/core";

/**
 * Marking setup complete is deliberately allowed with steps outstanding.
 *
 * A wizard that will not let go is a wizard people abandon. What matters is
 * that the company can take a booking, and the outstanding items stay visible
 * in Settings rather than trapping someone behind a form at 9pm.
 */
export async function completeSetup(): Promise<void> {
  const user = await requireUser();
  assertCan(user.actor, "settings:write");

  const db = createClient();
  await db
    .update(schema.organization)
    .set({ setupCompletedAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.organization.id, user.organizationId));

  redirect("/");
}
