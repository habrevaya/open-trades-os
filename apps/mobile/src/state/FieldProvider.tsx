import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from "react";
import { AppState, Platform } from "react-native";
import Constants from "expo-constants";
import * as Crypto from "expo-crypto";
import * as ImagePicker from "expo-image-picker";
import * as Network from "expo-network";
import type { Problem, SyncEngine, SyncReport } from "@opentradesos/field-client";
import type { Session } from "../lib/session";
import { sessionExpired } from "../lib/session";
import { signInPhone, type SignInOutcome } from "../lib/sign-in";
import { extensionFor, pngFromDataUrl } from "../lib/bytes";
import { clearSession, installationId, loadSession, saveSession } from "../platform/session";
import { fieldClientFor, forgetFieldClients, type FieldClient } from "../platform/field";
import { keepPhoto, keepSignature } from "../platform/files";
import { startBackgroundSync, stopBackgroundSync } from "../platform/background";

/**
 * THE PHONE'S STATE, IN ONE PLACE
 *
 * Every write goes the same way: into the queue on the phone first, then the
 * screen is redrawn from the queue, then a send is attempted. The screen
 * never waits for the network to show what the technician did, and nothing
 * the technician did exists only in memory.
 *
 * Sends happen after every tap, every half minute while the app is open
 * (unless the queue is backing off), when the app comes back to the front,
 * when the phone gets a connection back, and from the background task.
 */

type View = Awaited<ReturnType<SyncEngine["view"]>>;
type RecordKind = Parameters<FieldClient["queue"]["enqueue"]>[0]["kind"];

interface FieldState {
  status: "loading" | "signed-out" | "ready";
  session: Session | null;
  view: View | null;
  syncing: boolean;
  report: SyncReport | null;
  /** The token stopped working with work still on the phone. */
  signInEnded: boolean;
  signIn(input: { server: string; email: string; password: string }): Promise<SignInOutcome>;
  signOut(): Promise<void>;
  sync(): Promise<void>;
  record(kind: RecordKind, visitId?: string, payload?: Record<string, unknown>): Promise<void>;
  takePhoto(visitId: string): Promise<string | null>;
  saveSignature(visitId: string, dataUrl: string, signedBy: string): Promise<string | null>;
  resolve(problem: Problem, choice: "acknowledge" | "retry" | "discard"): Promise<void>;
  onMyWay(visitId: string, etaMinutes: number): Promise<string>;
}

const Context = createContext<FieldState | null>(null);

export function useField(): FieldState {
  const value = useContext(Context);
  if (!value) throw new Error("useField outside FieldProvider");
  return value;
}

