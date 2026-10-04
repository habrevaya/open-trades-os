import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import postgres from "postgres";
import type { Actor } from "@opentradesos/core";
import * as oauth from "../src/services/oauth";
import * as apps from "../src/services/apps";
import { handleToken, handleRegister, handleRevoke, handleIntrospect, handleRotateSecret, mcpUnauthorized } from "../src/http/oauth";
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

  it("refuses a way of authenticating it does not know", async () => {
    await expect(oauth.registerClient(db(), {
      redirect_uris: [REDIRECT], token_endpoint_auth_method: "private_key_jwt",
    })).rejects.toMatchObject({ error: "invalid_client_metadata" });
  });

  it("hands a confidential client its secret once, and keeps only the hash", async () => {
    const client = await oauth.registerClient(db(), {
      client_name: "Server Assistant", redirect_uris: ["https://assistant.example.test/cb"],
      token_endpoint_auth_method: "client_secret_basic",
    });
    expect(client.client_secret).toMatch(/^ocs_/);
    expect(client.client_secret_expires_at).toBe(0);
    const [row] = await raw<{ secret_hash: string; method: string }[]>`
      select secret_hash, token_endpoint_auth_method as method from public.oauth_client where client_id = ${client.client_id}`;
    expect(row!.method).toBe("client_secret_basic");
    expect(row!.secret_hash).toBe(createHash("sha256").update(client.client_secret!).digest("hex"));
    expect(row!.secret_hash).not.toContain(client.client_secret!);
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
    expect(metadata.revocation_endpoint).toBe("https://instance.test/api/oauth/revoke");
    expect(metadata.introspection_endpoint).toBe("https://instance.test/api/oauth/introspect");
    expect(metadata.token_endpoint_auth_methods_supported).toEqual(["none", "client_secret_basic", "client_secret_post"]);
    expect(oauth.protectedResourceMetadata("https://instance.test").resource).toBe("https://instance.test/api/mcp");
  });
});

/* ------------------------------------------------------------------------ */

/** A code exchanged for a pair, for the tests below. */
async function connect(client = clientId, scope = "read jobs") {
  const { verifier, challenge } = verifierPair();
  const { code, appId } = await authorize(challenge, scope, client);
  const pair = await exchange({
    grant_type: "authorization_code", code, client_id: client, redirect_uri: REDIRECT, code_verifier: verifier,
  });
  return { ...pair, appId };
}

