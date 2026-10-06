/**
 * "Friday, Oct 2" for a YYYY-MM-DD, read as a calendar date rather than an
 * instant, so it cannot slip a day in a timezone west of the server's.
 */
export function dayHeading(date: string): string {
  return new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "UTC", weekday: "long", month: "short", day: "numeric",
  });
}

/** The minutes a technician can pick for "on my way". Chosen, never assumed. */
export const ETA_CHOICES = [5, 10, 15, 20, 30, 45, 60] as const;

/** The phone number as a dial link, or null when there is nothing to dial. */
export function telUrl(phone: string | null): string | null {
  if (!phone) return null;
  const digits = phone.replace(/[^\d+]/g, "");
  return digits.length >= 7 ? `tel:${digits}` : null;
}

/** What the photo section says, counting only what was taken on this phone. */
export function photoSummary(photos: { waiting: number; sent: number; failed: number }): string {
  const parts: string[] = [];
  if (photos.sent > 0) parts.push(`${photos.sent} sent`);
  if (photos.waiting > 0) parts.push(`${photos.waiting} waiting to send`);
  if (photos.failed > 0) parts.push(`${photos.failed} could not be sent`);
  return parts.length > 0 ? `Taken on this phone: ${parts.join(", ")}.` : "No photos taken on this phone yet.";
}
