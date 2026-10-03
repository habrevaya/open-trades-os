import { createHash, randomBytes } from "node:crypto";
import { test, expect, run } from "./fixtures";

/**
 * A THIRD PARTY ASKS, THE OWNER DECIDES ON A SCREEN
 *
 * The two ways software asks to be let into a company, driven through the
 * browser the way an owner meets them: an app's install request, which the
 * owner reads in plain words and approves or refuses, after which the app
 * collects its credential; and a remote AI assistant connecting over OAuth,
 * which the owner approves on the authorization page and which then reaches
 * the MCP endpoint with the token it was given.
 */

const COMPANY = "ridgeline";

test("an app asks to be installed, the owner approves exactly what it asked for, and it collects its credential once", async ({ owner, stranger }) => {
  const name = `Partner ${run}`;
  const asked = await stranger.request.post("/api/v1/public/app-requests", {
    data: {
      company: COMPANY, name, publisher: "Partner Inc", description: "Sends you neighbourhood jobs.",
      permissions: ["customer:read", "job:read"], scopes: { customer: "all", job: "all" },
      redirectUri: "https://partner.example.test/back", state: "abc",
    },
  });
  expect(asked.status()).toBe(201);
  const request = await asked.json() as { id: string; decisionPath: string; decisionUrl: string; claimSecret: string };
  expect(request.decisionUrl).toContain(request.decisionPath);

  const early = await stranger.request.post(`/api/v1/public/app-requests/${request.id}/claim`, {
    data: { claimSecret: request.claimSecret },
  });
  expect((await early.json() as { status: string }).status).toBe("pending");

  // Somebody signed out is sent to sign in, and back here after.
  await stranger.goto(request.decisionPath);
  await expect(stranger).toHaveURL(new RegExp(`/login\\?next=${encodeURIComponent(request.decisionPath)}`));

  await owner.goto("/settings/apps");
  await expect(owner.getByRole("link", { name })).toBeVisible();
  await owner.getByRole("link", { name }).click();

  await expect(owner.getByRole("heading", { name: `${name} is asking to be let in` })).toBeVisible();
  const asks = owner.getByRole("list", { name: "What it asks for" });
  await expect(asks).toContainText("View customers");
  await expect(asks).toContainText("View jobs");
  await expect(owner.getByText("Sends you neighbourhood jobs.")).toBeVisible();

  await owner.getByRole("button", { name: `Approve ${name}` }).click();
  await expect(owner.getByRole("status").filter({ hasText: /^Approved\./ })).toBeVisible();
  const back = owner.getByRole("link", { name: "Go back to partner.example.test" });
  const returnTo = new URL(await back.getAttribute("href") ?? "");
  expect(Object.fromEntries(returnTo.searchParams)).toEqual({ request: request.id, status: "approved", state: "abc" });

  const collected = await stranger.request.post(`/api/v1/public/app-requests/${request.id}/claim`, {
    data: { claimSecret: request.claimSecret },
  });
  const credential = await collected.json() as { status: string; token: string };
  expect(credential.status).toBe("approved");

  const me = await stranger.request.get("/api/v1/apps/me", { headers: { authorization: `Bearer ${credential.token}` } });
  expect(me.status()).toBe(200);
  expect(await me.json()).toMatchObject({ name, permissions: ["customer:read", "job:read"] });

  const again = await stranger.request.post(`/api/v1/public/app-requests/${request.id}/claim`, {
    data: { claimSecret: request.claimSecret },
  });
  expect(await again.json()).toMatchObject({ status: "claimed" });
  expect(await again.json()).not.toHaveProperty("token");
});

test("the owner refuses a request, and the app is told no and gets nothing", async ({ owner, stranger }) => {
  const name = `Stranger app ${run}`;
  const asked = await stranger.request.post("/api/v1/public/app-requests", {
    data: { company: COMPANY, name, permissions: ["customer:read"] },
  });
  const request = await asked.json() as { id: string; decisionPath: string; claimSecret: string };

  await owner.goto(request.decisionPath);
  await owner.getByRole("textbox", { name: `Why ${name} is being refused` }).fill("We do not know you");
  await owner.getByRole("button", { name: "Refuse" }).click();
  await expect(owner.getByRole("status").filter({ hasText: /^Refused\./ })).toBeVisible();

  const answer = await stranger.request.post(`/api/v1/public/app-requests/${request.id}/claim`, {
    data: { claimSecret: request.claimSecret },
  });
  expect(await answer.json()).toMatchObject({ status: "refused", message: "Refused: We do not know you" });
});

test("a remote AI assistant connects over OAuth with PKCE and reaches the MCP endpoint", async ({ owner, stranger, baseURL }) => {
  const unauthenticated = await stranger.request.post("/api/mcp", {
    data: { jsonrpc: "2.0", id: 1, method: "tools/list" },
  });
  expect(unauthenticated.status()).toBe(401);
  expect(unauthenticated.headers()["www-authenticate"]).toContain("/.well-known/oauth-protected-resource");

  const metadata = await (await stranger.request.get("/.well-known/oauth-authorization-server")).json() as {
    authorization_endpoint: string; token_endpoint: string; registration_endpoint: string;
  };
  const callback = "http://127.0.0.1:47219/callback";
  const registered = await stranger.request.post(metadata.registration_endpoint, {
    data: { client_name: `Assistant ${run}`, redirect_uris: [callback] },
  });
  expect(registered.status()).toBe(201);
  const { client_id } = await registered.json() as { client_id: string };

  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL("/oauth/authorize", baseURL);
  for (const [key, value] of Object.entries({
    response_type: "code", client_id, redirect_uri: callback, scope: "read customers", state: "xyz",
    code_challenge: challenge, code_challenge_method: "S256",
  })) authorize.searchParams.set(key, value);

  // The callback is the assistant's own listener; here it answers so the browser has somewhere to land.
  let code = "";
  await owner.route(`${callback}**`, async (route) => {
    const url = new URL(route.request().url());
    code = url.searchParams.get("code") ?? "";
    expect(url.searchParams.get("state")).toBe("xyz");
    await route.fulfill({ status: 200, contentType: "text/html", body: "<p>Connected.</p>" });
  });

  await owner.goto(authorize.pathname + authorize.search);
  await expect(owner.getByRole("heading", { name: `Connect Assistant ${run}?` })).toBeVisible();
  const grants = owner.getByRole("list", { name: "What it would be able to do" });
  await expect(grants).toContainText("Create and edit customers");
  await owner.getByRole("button", { name: "Connect", exact: true }).click();
  await expect(owner.getByText("Connected.")).toBeVisible();
  expect(code).not.toBe("");

  const tokens = await stranger.request.post(metadata.token_endpoint, {
    form: { grant_type: "authorization_code", code, client_id, redirect_uri: callback, code_verifier: verifier },
  });
  expect(tokens.status()).toBe(200);
  const { access_token } = await tokens.json() as { access_token: string };

  const listed = await stranger.request.post("/api/mcp", {
    headers: { authorization: `Bearer ${access_token}` },
    data: { jsonrpc: "2.0", id: 2, method: "tools/list" },
  });
  const tools = (await listed.json() as { result: { tools: Array<{ name: string }> } }).result.tools;
  expect(tools.some((tool) => tool.name === "otos_create_customer")).toBe(true);

  await owner.goto("/settings/apps");
  await expect(owner.getByRole("heading", { level: 3, name: new RegExp(`Assistant ${run}`) })).toBeVisible();
});
