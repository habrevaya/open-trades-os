"use server";

import { attempt, field, fields, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { crews, onCall } from "@opentradesos/api/services";

export type CrewState = FormState;

/**
 * Crew and rota writes, through their service handlers.
 *
 * The refusals a dispatcher will actually hit are all the modules': a crew with
 * two leads, the same technician twice, somebody who is not an active technician
 * here, a production rate with no unit, two on-call rows covering one instant, and
 * a handover when nobody is on call to hand over from.
 */
export async function act(_previous: CrewState, form: FormData): Promise<CrewState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "crew":
        await crews.create(ctx, {
          name: String(form.get("name") ?? ""),
          /**
           * Both halves of the rate or neither. Sent as given so the service
           * refuses a half pair with its own sentence rather than this action
           * silently dropping one, which would produce a crew whose capacity
           * reads as a figure and means nothing.
           */
          productionRatePerDay: field(form, "productionRatePerDay") ?? null,
          productionUnit: field(form, "productionUnit") ?? null,
          skills: fields(form, "skill"),
        });
        return;
      case "members":
        await crews.setMembers(ctx, {
          id,
          /**
           * The whole list, replaced. A crew editor that added rather than
           * replaced would leave somebody who left the company on the crew, and
           * the only way to get them off would be a delete the form does not
           * have.
           */
          members: fields(form, "member").map((value) => ({
            technicianId: value,
            isLead: value === field(form, "lead"),
          })),
        });
        return;
      case "retire":
        await crews.update(ctx, { id, active: false });
        return;
      case "restore":
        await crews.update(ctx, { id, active: true });
        return;
      case "oncall":
        await onCall.schedule(ctx, {
          technicianId: String(form.get("technicianId") ?? ""),
          startsAt: new Date(String(form.get("startsAt") ?? "")).toISOString(),
          endsAt: new Date(String(form.get("endsAt") ?? "")).toISOString(),
          /**
           * Only sent when it was filled in. A multiplier is a statement about
           * what somebody is owed and needs `payroll:configure` on top of
           * dispatch rights, so sending an empty one would demand a permission
           * the person does not need for the shift itself.
           */
          rateMultiplier: field(form, "rateMultiplier") ?? null,
        });
        return;
      case "weeks":
        /**
         * The people in the order they take the phone. Four pickers rather
         * than one multi-select, because a multi-select has no order and the
         * order is the whole point of a rota.
         */
        await onCall.fillWeeks(ctx, {
          technicianIds: fields(form, "week"),
          firstDay: String(form.get("firstDay") ?? ""),
          handoverAt: String(form.get("handoverAt") ?? ""),
          weeks: Number(form.get("weeks") ?? 0),
        });
        return;
      case "handover":
        await onCall.handOver(ctx, {
          toTechnicianId: String(form.get("toTechnicianId") ?? ""),
        });
        return;
      default:
        throw new Error(`Unknown crew operation: ${op}`);
    }
  });

  if (state?.done) revalidatePath("/schedule/crews");
  return state;
}
