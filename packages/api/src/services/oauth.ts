import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, isNull, inArray, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import {
  oauth as rules, permissionsFor, effectiveScope, canDefineRole, SCOPED_RESOURCES, SYSTEM_USER_ID,
  type Permission, type Scope, type ScopedResource,
} from "@opentradesos/core";
import {
  audit, guardedWrite, inTenant, ConflictError, TooManyRequestsError, type ServiceContext,
} from "./context";
import { hashToken, mintToken } from "./apps";

/**
 * OAUTH FOR REMOTE MCP CLIENTS
 *
 * A remote MCP client (a hosted assistant, an editor on somebody's laptop)
 * reaches `/api/mcp` and needs a credential. Handing a person an app token to
 * paste is how the stdio transport works and is a poor way to connect a hosted
 * client: the token is long lived, it is copied through a clipboard, and the
 * client has no way to refresh it. The MCP authorization specification says
 * how this should go instead, and this file is the server side of it:
 *
 *   1. The client registers itself (RFC 7591) and gets a `client_id`. That
 *      grants nothing.
 *   2. It sends the person to `/oauth/authorize` with the scopes it wants and
 *      a PKCE challenge. The person, signed in to their company, sees what
 *      the scopes mean in plain words and approves or refuses.
 *   3. Approval makes the client a connected app of that company, through the
 *      same authority check as installing one by hand, and hands the browser a
 *      one time code.
 *   4. The client exchanges the code and the PKCE verifier for an hour long
 *      access token and a refresh token.
 *
 * THE ACCESS TOKEN IS AN APP TOKEN. Not a new kind of credential: the same
 * `ots_` token the HTTP API and the MCP endpoint already resolve, with the
 * same revocation in the same SQL. So everything a remote MCP client can do
 * is decided by the connected app row an operator can see on the
 * Applications screen and turn off, and nothing downstream knows OAuth was
 * involved.
 *
 * Errors come back in OAuth's own shape (`error`, `error_description`)
 * because the clients reading them are OAuth clients and branch on `error`.
 */

export class OAuthError extends Error {
  constructor(
    readonly error: string,
    readonly description: string,
    readonly status = 400,
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

const sha256hex = (value: string) => createHash("sha256").update(value).digest("hex");
const s256 = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");

/** Per network address per hour, for the two doors a stranger can knock on. */
const REGISTRATIONS_PER_ADDRESS = 30;
const TOKEN_CALLS_PER_ADDRESS = 600;

async function throttle(db: Database, key: string, limit: number): Promise<void> {
  const [row] = await db.execute<{ hits: number }>(sql`select app.count_public_hit(${key}, ${3600}) as hits`);
  if (Number(row?.hits ?? 0) > limit) throw new TooManyRequestsError(3600);
}

/* ---------------------------------------------------------- registration */

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: "none";
}

/**
 * RFC 7591 dynamic registration, for public clients only.
 *
 * No client secret is issued, ever. Every MCP client is a public client in
 * OAuth's sense: it runs on somebody's machine or in somebody else's service,
 * and a secret baked into it is a secret everybody with a copy holds. PKCE is
 * what stands in for it, and it is required on every authorization.
 */
export async function registerClient(
  db: Database,
  body: Record<string, unknown>,
  from?: string,
): Promise<RegisteredClient> {
  await throttle(db, `oauth-register:addr:${from ?? "unknown"}`, REGISTRATIONS_PER_ADDRESS);

  const uris = body["redirect_uris"];
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10
    || !uris.every((u): u is string => typeof u === "string" && u.length <= 1000)) {
    throw new OAuthError("invalid_redirect_uri", "redirect_uris must be a list of one to ten addresses.");
  }
  for (const uri of uris) {
    const problem = rules.redirectUriProblem(uri);
    if (problem) throw new OAuthError("invalid_redirect_uri", problem);
  }

