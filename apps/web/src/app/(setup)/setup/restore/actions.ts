"use server";

import { redirect } from "next/navigation";
import { attempt, field, refused, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { backups } from "@opentradesos/api/services";

/**
 * A copy straight from a bucket, which is also how a company too large to
 * upload through a browser is restored: the server reads it from the bucket.
 * With no copy named, it answers with the copies that are there to choose from.
 */
export async function fromBucket(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireUser()).actor, db: getDb() };
  const bucket = {
    endpoint: field(form, "endpoint") ?? "",
    bucket: field(form, "bucket") ?? "",
    region: field(form, "region") ?? "us-east-1",
    prefix: field(form, "prefix") ?? "",
    accessKeyId: field(form, "accessKeyId") ?? "",
    secretKeyRef: field(form, "secretKeyRef") ?? "",
    pathStyle: form.get("hostStyle") !== "on",
  };
  const key = field(form, "key");
  if (!key) {
    return attempt(form, async () => {
      const copies = await backups.copiesIn(ctx, bucket);
      if (copies.length === 0) return { message: "There are no copies (.zip files) in that bucket and folder." };
      return {
        message: `Copies there, newest first: ${copies.slice(0, 10).map((c) => c.key).join(", ")}. `
          + "Put the one to restore in the Copy box.",
      };
    });
  }
  let runId: string | null = null;
  const result = await attempt(form, async () => {
    const done = await backups.restoreFromBucket(ctx, {
      bucket, key, dryRun: form.get("restore") !== "on", keepSending: form.get("keepSending") === "on",
    });
    runId = done.runId;
    return {};
  });
  if (runId) redirect(`/setup/restore?run=${runId}`);
  return result ?? refused(form, "Nothing happened.");
}
