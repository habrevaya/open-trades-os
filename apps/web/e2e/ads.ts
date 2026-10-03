import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createClient, schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";

/**
 * GOOGLE, FAKED AT ITS EDGES
 *
 * Three things a Google Ads connection touches, answered by a local server:
 * the consent screen (which sends the browser straight back with a code, as
 * Google does once the person presses Allow), the token endpoint (a code for a
 * refresh token, a refresh token for an hour's access), and the Ads API's
 * search (one campaign's spend for today). Everything between those edges is
 * the product and runs for real. No request leaves the machine.
 */
export interface FakeGoogle {
  base: string;
  /** The spend the fake account reports for today, per campaign name. */
  spend: { name: string; micros: string }[];
  searches: number;
  close(): Promise<void>;
}

export async function fakeGoogle(): Promise<FakeGoogle> {
  const state = { searches: 0 };
  const spend: { name: string; micros: string }[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://fake");
      const json = (status: number, payload: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (request.method === "GET" && url.pathname === "/auth") {
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", "e2e-good-code");
        back.searchParams.set("state", url.searchParams.get("state")!);
        response.writeHead(302, { location: back.toString() });
        response.end();
        return;
      }
      if (request.method === "POST" && url.pathname === "/token") {
        const form = new URLSearchParams(body);
        if (form.get("grant_type") === "authorization_code" && form.get("code") === "e2e-good-code") {
          json(200, { access_token: "e2e-access", expires_in: 3599, refresh_token: "e2e-refresh", scope: "https://www.googleapis.com/auth/adwords" });
          return;
        }
        if (form.get("grant_type") === "refresh_token" && form.get("refresh_token") === "e2e-refresh") {
          json(200, { access_token: "e2e-access-2", expires_in: 3599 });
          return;
        }
        json(400, { error: "invalid_grant" });
        return;
      }
      if (request.method === "POST" && url.pathname === "/ads/v21/customers/1234567890/googleAds:search") {
        state.searches += 1;
        const today = new Date().toISOString().slice(0, 10);
        json(200, {
          results: spend.map((s, i) => ({
            customer: { currencyCode: "USD" },
            campaign: { id: String(9100 + i), name: s.name, advertisingChannelType: "SEARCH" },
            segments: { date: today },
            metrics: { costMicros: s.micros, clicks: "7", impressions: "300" },
          })),
        });
        return;
      }
      if (request.method === "POST" && url.pathname === "/ads/v21/customers/1234567890:uploadClickConversions") {
        json(200, { results: [] });
        return;
      }
      json(404, { error: { message: `The fake has no ${request.method} ${url.pathname}` } });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    base: `http://127.0.0.1:${port}`,
    spend,
    get searches() { return state.searches; },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Points the saved Google Ads connection's sign in and API at the fake: the three settings with no screen. */
export async function pointGoogleAdsAt(base: string): Promise<void> {
  const db = createClient();
  try {
    const rows = await db.select({ id: schema.integrationConnection.id, settings: schema.integrationConnection.settings })
      .from(schema.integrationConnection).where(eq(schema.integrationConnection.provider, "google_ads"));
    for (const row of rows) {
      await db.update(schema.integrationConnection).set({
        settings: { ...row.settings, authUrl: `${base}/auth`, tokenUrl: `${base}/token`, baseUrl: `${base}/ads` },
      }).where(eq(schema.integrationConnection.id, row.id));
    }
  } finally {
    await db.$close();
  }
}

/** A clean start: any Google Ads connection an earlier run left is taken away, with its grant. */
export async function forgetGoogleAds(): Promise<void> {
  const db = createClient();
  try {
    await db.delete(schema.integrationConnection).where(eq(schema.integrationConnection.provider, "google_ads"));
  } finally {
    await db.$close();
  }
}