run("a confidential client", () => {
  let confidential: oauth.RegisteredClient;
  const basic = (id: string, secret: string) =>
    `Basic ${Buffer.from(`${encodeURIComponent(id)}:${encodeURIComponent(secret)}`).toString("base64")}`;

  beforeAll(async () => {
    if (!url) return;
    confidential = await oauth.registerClient(db(), {
      client_name: "Hosted Assistant", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post",
    });
  });

  async function codeFor() {
    const { verifier, challenge } = verifierPair();
    const { code } = await authorize(challenge, "read", confidential.client_id);
    return { grant_type: "authorization_code", code, client_id: confidential.client_id, redirect_uri: REDIRECT, code_verifier: verifier };
  }

  it("is refused at the token endpoint without its secret, and with the wrong one", async () => {
    const form = await codeFor();
    await expect(exchange(form)).rejects.toMatchObject({ error: "invalid_client", status: 401 });
    await expect(exchange({ ...form, client_secret: "ocs_not-the-secret" }))
      .rejects.toMatchObject({ error: "invalid_client", status: 401 });
    // A refused client changed nothing: the code still works for the real one.
    const pair = await exchange({ ...form, client_secret: confidential.client_secret! });
    expect(pair.access_token).toMatch(/^ots_/);
  });

  it("may send the secret in the Authorization header instead, but not both ways at once", async () => {
    const form = await codeFor();
    const { client_id: _id, ...withoutId } = form;
    await expect(oauth.exchange(db(), { ...form, client_secret: confidential.client_secret! }, "198.51.100.2", {
      authorization: basic(confidential.client_id, confidential.client_secret!),
    })).rejects.toMatchObject({ error: "invalid_request" });
    const pair = await oauth.exchange(db(), withoutId, "198.51.100.2", {
      authorization: basic(confidential.client_id, confidential.client_secret!),
    });
    expect(pair.refresh_token).toMatch(/^otr_/);
    // The refresh is held to the secret too.
    await expect(exchange({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: confidential.client_id }))
      .rejects.toMatchObject({ error: "invalid_client" });
    const next = await exchange({
      grant_type: "refresh_token", refresh_token: pair.refresh_token,
      client_id: confidential.client_id, client_secret: confidential.client_secret!,
    });
    expect(next.refresh_token).not.toBe(pair.refresh_token);
  });

  it("still needs PKCE: the secret proves the client, not that it asked for this code", async () => {
    const { code_verifier: _verifier, ...form } = await codeFor();
    await expect(exchange({ ...form, client_secret: confidential.client_secret! }))
      .rejects.toMatchObject({ error: "invalid_request" });
  });

  it("answers a wrong secret over HTTP with a 401 naming Basic", async () => {
    const response = await handleToken(new Request("http://x/api/oauth/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        authorization: basic(confidential.client_id, "ocs_wrong"),
      },
      body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: "otr_whatever" }).toString(),
    }), db());
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toMatch(/^Basic/);
    expect(await response.json()).toMatchObject({ error: "invalid_client" });
  });

  it("refuses a public client that sends a secret it was never given, and an id nobody registered", async () => {
    const { challenge, verifier } = verifierPair();
    const { code } = await authorize(challenge);
    await expect(exchange({
      grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier,
      client_secret: "ocs_made-up",
    })).rejects.toMatchObject({ error: "invalid_client" });
    await expect(exchange({ grant_type: "refresh_token", refresh_token: "otr_x", client_id: "mcp_nobody" }))
      .rejects.toMatchObject({ error: "invalid_client", status: 401 });
  });
});

run("revoking a token (RFC 7009)", () => {
  const revoke = (form: Record<string, string>, credentials: oauth.ClientCredentials = {}) =>
    oauth.revoke(db(), form, "198.51.100.3", credentials);

  it("ends a refresh token and everything descended from the same approval", async () => {
    const first = await connect();
    const second = await exchange({ grant_type: "refresh_token", refresh_token: first.refresh_token, client_id: clientId });
    await revoke({ token: second.refresh_token, token_type_hint: "refresh_token", client_id: clientId });
    expect(await apps.resolveToken(db(), second.access_token)).toBeNull();
    await expect(exchange({ grant_type: "refresh_token", refresh_token: second.refresh_token, client_id: clientId }))
      .rejects.toMatchObject({ error: "invalid_grant" });
    // The app stays on the company's list, with nothing live, for the company to decide about.
    expect((await apps.list(owner())).find((a) => a.id === first.appId)).toMatchObject({ status: "active" });
    const [line] = await raw<{ n: number }[]>`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'app.oauth_token_revoked' and entity_id = ${first.appId}`;
    expect(line!.n).toBe(1);
  });

  it("ends an access token alone, leaving its refresh token able to make another", async () => {
    const pair = await connect();
    await revoke({ token: pair.access_token, client_id: clientId });
    expect(await apps.resolveToken(db(), pair.access_token)).toBeNull();
    const next = await exchange({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: clientId });
    expect(await apps.resolveToken(db(), next.access_token)).not.toBeNull();
  });

  it("finds the token whatever the hint says", async () => {
    const pair = await connect();
    await revoke({ token: pair.refresh_token, token_type_hint: "access_token", client_id: clientId });
    expect(await apps.resolveToken(db(), pair.access_token)).toBeNull();
  });

  it("succeeds without saying anything for a token nobody issued, one already revoked, and an operator's token", async () => {
    await expect(revoke({ token: "otr_never-issued", client_id: clientId })).resolves.toBeUndefined();
    const pair = await connect();
    await revoke({ token: pair.access_token, client_id: clientId });
    await expect(revoke({ token: pair.access_token, client_id: clientId })).resolves.toBeUndefined();

    // A token issued by hand under Settings, Applications is not an OAuth client's to end.
    const installed = await apps.install(owner(), { name: "Bookkeeping sync", permissions: ["customer:read"] });
    const issued = await apps.issueToken(owner(), { appId: installed.id });
    await revoke({ token: issued.token, client_id: clientId });
    expect(await apps.resolveToken(db(), issued.token)).not.toBeNull();
  });

  it("refuses to end another client's token, and leaves it working", async () => {
    const other = await register();
    const pair = await connect();
    await expect(revoke({ token: pair.refresh_token, client_id: other })).rejects.toMatchObject({ error: "unauthorized_client" });
    await expect(revoke({ token: pair.access_token, client_id: other })).rejects.toMatchObject({ error: "unauthorized_client" });
    expect(await apps.resolveToken(db(), pair.access_token)).not.toBeNull();
  });

  it("refuses a request with no token, and a confidential client without its secret", async () => {
    await expect(revoke({ client_id: clientId })).rejects.toMatchObject({ error: "invalid_request" });
    const confidential = await oauth.registerClient(db(), {
      redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_basic",
    });
    await expect(revoke({ token: "otr_x", client_id: confidential.client_id })).rejects.toMatchObject({ error: "invalid_client" });
  });

  it("answers over HTTP with a 200 and an empty object either way", async () => {
    const pair = await connect();
    const post = (token: string) => handleRevoke(new Request("http://x/api/oauth/revoke", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token, client_id: clientId }).toString(),
    }), db());
    for (const token of [pair.refresh_token, "otr_nothing"]) {
      const response = await post(token);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({});
    }
    expect(await apps.resolveToken(db(), pair.access_token)).toBeNull();
  });
});

