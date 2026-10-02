"use server";

import { attempt, field, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { rentals } from "@opentradesos/api/services";

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
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
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
      case "out":
        await rentals.tagOutOfService(ctx, { id, reason: String(form.get("reason") ?? "") });
        return;
      case "in":
        await rentals.returnToService(ctx, { id });
        return;
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
          ...(field(form, "deliveredAt") ? { deliveredAt: atNoon(field(form, "deliveredAt")!) } : {}),
          includedDays: number(form, "includedDays") ?? null,
          dailyRate: field(form, "dailyRate") ?? null,
          overageRate: field(form, "overageRate") ?? null,
          includedTons: field(form, "includedTons") ?? null,
          perTonRate: field(form, "perTonRate") ?? null,
        });
        return;
      case "pickup":
        await rentals.pickUp(ctx, {
          id,
          ...(field(form, "pickedUpAt") ? { pickedUpAt: atNoon(field(form, "pickedUpAt")!) } : {}),
          tons: field(form, "tons") ?? null,
          ticketNumber: field(form, "ticketNumber") ?? null,
          facility: field(form, "facility") ?? null,
          /** Unticked means the can came back needing work, not that it vanished. */
          backInService: form.get("backInService") !== null,
        });
        return;
      case "swap":
        await rentals.swap(ctx, {
          id,
          replacementAssetId: String(form.get("replacementAssetId") ?? ""),
          ...(field(form, "at") ? { at: atNoon(field(form, "at")!) } : {}),
          tons: field(form, "tons") ?? null,
          ticketNumber: field(form, "ticketNumber") ?? null,
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
 * A date box gives a calendar day and the service wants an instant.
 *
 * Midday rather than midnight, and that is the whole reason this helper exists.
 * A container day is any part of a calendar day in the company's timezone, so a
 * date sent as `T00:00:00Z` lands on the previous evening anywhere west of
 * Greenwich and starts the hire a day early. Midday UTC is the same calendar day
 * in every zone this product runs in.
 */
const atNoon = (date: string) => `${date}T12:00:00.000Z`;
