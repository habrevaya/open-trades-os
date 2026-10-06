"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { attempt, type FormState } from "@/lib/actions";
import { setup as rules } from "@opentradesos/core";
import { setup, tradePacks } from "@opentradesos/api/services";
import { packById } from "@opentradesos/trade-packs";
import { getDb } from "@/lib/db";
import { stepLink } from "./steps";

const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

/**
 * Leaving the wizard for the app is deliberately allowed with steps
 * outstanding.
 *
 * A wizard that will not let go is a wizard people abandon. What matters is
 * that the company can take a booking, and the outstanding steps stay on the
 * list at /setup, which stays open afterwards rather than redirecting away.
 */
export async function completeSetup(): Promise<void> {
  await setup.finish(await ctx());
  redirect("/");
}

/**
 * Mark a step done (and go on to the next one) or not done after all.
 *
 * Done is something the person says: the step page shows what is in place
 * beside the button, and pressing it is them agreeing it is enough.
 */
export async function markStep(form: FormData): Promise<void> {
  const key = String(form.get("key") ?? "");
  const done = form.get("done") !== "false";
  await setup.mark(await ctx(), { key, done });
  revalidatePath("/setup", "layout");
  if (!rules.isSetupStepKey(key)) redirect("/setup");
  const here = stepLink(key).href;
  if (!done) redirect(here);
  const next = rules.stepAfter(key);
  const onward = next ? stepLink(next).href : "/setup";
  redirect(onward);
}

/**
 * Applying the chosen trade pack, which is the trade step's whole job, so it
 * marks the step done too.
 *
 * The apply is one transaction inside the service, so a company never ends
 * up with job types and no price book. If it fails, nothing happened and the
 * wizard can simply be retried, which is the only behaviour that is safe to
 * put in front of somebody at 9pm.
 */
export async function chooseTrade(formData: FormData): Promise<void> {
  const context = await ctx();
  const packId = String(formData.get("packId") ?? "");
  if (!packById(packId)) redirect("/setup/trade?error=unknown-trade");

  await tradePacks.applyTradePack(context, packId);
  await setup.mark(context, { key: "trade", done: true });
  revalidatePath("/setup", "layout");
  redirect("/setup?applied=" + encodeURIComponent(packId));
}

/** The newer version of a pack, applied by the plan the page showed. */
export async function upgradePack(_previous: FormState, form: FormData): Promise<FormState> {
  const packId = String(form.get("packId") ?? "");
  const result = await attempt(form, async () => {
    const done = await tradePacks.upgrade(await ctx(), packId);
    return {
      message: `Now on version ${done.toVersion}. ${done.added} added, ${done.updated} updated, `
        + `${done.kept} of yours kept as they were${done.jobTypesAdded > 0 ? `, ${done.jobTypesAdded} job types added` : ""}.`
        + (done.setup.added + done.setup.updated + done.setup.kept > 0
          ? ` Reports, inspections, retention and the portal: ${done.setup.added} set up, ${done.setup.updated} updated, `
            + `${done.setup.kept} of yours kept.`
          : ""),
    };
  });
  revalidatePath("/setup/trade");
  return result;
}
