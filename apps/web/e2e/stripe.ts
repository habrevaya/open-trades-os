import { createHmac } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { Page } from "@playwright/test";
import { createClient, schema } from "@opentradesos/db";
import { eq } from "drizzle-orm";
import { E2E_STRIPE_ENV } from "./stripe-env";

/**
 * STRIPE, FAKED AT ITS TWO EDGES
 *
 * A card payment touches Stripe three times: the server asks for a payment
 * intent, the browser mounts Stripe's Payment Element from js.stripe.com and
 * confirms the card, and Stripe tells the server the money moved with a
 * signed webhook. Everything between those edges is the product and runs for
 * real here. The edges are faked the way the service layer's tests fake a
 * carrier:
 *
 *  - the intent is created by a local HTTP server standing in for
 *    api.stripe.com, reached through the adapter's own `baseUrl` setting,
 *    which exists for exactly this and has no screen;
 *  - Stripe.js is answered by a page route with a stand-in that mounts a
 *    placeholder element and, on confirm, sends the browser back to the
 *    return URL the way Stripe does after a card is accepted;
 *  - the webhook is signed with the signing secret the server was started
 *    with, by the same scheme Stripe uses, and posted to the address the
 *    settings screen shows.
 *
 * No request leaves the machine, and nothing here is a real key.
 */

export interface FakeIntent {
  id: string;
  clientSecret: string;
  amount: number;
  currency: string;
  metadata: Record<string, string>;
  authorization: string | undefined;
}

export interface FakeStripe {
  /** What the server would use as Stripe's API root. */
  baseUrl: string;
  intents: FakeIntent[];
  close(): Promise<void>;
}

export async function fakeStripeApi(): Promise<FakeStripe> {
  const intents: FakeIntent[] = [];
  const server: Server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => { body += chunk.toString("utf8"); });
    request.on("end", () => {
      if (request.method !== "POST" || request.url !== "/v1/payment_intents") {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `The fake has no ${request.method} ${request.url}` } }));
        return;
      }
      const params = new URLSearchParams(body);
      const metadata: Record<string, string> = {};
      for (const [key, value] of params) {
        const match = /^metadata\[(.+)\]$/.exec(key);
        if (match) metadata[match[1]!] = value;
      }
      /*
        Unique across runs, not just within one: the database outlives the
        fake, and a second run handing out pi_e2e_1 again would have its
        webhook taken for the first run's, already settled, and ignored.
      */
      const n = `${Date.now().toString(36)}${intents.length + 1}`;
      const intent: FakeIntent = {
        id: `pi_e2e_${n}`,
        clientSecret: `pi_e2e_${n}_secret_fake`,
        amount: Number(params.get("amount")),
        currency: params.get("currency") ?? "usd",
        metadata,
        authorization: request.headers.authorization,
      };
      intents.push(intent);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: intent.id, object: "payment_intent", client_secret: intent.clientSecret,
        amount: intent.amount, currency: intent.currency, status: "requires_payment_method", metadata,
      }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    intents,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Point the company's Stripe connection at the fake, the one setting with no screen. */
export async function pointStripeAt(connectionId: string, baseUrl: string): Promise<void> {
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

/**
 * Stripe.js, as far as the page uses it.
 *
 * The element mounts a labelled placeholder carrying the publishable key and
 * client secret it was given, so the test can see the browser was handed the
 * intent the server created. Confirming goes to the return URL with the
 * query Stripe adds, and the page shows paid only once the webhook lands.
 */
export async function fakeStripeJs(page: Page): Promise<void> {
  await page.route("https://js.stripe.com/v3/", (route) => route.fulfill({
    contentType: "application/javascript",
    body: `
      window.Stripe = function (publishableKey) {
        var secret = null;
        return {
          elements: function (options) {
            secret = options.clientSecret;
            return {
              create: function () {
                return {
                  mount: function (target) {
                    var el = document.createElement("div");
                    el.setAttribute("role", "group");
                    el.setAttribute("aria-label", "Stripe Payment Element");
                    el.dataset.publishableKey = publishableKey;
                    el.dataset.clientSecret = secret;
                    el.textContent = "Card number, expiry and CVC would be here.";
                    target.appendChild(el);
                  },
                  destroy: function () {},
                };
              },
            };
          },
          confirmPayment: function (options) {
            var intent = String(secret).split("_secret_")[0];
            window.location.assign(options.confirmParams.return_url
              + "?payment_intent=" + intent + "&redirect_status=succeeded");
            return new Promise(function () {});
          },
          confirmSetup: function (options) {
            var setup = String(secret).split("_secret_")[0];
            window.location.assign(options.confirmParams.return_url
              + "?setup_intent=" + setup + "&redirect_status=succeeded");
            return new Promise(function () {});
          },
          handleNextAction: function () {
            return Promise.resolve({});
          },
        };
      };
    `,
  }));
}

/** Stripe's `payment_intent.succeeded`, signed as Stripe signs it. */
export function succeeded(intent: FakeIntent): { body: string; signature: string } {
  const created = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({
    id: `evt_e2e_${intent.id}`,
    object: "event",
    type: "payment_intent.succeeded",
    created,
    data: {
      object: {
        id: intent.id, object: "payment_intent", amount: intent.amount, currency: intent.currency,
        status: "succeeded", metadata: intent.metadata,
        // A string, as a webhook carries it: Stripe expands nothing it is not asked to.
        latest_charge: `ch_${intent.id}`,
      },
    },
  });
  const v1 = createHmac("sha256", E2E_STRIPE_ENV.STRIPE_WEBHOOK_SECRET).update(`${created}.${body}`).digest("hex");
  return { body, signature: `t=${created},v1=${v1}` };
}
