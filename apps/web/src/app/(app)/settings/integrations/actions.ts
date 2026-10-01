"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ai, callTracking, leadIntake } from "@opentradesos/api/services";
import { FORMS, settingsFrom } from "./fields";

export type ActionState = { done?: boolean; error?: string };

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/**
 * The service's own words, or nothing. Every refusal on this path is written
 * for the person reading it: a provider that is named and not built, a
 * permission they do not hold, an account id that does not look like one.
 */
function message(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "That did not save. Nothing was changed.";
}

/**
 * Connect a provider, or change one already connected.
 *
 * Through the service each provider already has, so the permission checks
 * and the refusals are the ones the API applies: `integration:write`, or
 * `agent:configure` for a model, and the catalogue's refusal of anything
 * named and not built. Nothing here writes `integration_connection` itself.
 *
 * An edit keeps what is already stored and changes only what was typed,
 * because the screen never shows a stored setting back.
 */
export async function connect(_previous: ActionState, data: FormData): Promise<ActionState> {
  const provider = String(data.get("provider") ?? "");
  const form = FORMS[provider];
  if (!form || form.noForm) return { error: "That provider is not connected from here." };

  const accountLabel = String(data.get("accountLabel") ?? "").trim();
  const credentialRef = String(data.get("credentialRef") ?? "").trim();
  const settings = settingsFrom(form, data);
  const existing = data.get("existing") === "1";

  try {
    const context = await ctx();
    if (form.via === "ai") {
      if (!credentialRef && !existing) {
        return { error: "A model connection needs the name of the secret holding the API key." };
      }
      await ai.connect(context, {
        provider,
        credentialRef,
        ...(accountLabel ? { accountLabel } : {}),
        settings,
      });
    } else if (form.via === "call_tracking") {
      await callTracking.connect(context, {
        accountId: String(settings["accountId"] ?? ""),
        ...(typeof settings["companyId"] === "string" ? { companyId: settings["companyId"] } : {}),
        ...(accountLabel ? { accountLabel } : {}),
      });
    } else {
      await leadIntake.connect(context, {
        provider,
        ...(accountLabel ? { accountLabel } : {}),
        ...(credentialRef ? { credentialRef } : {}),
        settings,
        keepExisting: existing,
      });
    }
  } catch (error) {
    return { error: message(error) };
  }
  revalidatePath("/settings/integrations");
  return { done: true };
}

export async function disconnect(_previous: ActionState, data: FormData): Promise<ActionState> {
  const provider = String(data.get("provider") ?? "");
  try {
    const context = await ctx();
    if (FORMS[provider]?.via === "ai") await ai.disconnect(context, { provider });
    else await leadIntake.disconnect(context, provider);
  } catch (error) {
    return { error: message(error) };
  }
  revalidatePath("/settings/integrations");
  return { done: true };
}