  const method = body["token_endpoint_auth_method"];
  if (method !== undefined && method !== "none") {
    throw new OAuthError(
      "invalid_client_metadata",
      "Only public clients are registered here: token_endpoint_auth_method must be none, and PKCE is required.",
    );
  }
  const grants = body["grant_types"];
  if (grants !== undefined) {
    const allowed = new Set(["authorization_code", "refresh_token"]);
    if (!Array.isArray(grants) || !grants.every((g) => typeof g === "string" && allowed.has(g))) {
      throw new OAuthError("invalid_client_metadata", "Only authorization_code and refresh_token are supported.");
    }
  }

  const rawName = typeof body["client_name"] === "string" ? body["client_name"].trim() : "";
  const name = rawName === "" ? "An MCP client that did not name itself" : rawName.slice(0, 200);
  const clientId = `mcp_${randomBytes(18).toString("base64url")}`;

  await db.execute(sql`select app.oauth_register_client(
    ${clientId}, ${name}, ${JSON.stringify(uris)}::jsonb, ${from ?? null})`);

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: [...uris],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

export async function findClient(
  db: Database, clientId: string,
): Promise<{ clientId: string; name: string; redirectUris: string[] } | null> {
  const [row] = await db.execute<{ client_id: string; name: string; redirect_uris: string[] }>(
    sql`select * from app.oauth_client(${clientId})`,
  );
  return row ? { clientId: row.client_id, name: row.name, redirectUris: row.redirect_uris } : null;
}

/* --------------------------------------------------------- authorization */

export interface AuthorizeParams {
  response_type?: string | undefined;
  client_id?: string | undefined;
  redirect_uri?: string | undefined;
  scope?: string | undefined;
  state?: string | undefined;
  code_challenge?: string | undefined;
  code_challenge_method?: string | undefined;
  resource?: string | undefined;
}

/**
 * What an authorization request comes to, before anybody is asked.
 *
 * `stop`      the client or its address cannot be trusted, so nothing is sent
 *             back to it: RFC 6749 is explicit that an unknown client or an
 *             unregistered address must not be redirected to, because that
 *             is how a server becomes an open redirector.
 * `bounce`    the address is fine and the request is not, so the client is
 *             told why at its own address.
 * `ask`       a well formed request, ready for the consent page.
 */
export type AuthorizeCheck =
  | { kind: "stop"; message: string }
  | { kind: "bounce"; to: string }
  | {
    kind: "ask";
    client: { clientId: string; name: string };
    redirectUri: string;
    scopes: string[];
    state: string | null;
    codeChallenge: string;
    resource: string | null;
  };

export function errorRedirect(redirectUri: string, error: string, description: string, state?: string | null): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state) url.searchParams.set("state", state);
  return url.toString();
}

export async function checkAuthorization(db: Database, params: AuthorizeParams): Promise<AuthorizeCheck> {
  if (!params.client_id) return { kind: "stop", message: "The application did not say who it is (no client_id)." };
  const client = await findClient(db, params.client_id);
  if (!client) {
    return { kind: "stop", message: "This application is not registered here. Ask its maker to connect it again." };
  }
  const redirectUri = params.redirect_uri
    ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : undefined);
  if (!redirectUri || !rules.redirectUriMatches(redirectUri, client.redirectUris)) {
    return {
      kind: "stop",
      message: "The address this application wants the answer sent to is not one it registered, so nothing is sent.",
    };
  }
  const state = params.state ?? null;
  const bounce = (error: string, description: string): AuthorizeCheck =>
    ({ kind: "bounce", to: errorRedirect(redirectUri, error, description, state) });

  if (params.response_type !== "code") return bounce("unsupported_response_type", "Only response_type=code is supported.");
  if (!params.code_challenge) return bounce("invalid_request", "PKCE is required: send code_challenge.");
  if ((params.code_challenge_method ?? "plain") !== rules.CHALLENGE_METHOD) {
    return bounce("invalid_request", "Only code_challenge_method=S256 is accepted.");
  }
  if (!rules.isChallenge(params.code_challenge)) {
    return bounce("invalid_request", "code_challenge must be a base64url SHA-256, 43 characters.");
  }
  const scopes = rules.parseScope(params.scope);
  const unknown = rules.resolveScopes(scopes, new Set()).unknown;
  if (unknown.length > 0) return bounce("invalid_scope", `Unknown scope: ${unknown.join(", ")}.`);

  return {
    kind: "ask",
    client: { clientId: client.clientId, name: client.name },
    redirectUri,
    scopes,
    state,
    codeChallenge: params.code_challenge,
    resource: params.resource ?? null,
  };
}

