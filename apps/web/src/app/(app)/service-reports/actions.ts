"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { serviceReports } from "@opentradesos/api/services";
import { annotateServiceReport, publishServiceReport, unpublishServiceReport } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * Everything the office does to one service report, named by `op`, each the
 * call its API route makes with the route's permission, checked by the
 * service: the office's words on it (`PATCH /v1/service-reports/{id}`,
 * `servicereport:write`), and publishing it to the customer or taking it back
 * (`servicereport:publish`). Each writes its own audit row there.
 */
export async function actOnServiceReport(_previous: FormState, form: FormData): Promise<FormState> {
  const id = field(form, "id") ?? "";
  const result = await attempt(form, async () => {
    const c = await ctx();
    switch (field(form, "op")) {
      case "annotate":
        /** An empty box clears the words, so both are always sent. */
        await serviceReports.annotate(c, parsed(annotateServiceReport.input, {
          id, summary: field(form, "summary") ?? null, observations: field(form, "observations") ?? null,
        }));
        return { message: "Saved." };
      case "publish":
        await serviceReports.publish(c, parsed(publishServiceReport.input, { id }));
        return { message: "Published. The customer can see it now." };
      case "unpublish":
        await serviceReports.unpublish(c, parsed(unpublishServiceReport.input, { id, reason: field(form, "reason") }));
        return { message: "Taken back. The customer no longer sees it." };
      default:
        throw new Error("Unknown service report operation");
    }
  });
  revalidatePath(`/service-reports/${id}`);
  return result;
}
