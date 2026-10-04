import { time } from "@opentradesos/core";

/**
 * A datetime-local box as an instant.
 *
 * The browser sends the wall clock with no zone, and the person typed it in
 * the company's day, so it is read in the company's timezone through core's
 * own conversion, which knows what to do with the hour the clocks skip and the
 * hour they repeat. Null for an empty or unreadable box.
 */
export function instantFromLocal(raw: string | undefined | null, zone: string): string | null {
  if (!raw) return null;
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})/.exec(raw);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return time.instantOfLocal(match[1]!, minutes, zone).toISOString();
}

/** A file from a form as the base64 the services take, or null for an empty input. */
export async function fileAsBase64(value: FormDataEntryValue | null): Promise<{ fileName: string; contentType: string; bytes: string } | null> {
  if (!value || typeof value === "string" || value.size === 0) return null;
  return {
    fileName: value.name || "photo",
    contentType: value.type || "application/octet-stream",
    bytes: Buffer.from(await value.arrayBuffer()).toString("base64"),
  };
}
