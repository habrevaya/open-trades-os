"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { purchaseApprovals } from "@opentradesos/api/services";
import { addPurchaseApprovalRule } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** A step of approval: orders at or over an amount need somebody holding a role. */
export async function addRuleAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const role = field(form, "role") ?? "";
    await purchaseApprovals.addRule(await ctx(), parsed(addPurchaseApprovalRule.input, {
      minimumTotal: (field(form, "minimumTotal") ?? "").replace(/[$,\s]/g, ""),
      ...(role.startsWith("custom:") ? { approverRoleId: role.slice(7) } : { approverRole: role }),
    }));
  });
  if (state?.done) revalidatePath("/purchasing/approvals");
  return state;
}

export async function removeRuleAction(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    await purchaseApprovals.removeRule(await ctx(), { id: String(form.get("id") ?? "") });
  });
  if (state?.done) revalidatePath("/purchasing/approvals");
  return state;
}
