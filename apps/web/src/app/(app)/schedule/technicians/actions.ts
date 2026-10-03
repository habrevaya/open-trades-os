"use server";

import { attempt, field, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dispatchMap, geocoding, liveLocation } from "@opentradesos/api/services";
import { geo } from "@opentradesos/core";

/**
 * What a technician is recorded as doing, where their day starts, and how
 * drive time is estimated. Every refusal is the service's: a location from
 * another company, a speed of zero, a permission this person does not hold.
 */
export async function act(_previous: FormState, form: FormData): Promise<FormState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "profile": {
        const start = field(form, "homeLocationId");
        await dispatchMap.updateTechnician(ctx, {
          id,
          /**
           * Comma separated in the box, because a skill is a short word a
           * person types and a list of checkboxes would only offer the ones
           * somebody already typed elsewhere.
           */
          skills: String(form.get("skills") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
          homeLocationId: start ?? null,
          ...(field(form, "color") ? { color: field(form, "color")! } : {}),
          /** Both times or neither: a day with a start and no end is not a day. */
          workday: field(form, "startsAt") && field(form, "endsAt")
            ? { startsAt: field(form, "startsAt")!, endsAt: field(form, "endsAt")! }
            : null,
          ...(field(form, "shareLocation") ? { shareLocation: field(form, "shareLocation") === "on" } : {}),
        });
        return;
      }
      case "photo": {
        const file = form.get("photo");
        const clearing = field(form, "clear") === "yes";
        if (!clearing && !(file instanceof File && file.size > 0)) throw new Error("Choose a photo first.");
        await dispatchMap.setTechnicianPhoto(ctx, {
          id,
          bytes: clearing ? null : Buffer.from(await (file as File).arrayBuffer()).toString("base64"),
        });
        return;
      }
      case "workday": {
        const minutes = (key: string) => (field(form, key) ? Number(field(form, key)) : undefined);
        await dispatchMap.setWorkdaySettings(ctx, {
          ...(field(form, "dayEndsAt") ? { dayEndsAt: field(form, "dayEndsAt")! } : {}),
          ...(minutes("lunchMinutes") !== undefined ? { lunchMinutes: minutes("lunchMinutes")! } : {}),
          ...(field(form, "lunchEarliest") ? { lunchEarliest: field(form, "lunchEarliest")! } : {}),
          ...(field(form, "lunchLatest") ? { lunchLatest: field(form, "lunchLatest")! } : {}),
          ...(minutes("maxOvertimeMinutes") !== undefined ? { maxOvertimeMinutes: minutes("maxOvertimeMinutes")! } : {}),
        });
        return;
      }
      case "sharing": {
        const days = field(form, "retentionDays");
        const seconds = field(form, "intervalSeconds");
        await liveLocation.setSharing(ctx, {
          ...(field(form, "enabled") ? { enabled: field(form, "enabled") === "on" } : {}),
          ...(days ? { retentionDays: Number(days) } : {}),
          ...(seconds ? { intervalSeconds: Number(seconds) } : {}),
        });
        return;
      }
      case "travel": {
        const mph = field(form, "averageMph");
        const factor = field(form, "roadFactor");
        await dispatchMap.setTravelSettings(ctx, {
          ...(mph ? { averageKmh: Math.round(Number(mph) * geo.KM_PER_MILE * 10) / 10 } : {}),
          ...(factor ? { roadFactor: Number(factor) } : {}),
          ...(field(form, "dayStartsAt") ? { dayStartsAt: field(form, "dayStartsAt")! } : {}),
        });
        return;
      }
      case "pin":
        await geocoding.placePin(ctx, {
          entity: "location", id,
          latitude: Number(field(form, "latitude") ?? "NaN"),
          longitude: Number(field(form, "longitude") ?? "NaN"),
        });
        return;
      case "unpin":
        await geocoding.clearPin(ctx, { entity: "location", id });
        return;
      default:
        throw new Error(`Unknown operation ${op}`);
    }
  });

  revalidatePath("/schedule/technicians");
  return state;
}

/** The location pin editor posts here, through the same switch. */
export async function placeLocationPin(previous: FormState, form: FormData): Promise<FormState> {
  form.set("op", "pin");
  return act(previous, form);
}

export async function clearLocationPin(previous: FormState, form: FormData): Promise<FormState> {
  form.set("op", "unpin");
  return act(previous, form);
}
