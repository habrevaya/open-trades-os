"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agentDispatch } from "@opentradesos/api/services";
import { applyDispatchPlan, createDispatchPlan, dismissDispatchPlan } from "@opentradesos/api/contracts";
import { attempt, field, fields, parsed, type FormState } from "@/lib/actions";

/**
 * The copilot, from its screen: ask about a day, apply what was ticked, or
 * set a plan aside. Applying is the board's own assignment, one visit at a
 * time, with the qualification check run again.
 */

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function askCopilot(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, () => agentDispatch.plan(c, parsed(createDispatchPlan.input, { date: field(form, "date") })));
  revalidatePath("/schedule/copilot");
  return state;
}

export async function applyPlan(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, async () => {
    const applied = await agentDispatch.apply(c, parsed(applyDispatchPlan.input, {
      id: field(form, "id"), visitIds: fields(form, "visitIds"),
    }));
    const outcome = applied.outcome as { assigned: string[]; failed: { reason: string }[] };
    return {
      message: `Assigned ${outcome.assigned.length}.${outcome.failed.length > 0 ? ` ${outcome.failed.map((f) => f.reason).join(" ")}` : ""}`,
    };
  });
  revalidatePath("/schedule/copilot");
  revalidatePath("/schedule");
  return state;
}

export async function setPlanAside(_previous: FormState, form: FormData): Promise<FormState> {
  const c = await ctx();
  const state = await attempt(form, () => agentDispatch.handlers.dismissDispatchPlan(c, parsed(dismissDispatchPlan.input, { id: field(form, "id") })));
  revalidatePath("/schedule/copilot");
  return state;
}
