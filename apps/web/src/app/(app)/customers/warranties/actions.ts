"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { tasks } from "@opentradesos/api/services";
import { createTask } from "@opentradesos/api/contracts";
import { attempt, field, parsed, type FormState } from "@/lib/actions";

/**
 * A FOLLOW UP ON A WARRANTY, as a task about the unit.
 *
 * About the unit rather than the customer, because the unit is what the call
 * is about and the queue opens the address it is at. Due in two working days
 * by default: a lapsing warranty is worth a call this week, not this hour.
 */
export async function followUp(_previous: FormState, form: FormData): Promise<FormState> {
  const state = await attempt(form, async () => {
    const user = await requireSetupUser();
    const due = new Date(Date.now() + 2 * 86_400_000);
    const input = parsed(createTask.input, {
      title: field(form, "title"),
      body: field(form, "body"),
      entityType: "equipment",
      entityId: field(form, "equipmentId"),
      dueAt: due.toISOString(),
      priority: "normal",
    });
    await tasks.create({ actor: user.actor, db: getDb() }, {
      title: input.title,
      ...(input.body ? { body: input.body } : {}),
      entityType: "equipment",
      ...(input.entityId ? { entityId: input.entityId } : {}),
      dueAt: due,
      priority: "normal",
    });
    return { message: "In the task queue." };
  });
  revalidatePath("/customers/warranties");
  return state;
}
