import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as oauth from "../src/services/oauth";
import * as apps from "../src/services/apps";
import { handleToken, handleRegister, mcpUnauthorized } from "../src/http/oauth";
import { handleMcp } from "../src/mcp/server";
import { authenticate } from "../src/http/authenticate";
import type { ServiceContext } from "../src/services/context";
import { seedOrg, testDb, fixtureId } from "./helpers";

/**
 * OAUTH FOR REMOTE MCP CLIENTS
 *
 * The flow end to end, and every way it must refuse. The refusals are the
 * point: a code travels through a browser and lands in its history, so the
 * code alone must never be enough. Without the PKCE verifier, with the wrong
 * one, with `plain`, from another client, to another address, twice, or late,
 * the exchange is refused, and a code or refresh token used twice takes down
 * everything it produced.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
const run = url ? describe : describe.skip;

const ORG = fixtureId("oauth:org");
const USER = fixtureId("oauth:user");
const REDIRECT = "http://127.0.0.1:33418/callback";

let raw: postgres.Sql;
const db = () => testDb(url!);
const as = (roles: Actor["roles"]): ServiceContext => ({ actor: { userId: USER, organizationId: ORG, roles }, db: db() });
const owner = () => as(["owner"]);

const verifierPair = () => {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
};

let clientId = "";

async function register(): Promise<string> {
  const client = await oauth.registerClient(db(), { client_name: "Test Assistant", redirect_uris: [REDIRECT] }, "198.51.100.1");
  return client.client_id;
}

async function authorize(challenge: string, scope = "read jobs", client = clientId) {
  const check = await oauth.checkAuthorization(db(), {
    response_type: "code", client_id: client, redirect_uri: REDIRECT, scope, state: "s1",
    code_challenge: challenge, code_challenge_method: "S256", resource: "https://instance.test/api/mcp",
  });
  if (check.kind !== "ask") throw new Error(`expected ask, got ${check.kind}`);
  const { redirectTo, appId } = await oauth.approveAuthorization(owner(), check);
  const back = new URL(redirectTo);
  expect(back.searchParams.get("state")).toBe("s1");
  return { code: back.searchParams.get("code")!, appId };
}

const exchange = (form: Record<string, string>) => oauth.exchange(db(), form, "198.51.100.2");

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "OAuth Co", slug: "oauth-co" });
  await raw`delete from public.public_rate_limit where key like 'oauth-%'`;
  clientId = await register();
});

afterAll(async () => {
  if (raw) await raw.end();
});

run("registering a client", () => {
  it("issues a client id and no secret", async () => {
    const response = await handleRegister(new Request("http://x/api/oauth/register", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ client_name: "Desk", redirect_uris: ["https://claude.example.test/cb"] }),
    }), db());
    expect(response.status).toBe(201);
    const body = await response.json() as Record<string, unknown>;
    expect(body["client_id"]).toMatch(/^mcp_/);
    expect(body).not.toHaveProperty("client_secret");
    expect(body["token_endpoint_auth_method"]).toBe("none");
  });

  it("refuses plain http to anywhere but this machine, and a fragment", async () => {
    await expect(oauth.registerClient(db(), { redirect_uris: ["http://evil.example.test/cb"] }))
      .rejects.toMatchObject({ error: "invalid_redirect_uri" });
    await expect(oauth.registerClient(db(), { redirect_uris: ["https://ok.example.test/cb#frag"] }))
      .rejects.toMatchObject({ error: "invalid_redirect_uri" });
  });

  it("refuses a confidential client", async () => {
    await expect(oauth.registerClient(db(), {
      redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic",
    })).rejects.toMatchObject({ error: "invalid_client_metadata" });
  });
});

run("asking for authorization", () => {
  it("stops, sending nothing back, for an unknown client or an unregistered address", async () => {
    const { challenge } = verifierPair();
    expect(await oauth.checkAuthorization(db(), {
      response_type: "code", client_id: "mcp_nobody", redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: "S256",
    })).toMatchObject({ kind: "stop" });
    expect(await oauth.checkAuthorization(db(), {
      response_type: "code", client_id: clientId, redirect_uri: "https://attacker.example.test/cb",
      code_challenge: challenge, code_challenge_method: "S256",
    })).toMatchObject({ kind: "stop" });
  });

  it("bounces a request with no PKCE, or with plain PKCE, to the client's own address", async () => {
    const none = await oauth.checkAuthorization(db(), { response_type: "code", client_id: clientId, redirect_uri: REDIRECT });
    expect(none.kind).toBe("bounce");
    expect(new URL((none as { to: string }).to).searchParams.get("error")).toBe("invalid_request");

    const plain = await oauth.checkAuthorization(db(), {
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT,
      code_challenge: "a".repeat(43), code_challenge_method: "plain",
    });
    expect(new URL((plain as { to: string }).to).searchParams.get("error_description")).toMatch(/S256/);
  });

  it("bounces an unknown scope rather than dropping it", async () => {
    const { challenge } = verifierPair();
    const check = await oauth.checkAuthorization(db(), {
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope: "read teleport",
      code_challenge: challenge, code_challenge_method: "S256",
    });
    expect(new URL((check as { to: string }).to).searchParams.get("error")).toBe("invalid_scope");
  });

  it("accepts a loopback address on another port, which desktop clients pick each time", async () => {
    const { challenge } = verifierPair();
    const check = await oauth.checkAuthorization(db(), {
      response_type: "code", client_id: clientId, redirect_uri: "http://127.0.0.1:51000/callback",
      code_challenge: challenge, code_challenge_method: "S256",
    });
    expect(check.kind).toBe("ask");
  });

  it("maps scopes to what the approver holds, and shows what was left out", () => {
    const consent = oauth.consentFor(["jobs", "ledger:read"], new Set(["job:read", "job:write", "visit:read"]));
    expect(consent.granted.map((g) => g.permission)).toEqual(["job:read", "job:write", "visit:read"]);
    expect(consent.withheld.map((g) => g.permission)).toEqual(["ledger:read", "servicereport:read", "visit:write"]);
    expect(consent.bundles[0]!.label).toMatch(/Book jobs/);
  });
});

run("exchanging a code", () => {
  it("issues an access token that works on the MCP endpoint, as an app the company can see and revoke", async () => {
    const { verifier, challenge } = verifierPair();
    const { code, appId } = await authorize(challenge);
    const tokens = await exchange({
      grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier,
    });
    expect(tokens.token_type).toBe("Bearer");
    expect(tokens.access_token).toMatch(/^ots_/);
    expect(tokens.refresh_token).toMatch(/^otr_/);
    expect(tokens.scope).toBe("read jobs");

    const who = await authenticate(
      new Request("http://x", { headers: { authorization: `Bearer ${tokens.access_token}` } }),
      { db: db(), session: async () => null },
    );
    expect(who?.appId).toBe(appId);
    expect(who!.ctx.actor.grants).toContain("job:write");
    expect(who!.ctx.actor.grants).not.toContain("invoice:void");

    const listed = (await apps.list(owner())).find((app) => app.id === appId)!;
    expect(listed).toMatchObject({ source: "oauth", status: "active", live: true });

    const response = await handleMcp(new Request("http://x/api/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${tokens.access_token}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    }), {
      db: db(),
      resolveActor: async (req) => (await authenticate(req, { db: db(), session: async () => null }))?.ctx.actor ?? null,
      resolveSession: async (req) => (await authenticate(req, { db: db(), session: async () => null }))?.ctx ?? null,
    });
    const tools = (await response.json() as { result: { tools: Array<{ name: string }> } }).result.tools;
    expect(tools.some((t) => t.name === "otos_list_jobs")).toBe(true);
    expect(tools.some((t) => t.name === "otos_void_invoice")).toBe(false);
  });

  it("refuses an exchange with no verifier", async () => {
    const { challenge } = verifierPair();
    const { code } = await authorize(challenge);
    await expect(exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT }))
      .rejects.toMatchObject({ error: "invalid_request" });
  });

  it("refuses the wrong verifier", async () => {
    const { challenge } = verifierPair();
    const { code } = await authorize(challenge);
    await expect(exchange({
      grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT,
      code_verifier: verifierPair().verifier,
    })).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("refuses a verifier too short to be one, and a verifier sent as the challenge (plain)", async () => {
    const { challenge } = verifierPair();
    const { code } = await authorize(challenge);
    await expect(exchange({
      grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: "short",
    })).rejects.toMatchObject({ error: "invalid_request" });
    await expect(exchange({
      grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: challenge,
    })).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("refuses another client, and another redirect address", async () => {
    const other = await register();
    const { verifier, challenge } = verifierPair();
    const { code } = await authorize(challenge);
    await expect(exchange({
      grant_type: "authorization_code", code, client_id: other, redirect_uri: REDIRECT, code_verifier: verifier,
    })).rejects.toMatchObject({ error: "invalid_grant" });
    await expect(exchange({
      grant_type: "authorization_code", code, client_id: clientId, redirect_uri: "http://127.0.0.1:1/other", code_verifier: verifier,
    })).rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("refuses an expired code", async () => {
    const { verifier, challenge } = verifierPair();
    const { code } = await authorize(challenge);
    await raw`update public.oauth_code set expires_at = now() - interval '1 second'
      where code_hash = ${createHash("sha256").update(code).digest("hex")}`;
    await expect(exchange({
      grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier,
    })).rejects.toMatchObject({ error: "invalid_grant", description: expect.stringMatching(/expired/) });
  });

  it("refuses a code used twice, and revokes what the first use produced", async () => {
    const { verifier, challenge } = verifierPair();
    const { code } = await authorize(challenge);
    const form = { grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier };
    const first = await exchange(form);
    await expect(exchange(form)).rejects.toMatchObject({ error: "invalid_grant" });
    expect(await apps.resolveToken(db(), first.access_token)).toBeNull();
    await expect(exchange({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }))
      .rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("answers the token endpoint in OAuth's own shape, form encoded, never cached", async () => {
    const response = await handleToken(new Request("http://x/api/oauth/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "password", username: "a", password: "b" }).toString(),
    }), db());
    expect(response.status).toBe(400);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ error: "unsupported_grant_type" });
  });
});

run("refreshing", () => {
  it("rotates the refresh token and the access token beside it", async () => {
    const { verifier, challenge } = verifierPair();
    const { code } = await authorize(challenge);
    const first = await exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    const second = await exchange({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId });
    expect(second.refresh_token).not.toBe(first.refresh_token);
    expect(await apps.resolveToken(db(), first.access_token)).toBeNull();
    expect(await apps.resolveToken(db(), second.access_token)).not.toBeNull();
  });

  it("treats a refresh token used twice as stolen, and revokes the whole family", async () => {
    const { verifier, challenge } = verifierPair();
    const { code } = await authorize(challenge);
    const first = await exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    const second = await exchange({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId });
    await expect(exchange({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }))
      .rejects.toMatchObject({ error: "invalid_grant" });
    expect(await apps.resolveToken(db(), second.access_token)).toBeNull();
    await expect(exchange({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: clientId }))
      .rejects.toMatchObject({ error: "invalid_grant" });
  });

  it("stops working when the company turns the app off", async () => {
    const { verifier, challenge } = verifierPair();
    const { code, appId } = await authorize(challenge);
    const first = await exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    await apps.revoke(owner(), { id: appId });
    expect(await apps.resolveToken(db(), first.access_token)).toBeNull();
    await expect(exchange({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId }))
      .rejects.toMatchObject({ error: "invalid_grant" });
  });
});

run("discovery", () => {
  it("answers an unauthenticated MCP request with a 401 that says where to authorize", () => {
    const response = mcpUnauthorized(new Request("https://instance.test/api/mcp", { method: "POST" }), false);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate"))
      .toBe('Bearer resource_metadata="https://instance.test/.well-known/oauth-protected-resource"');
    const metadata = oauth.authorizationServerMetadata("https://instance.test");
    expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
    expect(oauth.protectedResourceMetadata("https://instance.test").resource).toBe("https://instance.test/api/mcp");
  });
});