run("asking whether a token is live (RFC 7662)", () => {
  const ask = (form: Record<string, string>, credentials: oauth.ClientCredentials = {}) =>
    oauth.introspect(db(), form, "https://instance.test", "198.51.100.4", credentials);

  it("describes a live access token and a live refresh token to the client holding them", async () => {
    const pair = await connect(clientId, "read jobs");
    const access = await ask({ token: pair.access_token, client_id: clientId });
    expect(access).toMatchObject({
      active: true, client_id: clientId, scope: "read jobs", token_type: "Bearer", iss: "https://instance.test",
    });
    expect((access as { exp: number }).exp - Math.floor(Date.now() / 1000)).toBeGreaterThan(3500);
    const refresh = await ask({ token: pair.refresh_token, token_type_hint: "refresh_token", client_id: clientId });
    expect(refresh).toMatchObject({ active: true, token_type: "refresh_token", scope: "read jobs" });
  });

  it("says inactive, and nothing more, once a token is revoked, used up, expired or its app turned off", async () => {
    const pair = await connect();
    await exchange({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: clientId });
    expect(await ask({ token: pair.refresh_token, client_id: clientId })).toEqual({ active: false });
    expect(await ask({ token: pair.access_token, client_id: clientId })).toEqual({ active: false });

    const late = await connect();
    await raw`update public.app_token set expires_at = now() - interval '1 second'
      where token_hash = ${createHash("sha256").update(late.access_token).digest("hex")}`;
    expect(await ask({ token: late.access_token, client_id: clientId })).toEqual({ active: false });

    const off = await connect();
    await apps.revoke(owner(), { id: off.appId });
    expect(await ask({ token: off.refresh_token, client_id: clientId })).toEqual({ active: false });
  });

  it("tells a client nothing about another client's token, or about a string nobody issued", async () => {
    const other = await register();
    const pair = await connect();
    expect(await ask({ token: pair.access_token, client_id: other })).toEqual({ active: false });
    expect(await ask({ token: pair.refresh_token, client_id: other })).toEqual({ active: false });
    expect(await ask({ token: "ots_never-issued", client_id: clientId })).toEqual({ active: false });
  });

  it("refuses a caller that does not say who it is, a wrong secret, and a request with no token", async () => {
    await expect(ask({ token: "ots_x" })).rejects.toMatchObject({ error: "invalid_request" });
    await expect(ask({ client_id: clientId })).rejects.toMatchObject({ error: "invalid_request" });
    const confidential = await oauth.registerClient(db(), {
      redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post",
    });
    await expect(ask({ token: "ots_x", client_id: confidential.client_id, client_secret: "ocs_wrong" }))
      .rejects.toMatchObject({ error: "invalid_client", status: 401 });
  });

  it("answers over HTTP in RFC 7662's shape, never cached", async () => {
    const pair = await connect();
    const response = await handleIntrospect(new Request("https://instance.test/api/oauth/introspect", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token: pair.access_token, client_id: clientId }).toString(),
    }), db());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ active: true, token_type: "Bearer" });
  });
});

