"use server";

import { revalidatePath } from "next/cache";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { branding, telephony, phoneNumbers, ConflictError } from "@opentradesos/api/services";
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

/**
 * The company's time zone.
 *
 * Every screen that turns a calendar day into a pair of instants reads it:
 * the dispatch board, the booking page's arrival windows, agreement dates,
 * workflow schedules. Until now nothing could write it, so every company was
 * permanently in Chicago and had no way to find out that was why their
 * booking page offered the wrong hours.
 */
export async function setTimezone(_previous: unknown, form: FormData) {
  try {
    const result = await branding.setTimezone(await ctx(), {
      timezone: String(form.get("timezone") ?? ""),
    });
    refresh();
    /**
     * The previous value is echoed back, because this setting silently moves
     * every published arrival window. Somebody who changes it by accident
     * should be able to read what it was without going to the audit log.
     */
    return result.previous && result.previous !== result.timezone
      ? { done: true, note: `Now ${result.timezone}, was ${result.previous}. Published arrival windows move with it.` }
      : { done: true };
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
}

/**
 * CALL RECORDING, AND WHAT THE OPERATOR IS DECLARING
 *
 * Nothing here decides what the law is. The operator says what they believe
 * the rule is in each place they work, in their own words, and the product
 * holds them to it: a call with a party in a place they have not declared
 * resolves to unknown, which is treated as all party and announcement
 * required, and recording is refused until that is satisfied.
 *
 * Withdrawing a declaration is therefore the safe direction. A person who is
 * no longer sure about a place should be able to remove it and have the
 * system get stricter, not quietly keep applying yesterday's confidence.
 */
export async function setRecordingPolicy(_previous: unknown, form: FormData) {
  try {
    const policy = await telephony.setPolicy(await ctx(), {
      jurisdiction: String(form.get("jurisdiction") ?? ""),
      rule: String(form.get("rule") ?? ""),
      announcementRequired: form.get("announcementRequired") === "on",
      note: String(form.get("note") ?? ""),
    });
    revalidatePath("/settings");
    return { done: true, note: `${policy.jurisdiction} is declared ${policy.rule.replace("_", " ")}.` };
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
}

export async function removeRecordingPolicy(_previous: unknown, form: FormData) {
  try {
    await telephony.removePolicy(await ctx(), String(form.get("jurisdiction") ?? ""));
    revalidatePath("/settings");
    return {
      done: true,
      note: "Withdrawn. Calls with a party there now resolve to unknown, which needs everybody's agreement and an announcement.",
    };
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
}

export async function addNumber(_previous: unknown, form: FormData) {
  try {
    await phoneNumbers.add(await ctx(), {
      e164: String(form.get("e164") ?? ""),
      purpose: String(form.get("purpose") ?? "main") as "main",
      label: String(form.get("label") ?? "") || null,
      attributionSource: String(form.get("attributionSource") ?? "") || null,
      smsRegistered: form.get("smsRegistered") === "yes",
    });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/settings");
  return { done: true };
}

/**
 * Hand a number back.
 *
 * The result carries what texts now come from, and the screen surfaces it,
 * because releasing the last sendable number is allowed and silently stops
 * every message. Returned rather than refused: a company leaving a provider
 * releases everything, and a product that blocks the last one makes them
 * edit the database.
 */
export async function releaseNumber(_previous: unknown, form: FormData) {
  let result;
  try {
    result = await phoneNumbers.release(await ctx(), { id: String(form.get("id") ?? "") });
  } catch (error) {
    if (error instanceof ConflictError) return { error: error.message };
    throw error;
  }
  revalidatePath("/settings");
  return { done: true, nowSendingFrom: result.nowSendingFrom };
}