/**
 * The person said yes. Make (or update) the connected app and hand the
 * browser a code.
 *
 * ONE APP PER CLIENT PER COMPANY. Authorizing the same client again replaces
 * its grant with what was just approved, rather than leaving a second app
 * nobody can tell from the first. Its record reach is the approver's own on
 * every resource, which is what "connect this assistant as me" means and
 * which `canDefineRole` accepts by construction; its permissions are the
 * scopes cut down to what the approver holds, which the consent page showed.
 */
export async function approveAuthorization(
  ctx: ServiceContext,
  request: Extract<AuthorizeCheck, { kind: "ask" }>,
): Promise<{ redirectTo: string; appId: string }> {
  const held = permissionsFor(ctx.actor);
  const resolution = rules.resolveScopes(request.scopes, held);
  if (resolution.unknown.length > 0) {
    throw new ConflictError(`Unknown scope: ${resolution.unknown.join(", ")}`);
  }
  if (resolution.granted.length === 0) {
    throw new ConflictError("You hold none of what this application asks for, so there is nothing you can give it.");
  }
  const scopes: Partial<Record<ScopedResource, Scope>> = {};
  for (const resource of SCOPED_RESOURCES) scopes[resource] = effectiveScope(ctx.actor, resource);
  const decision = canDefineRole(ctx.actor, { permissions: resolution.granted, scopes });
  if (!decision.ok) throw new ConflictError("That grant is wider than your own access.");

  return guardedWrite(ctx, "integration:write", async (tx) => {
    const now = new Date();
    const [existing] = await tx.select().from(schema.connectedApp)
      .where(and(
        eq(schema.connectedApp.oauthClientId, request.client.clientId),
        eq(schema.connectedApp.status, "active"),
      )).limit(1);

    let appId: string;
    if (existing) {
      const [after] = await tx.update(schema.connectedApp).set({
        permissions: resolution.granted,
        scopes: scopes as Record<string, string>,
        approvedByUserId: ctx.actor.userId,
        approvedAt: now,
        updatedAt: now,
      }).where(eq(schema.connectedApp.id, existing.id)).returning();
      await audit(tx, ctx, "app.oauth_reauthorized", "connectedApp", existing.id, existing, after);
      appId = existing.id;
    } else {
      const [created] = await tx.insert(schema.connectedApp).values({
        organizationId: ctx.actor.organizationId,
        name: request.client.name,
        description: "Connected through OAuth by a remote MCP client.",
        status: "active",
        source: "oauth",
        oauthClientId: request.client.clientId,
        redirectUri: request.redirectUri,
        permissions: resolution.granted,
        scopes: scopes as Record<string, string>,
        requestedByUserId: ctx.actor.userId,
        approvedByUserId: ctx.actor.userId,
        approvedAt: now,
      }).returning();
      await audit(tx, ctx, "app.oauth_authorized", "connectedApp", created!.id, null, created);
      appId = created!.id;
    }

    const code = randomBytes(32).toString("base64url");
    await tx.insert(schema.oauthCode).values({
      organizationId: ctx.actor.organizationId,
      appId,
      clientId: request.client.clientId,
      codeHash: sha256hex(code),
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      scope: request.scopes.join(" "),
      resource: request.resource,
      approvedByUserId: ctx.actor.userId,
      expiresAt: new Date(now.getTime() + rules.CODE_TTL_MS),
    });

    const url = new URL(request.redirectUri);
    url.searchParams.set("code", code);
    if (request.state) url.searchParams.set("state", request.state);
    return { redirectTo: url.toString(), appId };
  });
}

