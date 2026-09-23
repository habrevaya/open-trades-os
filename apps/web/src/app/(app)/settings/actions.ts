"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { branding, ConflictError } from "@opentradesos/api/services";
import type { branding as brand } from "@opentradesos/core";

const ctx = async () => ({ actor: (await requireSetupUser()).actor, db: getDb() });

/** Everything under this layout renders the colours, so it all revalidates. */
const refresh = () => revalidatePath("/", "layout");

export async function setBrandColor(_previous: unknown, form: FormData) {
  try {
    const result = await branding.setColor(await ctx(), {
      color: String(form.get("color") ?? ""),
    });
    refresh();
    /**
     * The darkening is reported back rather than applied silently. An owner
     * whose links come out a shade darker than their brand guide should hear
     * why once, on the screen where they chose it, instead of wondering
     * whether the product got their colour wrong.
     */
    return result.darkened
      ? { done: true, note: `Links and headings use ${result.text}, a darker shade of ${result.color}, because ${result.color} cannot be read as text on a white page.` }
      : { done: true };
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
}

export async function setBrandAsset(_previous: unknown, form: FormData) {
  const kind = String(form.get("kind") ?? "") as brand.BrandAssetKind;
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return { error: "Pick a file first." };
  }

  try {
    await branding.setAsset(await ctx(), {
      kind,
      // The bytes, and only the bytes. `file.type` is a string the browser
      // sent and the service never looks at it.
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  refresh();
  return { done: true };
}

export async function clearBrandAsset(_previous: unknown, form: FormData) {
  try {
    await branding.clearAsset(await ctx(), {
      kind: String(form.get("kind") ?? "") as brand.BrandAssetKind,
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  refresh();
  return { done: true };
}
