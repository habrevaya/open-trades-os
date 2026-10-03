"use server";

import { headers } from "next/headers";
import { getDb } from "@/lib/db";
import { forms } from "@opentradesos/api/services";

/**
 * Hand the submission to the same service the public API route reaches,
 * with the caller's address for the per address ceiling and for the consent
 * row's record of where it was given.
 */
export async function submitHosted(input: {
  organizationSlug: string;
  formSlug: string;
  values: Record<string, unknown>;
  startedAt?: string | undefined;
  visitorId?: string | undefined;
  landingQuery?: string | undefined;
  referrer?: string | undefined;
}): Promise<{ ok: true; accepted: boolean; refusals: { field: string; message: string }[]; thankYou: string | null } | { ok: false; message: string }> {
  const asked = await headers();
  try {
    const outcome = await forms.submit(getDb(), {
      organizationSlug: input.organizationSlug,
      formSlug: input.formSlug,
      values: input.values,
      ...(input.startedAt ? { startedAt: new Date(input.startedAt) } : {}),
      visitorId: input.visitorId?.slice(0, 64) ?? null,
      landingQuery: input.landingQuery?.slice(0, 4000) ?? null,
      referrer: input.referrer?.slice(0, 2000) ?? null,
    }, { ip: asked.get("x-forwarded-for")?.split(",")[0]?.trim() });
    /**
     * Spam is thanked like a person, as core asks: telling a script which
     * check caught it is how the next version gets past. The row is kept as
     * spam for the office either way.
     */
    if (outcome.refusals.some((r) => r.reason === "spam")) {
      return { ok: true, accepted: true, refusals: [], thankYou: null };
    }
    return {
      ok: true,
      accepted: outcome.accepted,
      refusals: outcome.refusals.map((r) => ({ field: r.field, message: r.message })),
      thankYou: outcome.thankYou,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "TooManyRequestsError") {
      return { ok: false, message: "We have had a lot of these from you just now. Please wait a minute and try again." };
    }
    return { ok: false, message: "That did not go through. Please give us a call instead." };
  }
}
