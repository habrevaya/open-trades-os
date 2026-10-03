import { Platform } from "react-native";
import Constants from "expo-constants";
import * as Notifications from "expo-notifications";
import { CHANNELS, projectIdFrom, visitFromNotice, type PushState } from "../lib/push";

/**
 * NOTICES FROM THE OFFICE
 *
 * The office moves somebody's day and the server pushes a notice through
 * Expo to this phone. This module asks the person for permission, makes the
 * two Android channels the server sends to, gets the Expo push token the
 * phone registers with, and opens the visit a tapped notice is about.
 *
 * A notice that arrives while the app is open is still shown, as a banner,
 * because the technician may be looking at the very visit that was cancelled.
 * It plays its sound only if it was sent with one: a quiet notice from inside
 * the company's quiet hours arrives without.
 */
Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

/**
 * A push token, or the reason there is none. Asks for permission once; a
 * person who said no is not asked again on every launch, which the operating
 * system would refuse anyway.
 */
export async function pushToken(): Promise<{ token: string } | { state: PushState }> {
  try {
    if (Platform.OS === "android") {
      for (const channel of CHANNELS) {
        await Notifications.setNotificationChannelAsync(channel.id, {
          name: channel.name,
          importance: channel.sound ? Notifications.AndroidImportance.HIGH : Notifications.AndroidImportance.LOW,
          sound: channel.sound ? "default" : null,
          enableVibrate: channel.sound,
        });
      }
    }

    let permission = await Notifications.getPermissionsAsync();
    if (!permission.granted && permission.canAskAgain) permission = await Notifications.requestPermissionsAsync();
    if (!permission.granted) return { state: "denied" };

    const projectId = projectIdFrom(Constants);
    if (!projectId) return { state: "unavailable" };
    const token = await Notifications.getExpoPushTokenAsync({ projectId });
    return { token: token.data };
  } catch {
    // A simulator, or no network to Expo. The day still syncs; it just is not pushed.
    return { state: "unavailable" };
  }
}

/** Open the visit a tapped notice is about, including the one that launched the app. */
export function onNoticeTapped(open: (visitId: string) => void): () => void {
  const subscription = Notifications.addNotificationResponseReceivedListener((response) => {
    const visitId = visitFromNotice(response.notification.request.content.data);
    if (visitId) open(visitId);
  });
  void Notifications.getLastNotificationResponseAsync().then((response) => {
    const visitId = response ? visitFromNotice(response.notification.request.content.data) : null;
    if (visitId) open(visitId);
  }).catch(() => undefined);
  return () => subscription.remove();
}