/** The person said no. Nothing is written; the client is told at its own address. */
export function refuseAuthorization(request: Extract<AuthorizeCheck, { kind: "ask" }>): string {
  return errorRedirect(request.redirectUri, "access_denied", "The person you asked said no.", request.state);
}

/* ------------------------------------------------------------- the token */

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

const systemCtx = (db: Database, organizationId: string, appId: string): ServiceContext => ({
  actor: { userId: SYSTEM_USER_ID, organizationId, roles: [] },
  db,
  agentId: `app:${appId}`,
});

/**
 * Revoke everything one authorization produced: every refresh token in the
 * family and every access token issued beside them. What a replayed code or
 * a reused refresh token sets off, because either means two parties hold
 * something only one should.
 */
async function burnFamily(tx: Database, familyId: string, extraTokenId: string | null): Promise<void> {
  const now = new Date();
  const family = await tx.update(schema.oauthRefreshToken)
    .set({ revokedAt: now })
    .where(eq(schema.oauthRefreshToken.familyId, familyId))
    .returning({ accessTokenId: schema.oauthRefreshToken.accessTokenId });
  const tokenIds = [
    ...family.map((row) => row.accessTokenId).filter((id): id is string => id !== null),
    ...(extraTokenId ? [extraTokenId] : []),
  ];
  if (tokenIds.length > 0) {
    await tx.update(schema.appToken).set({ revokedAt: now })
      .where(and(inArray(schema.appToken.id, tokenIds), isNull(schema.appToken.revokedAt)));
  }
}

async function issuePair(
  tx: Database, ctx: ServiceContext,
  input: { appId: string; clientId: string; familyId: string; scope: string },
): Promise<{ response: TokenResponse; accessTokenId: string }> {
  const now = Date.now();
  const access = await mintToken(tx, ctx, {
    appId: input.appId,
    label: "OAuth access token",
    expiresAt: new Date(now + rules.ACCESS_TTL_SECONDS * 1000),
  });
  const refresh = `otr_${randomBytes(32).toString("base64url")}`;
  await tx.insert(schema.oauthRefreshToken).values({
    organizationId: ctx.actor.organizationId,
    appId: input.appId,
    clientId: input.clientId,
    familyId: input.familyId,
    tokenHash: hashToken(refresh),
    scope: input.scope,
    expiresAt: new Date(now + rules.REFRESH_TTL_MS),
    accessTokenId: access.id,
  });
  return {
    accessTokenId: access.id,
    response: {
      access_token: access.token,
      token_type: "Bearer",
      expires_in: rules.ACCESS_TTL_SECONDS,
      refresh_token: refresh,
      scope: input.scope,
    },
  };
}

/**
 * The token endpoint. Takes the form fields as sent and answers with a token
 * pair or an `OAuthError`.
 *
 * Every refusal of a code is the same `invalid_grant`, with a description
 * saying which check failed. The descriptions are for the developer of the
 * client and name nothing about the company: a stranger holding a code learns
 * only that it does not work.
 */
export async function exchange(
  db: Database, form: Record<string, string | undefined>, from?: string,
): Promise<TokenResponse> {
  await throttle(db, `oauth-token:addr:${from ?? "unknown"}`, TOKEN_CALLS_PER_ADDRESS);
  const grant = form["grant_type"];
  if (grant === "authorization_code") return redeemCode(db, form);
  if (grant === "refresh_token") return refresh(db, form);
  throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
}

