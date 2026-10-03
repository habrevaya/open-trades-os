import * as Crypto from "expo-crypto";
import {
  FieldApi, FieldQueue, SyncEngine, UploadQueue, isOffline,
} from "@opentradesos/field-client";
import type { Session } from "../lib/session";
import { storageFor } from "./storage";
import { uploadFiles } from "./files";

/**
 * Everything the phone needs to work, built from a session.
 *
 * The screens and the background task both come through here, so they share
 * one definition of the queue, the transport and the day, and the two
 * cannot come to disagree about where the work is kept.
 */
export interface FieldClient {
  session: Session;
  api: FieldApi;
  queue: FieldQueue;
  uploads: UploadQueue;
  engine: SyncEngine;
}

const clients = new Map<string, Promise<FieldClient>>();

export function fieldClientFor(session: Session): Promise<FieldClient> {
  const key = `${session.userId}:${session.deviceId}:${session.token}`;
  let pending = clients.get(key);
  if (!pending) {
    pending = build(session);
    clients.set(key, pending);
  }
  return pending;
}

async function build(session: Session): Promise<FieldClient> {
  const storage = await storageFor(session.userId);
  const api = new FieldApi({ serverUrl: session.serverUrl, token: session.token });
  // The client id is the idempotency key, so it has to be a real UUID: the
  // server's contract says so, and Hermes has no crypto.randomUUID.
  const queue = new FieldQueue({ storage, deviceId: session.deviceId, newId: () => Crypto.randomUUID() });
  const uploads = new UploadQueue({ storage, queue, files: uploadFiles });
  const engine = new SyncEngine({
    queue, uploads, storage,
    transport: api.transport(),
    uploadTransport: {
      owed: async () => (await api.owedUploads(session.deviceId)).map((u) => u.clientId),
      store: (uploadId, base64, caption) => api.storeUpload(uploadId, base64, caption),
      fail: async (uploadId, error) => {
        try {
          await api.failUpload(uploadId, error);
        } catch (cause) {
          if (!isOffline(cause)) throw cause;
        }
      },
    },
    snapshot: (input) => api.snapshot({ deviceId: session.deviceId, ...input }),
    timezone: session.timezone,
  });
  return { session, api, queue, uploads, engine };
}

/** Forget the built client, after signing out, so nothing holds the old token. */
export function forgetFieldClients(): void {
  clients.clear();
}
