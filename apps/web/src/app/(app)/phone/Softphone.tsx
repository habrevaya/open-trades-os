"use client";

import { useEffect, useRef, useState } from "react";
import type { Call, Device } from "@twilio/voice-sdk";

/**
 * THE PHONE, IN THE BROWSER
 *
 * The carrier's own browser library does the audio. This is the few controls
 * around it: switch it on (which asks the server for a pass and loads the
 * library, and not before), take calls here or stop, dial, answer, mute, the
 * keypad for a phone menu on the other end, and hang up.
 *
 * "Take calls here" is a promise to the ring groups, so it is kept honestly:
 * it tells the server once a minute while it is on, it says off when it is
 * switched off, and a browser that stops saying anything stops being rung
 * within a couple of minutes, so a laptop shut at five does not swallow the
 * first call of the morning.
 */

type Props = {
  callerId: string;
  takingCalls: boolean;
  getToken: () => Promise<{ token: string; identity: string } | { problem: string }>;
  setTakingCalls: (available: boolean) => Promise<{ takingCalls: boolean }>;
};

type Line =
  | { state: "idle" }
  | { state: "ringing"; from: string }
  | { state: "calling"; to: string }
  | { state: "talking"; with: string; since: number };

const HEARTBEAT_MS = 60_000;
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "*", "0", "#"];
const BUTTON = "inline-flex h-10 items-center justify-center rounded px-4 text-sm font-medium disabled:opacity-60";

