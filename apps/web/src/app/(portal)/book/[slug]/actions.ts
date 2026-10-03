"use server";

import { getDb } from "@/lib/db";
import { booking } from "@opentradesos/api/services";
import { ConflictError } from "@opentradesos/api/services";

export type Slot = {
  date: string;
  arrivalWindowId: string;
  label: string;
  startsAt: string;
  endsAt: string;
  remaining: number;
};

export async function loadSlots(input: {
  slug: string;
  serviceId: string;
}): Promise<Slot[]> {
  const today = new Date().toISOString().slice(0, 10);
  const { slots } = await booking.availability(getDb(), {
    organizationSlug: input.slug,
    bookableServiceId: input.serviceId,
    from: today,
    days: 21,
  });
  return slots;
}

/** How the visitor arrived, read by the page in their browser. Every part optional. */
export type Arrival = {
  landingQuery?: string | undefined;
  referrer?: string | undefined;
  sourceUrl?: string | undefined;
  visitorId?: string | undefined;
};

/**
 * The utm tags out of the landing query, for the `utm` field.
 *
 * The raw query goes as well and is what the touch is parsed from; this is
 * kept for whatever reads the request's own `utm` column, which a widget
 * sending an empty bag left blank on every booking.
 */
function utmOf(query: string | undefined): Record<string, string> {
  const utm: Record<string, string> = {};
  if (!query) return utm;
  try {
    for (const [key, value] of new URLSearchParams(query)) {
      if (key.startsWith("utm_") && value && !(key in utm)) utm[key] = value.slice(0, 200);
    }
  } catch {
    // A query that will not parse still goes through as `landingQuery`.
  }
  return utm;
}

const clip = (value: string | undefined, max: number) =>
  value ? value.slice(0, max) : undefined;

export async function submitBooking(input: {
  slug: string;
  arrival?: Arrival;
  serviceId: string;
  date: string;
  arrivalWindowId: string;
  contactName: string;
  contactEmail?: string;
  contactPhone?: string;
  addressLine1: string;
  city: string;
  state: string;
  postalCode: string;
  notes?: string;
}): Promise<
  | { ok: true; trackingUrl: string }
  | { ok: false; message: string; retry: boolean }
> {
  try {
    const result = await booking.createRequest(getDb(), {
      organizationSlug: input.slug,
      bookableServiceId: input.serviceId,
      requestedDate: input.date,
      arrivalWindowId: input.arrivalWindowId,
      contactName: input.contactName,
      ...(input.contactEmail ? { contactEmail: input.contactEmail } : {}),
      ...(input.contactPhone ? { contactPhone: input.contactPhone } : {}),
      addressLine1: input.addressLine1,
      city: input.city,
      state: input.state,
      postalCode: input.postalCode,
      ...(input.notes ? { notes: input.notes } : {}),
      intakeAnswers: {},
      utm: utmOf(input.arrival?.landingQuery),
      ...(clip(input.arrival?.landingQuery, 4000) ? { landingQuery: clip(input.arrival?.landingQuery, 4000)! } : {}),
      ...(clip(input.arrival?.referrer, 2000) ? { referrer: clip(input.arrival?.referrer, 2000)! } : {}),
      ...(clip(input.arrival?.sourceUrl, 2000) ? { sourceUrl: clip(input.arrival?.sourceUrl, 2000)! } : {}),
      ...(clip(input.arrival?.visitorId, 200) ? { visitorId: clip(input.arrival?.visitorId, 200)! } : {}),
    });
    return { ok: true, trackingUrl: result.trackingUrl };
  } catch (error) {
    /**
     * The slot going in the gap between rendering and submitting is the
     * expected failure, not an exceptional one, and it is recoverable: send
     * the person back to the times rather than to an error page.
     */
    if (error instanceof ConflictError) {
      return { ok: false, message: error.message, retry: true };
    }
    // The demo company's booking page books nothing, and says so.
    if (error instanceof Error && error.name === "DemoReadOnlyError") {
      return { ok: false, message: error.message, retry: false };
    }
    return {
      ok: false,
      message: "Something went wrong booking that. Please give us a call.",
      retry: false,
    };
  }
}
