import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";

/**
 * THUMBTACK'S AND LOB'S APIS, FAKED AT THEIR EDGES
 *
 * One local server answering the two requests this product makes of them:
 * a reply to a Thumbtack customer on a lead, and a postcard to Lob. Each
 * request is kept whole so a spec can say exactly what left. Everything
 * between the screens and these edges is the product and runs for real.
 */
export interface FakeMarketing {
  base: string;
  replies: { lead: string; text: string; authorization: string | undefined }[];
  postcards: Record<string, unknown>[];
  close(): Promise<void>;
}

export async function fakeMarketing(): Promise<FakeMarketing> {
  const replies: FakeMarketing["replies"] = [];
  const postcards: FakeMarketing["postcards"] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://fake");
      const json = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      const reply = /^\/thumbtack\/v2\/business\/[^/]+\/lead\/([^/]+)\/message$/.exec(url.pathname);
      if (request.method === "POST" && reply) {
        replies.push({ lead: reply[1]!, text: (JSON.parse(body) as { text: string }).text, authorization: request.headers.authorization });
        json(200, { messageID: `e2e-msg-${replies.length}` });
        return;
      }
      if (request.method === "POST" && url.pathname === "/lob/v1/postcards") {
        postcards.push({ ...(JSON.parse(body) as Record<string, unknown>), idempotencyKey: request.headers["idempotency-key"] });
        json(200, { id: `psc_e2e_${postcards.length}`, expected_delivery_date: "2026-10-20" });
        return;
      }
      json(404, { error: { message: `The fake has no ${request.method} ${url.pathname}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    replies,
    postcards,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Points a connection's API at the fake: the one setting with no screen, because it exists only for tests. */
export async function pointAt(provider: "thumbtack" | "lob", base: string): Promise<void> {
  const db = createClient();
  try {
    const rows = await db.select({ id: schema.integrationConnection.id, settings: schema.integrationConnection.settings })
      .from(schema.integrationConnection).where(eq(schema.integrationConnection.provider, provider));
    for (const row of rows) {
      await db.update(schema.integrationConnection).set({ settings: { ...row.settings, baseUrl: `${base}/${provider}` } })
        .where(eq(schema.integrationConnection.id, row.id));
    }
  } finally {
    await db.$close();
  }
}
