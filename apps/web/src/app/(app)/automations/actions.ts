"use server";

import { refused } from "@/lib/actions";
import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { workflows, ConflictError } from "@opentradesos/api/services";
import { automation } from "@opentradesos/core";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function setEnabled(_previous: unknown, form: FormData) {
  try {
    await workflows.setEnabled(await ctx(), {
      id: String(form.get("id") ?? ""),
      enabled: form.get("enabled") === "1",
    });
  } catch (error) {
    // "It has nothing published to run" is a sentence, not a crash.
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/automations");
  return { done: true };
}

/**
 * THE STEPS THE CANVAS DREW.
 *
 * The screen posts a tree, because that is what somebody draws, and the engine runs
 * a flat list with arm counts. `automation.flattenPlan` is the translation and it is
 * the SAME function the canvas uses to show the step count and to check the arms. A
 * second implementation here would be the one that decides what actually runs, and
 * therefore the one whose disagreement matters.
 *
 * It used to read a set of checkboxes: one of each kind, in a fixed order, so there
 * was no way to send two messages, no way to order them and no way to branch at all.
 *
 * NOTHING HERE TRUSTS THE SHAPE. The field is a string a browser posted, so a
 * malformed one is an empty plan rather than a throw, and the service refuses an
 * automation with no steps with a sentence somebody can act on. Each step's config
 * is then rebuilt from named fields rather than passed through, so a caller cannot
 * put a key in a step config that this build does not expect: a step is as narrow as
 * the screen that draws it.
 */
const numeric = (value: unknown): number => {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
};

function configFor(kind: string, raw: Record<string, unknown>): Record<string, unknown> {
  const text = (field: string) => String(raw[field] ?? "").trim();
  switch (kind) {
    case "send_message":
      return { channel: "sms", purpose: "transactional", body: text("body") };
    case "create_task":
      return {
        title: text("title"),
        ...(text("queue") ? { queue: text("queue") } : {}),
        ...(text("dueInHours") ? { dueInHours: numeric(raw["dueInHours"]) } : {}),
      };
    case "wait":
      return { days: numeric(raw["days"]), hours: numeric(raw["hours"]) };
    case "branch": {
      /**
       * The conditions, rebuilt condition by condition. `all` only, which is what
       * the canvas offers; `any` and `none` are evaluated by the engine and reachable
       * through the API, and a screen offering them needs a nested group editor.
       *
       * A condition with no path is dropped rather than saved: it is a row somebody
       * added and did not fill in, and keeping it would make the branch compare
       * against nothing and silently always hold.
       */
      const group = (raw["conditions"] ?? {}) as { all?: unknown };
      const all = Array.isArray(group.all) ? group.all : [];
      const conditions = all
        .map((entry) => (entry ?? {}) as Record<string, unknown>)
        .filter((entry) => String(entry["path"] ?? "").trim() !== "")
        .map((entry) => {
          const op = String(entry["op"] ?? "eq");
          const base = { path: String(entry["path"]).trim(), op };
          if (op === "exists" || op === "not_exists") return base;
          const given = String(entry["value"] ?? "");
          /**
           * A numeric comparator gets a number. The browser posts every value as a
           * string, and `"1000" > 1000` is false for a string comparison, so a
           * branch on an invoice total would read as never holding.
           */
          const numericOp = op === "gt" || op === "gte" || op === "lt" || op === "lte";
          return { ...base, value: numericOp && given !== "" ? Number(given) : given };
        });
      return { conditions: { all: conditions } };
    }
    default:
      return {};
  }
}

function planFrom(form: FormData): automation.PlanNode[] {
  const posted = String(form.get("plan") ?? "");
  if (posted === "") return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(posted);
  } catch {
    return [];
  }

  const clean = (nodes: unknown): automation.PlanNode[] => {
    if (!Array.isArray(nodes)) return [];
    return nodes.flatMap((entry): automation.PlanNode[] => {
      const node = (entry ?? {}) as Record<string, unknown>;
      const kind = String(node["kind"] ?? "");
      if (kind === "") return [];
      const raw = (node["config"] ?? {}) as Record<string, unknown>;
      if (kind !== "branch") return [{ kind, config: configFor(kind, raw) }];
      return [{
        kind,
        config: configFor(kind, raw),
        then: clean(node["then"]),
        otherwise: clean(node["otherwise"]),
      }];
    });
  };

  return clean(parsed);
}

function definitionFrom(form: FormData) {
  const steps = automation.flattenPlan(planFrom(form));

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
    if (error instanceof ConflictError) return refused(form, error.message);
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
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath(`/automations/${id}`);
  return { done: true };
}

export async function deleteAutomation(_previous: unknown, form: FormData) {
  try {
    await workflows.remove(await ctx(), { id: String(form.get("id") ?? "") });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/automations");
  redirect("/automations");
}
