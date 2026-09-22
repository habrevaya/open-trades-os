"use server";

import { redirect } from "next/navigation";
import { eq } from "drizzle-orm";
import { createClient, schema } from "@opentradesos/db";
import { requireUser } from "@/lib/auth";
import { assertCan } from "@opentradesos/core";
import { tradePacks } from "@opentradesos/api/services";
import { packById } from "@opentradesos/trade-packs";

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


/**
 * Applying the chosen trade pack.
 *
 * The whole thing is one transaction inside the service, so a company never
 * ends up with job types and no price book. If it fails, nothing happened and
 * the wizard can simply be retried, which is the only behaviour that is safe
 * to put in front of somebody at 9pm.
 */
export async function chooseTrade(formData: FormData): Promise<void> {
  const user = await requireUser();
  assertCan(user.actor, "settings:write");

  const packId = String(formData.get("packId") ?? "");
  if (!packById(packId)) redirect("/setup/trade?error=unknown-trade");

  await tradePacks.applyTradePack({ actor: user.actor, db: createClient() }, packId);

  redirect("/setup?applied=" + encodeURIComponent(packId));
}
