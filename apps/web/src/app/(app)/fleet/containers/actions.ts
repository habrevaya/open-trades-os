"use server";

import { attempt, field, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ConflictError, haulTimes, rentals } from "@opentradesos/api/services";
import { time } from "@opentradesos/core";

export type ContainerState = FormState;

const number = (form: FormData, key: string): number | undefined => {
  const raw = field(form, key);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
};

/**
 * Every container write, through its service handler.
 *
 * Nothing here decides what is allowed. The refusals a driver will actually hit
 * are all the module's: a can with no number, a second delivery of a unit already
 * on a site, one tagged out for repair being sent out, a collection dated before
 * its delivery, a negative tonnage, a swap for the same can, and an overage asked
 * for while the container is still on site.
 */
export async function act(_previous: ContainerState, form: FormData): Promise<ContainerState> {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  /** Times typed on this board are the company's clock, the one every time on it is shown in. */
  const zone = user.organizationTimezone;
  const op = String(form.get("op") ?? "");
  const id = String(form.get("id") ?? "");

  const state = await attempt(form, async () => {
    switch (op) {
      case "add":
        await rentals.addAsset(ctx, {
          assetType: String(form.get("assetType") ?? ""),
          identifier: String(form.get("identifier") ?? ""),
          size: field(form, "size") ?? null,
        });
        return;
      case "out": {
        const since = localInstant(field(form, "since"), zone);
        await rentals.tagOutOfService(ctx, { id, reason: String(form.get("reason") ?? ""), ...(since ? { at: since } : {}) });
        return;
      }
      case "in": {
        const back = localInstant(field(form, "back"), zone);
        await rentals.returnToService(ctx, { id, ...(back ? { at: back } : {}) });
        return;
      }
      case "hold": {
        const since = localInstant(field(form, "since"), zone);
        await haulTimes.holdForCustomer(ctx, {
          assetId: id, reason: String(form.get("reason") ?? ""), ...(since ? { startsAt: since } : {}),
        });
        return;
      }
      case "end-hold": {
        const at = localInstant(field(form, "at"), zone);
        await haulTimes.endHold(ctx, { id, ...(at ? { endsAt: at } : {}) });
        return;
      }
      case "drop-time": {
        const day = String(form.get("day") ?? "");
        const at = localInstant(field(form, "time") ? `${day}T${field(form, "time")}` : undefined, zone);
        if (!at) throw new ConflictError("Type the time the can was put down.");
        await haulTimes.recordPlacement(ctx, { id, deliveredAt: at });
        return;
      }
      case "empty": {
        const day = String(form.get("day") ?? "");
        const at = localInstant(field(form, "time") ? `${day}T${field(form, "time")}` : undefined, zone);
        if (!at) throw new ConflictError("Type the time the empty can was collected.");
        await haulTimes.recordEmpty(ctx, { id, at });
        return;
      }
      case "not-empty":
        await haulTimes.recordEmpty(ctx, { id, at: null });
        return;
      case "material":
        await rentals.setMaterial(ctx, { id, materialType: field(form, "materialType") ?? null });
        return;
      case "tip": {
        const at = localInstant(field(form, "tippedAt"), zone);
        if (!at) throw new ConflictError("Type the day and time the load was emptied.");
        await haulTimes.recordTip(ctx, { id, tippedAt: at });
        return;
      }
      case "retire":
        await rentals.retireAsset(ctx, { id });
        return;
      case "deliver":
        await rentals.deliver(ctx, {
          assetId: id,
          propertyId: String(form.get("propertyId") ?? ""),
          /**
           * The instant the caller gives, not the clock. A driver writing up a
           * day's drops at five in the evening would otherwise have every hire
           * start at five, and every short rental would be a day short.
           */
          ...placement(field(form, "deliveredAt"), field(form, "deliveredTime"), zone, "deliveredAt", "deliveredOn"),
          includedDays: number(form, "includedDays") ?? null,
          dailyRate: field(form, "dailyRate") ?? null,
          overageRate: field(form, "overageRate") ?? null,
          includedTons: field(form, "includedTons") ?? null,
          perTonRate: field(form, "perTonRate") ?? null,
          invoiceAs: field(form, "invoiceAs") === "chain" ? "chain" : "per_haul",
          disposalPassThrough: form.get("disposalPassThrough") === "on",
          materialType: field(form, "materialType") ?? null,
        });
        return;
      case "pickup":
        await rentals.pickUp(ctx, {
          id,
          ...(field(form, "pickedUpAt") ? { pickedUpAt: atNoon(field(form, "pickedUpAt")!) } : {}),
          tons: field(form, "tons") ?? null,
          ticketNumber: field(form, "ticketNumber") ?? null,
          facility: field(form, "facility") ?? null,
          facilityId: field(form, "facilityId") ?? null,
          /** Unticked means the can came back needing work, not that it vanished. */
          backInService: form.get("backInService") !== null,
          ...(localInstant(field(form, "tippedAt"), zone) ? { tippedAt: localInstant(field(form, "tippedAt"), zone)! } : {}),
        });
        return;
      case "swap":
        await rentals.swap(ctx, {
          id,
          replacementAssetId: String(form.get("replacementAssetId") ?? ""),
          ...placement(field(form, "at"), field(form, "atTime"), zone, "at", "on"),
          tons: field(form, "tons") ?? null,
          ticketNumber: field(form, "ticketNumber") ?? null,
          facilityId: field(form, "facilityId") ?? null,
          ...(localInstant(field(form, "tippedAt"), zone) ? { tippedAt: localInstant(field(form, "tippedAt"), zone)! } : {}),
        });
        return;
      default:
        throw new Error(`Unknown container operation: ${op}`);
    }
  });

  if (state?.done) revalidatePath("/fleet/containers");
  return state;
}

/**
 * A drop's day and, when typed, its time. With a time it is the moment the can
 * was put down, in the company's clock; with only a day it is sent as a day,
 * which the hire keeps as one and never gives an hour. Neither is now.
 */
function placement<A extends string, D extends string>(
  day: string | undefined, clock: string | undefined, zone: string, instantKey: A, dayKey: D,
): Partial<Record<A | D, string>> {
  if (!day) return {};
  const at = clock ? localInstant(`${day}T${clock}`, zone) : undefined;
  return (at ? { [instantKey]: at } : { [dayKey]: day }) as Partial<Record<A | D, string>>;
}

/** `2026-06-08T14:10` from a datetime box (or a day and a time put together), as an instant in the company's zone. */
function localInstant(value: string | undefined, zone: string): string | undefined {
  const match = value ? /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(value) : null;
  if (!match) return undefined;
  return time.instantOfLocal(match[1]!, Number(match[2]) * 60 + Number(match[3]), zone).toISOString();
}

/**
 * A date box gives a calendar day and the service wants an instant.
 *
 * Midday rather than midnight, and that is the whole reason this helper exists.
 * A container day is any part of a calendar day in the company's timezone, so a
 * date sent as `T00:00:00Z` lands on the previous evening anywhere west of
 * Greenwich and starts the hire a day early. Midday UTC is the same calendar day
 * in every zone this product runs in.
 */
const atNoon = (date: string) => `${date}T12:00:00.000Z`;