export function Softphone({ callerId, takingCalls: initiallyTaking, getToken, setTakingCalls }: Props) {
  const device = useRef<Device | null>(null);
  const call = useRef<Call | null>(null);
  const [on, setOn] = useState(false);
  const [starting, setStarting] = useState(false);
  const [taking, setTaking] = useState(false);
  const [line, setLine] = useState<Line>({ state: "idle" });
  const [muted, setMuted] = useState(false);
  const [number, setNumber] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const [now, setNow] = useState(Date.now());

  /** The talk timer, ticking only while somebody is on a call. */
  useEffect(() => {
    if (line.state !== "talking") return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [line.state]);

  /** While taking calls, say so every minute; the server forgets a browser that stops. */
  useEffect(() => {
    if (!taking) return;
    const timer = setInterval(() => { void setTakingCalls(true).catch(() => {}); }, HEARTBEAT_MS);
    return () => clearInterval(timer);
  }, [taking, setTakingCalls]);

  /** Leaving the page mid call ends the call, so the browser asks first. */
  useEffect(() => {
    if (line.state === "idle" && !taking) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [line.state, taking]);

  /** Off when the page goes, as best the browser allows; the server's own clock is the backstop. */
  useEffect(() => () => {
    device.current?.destroy();
    device.current = null;
  }, []);

  function follow(active: Call, other: string) {
    call.current = active;
    setMuted(false);
    active.on("accept", () => setLine({ state: "talking", with: other, since: Date.now() }));
    const done = () => {
      call.current = null;
      setLine({ state: "idle" });
    };
    active.on("disconnect", done);
    active.on("cancel", done);
    active.on("reject", done);
    active.on("error", (error: { message?: string }) => {
      setProblem(error.message ?? "The call failed.");
      done();
    });
  }

  async function switchOn(): Promise<Device | null> {
    if (device.current) return device.current;
    setStarting(true);
    setProblem(null);
    try {
      const pass = await getToken();
      if ("problem" in pass) {
        setProblem(pass.problem);
        return null;
      }
      const { Device: TwilioDevice } = await import("@twilio/voice-sdk");
      const made = new TwilioDevice(pass.token, { closeProtection: true });
      made.on("error", (error: { message?: string }) => setProblem(error.message ?? "The phone had a problem."));
      made.on("tokenWillExpire", () => {
        void getToken().then((fresh) => { if (!("problem" in fresh)) made.updateToken(fresh.token); });
      });
      made.on("incoming", (incoming: Call) => {
        if (call.current) {
          incoming.reject();
          return;
        }
        const from = incoming.parameters["From"] ?? "A caller";
        setLine({ state: "ringing", from });
        follow(incoming, from);
      });
      device.current = made;
      setOn(true);
      if (initiallyTaking) await startTaking(made);
      return made;
    } catch (error) {
      setProblem(error instanceof Error ? error.message : "The phone could not be switched on.");
      return null;
    } finally {
      setStarting(false);
    }
  }

  async function startTaking(using?: Device) {
    const phone = using ?? device.current ?? await switchOn();
    if (!phone) return;
    await phone.register();
    await setTakingCalls(true);
    setTaking(true);
  }

  async function stopTaking() {
    await device.current?.unregister().catch(() => {});
    await setTakingCalls(false);
    setTaking(false);
  }

  async function dial() {
    const to = number.trim();
    if (!to) return;
    const phone = device.current ?? await switchOn();
    if (!phone) return;
    setProblem(null);
    const placed = await phone.connect({ params: { To: to } });
    setLine({ state: "calling", to });
    follow(placed, to);
  }

  const talkedFor = line.state === "talking" ? Math.max(0, Math.floor((now - line.since) / 1000)) : 0;

  return (
    <section aria-label="Phone" className="mt-6 max-w-md rounded-md border border-steel-200 p-4">
      <p className="text-sm text-ink-700">Calls you make show {callerId}.</p>

      {!on ? (
        <button type="button" onClick={() => void switchOn()} disabled={starting}
                className={`${BUTTON} mt-3 bg-ink-900 text-white hover:bg-ink-700`}>
          {starting ? "Switching on" : "Switch on the phone"}
        </button>
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={taking}
                   onChange={(event) => void (event.target.checked ? startTaking() : stopTaking())} />
            Take calls here
          </label>
          <span className="text-xs text-ink-500">
            {taking ? "Your ring groups ring this browser instead of your phone." : "Your ring groups ring your phone."}
          </span>
        </div>
      )}

      {line.state === "ringing" ? (
        <div className="mt-4 rounded border border-steel-300 bg-steel-100 p-3" role="status">
          <p className="text-sm font-medium">Call from {line.from}</p>
          <div className="mt-2 flex gap-2">
            <button type="button" className={`${BUTTON} bg-ink-900 text-white`} onClick={() => call.current?.accept()}>Answer</button>
            <button type="button" className={`${BUTTON} border border-steel-300`} onClick={() => call.current?.reject()}>Decline</button>
          </div>
        </div>
      ) : null}

      {line.state === "calling" || line.state === "talking" ? (
        <div className="mt-4 rounded border border-steel-300 p-3" role="status">
          <p className="text-sm font-medium">
            {line.state === "calling" ? `Calling ${line.to}` : `On a call with ${line.with}, ${Math.floor(talkedFor / 60)}:${String(talkedFor % 60).padStart(2, "0")}`}
          </p>
          <div className="mt-2 grid w-48 grid-cols-3 gap-1">
            {KEYS.map((key) => (
              <button key={key} type="button" aria-label={`Press ${key}`}
                      className="h-9 rounded border border-steel-300 text-sm"
                      onClick={() => call.current?.sendDigits(key)}>{key}</button>
            ))}
          </div>
          <div className="mt-2 flex gap-2">
            <button type="button" className={`${BUTTON} border border-steel-300`}
                    onClick={() => { const next = !muted; call.current?.mute(next); setMuted(next); }}>
              {muted ? "Unmute" : "Mute"}
            </button>
            <button type="button" className={`${BUTTON} border border-red-600 text-red-600`}
                    onClick={() => call.current?.disconnect()}>Hang up</button>
          </div>
        </div>
      ) : null}

      {line.state === "idle" ? (
        <form className="mt-4 flex flex-wrap items-end gap-2" onSubmit={(event) => { event.preventDefault(); void dial(); }}>
          <label className="block">
            <span className="text-sm font-medium text-ink-700">Number to call</span>
            <input value={number} onChange={(event) => setNumber(event.target.value)} inputMode="tel"
                   placeholder="(512) 555-0147" className="mt-1 block h-10 w-52 rounded border border-steel-300 bg-canvas px-2 text-sm" />
          </label>
          <button type="submit" className={`${BUTTON} bg-ink-900 text-white hover:bg-ink-700`} disabled={starting}>Call</button>
        </form>
      ) : null}

      {problem ? <p role="alert" className="mt-3 text-sm text-red-600">{problem}</p> : null}
    </section>
  );
}
