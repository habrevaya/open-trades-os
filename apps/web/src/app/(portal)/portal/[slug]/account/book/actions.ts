"use server";

import { redirect } from "next/navigation";
import { getDb } from "@/lib/db";
import { portalBooking } from "@opentradesos/api/services";
import { refusalOf } from "@/lib/actions";
import { requestMeta, requirePortalSession } from "@/lib/portal-session";

/**
 * ASKING FOR A VISIT FROM THE ACCOUNT, bound to the company's slug and read
 * with the sign in cookie on the server, like every other action on these
 * pages. The service checks the property and the technician against the
 * customer the sign in names.
 */

export type AccountSlot = {
  date: string;
  arrivalWindowId: string;
  label: string;
  startsAt: string;
  endsAt: string;
  remaining: number;
};

export async function loadAccountSlots(
  slug: string, input: { serviceId: string; technicianId?: string; propertyId?: string },
): Promise<{ ok: true; slots: AccountSlot[] } | { ok: false; message: string }> {
  const session = await requirePortalSession(slug);
  try {
    const { slots } = await portalBooking.availability(getDb(), {
      token: session.token,
      bookableServiceId: input.serviceId,
      days: 21,
      ...(input.technicianId ? { technicianId: input.technicianId } : {}),
      ...(input.propertyId ? { propertyId: input.propertyId } : {}),
    });
    return { ok: true, slots };
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? "The schedule could not load. Try again in a minute." };
  }
}

export async function bookFromAccount(slug: string, input: {
  serviceId: string;
  propertyId: string;
  date: string;
  arrivalWindowId: string;
  technicianId?: string;
  notes?: string;
  requestKey: string;
}): Promise<{ ok: false; message: string }> {
  const session = await requirePortalSession(slug);
  try {
    await portalBooking.request(getDb(), {
      token: session.token,
      bookableServiceId: input.serviceId,
      propertyId: input.propertyId,
      requestedDate: input.date,
      arrivalWindowId: input.arrivalWindowId,
      ...(input.technicianId ? { technicianId: input.technicianId } : {}),
      ...(input.notes?.trim() ? { notes: input.notes.trim() } : {}),
    }, { ...(await requestMeta()), idempotencyKey: input.requestKey });
  } catch (error) {
    return { ok: false, message: refusalOf(error) ?? "That could not be sent. Try again, or contact us." };
  }
  redirect(`/portal/${encodeURIComponent(slug)}/account?asked=1`);
}
