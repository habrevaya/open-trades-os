"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { workflows, ConflictError } from "@opentradesos/api/services";
import type { automation } from "@opentradesos/core";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function setEnabled(_previous: unknown, form: FormData) {
  try {
    await workflows.setEnabled(await ctx(), {
      id: String(form.get("id") ?? ""),
      enabled: form.get("enabled") === "1",
    });
  } catch (error) {
    // "It has nothing published to run" is a sentence, not a crash.
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/automations");
  return { done: true };
}

/**
 * The definition the form describes.
 *
 * Only the steps this build can actually perform, and only the fields each
 * one needs. A JSON textarea would be more expressive and would also be a way
 * to write a definition naming a step that does nothing, which is the failure
 * this whole screen exists to stop.
 */
function definitionFrom(form: FormData) {
  const kinds = form.getAll("step").map(String).filter(Boolean);
  const steps = kinds.map((kind, index) => {
    const at = (field: string) => String(form.get(`${kind}.${field}`) ?? "").trim();
    if (kind === "send_message") {
      return { kind, config: { channel: "sms", purpose: "transactional", body: at("body") } };
    }
    if (kind === "create_task") {
      return {
        kind,
        config: {
          title: at("title"),
          ...(at("queue") ? { queue: at("queue") } : {}),
          ...(at("dueInHours") ? { dueInHours: Number(at("dueInHours")) } : {}),
        },
      };
    }
    if (kind === "wait") {
      const days = Number(at("days") || 0);
      const hours = Number(at("hours") || 0);
      return { kind, config: { days, hours } };
    }
    return { kind, config: {} as Record<string, unknown>, index };
  });

  const chosen = String(form.get("triggerKind") ?? "event");
  const triggerKind = chosen === "schedule" || chosen === "dwell"
    ? chosen as "schedule" | "dwell"
    : "event" as const;
  const schedule = String(form.get("schedule") ?? "").trim();
  const description = String(form.get("description") ?? "").trim();
  const dwellShape = String(form.get("dwellShape") ?? "").trim();

  return {
    name: String(form.get("name") ?? ""),
    triggerKind,
    triggerEvents: form.getAll("triggerEvent").map(String).filter(Boolean),
    ...(schedule ? { schedule } : {}),
    ...(dwellShape
      ? { dwell: { shape: dwellShape, afterDays: Number(form.get("dwellDays") ?? 0) } }
      : {}),
    ...(description ? { description } : {}),
    steps,
    conditions: {} as automation.ConditionGroup,
  };
}

export async function createAutomation(_previous: unknown, form: FormData) {
  let created;
  try {
    created = await workflows.create(await ctx(), definitionFrom(form));
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/automations");
  redirect(`/automations/${created.id}`);
}

export async function publishAutomation(_previous: unknown, form: FormData) {
  const id = String(form.get("id") ?? "");
  try {
    await workflows.publish(await ctx(), { id, ...definitionFrom(form) });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/automations/${id}`);
  return { done: true };
}

export async function deleteAutomation(_previous: unknown, form: FormData) {
  try {
    await workflows.remove(await ctx(), { id: String(form.get("id") ?? "") });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/automations");
  redirect("/automations");
}
