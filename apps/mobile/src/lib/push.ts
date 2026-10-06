import { PUSH_CHANNELS } from "@opentradesos/field-client";

/**
 * NOTICES ABOUT THE DAY, WITHOUT THE PHONE
 *
 * The decisions the notification code makes, kept out of the module that
 * talks to the operating system so they are tested in Node: which channels
 * the app creates, which visit a tapped notice opens, where the push
 * project id comes from, and what the day screen says when notices are off.
 */

/**
 * The two Android channels, named as the server sends to them. Android lets
 * the person turn each off on its own, which is the right control: somebody
 * can silence the quiet one and still be woken for a job tonight.
 */
export const CHANNELS = [
  { id: PUSH_CHANNELS.normal, name: "Changes to your day", sound: true },
  { id: PUSH_CHANNELS.quiet, name: "Changes to your day, at night", sound: false },
] as const;

export type PushState = "on" | "off" | "denied" | "unavailable";

/** The visit a tapped notice is about, or null for anything that is not one of ours. */
export function visitFromNotice(data: unknown): string | null {
  if (typeof data !== "object" || data === null) return null;
  const visitId = (data as { visitId?: unknown }).visitId;
  return typeof visitId === "string" && /^[0-9a-f-]{36}$/i.test(visitId) ? visitId : null;
}

/**
 * The Expo project a push token is issued for. EAS writes it into the app's
 * config when a company runs `eas init`; a build that never did has none,
 * and Expo will not issue a token without one.
 */
export function projectIdFrom(constants: {
  expoConfig?: { extra?: { eas?: { projectId?: unknown } } } | null;
  easConfig?: { projectId?: unknown } | null;
}): string | null {
  const id = constants.expoConfig?.extra?.eas?.projectId ?? constants.easConfig?.projectId;
  return typeof id === "string" && id.trim() !== "" ? id : null;
}

/** What the day screen says about notices, or null when they are on and nothing needs saying. */
export function pushLine(state: PushState): string | null {
  switch (state) {
    case "denied":
      return "Notices are turned off for this app, so you will not hear when the office changes your day. Turn them on in the phone's settings.";
    case "unavailable":
      return "This copy of the app cannot get notices. Ask whoever built it to set up push notifications.";
    default:
      return null;
  }
}
