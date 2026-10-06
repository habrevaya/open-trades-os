"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { attempt, fields, refused, type FormState } from "@/lib/actions";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { SESSION_COOKIE, hashToken } from "@/lib/session";
import { sandbox, type ServiceContext } from "@opentradesos/api/services";

const ctx = async (): Promise<ServiceContext> => ({ actor: (await requireUser()).actor, db: getDb() });

export async function makeSandbox(_previous: FormState, form: FormData): Promise<FormState> {
  const result = await attempt(form, async () => {
    const made = await sandbox.create(await ctx(), { sampleData: form.get("sampleData") === "on" });
    return {
      message: `Made ${made.name}: ${made.copied.customFields} fields, ${made.copied.kinds} kinds of record, `
        + `${made.copied.workflows} automations (all switched off), ${made.copied.proposalTemplates} proposal layouts`
        + (made.sampleJobs > 0 ? ` and ${made.sampleJobs} sample jobs.` : "."),
    };
  });
  revalidatePath("/settings/sandbox");
  return result;
}

/**
 * Move this browser's session into the sandbox or back. The database decides
 * whether the move is allowed (this person, this company's own pair); a
 * refusal leaves the session where it was.
 */
export async function switchCompany(_previous: FormState, form: FormData): Promise<FormState> {
  const target = String(form.get("organizationId") ?? "");
  const token = (await cookies()).get(SESSION_COOKIE)?.value;
  if (!token) return refused(form, "You are not signed in.");
  const moved = await sandbox.switchTo(getDb(), hashToken(token), target);
  if (!moved) return refused(form, "That is not this company's sandbox, or you are not a member of it.");
  revalidatePath("/", "layout");
  redirect("/");
}

export async function throwAway(_previous: FormState, form: FormData): Promise<FormState> {
  if (form.get("sure") !== "on") return refused(form, "Tick the box to say you mean it: the sandbox cannot be opened again.");
  const result = await attempt(form, async () => {
    await sandbox.discard(await ctx());
    return { message: "Thrown away. Make a new one any time from today's settings." };
  });
  revalidatePath("/settings/sandbox");
  return result;
}

/**
 * Copy the ticked settings into the real company, or only check what that
 * would do: the copy run in a transaction and rolled back, so the check is
 * the copy itself rather than a prediction of it.
 */
export async function copyBack(_previous: FormState, form: FormData): Promise<FormState> {
  const items = fields(form, "items");
  if (items.length === 0) return refused(form, "Tick at least one setting to copy back.");
  const check = form.get("check") === "on";
  const context = await ctx();
  const result = await attempt(form, async () => {
    if (check) {
      const tried = await context.db.transaction(async (tx) => {
        const answer = await sandbox.copyBack({ ...context, db: tx as unknown as typeof context.db }, { items });
        throw Object.assign(new Error("rolled back"), { name: "CheckedOnly", answer });
      }).catch((error: unknown) => {
        if (error instanceof Error && error.name === "CheckedOnly") {
          return (error as Error & { answer: Awaited<ReturnType<typeof sandbox.copyBack>> }).answer;
        }
        throw error;
      });
      const changing = tried.applied.filter((item) => item.action !== "same").length;
      return { message: `It would work: ${changing} of ${tried.applied.length} would change the real company. Nothing has been copied yet.` };
    }
    const done = await sandbox.copyBack(context, { items });
    const changed = done.applied.filter((item) => item.action !== "same").length;
    return { message: `Copied back. ${changed} setting${changed === 1 ? "" : "s"} changed in the real company; new automations arrive switched off.` };
  });
  revalidatePath("/settings/sandbox");
  return result;
}
