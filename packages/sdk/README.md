# @opentradesos/sdk

A typed TypeScript client for every operation in the OpenTradesOS API, a helper
that verifies webhook deliveries, and `opentradesos-mcp`, a bridge that lets a
desktop MCP client talk to a hosted instance.

The client is generated from `packages/api/openapi.json`, which is generated
from the route contracts. `pnpm --filter @opentradesos/api run openapi` writes
both, and a test fails when the client and the document disagree, so an
operation cannot exist in the API and be missing here.

The package is used from this repository and is not published to a registry
yet: it is marked private until the licensing exception proposed in
`docs/project/licensing-and-hosting.md` is settled.

## Connect

You need an app token (`ots_...`). An owner issues one under Settings,
Applications, or your app asks to be installed and collects one after the
company approves it (see below).

```ts
import { OpenTradesOS } from "@opentradesos/sdk";

const ots = new OpenTradesOS({
  baseUrl: "https://ops.example.com",
  token: process.env.OTS_TOKEN!,
});

const me = await ots.getAppSelf();            // what this token may do
const { data } = await ots.listCustomers({ q: "smith" });
const job = await ots.createJob({ customerId, propertyId, summary: "No heat" });
```

Every operation is a method named by its operation id in the OpenAPI document,
taking one object: path parameters, query parameters and body fields together.
The token travels as a bearer header and nowhere else.

## Retries and idempotency

Every operation that takes an idempotency key gets one automatically: made once
per call and sent again on the client's own retries, so a request that timed
out and was retried is a no-op on the server rather than a second invoice. The
client retries a dropped connection, a 429 and a 5xx, up to `maxRetries` (2),
and only for reads and for writes that carry a key.

A retry that might come from somewhere else (another process, a queue, a
restart) is only safe with a key you keep yourself:

```ts
await ots.createInvoice(input, { idempotencyKey: `invoice-for-${order.id}` });
```

## Errors

A refusal throws `OpenTradesOSError` with the HTTP `status`, the server's own
sentence as `message`, and for a 422 the field by field `issues`:

```ts
try {
  await ots.createCustomer({ ...input, name: "" });
} catch (error) {
  if (error instanceof OpenTradesOSError && error.status === 422) console.log(error.issues);
}
```

## Pages

```ts
for await (const customer of ots.paginate("listCustomers", { limit: 100 })) {
  // every customer, one page fetched at a time
}
```

## Dry runs

A bulk operation can be asked what it would change without changing anything.
It runs on the server and is rolled back; you get what it would have returned,
the rows it would have written per table, and the audit lines naming each
record.

```ts
const report = await ots.dryRun("renameCustomerTag", { from: "Lead", to: "Prospect" });
report.wouldReturn.customers;   // how many customers it would change
```

## Webhooks

Verify against the raw body exactly as it arrived:

```ts
import { verifyWebhook } from "@opentradesos/sdk/webhooks";

const event = await verifyWebhook({
  secret: process.env.OTS_WEBHOOK_SECRET!,
  body: rawBody,
  headers: request.headers,
});
```

It checks the timestamp is within five minutes, so a captured delivery cannot be
replayed later, and accepts a delivery when any signature in `x-otos-signature`
matches. During a secret rotation's overlap that header carries two, and you can
pass both secrets while you move from one to the other:
`secret: [newSecret, oldSecret]`. Deduplicate on `x-otos-delivery`, which is the
same for every retry and replay of one event to one endpoint.

## MCP from a desktop client

`bin/opentradesos-mcp.mjs` is a stdio MCP server with no dependencies. It carries
every message to the instance's `/api/mcp` with your app token, so the tools,
their permissions and every refusal are the server's.

```json
{
  "mcpServers": {
    "opentradesos": {
      "command": "node",
      "args": ["/path/to/open-trades-os/packages/sdk/bin/opentradesos-mcp.mjs"],
      "env": { "OPENTRADESOS_URL": "https://ops.example.com", "OPENTRADESOS_TOKEN": "ots_..." }
    }
  }
}
```

From a checkout, `npx ./packages/sdk` and `pnpm mcp:bridge` run the same thing.
A hosted assistant does not need it: point it at `/api/mcp` and it connects with
OAuth.

## Asking to be installed

An app with no credential asks a company to let it in, sends a person there to
decide, and collects its token after approval:

```ts
const asked = await fetch(`${base}/api/v1/public/app-requests`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    company: "ridgeline",
    name: "Your app",
    permissions: ["customer:read", "booking:read"],
    scopes: { customer: "all" },
    redirectUri: "https://your-app.example.com/connected",
  }),
}).then((r) => r.json());
// Send the person to asked.decisionUrl. Keep asked.claimSecret: it is shown once.

const claim = await fetch(`${base}/api/v1/public/app-requests/${asked.id}/claim`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ claimSecret: asked.claimSecret }),
}).then((r) => r.json());
// claim.status is pending, refused, expired or approved; approved carries claim.token, once.
```

The same two operations are `requestAppInstall` and `claimAppCredential` on the
client, which needs a token to construct, so an app that has none yet calls them
as above.

## Tests

`pnpm --filter @opentradesos/sdk test` with `DATABASE_URL` set runs the client
against the real API on a local port, signed in with an app token, and checks
the generated file against the document.
