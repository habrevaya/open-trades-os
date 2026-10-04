import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket } from "ws";
import type { Database } from "@opentradesos/db";
import * as voice from "../services/voice";
import * as voiceAgent from "../services/voice-agent";
import type { AiDeps } from "../services/ai";
import { DEFAULT_AGENT_DEPS } from "../services/agents";
import { parseRelay, relayEnd, relayText, relayTokens } from "./relay";

/**
 * THE VOICE RELAY
 *
 * The phone assistant's conversations are WebSockets: the carrier
 * (ConversationRelay) opens one per call, sends the caller's words as text,
 * and reads aloud the text sent back. The web app cannot hold one open (a
 * Next.js route handler answers a request and is done), so this is a small
 * server of its own: `pnpm --filter @opentradesos/api voice-relay`, beside the
 * web app and the worker, reached by the carrier at VOICE_RELAY_URL.
 *
 * WHO MAY CONNECT. Only the carrier. The upgrade request carries Twilio's
 * signature over the exact address it was given, made with the account's auth
 * token, and it is checked before the socket is accepted, the same way every
 * voice webhook is checked. The address holds two secrets: the company's
 * webhook token, which says whose account to check the signature against, and
 * a token made for this one call, which says which call it is. A socket that
 * fails any of it is refused at the handshake with nothing said.
 *
 * WHAT IT DOES WITH A MESSAGE. Hands it to `services/voice-agent.ts`, one at a
 * time per call in the order they arrived, so a caller who talks while the
 * assistant is thinking is heard next rather than at the same time. Nothing
 * here decides anything about the call.
 */

export interface RelayOptions {
  db: Database;
  /** The public address the carrier connects to, `wss://` and a host, which the signature is made over. */
  publicBase: string;
  port: number;
  host?: string | undefined;
  voiceDeps?: voice.VoiceDeps | undefined;
  aiDeps?: AiDeps | undefined;
  log?: ((line: string) => void) | undefined;
}

export interface RelayServer {
  /** The port it is listening on, for a server started on port 0. */
  port: number;
  /** Conversations open right now. */
  open(): number;
  close(): Promise<void>;
}

function headersOf(request: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(request.headers)) {
    if (typeof value === "string") out[key.toLowerCase()] = value;
    else if (Array.isArray(value)) out[key.toLowerCase()] = value.join(", ");
  }
  return out;
}

export async function startVoiceRelay(options: RelayOptions): Promise<RelayServer> {
  const log = options.log ?? ((line: string) => console.info(`[voice-relay] ${line}`));
  const base = options.publicBase.replace(/\/$/, "");
  const sockets = new Set<WebSocket>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  const server: Server = createServer((request, response) => {
    /** A plain request is a health check from whatever runs this process, and says nothing else. */
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "text/plain" });
      response.end("ok");
      return;
    }
    response.writeHead(404, { "content-type": "text/plain" });
    response.end("Not found");
  });

  server.on("upgrade", (request, socket, head) => {
    const refuse = (status: number) => {
      socket.write(`HTTP/1.1 ${status} ${status === 403 ? "Forbidden" : "Not Found"}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    void (async () => {
      const path = request.url ?? "";
      const tokens = relayTokens(path);
      if (!tokens) return refuse(404);
      const connection = await voice.resolveWebhook(options.db, tokens.webhookToken, options.voiceDeps);
      if (!connection) return refuse(404);
      /** Over the public address the carrier was given, path and query, with no form fields: a handshake has none. */
      const signed = connection.provider.verify({ url: `${base}${path}`, headers: headersOf(request), body: "" });
      if (!signed) return refuse(403);
      wss.handleUpgrade(request, socket, head, (ws) => {
        sockets.add(ws);
        ws.on("close", () => sockets.delete(ws));
        converse(ws, connection.organizationId, tokens.sessionToken);
      });
    })().catch((error: unknown) => {
      log(`handshake failed: ${error instanceof Error ? error.message : String(error)}`);
      refuse(404);
    });
  });

  /**
   * One call's conversation. Messages are handled strictly one after
   * another; the chain is the queue.
   */
  function converse(ws: WebSocket, organizationId: string, sessionToken: string) {
    let live: voiceAgent.Live | null = null;
    let over = false;
    let chain: Promise<void> = Promise.resolve();
    const speak = async (text: string) => {
      if (ws.readyState === ws.OPEN) ws.send(relayText(text));
    };
    const end = (reason: string) => {
      if (over) return;
      over = true;
      if (ws.readyState === ws.OPEN) ws.send(relayEnd(reason));
    };

    ws.on("message", (data) => {
      const raw = Array.isArray(data) ? Buffer.concat(data).toString("utf8") : Buffer.from(data as ArrayBuffer).toString("utf8");
      chain = chain.then(async () => {
        if (over) return;
        const message = parseRelay(raw);
        if (!message) return;
        if (message.type === "setup") {
          live = await voiceAgent.open(options.db, organizationId, sessionToken, { callSid: message.callSid });
          if (!live) {
            log("a conversation named a call it does not belong to, and was closed");
            ws.close(1008, "Unknown call");
          }
          return;
        }
        if (!live) return;
        switch (message.type) {
          case "prompt": {
            if (!message.last) return;
            const heard = await voiceAgent.hear(options.db, live, message.text, speak, options.aiDeps ?? DEFAULT_AGENT_DEPS);
            if (heard.kind === "end") end(heard.reason);
            return;
          }
          case "dtmf": {
            const heard = await voiceAgent.pressed(options.db, live, message.digit);
            if (heard.kind === "end") end(heard.reason);
            return;
          }
          case "interrupt":
            await voiceAgent.interrupted(options.db, live, message.heard);
            return;
          case "error":
            log(`the carrier reported: ${message.description}`);
            return;
        }
      }).catch((error: unknown) => {
        /**
         * Anything that throws ends the conversation towards a person: the
         * carrier's next step finds nothing decided and puts the caller
         * through, which is better than an assistant that has gone quiet.
         */
        log(`a turn failed: ${error instanceof Error ? error.message : String(error)}`);
        end("failed");
      });
    });

    ws.on("close", () => {
      chain = chain.then(async () => {
        if (live) await voiceAgent.closed(options.db, live);
      }).catch((error: unknown) => log(`closing failed: ${error instanceof Error ? error.message : String(error)}`));
    });
  }

  await new Promise<void>((resolve) => server.listen(options.port, options.host ?? "0.0.0.0", resolve));
  const { port } = server.address() as AddressInfo;
  log(`listening on ${port}, reached by the carrier at ${base}`);

  return {
    port,
    open: () => sockets.size,
    close: () => new Promise<void>((resolve) => {
      for (const ws of sockets) ws.terminate();
      wss.close();
      server.close(() => resolve());
    }),
  };
}
