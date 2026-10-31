"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { portalLayout } from "@opentradesos/api/services";
import { setPortalLayout, setPlanPortalLayout } from "@opentradesos/api/contracts";
import { attempt, fields, parsed, refused, type FormState } from "@/lib/actions";

/**
 * SAVING THE ACCOUNT PAGE'S LAYOUT
 *
 * `PUT /v1/portal-layout`. The blocks arrive in the order they are on the
 * screen, each with its heading and whether it is shown, and the service
 * decides whether the arrangement is allowed (the bills cannot be hidden, a
 * heading has a length); the refusal is its sentence.
 */
/**
 * SAVING A PLAN'S PAGE, OR TAKING IT AWAY
 *
 * `PUT /v1/agreement-plans/{id}/portal-layout`: the same blocks as the
 * company's page, saved as the page the members of that plan see.
 */
export async function savePlanLayout(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt(form, async () => {
    const input = parsed(setPlanPortalLayout.input, {
      id: String(form.get("planId") ?? ""),
      blocks: fields(form, "kind").map((kind) => ({
        kind,
        title: typeof form.get(`title:${kind}`) === "string" ? String(form.get(`title:${kind}`)) : null,
        visible: form.get(`visible:${kind}`) === "on",
      })),
    });
    const { id, ...rest } = input;
    await portalLayout.setForPlan({ actor: (await requireSetupUser()).actor, db: getDb() }, { planId: id, ...rest });
    revalidatePath("/settings/portal/layout");
    return { message: "Saved. Members of this plan see it this way from now on." };
  });
}

export async function removePlanLayout(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt(form, async () => {
    await portalLayout.removeForPlan({ actor: (await requireSetupUser()).actor, db: getDb() }, { planId: String(form.get("planId") ?? "") });
    revalidatePath("/settings/portal/layout");
    return { message: "Done. Members of this plan see the company's page again." };
  });
}

export async function saveLayout(_previous: FormState, form: FormData): Promise<FormState> {
  return attempt(form, async () => {
    const input = parsed(setPortalLayout.input, {
      blocks: fields(form, "kind").map((kind) => ({
        kind,
        title: typeof form.get(`title:${kind}`) === "string" ? String(form.get(`title:${kind}`)) : null,
        visible: form.get(`visible:${kind}`) === "on",
      })),
    });
    await portalLayout.set({ actor: (await requireSetupUser()).actor, db: getDb() }, input);
    revalidatePath("/settings/portal/layout");
    return { message: "Saved. Customers see it this way from now on." };
  });
}

/**
 * `POST /v1/portal-layout/reset`: the company's account page back to the trade
 * pack's. It replaces what was arranged and cannot be undone from the screen, so
 * the box has to be ticked.
 */
export async function resetLayout(_previous: FormState, form: FormData): Promise<FormState> {
  if (form.get("confirm") !== "on") {
    return refused(form, "Tick the box to say you want your arrangement replaced. It cannot be brought back from here.");
  }
  return attempt(form, async () => {
    await portalLayout.resetToPack({ actor: (await requireSetupUser()).actor, db: getDb() });
    revalidatePath("/settings/portal/layout");
    return { message: "Done. Customers see the page your trade pack sets up." };
  });
}
