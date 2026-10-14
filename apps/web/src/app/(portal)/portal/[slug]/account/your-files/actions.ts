"use server";

import { revalidatePath } from "next/cache";
import { getDb } from "@/lib/db";
import { portalFiles } from "@opentradesos/api/services";
import { field, refused, refusalOf, type FormState } from "@/lib/actions";
import { fileAsBase64 } from "@/lib/local-time";
import { requestMeta, requirePortalSession } from "@/lib/portal-session";

/**
 * A SIGNED IN CUSTOMER ADDING A FILE TO THEIR JOB, OR TAKING ONE BACK, bound
 * to the company's slug and read with the sign in cookie on the server like
 * every other action on these pages. The service checks the job, the visit
 * and the file against the customer the sign in names.
 */

const here = (slug: string) => `/portal/${encodeURIComponent(slug)}/account/your-files`;

/** The hourly limit is the one refusal `refusalOf` does not word, because only the open routes raise it. */
const tooMany = "You have sent a lot of files in the last hour. Wait an hour and try again, or call us.";

function wording(error: unknown): string | null {
  if (error instanceof Error && error.name === "TooManyRequestsError") return tooMany;
  return refusalOf(error);
}

export async function addFile(slug: string, _previous: FormState, form: FormData): Promise<FormState> {
  const session = await requirePortalSession(slug);
  const [jobId, visitId] = (field(form, "about") ?? "").split(":");
  if (!jobId) return refused(form, "Choose which job the file is about.");
  const file = await fileAsBase64(form.get("file"));
  if (!file) return refused(form, "Choose a photo or a PDF to send.");
  try {
    const added = await portalFiles.add(getDb(), {
      token: session.token, jobId, ...(visitId ? { visitId } : {}),
      fileName: file.fileName, contentType: file.contentType, bytes: file.bytes,
    }, await requestMeta());
    revalidatePath(here(slug));
    return { done: true, message: `Sent. ${added.fileName ?? "Your file"} is with ${added.jobLabel.split(":")[0]}.` };
  } catch (error) {
    const message = wording(error);
    if (message === null) throw error;
    return refused(form, message);
  }
}

export async function removeFile(slug: string, _previous: FormState, form: FormData): Promise<FormState> {
  const session = await requirePortalSession(slug);
  try {
    await portalFiles.remove(getDb(), { token: session.token, id: field(form, "id") ?? "" });
  } catch (error) {
    const message = wording(error);
    if (message === null) throw error;
    return refused(form, message);
  }
  revalidatePath(here(slug));
  return { done: true, message: "Taken back." };
}
