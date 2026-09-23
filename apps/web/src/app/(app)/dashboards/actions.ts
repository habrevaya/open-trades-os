"use server";

import { redirect } from "next/navigation";
import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dashboards, ConflictError } from "@opentradesos/api/services";
import { tileFromForm, withoutTile, moved } from "@/lib/dashboard-tiles";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

export async function createDashboard(_previous: unknown, form: FormData) {
  const description = String(form.get("description") ?? "").trim();
  let created;
  try {
    created = await dashboards.create(await ctx(), {
      name: String(form.get("name") ?? ""),
      ...(description ? { description } : {}),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }

  revalidatePath("/dashboards");
  redirect(`/dashboards/saved/${created.id}`);
}

export async function deleteDashboard(_previous: unknown, form: FormData) {
  try {
    await dashboards.remove(await ctx(), { id: String(form.get("id") ?? "") });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/dashboards");
  redirect("/dashboards");
}

/**
 * Every tile change is a write of the whole list.
 *
 * The form carries the tiles it started from, so adding one is "these plus
 * this" rather than a read, an append and a write. Two people with the same
 * dashboard open will have the second save overwrite the first, which is
 * honest: this is a layout, the whole thing is the unit, and a merge would
 * have to invent an order nobody chose.
 */
export async function addTile(_previous: unknown, form: FormData) {
  const id = String(form.get("id") ?? "");
  const existing = JSON.parse(String(form.get("tiles") ?? "[]")) as dashboards.StoredTile[];
  const tile = tileFromForm(form, existing);
  if (!tile) return { error: "Pick a report to show" };

  try {
    await dashboards.setTiles(await ctx(), { id, tiles: [...existing, tile] });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/dashboards/saved/${id}`);
  return { done: true };
}

export async function removeTile(_previous: unknown, form: FormData) {
  const id = String(form.get("id") ?? "");
  const existing = JSON.parse(String(form.get("tiles") ?? "[]")) as dashboards.StoredTile[];

  try {
    await dashboards.setTiles(await ctx(), {
      id, tiles: withoutTile(existing, String(form.get("key") ?? "")),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/dashboards/saved/${id}`);
  return { done: true };
}

export async function moveTile(_previous: unknown, form: FormData) {
  const id = String(form.get("id") ?? "");
  const existing = JSON.parse(String(form.get("tiles") ?? "[]")) as dashboards.StoredTile[];
  const direction = String(form.get("direction") ?? "");

  try {
    await dashboards.setTiles(await ctx(), {
      id,
      tiles: moved(existing, String(form.get("key") ?? ""), direction === "up" ? -1 : 1),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath(`/dashboards/saved/${id}`);
  return { done: true };
}