run("narrowing on the consent page", () => {
  async function ask(scope: string) {
    const { verifier, challenge } = verifierPair();
    const check = await oauth.checkAuthorization(db(), {
      response_type: "code", client_id: clientId, redirect_uri: REDIRECT, scope, state: "n1",
      code_challenge: challenge, code_challenge_method: "S256",
    });
    if (check.kind !== "ask") throw new Error(`expected ask, got ${check.kind}`);
    return { check, verifier };
  }

  it("grants only what was left ticked, and tells the client its scope is narrower", async () => {
    const { check, verifier } = await ask("customers");
    const { redirectTo, appId } = await oauth.approveAuthorization(owner(), check, {
      permissions: ["customer:read", "property:read"],
    });
    const code = new URL(redirectTo).searchParams.get("code")!;
    const pair = await exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(pair.scope).toBe("customer:read property:read");
    const app = (await apps.list(owner())).find((a) => a.id === appId)!;
    expect([...app.permissions].sort()).toEqual(["customer:read", "property:read"]);
    const who = await apps.resolveToken(db(), pair.access_token);
    expect(who!.actor.grants).not.toContain("customer:write");
  });

  it("refuses a permission the page did not offer, and a grant with nothing ticked", async () => {
    const { check } = await ask("customers");
    await expect(oauth.approveAuthorization(owner(), check, { permissions: ["customer:read", "invoice:void"] }))
      .rejects.toThrow(/invoice:void/);
    await expect(oauth.approveAuthorization(owner(), check, { permissions: [] })).rejects.toThrow(/Tick at least one/);
  });

  it("keeps the scope as asked when the person gave everything the page showed", async () => {
    const { check, verifier } = await ask("tasks");
    const offered = oauth.consentFor(check.scopes, new Set(["task:read", "task:write"])).granted.map((g) => g.permission);
    const { redirectTo } = await oauth.approveAuthorization(owner(), check, { permissions: offered });
    const code = new URL(redirectTo).searchParams.get("code")!;
    const pair = await exchange({ grant_type: "authorization_code", code, client_id: clientId, redirect_uri: REDIRECT, code_verifier: verifier });
    expect(pair.scope).toBe("tasks");
  });
});

run("clearing out registrations nobody used", () => {
  it("removes a week old registration no company approved, and keeps one a company did", async () => {
    const unused = await register();
    const used = await register();
    await connect(used);
    await raw`update public.oauth_client set created_at = now() - interval '8 days'
      where client_id in (${unused}, ${used})`;
    const fresh = await register();

    expect(await oauth.purgeUnusedClients(db())).toBeGreaterThanOrEqual(1);
    expect(await oauth.findClient(db(), unused)).toBeNull();
    expect(await oauth.findClient(db(), used)).not.toBeNull();
    expect(await oauth.findClient(db(), fresh)).not.toBeNull();
  });
});

