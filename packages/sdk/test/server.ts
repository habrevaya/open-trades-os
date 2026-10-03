import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Database } from "@opentradesos/db";
import { dispatch, authenticate, oauthEndpoints } from "@opentradesos/api/http";
import { handleMcp } from "@opentradesos/api/mcp";

/**
 * A REAL API ON A REAL PORT
 *
 * The SDK is tested the way a third party uses it: over HTTP, against the
 * same dispatcher the web app mounts, with an app token as the only
 * credential. Nothing is mocked between the client and the database, so a
 * test that passes here is a request that works against an instance.
 */
async function toRequest(message: IncomingMessage, origin: string): Promise<Request> {
  const chunks: Buffer[] = [];
  for await (const chunk of message) chunks.push(chunk as Buffer);
  const headers = new Headers();
  for (const [name, value] of Object.entries(message.headers)) {
    if (typeof value === "string") headers.set(name, value);
    else if (Array.isArray(value)) for (const item of value) headers.append(name, item);
  }
  const body = chunks.length > 0 && message.method !== "GET" && message.method !== "HEAD" ? Buffer.concat(chunks) : undefined;
  return new Request(`${origin}${message.url ?? "/"}`, {
    method: message.method ?? "GET", headers, ...(body ? { body } : {}),
  });
}

export async function serve(db: Database): Promise<{ origin: string; server: Server; close: () => Promise<void> }> {
  const auth = { db, session: async () => null };
  const server = createServer(async (incoming, outgoing) => {
    const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const request = await toRequest(incoming, origin);
    const path = new URL(request.url).pathname;
    /**
     * The MCP route answers an unusable credential with a 401 and the OAuth
     * challenge, as the web app's route does, so the bridge's handling of a
     * refused token is tested against what an instance actually sends.
     */
    const refused = path === "/api/mcp" && !(await authenticate(request.clone(), auth));
    const response = refused
      ? oauthEndpoints.mcpUnauthorized(request, request.headers.has("authorization"))
      : path === "/api/mcp"
      ? await handleMcp(request, {
          db,
          resolveActor: async (req) => (await authenticate(req, auth))?.ctx.actor ?? null,
          resolveSession: async (req) => (await authenticate(req, auth))?.ctx ?? null,
        })
      : await dispatch(request, {
          db, basePath: "/api",
          resolveSession: async (req) => (await authenticate(req, auth))?.ctx ?? null,
        });
    outgoing.statusCode = response.status;
    response.headers.forEach((value, name) => outgoing.setHeader(name, value));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, server, close: () => new Promise((resolve) => server.close(() => resolve())) };
}