export function FieldProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<FieldState["status"]>("loading");
  const [session, setSession] = useState<Session | null>(null);
  const [client, setClient] = useState<FieldClient | null>(null);
  const [view, setView] = useState<View | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [signInEnded, setSignInEnded] = useState(false);
  const clientRef = useRef<FieldClient | null>(null);
  clientRef.current = client;

  const refreshView = useCallback(async (c: FieldClient | null = clientRef.current) => {
    if (c) setView(await c.engine.view());
  }, []);

  const sync = useCallback(async (force = true) => {
    const c = clientRef.current;
    if (!c) return;
    setSyncing(true);
    await refreshView(c);
    try {
      const result = await c.engine.run({ force });
      if (result.ran) setReport(result);
      if (result.signedOut) setSignInEnded(true);
    } catch {
      // The engine reports rather than throws. Anything here is a bug, and
      // the work is still on the phone either way.
    } finally {
      setSyncing(false);
      await refreshView(c);
    }
  }, [refreshView]);

  const open = useCallback(async (s: Session, lastSequence?: number) => {
    const c = await fieldClientFor(s);
    if (lastSequence !== undefined) await c.queue.adoptSequence(lastSequence);
    setSession(s);
    setClient(c);
    clientRef.current = c;
    setSignInEnded(sessionExpired(s));
    setStatus("ready");
    await refreshView(c);
    void startBackgroundSync();
    void sync(true);
  }, [refreshView, sync]);

  // Launch: open whoever was signed in, with no network needed.
  useEffect(() => {
    void (async () => {
      const saved = await loadSession();
      if (saved) await open(saved);
      else setStatus("signed-out");
    })();
  }, [open]);

  // The half minute timer, the app coming forward, and the signal coming back.
  useEffect(() => {
    if (status !== "ready") return;
    const timer = setInterval(() => void sync(false), 30_000);
    const app = AppState.addEventListener("change", (state) => {
      if (state === "active") void sync(true);
    });
    const network = Network.addNetworkStateListener((state) => {
      if (state.isInternetReachable ?? state.isConnected) void sync(true);
    });
    return () => { clearInterval(timer); app.remove(); network.remove(); };
  }, [status, sync]);

  const signIn = useCallback<FieldState["signIn"]>(async (input) => {
    const outcome = await signInPhone(input, {
      installation: await installationId(),
      platform: Platform.OS === "ios" ? "ios" : "android",
      label: Platform.OS === "ios" ? "iPhone app" : "Android app",
      appVersion: Constants.expoConfig?.version,
      osVersion: String(Platform.Version),
    });
    if (outcome.ok) {
      await saveSession(outcome.session);
      await open(outcome.session, outcome.lastSequence);
    }
    return outcome;
  }, [open]);

  const signOut = useCallback(async () => {
    const c = clientRef.current;
    if (c) {
      // Best effort. Signed out on the server or not, the token leaves this phone.
      try { await c.api.signOut(c.session.deviceId); } catch { /* ended anyway, or later */ }
    }
    await stopBackgroundSync();
    await clearSession();
    forgetFieldClients();
    setClient(null);
    clientRef.current = null;
    setSession(null);
    setView(null);
    setReport(null);
    setSignInEnded(false);
    setStatus("signed-out");
  }, []);

  const record = useCallback<FieldState["record"]>(async (kind, visitId, payload) => {
    const c = clientRef.current;
    if (!c) return;
    await c.queue.enqueue({
      kind,
      ...(visitId ? { subjectId: visitId } : {}),
      ...(payload ? { payload } : {}),
    });
    await refreshView(c);
    void sync(true);
  }, [refreshView, sync]);

  const takePhoto = useCallback<FieldState["takePhoto"]>(async (visitId) => {
    const c = clientRef.current;
    if (!c) return null;
    const permission = await ImagePicker.requestCameraPermissionsAsync();
    if (!permission.granted) {
      return "The camera is turned off for this app. Turn it on in the phone's settings to take photos.";
    }
    const shot = await ImagePicker.launchCameraAsync({ mediaTypes: ["images"], quality: 0.6, exif: false });
    const asset = shot.canceled ? null : shot.assets[0];
    if (!asset) return null;

    const uploadId = Crypto.randomUUID();
    const { extension, contentType } = extensionFor(asset.mimeType);
    const kept = await keepPhoto(asset.uri, uploadId, extension);
    await c.uploads.add({ uploadId, visitId, kind: "photo", contentType, ...kept });
    await refreshView(c);
    void sync(true);
    return null;
  }, [refreshView, sync]);

  const saveSignature = useCallback<FieldState["saveSignature"]>(async (visitId, dataUrl, signedBy) => {
    const c = clientRef.current;
    if (!c) return "Not signed in.";
    const png = pngFromDataUrl(dataUrl);
    if (!png) return "The signature could not be saved. Ask them to sign again.";
    const uploadId = Crypto.randomUUID();
    const kept = await keepSignature(png, uploadId);
    await c.uploads.add({
      uploadId, visitId, kind: "signature", contentType: "image/png", ...kept,
      caption: signedBy.trim() ? `Signed by ${signedBy.trim()}` : undefined,
    });
    await refreshView(c);
    void sync(true);
    return null;
  }, [refreshView, sync]);

  const resolve = useCallback<FieldState["resolve"]>(async (problem, choice) => {
    const c = clientRef.current;
    if (!c) return;
    if (problem.source === "upload") {
      await c.uploads.dismiss(problem.id);
    } else if (choice === "retry") {
      await c.queue.retry(problem.id);
    } else {
      await c.queue.dismiss(problem.id);
    }
    await refreshView(c);
    if (choice === "retry") void sync(true);
  }, [refreshView, sync]);

  /**
   * The text to the customer is sent now or not at all. Queued for later it
   * would reach them as "about 20 minutes away" an hour after it was true.
   */
  const onMyWay = useCallback<FieldState["onMyWay"]>(async (visitId, etaMinutes) => {
    const c = clientRef.current;
    if (!c) return "Not signed in.";
    try {
      const result = await c.api.onMyWay(visitId, etaMinutes, Crypto.randomUUID());
      if (result.sent) return `Texted: about ${etaMinutes} minutes away.`;
      return result.reason ?? "Not sent.";
    } catch (error) {
      const offline = typeof error === "object" && error !== null && (error as { offline?: unknown }).offline === true;
      return offline
        ? "No signal, so the customer was not texted. Call them if you can."
        : error instanceof Error ? error.message : "Not sent.";
    }
  }, []);

  const value = useMemo<FieldState>(() => ({
    status, session, view, syncing, report, signInEnded,
    signIn, signOut, sync: () => sync(true), record, takePhoto, saveSignature, resolve, onMyWay,
  }), [status, session, view, syncing, report, signInEnded, signIn, signOut, sync, record, takePhoto, saveSignature, resolve, onMyWay]);

  return <Context.Provider value={value}>{children}</Context.Provider>;
}