run("rotating a confidential client's secret", () => {
  /**
   * The refusals first, because a rotation is a way to obtain a working
   * secret. Only the client may rotate, only with the secret that is current,
   * and the overlap is short and the caller's to choose, down to none.
   */
  const rotate = (form: Record<string, string>, credentials: oauth.ClientCredentials = {}) =>
    oauth.rotateClientSecret(db(), form, "198.51.100.7", credentials);
  const confidential = () => oauth.registerClient(db(), {
    client_name: "Rotating Assistant", redirect_uris: [REDIRECT], token_endpoint_auth_method: "client_secret_post",
  });
  const refreshWith = async (client: oauth.RegisteredClient, secret: string, refreshToken: string) =>
    exchange({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: client.client_id, client_secret: secret });

  it("refuses a public client, a wrong secret, a missing secret and an overlap out of bounds", async () => {
    await expect(rotate({ client_id: clientId })).rejects.toMatchObject({ error: "invalid_client", status: 401 });
    const client = await confidential();
    await expect(rotate({ client_id: client.client_id })).rejects.toMatchObject({ error: "invalid_client" });
    await expect(rotate({ client_id: client.client_id, client_secret: "ocs_guess" }))
      .rejects.toMatchObject({ error: "invalid_client", status: 401 });
    for (const overlap of ["-1", "86401", "1.5", "an hour"]) {
      await expect(rotate({ client_id: client.client_id, client_secret: client.client_secret!, overlap_seconds: overlap }))
        .rejects.toMatchObject({ error: "invalid_request" });
    }
    // Nothing above changed the secret.
    const { verifier, challenge } = verifierPair();
    const { code } = await authorize(challenge, "read", client.client_id);
    await expect(exchange({
      grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT,
      code_verifier: verifier, client_secret: client.client_secret!,
    })).resolves.toMatchObject({ token_type: "Bearer" });
  });

  it("refuses a rotation asked for with the old secret during its overlap", async () => {
    /** A leaked old secret that could rotate would let whoever holds it keep a working secret for good. */
    const client = await confidential();
    const first = await rotate({ client_id: client.client_id, client_secret: client.client_secret! });
    await expect(rotate({ client_id: client.client_id, client_secret: client.client_secret! }))
      .rejects.toMatchObject({ error: "invalid_client" });
    // The new one may rotate again, and that retires the oldest at once.
    const second = await rotate({ client_id: client.client_id, client_secret: first.client_secret });
    await expect(oauth.authenticateClient(db(), { client_id: client.client_id, client_secret: client.client_secret! }))
      .rejects.toMatchObject({ error: "invalid_client" });
    await expect(oauth.authenticateClient(db(), { client_id: client.client_id, client_secret: first.client_secret }))
      .resolves.toMatchObject({ confidential: true });
    await expect(oauth.authenticateClient(db(), { client_id: client.client_id, client_secret: second.client_secret }))
      .resolves.toMatchObject({ confidential: true });
  });

  it("shows the new secret once, keeps only its hash, and lets both work during the overlap", async () => {
    const client = await confidential();
    const { verifier, challenge } = verifierPair();
    const { code, appId } = await authorize(challenge, "read", client.client_id);
    const pair = await exchange({
      grant_type: "authorization_code", code, client_id: client.client_id, redirect_uri: REDIRECT,
      code_verifier: verifier, client_secret: client.client_secret!,
    });

    const rotated = await rotate({ client_id: client.client_id, client_secret: client.client_secret!, overlap_seconds: "600" });
    expect(rotated.client_secret).toMatch(/^ocs_/);
    expect(rotated.client_secret).not.toBe(client.client_secret);
    expect(rotated.previous_secret_expires_at! - Math.floor(Date.now() / 1000)).toBeGreaterThan(500);
    expect(rotated.previous_secret_expires_at! - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(600);

    const [row] = await raw<{ secret_hash: string; previous_secret_hash: string; secret_rotated_at: Date | null }[]>`
      select secret_hash, previous_secret_hash, secret_rotated_at from public.oauth_client where client_id = ${client.client_id}`;
    expect(row!.secret_hash).toBe(createHash("sha256").update(rotated.client_secret).digest("hex"));
    expect(row!.previous_secret_hash).toBe(createHash("sha256").update(client.client_secret!).digest("hex"));
    expect(JSON.stringify(row)).not.toContain(rotated.client_secret);
    expect(row!.secret_rotated_at).not.toBeNull();

    // Both work while the overlap runs: the old on one server, the new on the next.
    const next = await refreshWith(client, client.client_secret!, pair.refresh_token);
    await refreshWith(client, rotated.client_secret, next.refresh_token);

    // The company that connected it sees the rotation in its own log, and never the secret.
    const lines = await raw<{ after: Record<string, unknown> }[]>`select after from public.audit_log
      where organization_id = ${ORG} and action = 'app.oauth_secret_rotated' and entity_id = ${appId}`;
    expect(lines).toHaveLength(1);
    expect(lines[0]!.after).toMatchObject({ clientId: client.client_id });
    expect(JSON.stringify(lines[0]!.after)).not.toContain(rotated.client_secret);
  });

  it("stops the old secret once the overlap is over, and at once when no overlap was asked for", async () => {
    const leaked = await confidential();
    const fresh = await rotate({ client_id: leaked.client_id, client_secret: leaked.client_secret!, overlap_seconds: "0" });
    expect(fresh.previous_secret_expires_at).toBeNull();
    await expect(oauth.authenticateClient(db(), { client_id: leaked.client_id, client_secret: leaked.client_secret! }))
      .rejects.toMatchObject({ error: "invalid_client" });

    const rolling = await confidential();
    await rotate({ client_id: rolling.client_id, client_secret: rolling.client_secret! });
    await raw`update public.oauth_client set previous_secret_expires_at = now() - interval '1 second'
      where client_id = ${rolling.client_id}`;
    await expect(oauth.authenticateClient(db(), { client_id: rolling.client_id, client_secret: rolling.client_secret! }))
      .rejects.toMatchObject({ error: "invalid_client" });
  });

  it("answers over HTTP with the new secret, never cached", async () => {
    const client = await confidential();
    const response = await handleRotateSecret(new Request("http://x/api/oauth/client-secret", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ client_id: client.client_id, client_secret: client.client_secret! }).toString(),
    }), db());
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json() as oauth.RotatedSecret;
    expect(body.client_secret).toMatch(/^ocs_/);
    expect(body.client_id).toBe(client.client_id);
  });
});

