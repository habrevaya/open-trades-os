"use server";

import { refused, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { assets } from "@opentradesos/api/services";

export type FleetState = FormState;

const text = (form: FormData, key: string): string | null => {
  const value = String(form.get(key) ?? "").trim();
  return value === "" ? null : value;
};

/**
 * Every fleet write, through its API handler, so the refusals are the
 * module's: a second open assignment, a reading lower than the last, a
 * service recorded before the one already on file, a retirement while
 * somebody still has the thing.
 */
export async function act(_previous: FleetState, form: FormData): Promise<FleetState> {
  const ctx = { actor: (await requireSetupUser()).actor, db: getDb() };
  const op = String(form.get("op") ?? "");
  const assetId = String(form.get("assetId") ?? "");
  try {
    switch (op) {
      case "register": {
        const unit = text(form, "meterUnit");
        await assets.handlers.registerAsset(ctx, {
          kind: String(form.get("kind")) as "vehicle",
          label: String(form.get("label") ?? ""),
          identifier: text(form, "identifier"),
          meterUnit: unit as "miles" | null,
          acquiredOn: text(form, "acquiredOn"),
        });
        break;
      }
      case "check-out":
        await assets.handlers.checkOutAsset(ctx, {
          assetId, custodianKind: "technician", custodianId: String(form.get("custodianId") ?? ""),
        });
        break;
      case "check-in":
        await assets.handlers.checkInAsset(ctx, { assetId });
        break;
      case "reading":
        await assets.handlers.recordAssetReading(ctx, {
          assetId, value: Number(form.get("value")), source: "technician",
        });
        break;
      case "serviced":
        await assets.handlers.recordAssetService(ctx, { planId: String(form.get("planId") ?? "") });
        break;
      case "obligation":
        await assets.handlers.setAssetObligation(ctx, {
          assetId,
          kind: String(form.get("kind")) as "registration",
          expiresOn: String(form.get("expiresOn") ?? ""),
          reference: text(form, "reference"),
        });
        break;
      case "retire":
        await assets.handlers.retireAsset(ctx, { id: assetId, ...(text(form, "reason") ? { reason: text(form, "reason")! } : {}) });
        break;
      default:
        return refused(form, "Nothing to do.");
    }
  } catch (error) {
    if (error instanceof Error && ["ConflictError", "NotFoundError", "UnprocessableError", "PermissionError"].includes(error.name)) {
      return refused(form, error.message);
    }
    throw error;
  }
  revalidatePath("/fleet");
  return { done: true };
}
