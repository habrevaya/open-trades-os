import * as BackgroundTask from "expo-background-task";
import * as TaskManager from "expo-task-manager";
import { loadSession } from "./session";
import { fieldClientFor } from "./field";
import { sessionExpired } from "../lib/session";

/**
 * SENDING THE QUEUE WITH THE APP CLOSED
 *
 * The operating system decides when this runs: Android's WorkManager at an
 * interval no shorter than fifteen minutes, iOS's background tasks when it
 * judges the phone idle and charged enough, which can be hours. So it is a
 * backstop, not the main path. The main path is the app sending the moment
 * something is tapped and again whenever the connection comes back.
 *
 * It does exactly what the screen's sync does, through the same engine and
 * the same database, and does nothing at all when nobody is signed in.
 */
export const SYNC_TASK = "opentradesos-field-sync";

TaskManager.defineTask(SYNC_TASK, async () => {
  try {
    const session = await loadSession();
    if (!session || sessionExpired(session)) return BackgroundTask.BackgroundTaskResult.Success;
    const client = await fieldClientFor(session);
    const report = await client.engine.run({ force: true });
    return report.error === null ? BackgroundTask.BackgroundTaskResult.Success : BackgroundTask.BackgroundTaskResult.Failed;
  } catch {
    return BackgroundTask.BackgroundTaskResult.Failed;
  }
});

export async function startBackgroundSync(): Promise<void> {
  try {
    const status = await BackgroundTask.getStatusAsync();
    if (status !== BackgroundTask.BackgroundTaskStatus.Available) return;
    if (!(await TaskManager.isTaskRegisteredAsync(SYNC_TASK))) {
      await BackgroundTask.registerTaskAsync(SYNC_TASK, { minimumInterval: 15 });
    }
  } catch {
    // Background sync is a backstop. Without it the app still sends while open.
  }
}

export async function stopBackgroundSync(): Promise<void> {
  try {
    if (await TaskManager.isTaskRegisteredAsync(SYNC_TASK)) await BackgroundTask.unregisterTaskAsync(SYNC_TASK);
  } catch {
    // Nothing registered is the outcome wanted.
  }
}
