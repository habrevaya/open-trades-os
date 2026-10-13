import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { and, eq, sql } from "drizzle-orm";
import { E2E_ORGANIZATION_ID } from "./stripe-env";

/**
 * QUICKBOOKS, FAKED AT ITS EDGE
 *
 * The accounting settings screen reads two lists from the books when a person
 * asks: the chart of accounts (accounts and items) and the classes. Both are
 * QuickBooks' query endpoint, behind its token endpoint. This is a local HTTP
 * server answering both, reached through the connection's `baseUrl` and
 * `tokenUrl`, which only a server started with ALLOW_PROVIDER_BASE_URL obeys.
 * It counts the reads, because a read is what QuickBooks meters, and the page
 * must spend them only when somebody asks. No request leaves the machine.
 */
export interface FakeQuickBooks {
  baseUrl: string;
  tokenUrl: string;
  /** Every query the server made, in order. */
  queries: string[];
  close(): Promise<void>;
}

export async function fakeQuickBooks(): Promise<FakeQuickBooks> {
  const queries: string[] = [];
  const server: Server = createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      const reply = (status: number, json: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(json));
      };
      const url = new URL(request.url ?? "/", "http://fake");
      if (request.method === "POST" && url.pathname === "/token") {
        reply(200, { access_token: "e2e-fake-access", expires_in: 3600 });
        return;
      }
      if (request.method === "GET" && /^\/v3\/company\/[^/]+\/query$/.test(url.pathname)) {
        const query = url.searchParams.get("query") ?? "";
        queries.push(query);
        if (/from Account/i.test(query)) {
          reply(200, { QueryResponse: { Account: [
            { Id: "79", Name: "Sales of Service", AcctNum: "4010", Classification: "Revenue", Active: true },
            { Id: "35", Name: "Undeposited Funds", Classification: "Asset", Active: true },
            { Id: "90", Name: "Retired Income", Classification: "Revenue", Active: false },
          ] } });
          return;
        }
        if (/from Item/i.test(query)) {
          reply(200, { QueryResponse: { Item: [{ Id: "9", Name: "Hours", Active: true }] } });
          return;
        }
        if (/from Class/i.test(query)) {
          reply(200, { QueryResponse: { Class: [
            { Id: "c-rr", Name: "Round Rock shop", FullyQualifiedName: "Round Rock shop", Active: true },
            { Id: "c-gt", Name: "Georgetown shop", FullyQualifiedName: "Georgetown shop", Active: true },
          ] } });
          return;
        }
      }
      reply(404, { Fault: { Error: [{ Message: `The fake has no ${request.method} ${request.url}` }] } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    tokenUrl: `http://127.0.0.1:${port}/token`,
    queries,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/**
 * Connect the seeded company's books to the fake, as Settings, Integrations
 * would after Intuit's consent screen, which a browser suite cannot reach.
 * Answers the connection's id. `disconnectQuickBooks` takes it away again, so
 * the specs that run after this one see a company with no books, as seeded.
 */
export async function connectQuickBooks(fake: FakeQuickBooks): Promise<string> {
  const db = createClient();
  try {
    const [row] = await db.insert(schema.integrationConnection).values({
      organizationId: E2E_ORGANIZATION_ID,
      capability: "accounting",
      provider: "quickbooks",
      status: "connected",
      accountLabel: "Fake books",
      credentialRef: "E2E_QUICKBOOKS_CREDENTIAL",
      settings: { realmId: "e2e-realm", baseUrl: fake.baseUrl, tokenUrl: fake.tokenUrl },
    }).onConflictDoUpdate({
      target: [schema.integrationConnection.organizationId, schema.integrationConnection.capability, schema.integrationConnection.provider],
      set: {
        status: "connected", credentialRef: "E2E_QUICKBOOKS_CREDENTIAL",
        settings: { realmId: "e2e-realm", baseUrl: fake.baseUrl, tokenUrl: fake.tokenUrl },
      },
    }).returning({ id: schema.integrationConnection.id });
    return row!.id;
  } finally {
    await db.$close();
  }
}

export async function disconnectQuickBooks(connectionId: string): Promise<void> {
  const db = createClient();
  try {
    await db.delete(schema.integrationConnection).where(eq(schema.integrationConnection.id, connectionId));
  } finally {
    await db.$close();
  }
}

/**
 * A document the sync gave up on: an invoice QuickBooks refused five times,
 * written the way the sync records one, because making QuickBooks refuse an
 * invoice is not what the screen is being tested for.
 */
export async function refusedInvoice(connectionId: string, reason: string): Promise<{ linkId: string; number: number }> {
  const db = createClient();
  try {
    const [invoice] = await db.select({ id: schema.invoice.id, number: schema.invoice.number })
      .from(schema.invoice)
      .where(and(eq(schema.invoice.organizationId, E2E_ORGANIZATION_ID), sql`${schema.invoice.status} <> 'draft'`))
      .limit(1);
    if (!invoice) throw new Error("The seed has no issued invoice");
    const [link] = await db.insert(schema.accountingEntityLink).values({
      organizationId: E2E_ORGANIZATION_ID,
      connectionId,
      kind: "invoice",
      entityId: invoice.id,
      idempotencyKey: String(invoice.number),
      state: "failed",
      attempts: 5,
      lastError: reason,
    }).returning({ id: schema.accountingEntityLink.id });
    return { linkId: link!.id, number: invoice.number };
  } finally {
    await db.$close();
  }
}