run("handing a token back and ending the connection", () => {
  const revoke = (form: Record<string, string>) => oauth.revoke(db(), form, "198.51.100.8");

  it("refuses an end_connection that is not true or false, and changes nothing", async () => {
    const client = await register();
    const pair = await connect(client);
    await expect(revoke({ token: pair.refresh_token, client_id: client, end_connection: "yes" }))
      .rejects.toMatchObject({ error: "invalid_request" });
    expect(await apps.resolveToken(db(), pair.access_token)).not.toBeNull();
  });

  it("will not end another client's connection", async () => {
    const mine = await register();
    const theirs = await register();
    const pair = await connect(mine);
    await expect(revoke({ token: pair.refresh_token, client_id: theirs, end_connection: "true" }))
      .rejects.toMatchObject({ error: "unauthorized_client" });
    expect((await apps.list(owner())).find((a) => a.id === pair.appId)).toMatchObject({ status: "active" });
  });

  it("turns the app off with every token it holds, and says the app did it", async () => {
    const client = await register();
    const pair = await connect(client);
    const again = await exchange({ grant_type: "refresh_token", refresh_token: pair.refresh_token, client_id: client });
    await revoke({ token: again.access_token, client_id: client, end_connection: "true" });

    const app = (await apps.list(owner())).find((a) => a.id === pair.appId)!;
    expect(app.status).toBe("revoked");
    expect(app.revokedReason).toMatch(/disconnected itself/);
    expect(app.live).toBe(false);
    expect(await apps.resolveToken(db(), again.access_token)).toBeNull();
    await expect(exchange({ grant_type: "refresh_token", refresh_token: again.refresh_token, client_id: client }))
      .rejects.toMatchObject({ error: "invalid_grant" });
    const [line] = await raw<{ n: number }[]>`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'app.revoked' and entity_id = ${pair.appId}`;
    expect(line!.n).toBe(1);

    // A retry after a lost answer succeeds and writes nothing more.
    await revoke({ token: again.access_token, client_id: client, end_connection: "true" });
    const [after] = await raw<{ n: number }[]>`select count(*)::int as n from public.audit_log
      where organization_id = ${ORG} and action = 'app.revoked' and entity_id = ${pair.appId}`;
    expect(after!.n).toBe(1);
  });

  it("leaves the connection alone when end_connection is false or absent", async () => {
    const client = await register();
    const pair = await connect(client);
    await revoke({ token: pair.access_token, client_id: client, end_connection: "false" });
    expect((await apps.list(owner())).find((a) => a.id === pair.appId)).toMatchObject({ status: "active" });
  });
});
