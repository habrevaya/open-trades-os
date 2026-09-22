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

export async function submitBooking(input: {
  slug: string;
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
      utm: {},
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
    return {
      ok: false,
      message: "Something went wrong booking that. Please give us a call.",
      retry: false,
    };
  }
}
