"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { backups, type ServiceContext } from "@opentradesos/api/services";

const ctx = async (): Promise<ServiceContext> => ({ actor: (await requireUser()).actor, db: getDb() });

/**
 * Save where copies go, which also checks the bucket takes one. A failed
 * check is not a refusal: the destination is saved and the page says what the
 * bucket answered, so a key fixed in another tab does not mean typing it all
 * again here.
 */
export async function saveDestination(_previous: FormState, form: FormData): Promise<FormState> {
  const frequency = (field(form, "frequency") ?? "daily") as "daily" | "weekly" | "off";
  const result = await attempt(form, async () => {
    const saved = await backups.saveDestination(await ctx(), {
      endpoint: field(form, "endpoint") ?? "",
      bucket: field(form, "bucket") ?? "",
      region: field(form, "region") ?? "us-east-1",
      prefix: field(form, "prefix") ?? "",
      accessKeyId: field(form, "accessKeyId") ?? "",
      secretKeyRef: field(form, "secretKeyRef") ?? "",
      pathStyle: form.get("hostStyle") !== "on",
      frequency,
      hour: Number(field(form, "hour") ?? 2),
      weekday: frequency === "weekly" ? Number(field(form, "weekday") ?? 0) : null,
      keep: Number(field(form, "keep") ?? 14),
    });
    return {
      message: saved.check.ok
        ? "Saved. The bucket took a test copy and gave it back."
        : `Saved, but the bucket did not take a test copy: ${saved.check.error}`,
    };
  });
  revalidatePath("/settings/backups");
  return result;
}

export async function backUpNow(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await backups.backUpNow(await ctx());
    return { message: "Queued. The copy starts within a minute; refresh to see it below." };
  });
  revalidatePath("/settings/backups");
  return result;
}

export async function stopBackups(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    await backups.removeDestination(await ctx());
    return { message: "No more copies will be taken. The ones in the bucket are still there." };
  });
  revalidatePath("/settings/backups");
  return result;
}
