/**
 * WHAT THE TECHNICIAN IS TOLD WHEN A PUNCH DID NOT TAKE
 *
 * A punch goes into the phone's queue and is sent from there, so the
 * button always "works". When the server then refused it, nothing on the
 * screen said so: a punch the server rejected only reached the banner at the
 * top, and a sync the server refused as a whole (a device the office
 * revoked, an account that is no longer a technician) was retried quietly
 * on a timer and only mentioned after five failed attempts, minutes later,
 * by which time the technician had driven off believing they were on the
 * clock. Paid hours depend on this one, so its answer goes beside the
 * button, in the server's own words, the moment it arrives.
 *
 * Pure, so the rule is tested without a phone. The clock speaks for the
 * punch pressed on this screen, by its sequence, and no other: a punch
 * refused yesterday that is still listed in the queue is not what the button
 * just did, and the banner above already lists it. Gone from the queue means it
 * landed and there is nothing to say; rejected is the server's reason;
 * still waiting after the server answered with a refusal is that refusal.
 * Waiting because there is no signal is not a failure and says nothing here,
 * the "waiting to send" count already says it.
 */
export interface QueuedPunch {
  kind: string;
  sequence: number;
  status: string;
  attempts: number;
  lastError?: string | undefined;
}

export function punchNotice(
  queued: readonly QueuedPunch[], pressed: number | null, serverRefusal: string | null,
): string | null {
  if (pressed === null) return null;
  const punch = queued.find((op) => op.sequence === pressed);
  if (!punch) return null;
  const what = punch.kind === "timeclock.punch_in" ? "Not clocked in" : "Not clocked out";
  if (punch.status === "rejected") return `${what}: ${punch.lastError ?? "the office's system refused it."}`;
  if (serverRefusal && punch.attempts > 0) return `${what} yet: ${serverRefusal}`;
  return null;
}
