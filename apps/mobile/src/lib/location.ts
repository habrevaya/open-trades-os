import type { PositionFix, SharingState } from "@opentradesos/field-client";

/**
 * LOCATION, WITHOUT THE PHONE
 *
 * The decisions the location code makes, kept out of the module that talks
 * to the operating system so they are tested in Node: when the phone should
 * be asking for fixes, what one fix becomes on the wire, and the line the
 * day screen shows. The rule itself (only on the clock or on a visit, only
 * when the company and this person have it on) is core's, through the field
 * client's `sharingFor`.
 */

export type LocationPermission = "always" | "while_open" | "denied" | "undetermined";

/** Whether the operating system should be delivering fixes right now. */
export function shouldTrack(sharing: SharingState | null | undefined, permission: LocationPermission): boolean {
  return Boolean(sharing?.state.sharing) && (permission === "always" || permission === "while_open");
}

/** What the operating system hands over, in the shape `expo-location` uses. */
export interface DeviceLocation {
  coords: { latitude: number; longitude: number; accuracy: number | null; heading: number | null; speed: number | null };
  timestamp: number;
  mocked?: boolean;
}

/**
 * One fix for the wire, or null for one not worth sending. A mocked location
 * (a developer setting that fakes the GPS) is not sent: it would draw the
 * technician wherever somebody typed. A negative heading or speed is the
 * platform's way of saying it does not know.
 */
export function fixFrom(location: DeviceLocation): PositionFix | null {
  if (location.mocked) return null;
  const { latitude, longitude, accuracy, heading, speed } = location.coords;
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return {
    latitude,
    longitude,
    ...(accuracy !== null && accuracy >= 0 ? { accuracyMeters: Math.round(accuracy) } : {}),
    ...(heading !== null && heading >= 0 ? { heading: Math.round(heading) % 360 } : {}),
    ...(speed !== null && speed >= 0 ? { speed } : {}),
    recordedAt: new Date(location.timestamp).toISOString(),
  };
}

/**
 * The line on the day screen. Always shown when sharing is on, in words, so
 * the person is never located without knowing it; shown when it is off only
 * when it should be on and the phone's permission is what stops it.
 */
export function locationLine(
  sharing: SharingState | null | undefined, permission: LocationPermission,
): { tone: "on" | "off" | "problem"; text: string } | null {
  if (!sharing) return null;
  if (!sharing.state.sharing) {
    return sharing.state.reason === "person_off" || sharing.state.reason === "off_the_clock"
      ? { tone: "off", text: sharing.sentence }
      : null;
  }
  if (permission === "denied") {
    return {
      tone: "problem",
      text: "Your company shares technicians' locations while they work, and this phone's location is turned off for the app. The office cannot see where you are, and your customer's tracking link shows no pin.",
    };
  }
  if (permission === "undetermined") return { tone: "problem", text: "Allow location for this app to share where you are while you work." };
  return {
    tone: "on",
    text: permission === "while_open"
      ? `${sharing.sentence} Only while the app is open: allow location all the time for it to keep sharing with the screen off.`
      : sharing.sentence,
  };
}
