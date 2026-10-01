"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { projects } from "@opentradesos/api/services";

export type ProjectState = { done?: boolean; error?: string } | null;

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });
const text = (form: FormData, key: string): string | null => {
  const value = String(form.get(key) ?? "").trim();
  return value === "" ? null : value;
};

/**
 * Every project write, one action, named by `op`.
 *
 * Each goes through the handler the API route uses, so the refusals are the
 * API's own sentences: phases worth more than the contract, a phase started
 * before the one it waits for, a draw against a phase nobody has begun.
 * Those are shown to the person, never thrown at them.
 */
export async function act(_previous: ProjectState, form: FormData): Promise<ProjectState> {
  const op = String(form.get("op") ?? "");
  const projectId = String(form.get("projectId") ?? "");
  const c = await ctx();
  let created: string | null = null;
  try {
    switch (op) {
      case "create": {
        const made = await projects.handlers.createProject(c, {
          customerId: String(form.get("customerId") ?? ""),
          propertyId: String(form.get("propertyId") ?? ""),
          name: String(form.get("name") ?? ""),
          description: text(form, "description"),
          startsOn: text(form, "startsOn"),
          targetCompletionOn: text(form, "targetCompletionOn"),
          contractValue: text(form, "contractValue"),
          budgetCost: text(form, "budgetCost"),
        });
        created = made.id;
        break;
      }
      case "status":
        await projects.handlers.updateProject(c, {
          id: projectId, status: String(form.get("status")) as "active",
        });
        break;
      case "phase":
        await projects.handlers.addProjectPhase(c, {
          projectId,
          name: String(form.get("name") ?? ""),
          billingValue: text(form, "billingValue"),
          budgetCost: text(form, "budgetCost"),
          dependsOnPhaseId: text(form, "dependsOnPhaseId"),
          startsOn: text(form, "startsOn"),
          endsOn: text(form, "endsOn"),
        });
        break;
      case "phase-status":
        await projects.handlers.setProjectPhaseStatus(c, {
          id: String(form.get("phaseId") ?? ""), status: String(form.get("status")) as "complete",
        });
        break;
      case "materialise":
        await projects.handlers.materialiseProject(c, { id: projectId });
        break;
      case "draw": {
        const percent = text(form, "percent");
        await projects.handlers.planProjectDraw(c, {
          projectId,
          label: String(form.get("label") ?? ""),
          phaseId: text(form, "phaseId"),
          /** Typed as a percentage, stored as a rate: 30 means 0.3. */
          percent: percent === null ? null : String(Number(percent) / 100),
          amount: percent === null ? text(form, "amount") : null,
        });
        break;
      }
      case "raise":
        await projects.handlers.raiseProjectDraw(c, { id: String(form.get("drawId") ?? "") });
        break;
      case "attach":
        await projects.handlers.attachJobToProject(c, {
          projectId, jobId: String(form.get("jobId") ?? ""), phaseId: text(form, "phaseId"),
        });
        break;
      default:
        return { error: "Nothing to do." };
    }
  } catch (error) {
    if (error instanceof Error && ["ConflictError", "NotFoundError", "UnprocessableError", "PermissionError"].includes(error.name)) {
      return { error: error.message };
    }
    throw error;
  }
  if (created) redirect(`/projects/${created}`);
  revalidatePath(`/projects/${projectId}`);
  return { done: true };
}
