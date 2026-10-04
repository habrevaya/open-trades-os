/**
 * WHAT THE CARRIER AND THE PHONE ASSISTANT SAY TO EACH OTHER
 *
 * Twilio's ConversationRelay holds the call. It turns the caller's speech into
 * text and sends it over a WebSocket, and reads aloud whatever text comes back.
 * This file is that conversation's vocabulary and nothing else: the messages
 * the carrier sends, read defensively, and the three this product sends back.
 *
 * Read defensively because a WebSocket message is a body somebody wrote. The
 * handshake was signed by the carrier, but a field this code has never seen
 * is ignored rather than trusted, and a message that is not one of the shapes
 * below is dropped with nothing done.
 */

export type RelayInbound =
  /** The first message: which call this is. */
  | { type: "setup"; callSid: string; sessionId: string; from: string | null; to: string | null }
  /** Words the caller said. `last` is false only for partial results, which are not asked for. */
  | { type: "prompt"; text: string; last: boolean }
  | { type: "dtmf"; digit: string }
  /** The caller talked over the assistant; `heard` is how far it had got. */
  | { type: "interrupt"; heard: string }
  | { type: "error"; description: string };

const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

/** A message from the carrier, or null for anything that is not one. */
export function parseRelay(raw: string): RelayInbound | null {
  if (raw.length > 64_000) return null;
  let message: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    message = parsed as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (message["type"]) {
    case "setup": {
      const callSid = str(message["callSid"]);
      if (!callSid) return null;
      return {
        type: "setup", callSid, sessionId: str(message["sessionId"]) ?? "",
        from: str(message["from"]), to: str(message["to"]),
      };
    }
    case "prompt":
      return { type: "prompt", text: (str(message["voicePrompt"]) ?? "").slice(0, 4000), last: message["last"] !== false };
    case "dtmf": {
      const digit = str(message["digit"]);
      return digit && /^[0-9*#]$/.test(digit) ? { type: "dtmf", digit } : null;
    }
    case "interrupt":
      return { type: "interrupt", heard: (str(message["utteranceUntilInterrupt"]) ?? "").slice(0, 4000) };
    case "error":
      return { type: "error", description: (str(message["description"]) ?? "").slice(0, 500) };
    default:
      return null;
  }
}

/** Words for the carrier to read aloud, as one complete piece. */
export const relayText = (text: string): string => JSON.stringify({ type: "text", token: text, last: true });

/**
 * End the conversation. The carrier then asks the call's next step what to
 * do, which is where the caller is put through or said goodbye to: the
 * decision is on the assistant's session, so nothing the carrier hands back
 * here is trusted for it.
 */
export const relayEnd = (reason: string): string =>
  JSON.stringify({ type: "end", handoffData: JSON.stringify({ reason }) });

/** Where the carrier opens the conversation for one call. */
export function relayUrl(relayBase: string, webhookToken: string, sessionToken: string): string {
  return `${relayBase.replace(/\/$/, "")}/voice-relay/${webhookToken}?s=${encodeURIComponent(sessionToken)}`;
}

/** The two tokens out of a relay address's path and query, or null. */
export function relayTokens(pathAndQuery: string): { webhookToken: string; sessionToken: string } | null {
  let parsed: URL;
  try {
    parsed = new URL(pathAndQuery, "http://relay.invalid");
  } catch {
    return null;
  }
  const match = /^\/voice-relay\/([A-Za-z0-9_-]{32,128})$/.exec(parsed.pathname);
  const session = parsed.searchParams.get("s");
  if (!match || !session || !/^[A-Za-z0-9_-]{32,128}$/.test(session)) return null;
  return { webhookToken: match[1]!, sessionToken: session };
}
