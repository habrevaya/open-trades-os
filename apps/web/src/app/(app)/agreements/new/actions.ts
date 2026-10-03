"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreements } from "@opentradesos/api/services";
import { sellAgreement as sellRoute } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/** `POST /v1/agreements`, then the agreement's own screen with everything the term owes. */
export async function sellAgreement(_previous: FormState, form: FormData): Promise<FormState> {
  let id: string | null = null;
  const result = await attempt(form, async () => {
    const user = await requireSetupUser();
    const input = parsed(sellRoute.input, {
      planId: field(form, "planId"),
      customerId: field(form, "customerId"),
      propertyId: field(form, "propertyId"),
      startedOn: field(form, "startedOn"),
      price: field(form, "price")?.replace(/[$,\s]/g, ""),
    });
    id = (await agreements.sell({ actor: user.actor, db: getDb() }, {
      planId: input.planId,
      customerId: input.customerId,
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
      ...(input.startedOn ? { startedOn: input.startedOn } : {}),
      ...(input.price ? { price: input.price } : {}),
    })).id;
  });
  if (!id) return result;
  revalidatePath("/agreements");
  redirect(`/agreements/${id}`);
}
