import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";
import { E2E_WISETACK_ENV } from "./wisetack-env";

/**
 * WISETACK, FAKED AT ITS EDGES
 *
 * The product opens a transaction for an amount and gets back the link the
 * customer applies on, reads a transaction back after every webhook, and is
 * told by a signed webhook that something changed. The first two are a local
 * HTTP server standing in for Wisetack's API, reached through the
 * connection's `baseUrl`; the third is signed here with the secret the server
 * was started with. What the fake answers when a transaction is read is
 * whatever the spec last set, which is how it plays the lender funding the
 * loan. No request leaves the machine.
 */
export interface FakeTransaction {
  transactionId: string;
  amount: string;
  purchaseId: string;
  authorization: string | undefined;
  state: Record<string, unknown>;
}

export interface FakeWisetack {
  baseUrl: string;
  transactions: FakeTransaction[];
  close(): Promise<void>;
}

export async function fakeWisetackApi(): Promise<FakeWisetack> {
  const transactions: FakeTransaction[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const reply = (status: number, json: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(json));
      };
      const created = /^\/v1\/merchants\/[^/]+\/transactions$/.exec(request.url ?? "");
      const read = /^\/v1\/merchants\/[^/]+\/transactions\/([^/]+)$/.exec(request.url ?? "");
      if (request.method === "POST" && created) {
        const input = JSON.parse(body) as { transactionAmount: string; purchaseId: string };
        /* Unique across runs: the database outlives the fake. */
        const transactionId = `wt_e2e_${Date.now().toString(36)}${transactions.length + 1}`;
        const transaction: FakeTransaction = {
          transactionId, amount: input.transactionAmount, purchaseId: input.purchaseId,
          authorization: request.headers.authorization,
          state: { transactionId, status: "PENDING" },
        };
        transactions.push(transaction);
        reply(200, { transactionId, paymentLink: `https://wisetack.test/apply/${transactionId}`, status: "PENDING" });
        return;
      }
      if (request.method === "GET" && read) {
        const transaction = transactions.find((t) => t.transactionId === read[1]);
        if (!transaction) { reply(404, { message: "No such transaction" }); return; }
        reply(200, transaction.state);
        return;
      }
      reply(404, { message: `The fake has no ${request.method} ${request.url}` });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    transactions,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Point the company's Wisetack connection at the fake, the one setting with no screen. */
export async function pointWisetackAt(connectionId: string, baseUrl: string): Promise<void> {
  const db = createClient();
  try {
    const [row] = await db.select({ settings: schema.integrationConnection.settings })
      .from(schema.integrationConnection).where(eq(schema.integrationConnection.id, connectionId)).limit(1);
    if (!row) throw new Error(`No connection ${connectionId}`);
    await db.update(schema.integrationConnection)
      .set({ settings: { ...row.settings, baseUrl } })
      .where(eq(schema.integrationConnection.id, connectionId));
  } finally {
    await db.$close();
  }
}

/** A status change, signed as Wisetack's adapter checks it. */
export function statusChanged(transactionId: string, status: string): { body: string; signature: string } {
  const body = JSON.stringify({
    messageId: `msg_${transactionId}_${status}_${Date.now()}`, transactionId, changedStatus: status, eventType: "status_change",
  });
  return { body, signature: createHmac("sha256", E2E_WISETACK_ENV.E2E_WISETACK_SIGNING).update(body).digest("hex") };
}