async function redeemCode(db: Database, form: Record<string, string | undefined>): Promise<TokenResponse> {
  const code = form["code"];
  const clientId = form["client_id"];
  const verifier = form["code_verifier"];
  if (!code || !clientId) throw new OAuthError("invalid_request", "code and client_id are required.");
  if (!verifier) throw new OAuthError("invalid_request", "PKCE is required: send code_verifier.");
  if (!rules.isVerifier(verifier)) {
    throw new OAuthError("invalid_request", "code_verifier must be 43 to 128 characters of A-Z a-z 0-9 - . _ ~");
  }

  const hash = sha256hex(code);
  const [found] = await db.execute<{ organization_id: string | null }>(
    sql`select app.oauth_code_organization(${hash}) as organization_id`,
  );
  const organizationId = found?.organization_id;
  if (!organizationId) throw new OAuthError("invalid_grant", "That code is not valid.");

  /**
   * A refusal that must also REVOKE has to commit. Throwing inside the
   * transaction would roll back the revocation along with everything else,
   * so the transaction returns the refusal and it is thrown after.
   */
  const outcome = await inTenant(
    { actor: { userId: SYSTEM_USER_ID, organizationId, roles: [] }, db },
    async (tx): Promise<TokenResponse | OAuthError> => {
      const [row] = await tx.select().from(schema.oauthCode)
        .where(eq(schema.oauthCode.codeHash, hash)).for("update").limit(1);
      if (!row) return new OAuthError("invalid_grant", "That code is not valid.");
      const ctx = systemCtx(db, organizationId, row.appId);

      if (row.usedAt) {
        /**
         * RFC 6749 section 4.1.2: a code presented twice means it leaked, and
         * whatever the first exchange produced should die with it.
         */
        if (row.familyId) await burnFamily(tx, row.familyId, row.issuedTokenId);
        await audit(tx, ctx, "app.oauth_code_replayed", "connectedApp", row.appId, null, { codeId: row.id });
        return new OAuthError("invalid_grant", "That code has already been used. Everything it produced has been revoked.");
      }
      if (row.clientId !== clientId) return new OAuthError("invalid_grant", "That code was issued to another client.");
      if (form["redirect_uri"] !== undefined && form["redirect_uri"] !== row.redirectUri) {
        return new OAuthError("invalid_grant", "redirect_uri does not match the one the code was sent to.");
      }
      if (row.expiresAt.getTime() <= Date.now()) return new OAuthError("invalid_grant", "That code has expired.");
      if (!rules.sameString(s256(verifier), row.codeChallenge)) {
        return new OAuthError("invalid_grant", "code_verifier does not match the code_challenge.");
      }
      if (row.resource && form["resource"] !== undefined && form["resource"] !== row.resource) {
        return new OAuthError("invalid_target", "resource does not match the one the code was issued for.");
      }
      const [app] = await tx.select({ status: schema.connectedApp.status })
        .from(schema.connectedApp).where(eq(schema.connectedApp.id, row.appId)).limit(1);
      if (app?.status !== "active") return new OAuthError("invalid_grant", "This connection has been turned off.");

      const familyId = randomUUID();
      const { response, accessTokenId } = await issuePair(tx, ctx, {
        appId: row.appId, clientId, familyId, scope: row.scope,
      });
      await tx.update(schema.oauthCode).set({ usedAt: new Date(), issuedTokenId: accessTokenId, familyId })
        .where(eq(schema.oauthCode.id, row.id));
      return response;
    },
  );
  if (outcome instanceof OAuthError) throw outcome;
  return outcome;
}

