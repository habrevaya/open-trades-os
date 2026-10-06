"use server";

import { revalidatePath } from "next/cache";
import { attempt, field, fields, type FormState } from "@/lib/actions";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { fileAsBase64, instantFromLocal } from "@/lib/local-time";
import { safety } from "@opentradesos/api/services";

/**
 * Recording a toolbox talk and keeping its sign in sheet. Every refusal is the
 * service's: a sheet that is closed, somebody already on it, a talk with no
 * topic.
 */
export async function act(_previous: FormState, form: FormData): Promise<FormState> {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "create": {
        const names = (field(form, "visitors") ?? "").split(",").map((n) => n.trim()).filter(Boolean);
        const heldAt = instantFromLocal(field(form, "heldAt"), user.organizationTimezone) ?? new Date().toISOString();
        await safety.createMeeting(ctx, {
          topic: field(form, "topic") ?? "",
          notes: field(form, "notes"),
          heldAt,
          location: field(form, "location"),
          ledBy: field(form, "ledBy"),
          attendees: [
            ...fields(form, "technicianIds").map((technicianId) => ({ technicianId })),
            ...names.map((name) => ({ name })),
          ],
        });
        return { message: "Recorded. Your people can sign it from their phones." };
      }
      case "add": {
        const names = (field(form, "visitors") ?? "").split(",").map((n) => n.trim()).filter(Boolean);
        await safety.addAttendees(ctx, {
          id,
          attendees: [
            ...fields(form, "technicianIds").map((technicianId) => ({ technicianId })),
            ...names.map((name) => ({ name })),
          ],
        });
        return { message: "Added to the sheet." };
      }
      case "signed":
        await safety.markSigned(ctx, { id, attendeeId: String(form.get("attendeeId") ?? "") });
        return { message: "Marked signed on the paper sheet." };
      case "photo": {
        const photo = await fileAsBase64(form.get("file"));
        if (!photo) return { message: "Choose a photograph first." };
        await safety.addMeetingPhoto(ctx, { id, ...photo });
        return { message: "Photograph kept with the talk." };
      }
      case "close":
        await safety.closeMeeting(ctx, { id });
        return { message: "Closed. Nobody else signs it now." };
      default:
        throw new Error(`Unknown op: ${op}`);
    }
  });

  if (state?.done) {
    revalidatePath("/compliance/safety");
    if (id) revalidatePath(`/compliance/safety/${id}`);
  }
  return state;
}
