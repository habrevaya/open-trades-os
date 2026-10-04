import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { loadSession } from "./session";
import { fieldClientFor } from "./field";
import { sessionExpired } from "../lib/session";
import { fixFrom, type DeviceLocation, type LocationPermission } from "../lib/location";

/**
 * TAKING FIXES WHILE THE PERSON WORKS
 *
 * The operating system's location updates, started when the field client
 * says the phone should be sharing (clocked in, on the way to a visit or
 * working one, with the company and this person both on) and stopped the
 * moment it says otherwise. Between those, fixes arrive here, in the
 * background too, and wait in the position buffer for the next sync.
 *
 * Android shows its own notice for as long as this runs ("Sharing your
 * location"), and iOS shows the blue location indicator, so the person can
 * see it from any screen, not only from this app's. Neither can be turned
 * off from here, and that is intended.
 */
export const LOCATION_TASK = "opentradesos-field-location";

TaskManager.defineTask(LOCATION_TASK, async ({ data, error }) => {
  if (error) return;
  const locations = (data as { locations?: DeviceLocation[] } | undefined)?.locations ?? [];
  if (locations.length === 0) return;
  const session = await loadSession();
  if (!session || sessionExpired(session)) return;
  const client = await fieldClientFor(session);
  /** Checked again here: a fix that arrives after sharing stopped is not kept. */
  const view = await client.engine.view();
  if (!view.location.state.sharing) return;
  for (const location of locations) {
    const fix = fixFrom(location);
    if (fix) await client.positions.record(fix);
  }
});

export async function locationPermission(ask: boolean): Promise<LocationPermission> {
  try {
    let foreground = await Location.getForegroundPermissionsAsync();
    if (!foreground.granted && foreground.canAskAgain && ask) foreground = await Location.requestForegroundPermissionsAsync();
    if (!foreground.granted) return foreground.canAskAgain ? "undetermined" : "denied";
    let background = await Location.getBackgroundPermissionsAsync();
    if (!background.granted && background.canAskAgain && ask) background = await Location.requestBackgroundPermissionsAsync();
    return background.granted ? "always" : "while_open";
  } catch {
    return "denied";
  }
}

export async function startSharing(intervalSeconds: number): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) return;
    await Location.startLocationUpdatesAsync(LOCATION_TASK, {
      accuracy: Location.Accuracy.Balanced,
      timeInterval: intervalSeconds * 1000,
      distanceInterval: 50,
      pausesUpdatesAutomatically: true,
      activityType: Location.LocationActivityType.AutomotiveNavigation,
      showsBackgroundLocationIndicator: true,
      foregroundService: {
        notificationTitle: "Sharing your location",
        notificationBody: "While you are clocked in or on a visit. It stops when you clock out.",
        killServiceOnDestroy: true,
      },
    });
  } catch {
    // No permission, or a phone that cannot. The day screen says which.
  }
}

export async function stopSharing(): Promise<void> {
  try {
    if (await Location.hasStartedLocationUpdatesAsync(LOCATION_TASK)) await Location.stopLocationUpdatesAsync(LOCATION_TASK);
  } catch {
    // Not running is the outcome wanted.
  }
}
