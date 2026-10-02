"use server";

import { attempt, field, fields, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { serviceRoutes as routes } from "@opentradesos/api/services";

export type RouteState = FormState;

const whole = (form: FormData, key: string): number | null => {
  const raw = field(form, key);
  if (raw === undefined) return null;
  const parsed = Number(raw);
  return Number.isInteger(parsed) ? parsed : null;
};

/**
 * Route writes, through their service handlers.
 *
 * The refusals are the module's and every one of them is worth hitting: a route
 * with no servicer or with two, the same property twice on one route, an order
 * that names a stop twice or names one that is not on this route, and a
 * materialisation onto the wrong weekday.
 */
export async function act(_previous: RouteState, form: FormData): Promise<RouteState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "route": {
        /**
         * The servicer comes from one select whose value says which kind it is,
         * so there is no shape of this form that sends both or neither. The
         * service refuses both anyway; this just means the form cannot ask.
         */
        const servicer = String(form.get("servicer") ?? "");
        const [kind, who] = servicer.split(":");
        await routes.create(ctx, {
          name: String(form.get("name") ?? ""),
          dayOfWeek: whole(form, "dayOfWeek") ?? 1,
          technicianId: kind === "technician" ? who ?? null : null,
          crewId: kind === "crew" ? who ?? null : null,
          targetStopCount: whole(form, "targetStopCount"),
          startsAt: field(form, "startsAt") ?? null,
          travelMinutesBetweenStops: whole(form, "travelMinutesBetweenStops"),
        });
        return;
      }
      case "stop":
        await routes.addStop(ctx, {
          routeId: id,
          propertyId: String(form.get("propertyId") ?? ""),
          ...(whole(form, "estimatedMinutes") !== null
            ? { estimatedMinutes: whole(form, "estimatedMinutes")! } : {}),
          intervalDays: whole(form, "intervalDays"),
          pricePerStop: field(form, "pricePerStop") ?? null,
          firstDueOn: field(form, "firstDueOn") ?? null,
        });
        return;
      case "reorder":
        /**
         * The whole order in one call, which renumbers the route in one
         * statement. A half renumbered day is two stops numbered four, and the
         * driver's sheet is then in an order nobody chose.
         */
        await routes.reorder(ctx, { id, stopIds: fields(form, "stopId") });
        return;
      case "skip":
        await routes.setStopActive(ctx, { id: String(form.get("stopId") ?? ""), active: false });
        return;
      case "unskip":
        await routes.setStopActive(ctx, { id: String(form.get("stopId") ?? ""), active: true });
        return;
      case "materialise": {
        const result = await routes.materialise(ctx, {
          id, date: String(form.get("date") ?? ""),
        });
        /**
         * Three numbers in the message, because one would hide the two that
         * explain a short day: a stop that already had a visit (a retried timer,
         * not an error) and a stop whose own cadence does not fall today.
         */
        const already = result.alreadyThere > 0 ? `, ${result.alreadyThere} already there` : "";
        const notDue = result.notDue.length > 0 ? `, ${result.notDue.length} not due` : "";
        return { message: `${result.created.length} jobs created${already}${notDue}.` };
      }
      default:
        throw new Error(`Unknown route operation: ${op}`);
    }
  });

  if (state?.done) revalidatePath("/schedule/routes");
  return state;
}
