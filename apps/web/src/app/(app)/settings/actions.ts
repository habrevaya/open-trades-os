"use server";

import { attempt, field, refused, type FormState } from "@/lib/actions";
import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { branding, setup, telephony, phoneNumbers, voice, websiteTracking, ConflictError } from "@opentradesos/api/services";
import type { branding as brand } from "@opentradesos/core";

/**
 * `requireUser`, not the setup gate: the setup wizard draws these same forms
 * before setup is finished, and the gate is about which page a person lands
 * on, not about what they may change. What they may change is the service's
 * question, asked the same way either side of setup.
 */
const ctx = async () => ({ actor: (await requireUser()).actor, db: getDb() });

/** Everything under this layout renders the colours, so it all revalidates. */
const refresh = () => revalidatePath("/", "layout");

/**
 * The company's names and how a customer reaches it, from the one form the
 * setup wizard and Settings both draw. An emptied contact box is posted as
 * null, which clears it, rather than left out, which would keep the old one:
 * somebody who deletes the address expects it off the next invoice.
 */
export async function saveCompanyDetails(_previous: FormState, form: FormData): Promise<FormState> {
  const cleared = (name: string) => field(form, name) ?? null;
  const result = await attempt(form, async () => setup.updateDetails(await ctx(), {
    name: field(form, "name") ?? "",
    legalName: cleared("legalName"),
    phone: cleared("phone"),
    email: cleared("email"),
    addressLine1: cleared("addressLine1"),
    addressLine2: cleared("addressLine2"),
    city: cleared("city"),
    state: cleared("state"),
    postalCode: cleared("postalCode"),
  }));
  refresh();
  return result;
}

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
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
}

export async function setBrandAsset(_previous: unknown, form: FormData) {
  const kind = String(form.get("kind") ?? "") as brand.BrandAssetKind;
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return refused(form, "Pick a file first.");
  }

  try {
    await branding.setAsset(await ctx(), {
      kind,
      // The bytes, and only the bytes. `file.type` is a string the browser
      // sent and the service never looks at it.
      bytes: new Uint8Array(await file.arrayBuffer()),
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
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
    if (error instanceof ConflictError) return refused(form, error.message);
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
    if (error instanceof ConflictError) return refused(form, error.message);
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
    if (error instanceof ConflictError) return refused(form, error.message);
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
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
}

export async function addNumber(_previous: unknown, form: FormData) {
  try {
    await phoneNumbers.add(await ctx(), {
      e164: String(form.get("e164") ?? ""),
      purpose: String(form.get("purpose") ?? "main") as "main",
      label: String(form.get("label") ?? "") || null,
      ...creditFrom(form),
      smsRegistered: form.get("smsRegistered") === "yes",
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/settings");
  return { done: true };
}

/**
 * What a tracking number's calls are credited to, off the form's one select:
 * `campaign:<id>` or `channel:<id>`. The service makes the campaign, the
 * channel and the source key agree.
 */
function creditFrom(form: FormData): { campaignId?: string; channelId?: string } {
  const [kind, id] = String(form.get("credit") ?? "").split(":");
  if (!id) return {};
  return kind === "campaign" ? { campaignId: id } : kind === "channel" ? { channelId: id } : {};
}

/** Move a tracking number to another campaign. Calls already taken keep theirs. */
export async function assignNumber(_previous: unknown, form: FormData) {
  try {
    const credit = creditFrom(form);
    await phoneNumbers.update(await ctx(), {
      id: String(form.get("id") ?? ""),
      ...(credit.campaignId ? { campaignId: credit.campaignId } : { channelId: credit.channelId ?? null }),
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
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
    /**
     * Through the voice service, which hands a number bought here back at the
     * carrier first and then here, and a typed in number here only.
     */
    result = await voice.releaseNumber(await ctx(), { id: String(form.get("id") ?? "") });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/settings");
  return { done: true, nowSendingFrom: result.nowSendingFrom };
}

/**
 * Numbers the company's own Twilio account could buy.
 *
 * The list comes back in the form's state rather than a page reload, because
 * it is a question asked of the carrier, not something this product stores.
 */
export async function searchNumbers(_previous: unknown, form: FormData) {
  try {
    const numbers = await voice.searchNumbers(await ctx(), {
      areaCode: String(form.get("areaCode") ?? "") || undefined,
      locality: String(form.get("locality") ?? "") || undefined,
      region: String(form.get("region") ?? "") || undefined,
    });
    return { done: true, numbers };
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
}

const e164Or = (form: FormData, name: string) => {
  const value = String(form.get(name) ?? "").trim();
  return value === "" ? undefined : value;
};

/** Buy one of them, credited and routed as the form says. */
export async function buyNumber(_previous: unknown, form: FormData) {
  try {
    const purpose = String(form.get("purpose") ?? "tracking") === "pool" ? "pool" as const : "tracking" as const;
    const credit = creditFrom(form);
    const forwardsToE164 = e164Or(form, "forwardsToE164");
    const afterHoursForwardsToE164 = e164Or(form, "afterHoursForwardsToE164");
    await voice.buyNumber(await ctx(), {
      e164: String(form.get("e164") ?? ""),
      purpose,
      label: String(form.get("label") ?? "") || null,
      ...(purpose === "tracking" ? credit : {}),
      ...(forwardsToE164 ? { forwardsToE164 } : {}),
      ...(afterHoursForwardsToE164 ? { afterHoursForwardsToE164 } : {}),
      whisper: form.get("whisper") === "yes",
      recordCalls: form.get("recordCalls") === "yes",
      routeByHours: form.get("routeByHours") === "yes",
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/settings");
  return { done: true, bought: String(form.get("e164") ?? "") };
}

/** How a routed number's calls are answered. */
export async function setRouting(_previous: unknown, form: FormData) {
  try {
    await phoneNumbers.update(await ctx(), {
      id: String(form.get("id") ?? ""),
      forwardsToE164: e164Or(form, "forwardsToE164") ?? null,
      afterHoursForwardsToE164: e164Or(form, "afterHoursForwardsToE164") ?? null,
      whisper: form.get("whisper") === "yes",
      recordCalls: form.get("recordCalls") === "yes",
      routeByHours: form.get("routeByHours") === "yes",
    });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/settings");
  return { done: true };
}

/** How long a quiet website visitor keeps their pool number. */
export async function setIdleMinutes(_previous: unknown, form: FormData) {
  try {
    await websiteTracking.setSettings(await ctx(), { idleMinutes: Number(form.get("idleMinutes") ?? "") });
  } catch (error) {
    if (error instanceof ConflictError) return refused(form, error.message);
    throw error;
  }
  revalidatePath("/settings/website");
  return { done: true, message: "Saved." };
}