async function refresh(db: Database, form: Record<string, string | undefined>): Promise<TokenResponse> {
  const token = form["refresh_token"];
  const clientId = form["client_id"];
  if (!token || !clientId) throw new OAuthError("invalid_request", "refresh_token and client_id are required.");

  const hash = hashToken(token);
  const [found] = await db.execute<{ organization_id: string | null }>(
    sql`select app.oauth_refresh_organization(${hash}) as organization_id`,
  );
  const organizationId = found?.organization_id;
  if (!organizationId) throw new OAuthError("invalid_grant", "That refresh token is not valid.");

  const outcome = await inTenant(
    { actor: { userId: SYSTEM_USER_ID, organizationId, roles: [] }, db },
    async (tx): Promise<TokenResponse | OAuthError> => {
      const [row] = await tx.select().from(schema.oauthRefreshToken)
        .where(eq(schema.oauthRefreshToken.tokenHash, hash)).for("update").limit(1);
      if (!row) return new OAuthError("invalid_grant", "That refresh token is not valid.");
      const ctx = systemCtx(db, organizationId, row.appId);

      if (row.clientId !== clientId) return new OAuthError("invalid_grant", "That refresh token belongs to another client.");
      if (row.revokedAt) return new OAuthError("invalid_grant", "That refresh token has been revoked.");
      if (row.usedAt) {
        await burnFamily(tx, row.familyId, null);
        await audit(tx, ctx, "app.oauth_refresh_reused", "connectedApp", row.appId, null, { familyId: row.familyId });
        return new OAuthError(
          "invalid_grant",
          "That refresh token was already used, so two parties hold it. Every token from this connection has been revoked; connect again.",
        );
      }
      if (row.expiresAt.getTime() <= Date.now()) return new OAuthError("invalid_grant", "That refresh token has expired.");
      const [app] = await tx.select({ status: schema.connectedApp.status })
        .from(schema.connectedApp).where(eq(schema.connectedApp.id, row.appId)).limit(1);
      if (app?.status !== "active") return new OAuthError("invalid_grant", "This connection has been turned off.");

      const now = new Date();
      await tx.update(schema.oauthRefreshToken).set({ usedAt: now })
        .where(eq(schema.oauthRefreshToken.id, row.id));
      // The access token beside the old refresh token goes too: one live pair per family.
      if (row.accessTokenId) {
        await tx.update(schema.appToken).set({ revokedAt: now })
          .where(and(eq(schema.appToken.id, row.accessTokenId), isNull(schema.appToken.revokedAt)));
      }
      const { response } = await issuePair(tx, ctx, {
        appId: row.appId, clientId, familyId: row.familyId, scope: row.scope,
      });
      return response;
    },
  );
  if (outcome instanceof OAuthError) throw outcome;
  return outcome;
}

/* ------------------------------------------------------------- discovery */

/**
 * RFC 8414. Where the endpoints are and what they accept. The issuer is the
 * instance's own origin, which is also what a client was pointed at.
 */
export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: [rules.CHALLENGE_METHOD],
    token_endpoint_auth_methods_supported: ["none"],
    scopes_supported: rules.supportedScopes(),
    service_documentation: "https://opentradesos.com/docs",
  };
}

/** RFC 9728. What the MCP endpoint is and who issues tokens for it. */
export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}/api/mcp`,
    authorization_servers: [origin],
    scopes_supported: rules.supportedScopes(),
    bearer_methods_supported: ["header"],
    resource_name: "OpenTradesOS MCP server",
  };
}

/** What the person on the consent page is shown: the scopes expanded against what they hold. */
export function consentFor(scopes: readonly string[], held: ReadonlySet<Permission>) {
  const resolution = rules.resolveScopes(scopes, held);
  return {
    bundles: scopes
      .filter((name) => name in rules.SCOPE_BUNDLES)
      .map((name) => ({ name, label: rules.SCOPE_BUNDLES[name]!.label })),
    granted: resolution.granted.map((permission) => ({
      permission, label: rules.describePermission(permission), sensitive: rules.isSensitive(permission),
    })),
    withheld: resolution.withheld.map((permission) => ({
      permission, label: rules.describePermission(permission),
    })),
  };
}
