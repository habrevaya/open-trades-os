"use server";

import { refused, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { ai, callTracking, leadIntake, secrets } from "@opentradesos/api/services";
import { connectors } from "@opentradesos/core";
import { FORMS, settingsFrom } from "./fields";

export type ActionState = NonNullable<FormState>;

/**
 * `requireUser`, not the setup gate: the setup wizard draws these same forms
 * before setup is finished, and the gate is about which page a person lands
 * on, not about what they may change. What they may change is the service's
 * question, asked the same way either side of setup.
 */
const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

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
  if (!form || form.noForm) return refused(data, "That provider is not connected from here.");

  const accountLabel = String(data.get("accountLabel") ?? "").trim();
  let credentialRef = String(data.get("credentialRef") ?? "").trim();
  const settings = settingsFrom(form, data);
  const existing = data.get("existing") === "1";

  try {
    const context = await ctx();

    /**
     * PASTED VALUES, with the database store. Each goes to the secrets
     * service first (`integration:write`, encrypted, audited by name) under
     * the provider's default name, and the connection then holds that name,
     * exactly as if it had been typed. Nothing pasted is echoed back: the
     * field names contain "secret", which `keptForm` never keeps.
     */
    const pasted = String(data.get("secretValue:credential") ?? "").trim();
    if (pasted) {
      const name = connectors.defaultSecretName(provider, "credential");
      await secrets.service.put(context, { name, value: pasted });
      credentialRef = name;
    }
    for (const field of form.fields.filter((f) => f.kind === "secret_name")) {
      const value = String(data.get(`secretValue:${field.key}`) ?? "").trim();
      if (!value) continue;
      const name = connectors.defaultSecretName(provider, field.key);
      await secrets.service.put(context, { name, value });
      settings[field.key] = name;
    }

    if (form.via === "ai") {
      if (!credentialRef && !existing) {
        return refused(data, "A model connection needs the name of the secret holding the API key.");
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
    return refused(data, message(error));
  }
  revalidatePath("/settings/integrations");
  revalidatePath("/setup", "layout");
  return { done: true };
}

export async function disconnect(_previous: ActionState, data: FormData): Promise<ActionState> {
  const provider = String(data.get("provider") ?? "");
  try {
    const context = await ctx();
    if (FORMS[provider]?.via === "ai") await ai.disconnect(context, { provider });
    else await leadIntake.disconnect(context, provider);
  } catch (error) {
    return refused(data, message(error));
  }
  revalidatePath("/settings/integrations");
  revalidatePath("/setup", "layout");
  return { done: true };
}

/**
 * Replace one secret's value, or clear it, by name. Database store only; the
 * service refuses otherwise and names the variable to set.
 */
export async function saveSecret(_previous: ActionState, data: FormData): Promise<ActionState> {
  const name = String(data.get("name") ?? "");
  const value = String(data.get("secretValue") ?? "");
  try {
    await secrets.service.put(await ctx(), { name, value });
  } catch (error) {
    return refused(data, message(error));
  }
  revalidatePath("/settings/integrations");
  return { done: true };
}

export async function clearSecret(_previous: ActionState, data: FormData): Promise<ActionState> {
  const name = String(data.get("name") ?? "");
  try {
    await secrets.service.remove(await ctx(), { name });
  } catch (error) {
    return refused(data, message(error));
  }
  revalidatePath("/settings/integrations");
  return { done: true };
}
