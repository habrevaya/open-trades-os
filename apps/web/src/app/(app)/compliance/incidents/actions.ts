"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { attempt, field, refusalOf, refused, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fileAsBase64, instantFromLocal } from "@/lib/local-time";
import { safety } from "@opentradesos/api/services";
import { safety as rules } from "@opentradesos/core";

/** The rows of people on the report form, the ones somebody filled in. */
function peopleFrom(form: FormData) {
  const out: Array<{ technicianId?: string; name?: string; role: rules.PersonRole; injury?: string }> = [];
  for (let row = 0; row < 4; row += 1) {
    const technicianId = field(form, `person.${row}.technicianId`);
    const name = field(form, `person.${row}.name`);
    if (!technicianId && !name) continue;
    const role = (field(form, `person.${row}.role`) ?? "involved") as rules.PersonRole;
    const injury = field(form, `person.${row}.injury`);
    out.push({
      ...(technicianId ? { technicianId } : {}),
      ...(name ? { name } : {}),
      role: rules.PERSON_ROLES.includes(role) ? role : "involved",
      ...(injury ? { injury } : {}),
    });
  }
  return out;
}

/**
 * Report something that went wrong. On success the person lands on the report
 * they made, which they can always open again, so they can see it went in.
 */
export async function report(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  let id: string;
  try {
    const photo = await fileAsBase64(form.get("photo"));
    const kind = (field(form, "kind") ?? "other") as rules.IncidentKind;
    ({ id } = await safety.report(ctx, {
      kind: rules.INCIDENT_KINDS.includes(kind) ? kind : "other",
      occurredAt: instantFromLocal(field(form, "occurredAt"), user.organizationTimezone) ?? new Date().toISOString(),
      location: field(form, "location"),
      description: field(form, "description") ?? "",
      immediateAction: field(form, "immediateAction"),
      people: peopleFrom(form),
      ...(photo ? { photos: [photo] } : {}),
    }));
  } catch (error) {
    const message = refusalOf(error);
    if (message === null) throw error;
    return refused(form, message);
  }
  revalidatePath("/compliance/incidents");
  redirect(`/compliance/incidents/${id}`);
}

/** Following a report up: an action as a task, a photograph, and closing it. */
export async function act(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "follow-up": {
        const dueAt = instantFromLocal(field(form, "dueAt"), user.organizationTimezone);
        await safety.addFollowUp(ctx, {
          id, title: field(form, "title") ?? "",
          ...(field(form, "assigneeUserId") ? { assigneeUserId: field(form, "assigneeUserId")! } : {}),
          ...(dueAt ? { dueAt } : {}),
        });
        return { message: "Added to the task queue." };
      }
      case "photo": {
        const photo = await fileAsBase64(form.get("file"));
        if (!photo) return { message: "Choose a photograph first." };
        await safety.addIncidentPhoto(ctx, { id, ...photo });
        return { message: "Photograph added." };
      }
      case "close":
        await safety.closeIncident(ctx, { id, closingNote: field(form, "closingNote") ?? "" });
        return { message: "Closed." };
      default:
        throw new Error(`Unknown op: ${op}`);
    }
  });
  if (state?.done) {
    revalidatePath("/compliance/incidents");
    revalidatePath(`/compliance/incidents/${id}`);
  }
  return state;
}
