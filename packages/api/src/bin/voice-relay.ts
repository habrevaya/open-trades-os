/**
 * THE VOICE RELAY PROCESS
 *
 * Holds the phone assistant's conversations: one WebSocket per call, opened by
 * the carrier at VOICE_RELAY_URL. Runs beside the web app and the worker, for
 * the same reason the worker is separate: the web app answers requests and is
 * done, and a call is a conversation that stays open.
 *
 *   pnpm --filter @opentradesos/api voice-relay
 *
 * It needs DATABASE_URL (the same role as the web app: it reads and writes the
 * way a carrier webhook does), VOICE_RELAY_URL (the public `wss://` address
 * the carrier is given, which the carrier's signature is checked against),
 * and the secrets the Twilio and model connections name, in its own
 * environment. VOICE_RELAY_PORT is where it listens, 3300 when unset; put it
 * behind whatever terminates TLS for the web app.
 */
import { createClient } from "@opentradesos/db";
import "../voice/index";
import "../ai/index";
import { startVoiceRelay } from "../voice/relay-server";

// `||`, not `??`, as in the worker: an env file line with nothing after it means unset.
const url = process.env["DATABASE_URL"];
const publicBase = process.env["VOICE_RELAY_URL"] || "";
if (!url) {
  console.error("Set DATABASE_URL.");
  process.exit(1);
}
if (!/^wss?:\/\//.test(publicBase)) {
  console.error("Set VOICE_RELAY_URL to the public address the carrier reaches this relay on, like wss://relay.example.com.");
  process.exit(1);
}

const db = createClient(url);
const relay = await startVoiceRelay({
  db,
  publicBase,
  port: Number(process.env["VOICE_RELAY_PORT"] || 3300),
});

/**
 * Stop taking calls, then close. A call already in a conversation is cut off
 * by a restart, and the carrier's next step puts that caller through to a
 * person rather than leaving them with silence.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.on(signal, () => {
    console.info(`[voice-relay] ${signal}, closing ${relay.open()} conversation(s)`);
    void relay.close().then(() => db.$close()).then(() => process.exit(0));
  });
}
