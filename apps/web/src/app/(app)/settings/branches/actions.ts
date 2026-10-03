"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, fields, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { branches, company } from "@opentradesos/api/services";

/**
 * Branches: made, renamed, retired, and work put in them.
 *
 * `requireUser` rather than `requireSetupUser`, because the setup wizard's
 * team step draws these same forms before setup is finished. Whether the
 * person may do any of it is the service's question, asked the same way
 * either side of setup.
 */
const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

function refresh() {
  revalidatePath("/settings/branches");
  revalidatePath("/setup/team");
}

export async function createBranch(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => company.createBusinessUnit(await ctx(), {
    name: field(form, "name") ?? "",
    code: field(form, "code") ?? null,
  }));
  refresh();
  return result;
}

export async function renameBranch(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => company.updateBusinessUnit(await ctx(), {
    id: String(form.get("id") ?? ""),
    name: field(form, "name") ?? "",
    code: field(form, "code") ?? null,
  }));
  refresh();
  return result;
}

export async function setBranchActive(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => company.updateBusinessUnit(await ctx(), {
    id: String(form.get("id") ?? ""),
    active: form.get("active") === "true",
  }));
  refresh();
  return result;
}

export async function moveJobs(_previous: FormState, form: FormData): Promise<FormState> {
  const target = String(form.get("businessUnitId") ?? "");
  const result = await attempt(form, async () => {
    const moved = await branches.assignJobs(await ctx(), {
      jobIds: fields(form, "jobId"),
      businessUnitId: target === "" ? null : target,
    });
    return { message: `${moved.moved} ${moved.moved === 1 ? "job" : "jobs"} moved.` };
  });
  refresh();
  revalidatePath("/jobs");
  return result;
}
