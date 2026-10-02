"use server";

import { attempt, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { network } from "@opentradesos/api/services";

export type NetworkState = FormState;

/**
 * Agreeing to share an aggregate, and stopping.
 *
 * Both go through the member's OWN session, which is the whole point of the
 * module: there is no shape of call in which an operator grants on a member's
 * behalf, and this screen is the member's. The refusals are the service's: an
 * aggregate that is not one, a company in no network, a reader who holds
 * `settings:read` but not `settings:write`.
 */
export async function act(_previous: NetworkState, form: FormData): Promise<NetworkState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const aggregate = String(form.get("aggregate") ?? "");
  const state = await attempt(form, async () => {
    if (String(form.get("op") ?? "") === "share") {
      await network.share(ctx, { aggregate });
    } else {
      await network.stopSharing(ctx, { aggregate });
    }
  });
  if (state?.done) revalidatePath("/settings/network");
  return state;
}
