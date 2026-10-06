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
 *
 * A client can also hand a token back (RFC 7009, `revoke`) and ask whether
 * one is still good (RFC 7662, `introspect`). Most clients are public and
 * prove nothing but their id; a client that runs on its maker's own server
 * can register as confidential, and is then held to its secret at every
 * endpoint that takes one, on top of PKCE rather than instead of it.
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

/** Per network address per hour, for the doors a stranger can knock on. */
const REGISTRATIONS_PER_ADDRESS = 30;
const TOKEN_CALLS_PER_ADDRESS = 600;

async function throttle(db: Database, key: string, limit: number): Promise<void> {
  const [row] = await db.execute<{ hits: number }>(sql`select app.count_public_hit(${key}, ${3600}) as hits`);
  if (Number(row?.hits ?? 0) > limit) throw new TooManyRequestsError(3600);
}

/* ---------------------------------------------------------- registration */

/**
 * How a client proves who it is. `none` is a public client: it runs on
 * somebody's laptop or in a browser, anything baked into it is held by
 * everybody with a copy, and PKCE is what stands in for a secret. The other
 * two are a confidential client sending its secret in the `Authorization`
 * header or in the form, which RFC 6749 section 2.3.1 names.
 */
export const AUTH_METHODS = ["none", "client_secret_basic", "client_secret_post"] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];
const isAuthMethod = (value: unknown): value is AuthMethod =>
  typeof value === "string" && (AUTH_METHODS as readonly string[]).includes(value);

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  grant_types: string[];
  response_types: string[];
  token_endpoint_auth_method: AuthMethod;
  /** A confidential client's secret, in this answer and never again. */
  client_secret?: string;
  /** Zero: a secret does not run out. A leaked one is ended by registering again. */
  client_secret_expires_at?: number;
}

/**
 * RFC 7591 dynamic registration.
 *
 * Public by default, and that is what every MCP client on a person's machine
 * should be: a secret baked into a desktop app is a secret everybody with a
 * copy holds. A client running on its maker's server can ask to be
 * confidential (`client_secret_basic` or `client_secret_post`), and is
 * handed a secret here, once. Only its hash is kept, and from then on the
 * token, revocation and introspection endpoints refuse that client without
 * it. PKCE is still required of it, because the secret proves which client
 * is calling and PKCE proves the code was asked for by the same one.
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

  const asked = body["token_endpoint_auth_method"];
  if (asked !== undefined && !isAuthMethod(asked)) {
    throw new OAuthError(
      "invalid_client_metadata",
      "token_endpoint_auth_method must be none (a public client, held to PKCE), client_secret_basic or client_secret_post.",
    );
  }
  const method: AuthMethod = asked ?? "none";
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
  // 256 bits, like every other credential here. Shown once.
  const secret = method === "none" ? null : `ocs_${randomBytes(32).toString("base64url")}`;

  await db.execute(sql`select app.oauth_register_client(
    ${clientId}, ${name}, ${JSON.stringify(uris)}::jsonb, ${from ?? null},
    ${method}, ${secret === null ? null : sha256hex(secret)})`);

  return {
    client_id: clientId,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    client_name: name,
    redirect_uris: [...uris],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: method,
    ...(secret === null ? {} : { client_secret: secret, client_secret_expires_at: 0 }),
  };
}

export async function findClient(
  db: Database, clientId: string,
): Promise<{ clientId: string; name: string; redirectUris: string[]; authMethod: AuthMethod } | null> {
  const [row] = await db.execute<{ client_id: string; name: string; redirect_uris: string[]; auth_method: string }>(
    sql`select * from app.oauth_client(${clientId})`,
  );
  if (!row) return null;
  return {
    clientId: row.client_id,
    name: row.name,
    redirectUris: row.redirect_uris,
    authMethod: isAuthMethod(row.auth_method) ? row.auth_method : "none",
  };
}

/* ------------------------------------------------- who is calling, proven */

/**
 * What a client sent to prove who it is, as the HTTP layer found it: the
 * `Authorization` header, if any, beside the form.
 */
export interface ClientCredentials {
  authorization?: string | null | undefined;
}

/** `Basic base64(client_id:client_secret)`, each half form encoded first, by RFC 6749 section 2.3.1. */
function basicCredentials(header: string | null | undefined): { id: string; secret: string } | null {
  if (!header || !/^basic /i.test(header.trim())) return null;
  const decoded = Buffer.from(header.trim().slice(6).trim(), "base64").toString("utf8");
  const colon = decoded.indexOf(":");
  if (colon < 1) throw new OAuthError("invalid_client", "The Basic credentials are not client_id:client_secret.", 401);
  const unform = (value: string) => {
    try {
      return decodeURIComponent(value.replace(/\+/g, " "));
    } catch {
      throw new OAuthError("invalid_client", "The Basic credentials are not form encoded.", 401);
    }
  };
  return { id: unform(decoded.slice(0, colon)), secret: unform(decoded.slice(colon + 1)) };
}

/**
 * The client making this call, proven as far as its kind allows.
 *
 * A public client names itself and that is all it can do; what it may then
 * do is limited to its own codes and tokens, which it can only have if it is
 * who it says. A confidential client must present its secret, by either of
 * the two methods, and a wrong or missing one is `invalid_client` with a 401
 * whichever it registered with. Both methods at once is refused, because
 * RFC 6749 allows one, and a public client presenting a secret is refused
 * rather than ignored: it is a client that believes it is something it is
 * not, and the next thing it does will not work either.
 *
 * Every refusal is the same `invalid_client` a stranger gets, so an unknown
 * id and a wrong secret cannot be told apart from outside.
 */
export async function authenticateClient(
  db: Database, form: Record<string, string | undefined>, credentials: ClientCredentials = {},
): Promise<{ clientId: string; confidential: boolean }> {
  const basic = basicCredentials(credentials.authorization);
  const postedSecret = form["client_secret"];
  if (basic && postedSecret !== undefined) {
    throw new OAuthError("invalid_request", "Send the client secret one way, in the Authorization header or in the form, not both.");
  }
  if (basic && form["client_id"] !== undefined && form["client_id"] !== basic.id) {
    throw new OAuthError("invalid_client", "The client_id in the form is not the one in the Authorization header.", 401);
  }
  const clientId = basic?.id ?? form["client_id"];
  if (!clientId) throw new OAuthError("invalid_request", "client_id is required.");
  const secret = basic?.secret ?? postedSecret;

  const client = await findClient(db, clientId);
  if (!client) throw new OAuthError("invalid_client", "This client is not registered here.", 401);
  if (client.authMethod === "none") {
    if (secret !== undefined) {
      throw new OAuthError("invalid_client", "This client registered as public and has no secret. Send its client_id alone.", 401);
    }
    return { clientId, confidential: false };
  }
  if (secret === undefined || secret === "") {
    throw new OAuthError("invalid_client", "This client registered with a secret, and it was not sent.", 401);
  }
  const [match] = await db.execute<{ ok: boolean }>(
    sql`select app.oauth_client_secret_matches(${clientId}, ${sha256hex(secret)}) as ok`,
  );
  if (match?.ok !== true) throw new OAuthError("invalid_client", "The client secret is not right.", 401);
  return { clientId, confidential: true };
}

/* --------------------------------------------------------- authorization */

/** The parameters an authorization request is made of, and the only ones the consent page carries forward. */
export const AUTHORIZE_PARAMS = [
  "response_type", "client_id", "redirect_uri", "scope", "state", "code_challenge", "code_challenge_method", "resource",
] as const;

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
  choice: { permissions?: readonly string[] | undefined } = {},
): Promise<{ redirectTo: string; appId: string }> {
  const held = permissionsFor(ctx.actor);
  const resolution = rules.resolveScopes(request.scopes, held);
  if (resolution.unknown.length > 0) {
    throw new ConflictError(`Unknown scope: ${resolution.unknown.join(", ")}`);
  }
  if (resolution.granted.length === 0) {
    throw new ConflictError("You hold none of what this application asks for, so there is nothing you can give it.");
  }
  /**
   * NARROWED ON THE CONSENT PAGE. The person may untick anything the client
   * asked for, and the app gets what is left. Only ever narrower: a
   * permission that was not on the page (not asked for, or cut because the
   * approver does not hold it) is refused rather than granted, because the
   * form is posted by a browser and a browser can post anything.
   */
  const narrowed = choice.permissions === undefined ? null : rules.narrowGrant(resolution.granted, choice.permissions);
  if (narrowed && !narrowed.ok) throw new ConflictError(narrowed.message);
  const granted = narrowed ? narrowed.granted : resolution.granted;
  const scopes: Partial<Record<ScopedResource, Scope>> = {};
  for (const resource of SCOPED_RESOURCES) scopes[resource] = effectiveScope(ctx.actor, resource);
  const decision = canDefineRole(ctx.actor, { permissions: granted, scopes });
  if (!decision.ok) throw new ConflictError("That grant is wider than your own access.");
  /**
   * The scope the token answers with. As asked, when the person gave all of
   * what the page showed; the permissions themselves, space separated, when
   * they narrowed it, because RFC 6749 section 3.3 says a client must be told
   * when it got less than it asked for, and "jobs" would no longer be true.
   */
  const approvedScope = narrowed && narrowed.granted.length < resolution.granted.length
    ? narrowed.granted.join(" ")
    : request.scopes.join(" ");

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
        permissions: granted,
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
        permissions: granted,
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
      scope: approvedScope,
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
  db: Database, form: Record<string, string | undefined>, from?: string, credentials: ClientCredentials = {},
): Promise<TokenResponse> {
  await throttle(db, `oauth-token:addr:${from ?? "unknown"}`, TOKEN_CALLS_PER_ADDRESS);
  const grant = form["grant_type"];
  if (grant !== "authorization_code" && grant !== "refresh_token") {
    throw new OAuthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token.");
  }
  const { clientId } = await authenticateClient(db, form, credentials);
  return grant === "authorization_code" ? redeemCode(db, form, clientId) : refresh(db, form, clientId);
}

async function redeemCode(db: Database, form: Record<string, string | undefined>, clientId: string): Promise<TokenResponse> {
  const code = form["code"];
  const verifier = form["code_verifier"];
  if (!code) throw new OAuthError("invalid_request", "code is required.");
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

async function refresh(db: Database, form: Record<string, string | undefined>, clientId: string): Promise<TokenResponse> {
  const token = form["refresh_token"];
  if (!token) throw new OAuthError("invalid_request", "refresh_token is required.");

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

/* ---------------------------------------------- handing a token back */

/** Where a token presented to revocation or introspection was found, if anywhere. */
type FoundToken =
  | { kind: "refresh"; organizationId: string; hash: string }
  | { kind: "access"; organizationId: string; hash: string }
  | null;

/**
 * Which of this server's tokens a string is, by the hint first and then the
 * other kind. A hint is advice (RFC 7009 section 2.1 lets a server ignore a
 * wrong one), so a refresh token sent as `access_token` is still found. The
 * prefixes would answer it too, and are not trusted to, because a token is
 * whatever its hash finds.
 */
async function findToken(db: Database, token: string, hint: string | undefined): Promise<FoundToken> {
  const hash = hashToken(token);
  const asRefresh = async (): Promise<FoundToken> => {
    const [row] = await db.execute<{ organization_id: string | null }>(
      sql`select app.oauth_refresh_organization(${hash}) as organization_id`,
    );
    return row?.organization_id ? { kind: "refresh", organizationId: row.organization_id, hash } : null;
  };
  const asAccess = async (): Promise<FoundToken> => {
    const [row] = await db.execute<{ organization_id: string | null }>(
      sql`select app.oauth_access_organization(${hash}) as organization_id`,
    );
    return row?.organization_id ? { kind: "access", organizationId: row.organization_id, hash } : null;
  };
  return hint === "access_token"
    ? (await asAccess()) ?? (await asRefresh())
    : (await asRefresh()) ?? (await asAccess());
}

/**
 * RFC 7009. A client hands back a token it no longer wants: the person
 * pressed disconnect in the assistant, or it is tidying up after itself.
 *
 * A refresh token takes its whole family with it, every refresh token and
 * every access token descended from the same approval, because the RFC asks
 * that revoking a refresh token end what it can produce, and a family is
 * exactly that. An access token is ended alone, and the refresh token beside
 * it can still make a new one; that is what handing back one access token
 * means. The connected app itself stays on the company's Applications screen,
 * with nothing live, until somebody there turns it off or the client is
 * approved again.
 *
 * A token that was never issued, has already gone, or is not an OAuth token
 * at all is answered with the same success (section 2.2), so the answer says
 * nothing about what exists. A token another client holds is refused: it can
 * only have been taken from that client, and the RFC says to refuse it.
 */
export async function revoke(
  db: Database, form: Record<string, string | undefined>, from?: string, credentials: ClientCredentials = {},
): Promise<void> {
  await throttle(db, `oauth-revoke:addr:${from ?? "unknown"}`, TOKEN_CALLS_PER_ADDRESS);
  const client = await authenticateClient(db, form, credentials);
  const token = form["token"];
  if (!token) throw new OAuthError("invalid_request", "token is required.");

  const found = await findToken(db, token, form["token_type_hint"]);
  if (!found) return;

  const outcome = await inTenant(
    { actor: { userId: SYSTEM_USER_ID, organizationId: found.organizationId, roles: [] }, db },
    async (tx): Promise<OAuthError | null> => {
      if (found.kind === "refresh") {
        const [row] = await tx.select().from(schema.oauthRefreshToken)
          .where(eq(schema.oauthRefreshToken.tokenHash, found.hash)).for("update").limit(1);
        if (!row) return null;
        if (row.clientId !== client.clientId) return new OAuthError("unauthorized_client", "That token was issued to another client.");
        if (row.revokedAt) return null;
        await burnFamily(tx, row.familyId, null);
        await audit(tx, systemCtx(db, found.organizationId, row.appId), "app.oauth_token_revoked", "connectedApp", row.appId,
          null, { kind: "refresh_token", familyId: row.familyId, by: "client" });
        return null;
      }
      const [row] = await tx.select({ token: schema.appToken, clientId: schema.connectedApp.oauthClientId })
        .from(schema.appToken)
        .innerJoin(schema.connectedApp, eq(schema.connectedApp.id, schema.appToken.appId))
        .where(eq(schema.appToken.tokenHash, found.hash)).for("update", { of: schema.appToken }).limit(1);
      if (!row) return null;
      if (row.clientId !== client.clientId) return new OAuthError("unauthorized_client", "That token was issued to another client.");
      if (row.token.revokedAt) return null;
      await tx.update(schema.appToken).set({ revokedAt: new Date() }).where(eq(schema.appToken.id, row.token.id));
      await audit(tx, systemCtx(db, found.organizationId, row.token.appId), "app.oauth_token_revoked", "appToken", row.token.id,
        null, { kind: "access_token", appId: row.token.appId, by: "client" });
      return null;
    },
  );
  if (outcome) throw outcome;
}

/** RFC 7662's answer. `active: false` and nothing else for anything not live. */
export type Introspection =
  | { active: false }
  | {
    active: true;
    client_id: string;
    scope: string;
    token_type: "Bearer" | "refresh_token";
    exp: number;
    iat: number;
    iss: string;
  };

const seconds = (at: Date) => Math.floor(at.getTime() / 1000);

/**
 * RFC 7662. Whether a token is live, for the client that holds it.
 *
 * Asked by the client itself, authenticated as at the token endpoint: a
 * confidential client with its secret, a public one with its id. The answer
 * is about the caller's own tokens and nobody else's. A token of another
 * client, a token that ran out, was revoked, was used up by a refresh, or
 * belongs to an app the company turned off, is `active: false` and nothing
 * more, which is what section 2.2 asks for, so this cannot be used to learn
 * anything about a token the caller does not already hold.
 *
 * Live means what the MCP endpoint would accept: the same conditions as
 * `app.resolve_app_token` for an access token, and for a refresh token the
 * conditions the refresh grant checks.
 */
export async function introspect(
  db: Database, form: Record<string, string | undefined>, origin: string,
  from?: string, credentials: ClientCredentials = {},
): Promise<Introspection> {
  await throttle(db, `oauth-introspect:addr:${from ?? "unknown"}`, TOKEN_CALLS_PER_ADDRESS);
  const client = await authenticateClient(db, form, credentials);
  const token = form["token"];
  if (!token) throw new OAuthError("invalid_request", "token is required.");

  const inactive: Introspection = { active: false };
  const found = await findToken(db, token, form["token_type_hint"]);
  if (!found) return inactive;

  return inTenant(
    { actor: { userId: SYSTEM_USER_ID, organizationId: found.organizationId, roles: [] }, db },
    async (tx): Promise<Introspection> => {
      const now = Date.now();
      if (found.kind === "refresh") {
        const [row] = await tx.select({ refresh: schema.oauthRefreshToken, status: schema.connectedApp.status })
          .from(schema.oauthRefreshToken)
          .innerJoin(schema.connectedApp, eq(schema.connectedApp.id, schema.oauthRefreshToken.appId))
          .where(eq(schema.oauthRefreshToken.tokenHash, found.hash)).limit(1);
        if (!row || row.refresh.clientId !== client.clientId) return inactive;
        if (row.refresh.revokedAt || row.refresh.usedAt || row.refresh.expiresAt.getTime() <= now || row.status !== "active") {
          return inactive;
        }
        return {
          active: true, client_id: row.refresh.clientId, scope: row.refresh.scope, token_type: "refresh_token",
          exp: seconds(row.refresh.expiresAt), iat: seconds(row.refresh.createdAt), iss: origin,
        };
      }
      const [row] = await tx.select({ token: schema.appToken, app: schema.connectedApp })
        .from(schema.appToken)
        .innerJoin(schema.connectedApp, eq(schema.connectedApp.id, schema.appToken.appId))
        .where(eq(schema.appToken.tokenHash, found.hash)).limit(1);
      if (!row || row.app.oauthClientId !== client.clientId) return inactive;
      if (row.token.revokedAt || row.token.expiresAt.getTime() <= now
        || row.app.status !== "active" || row.app.revokedAt) {
        return inactive;
      }
      /** The scope as approved, from the refresh token issued beside it. */
      const [pair] = await tx.select({ scope: schema.oauthRefreshToken.scope }).from(schema.oauthRefreshToken)
        .where(eq(schema.oauthRefreshToken.accessTokenId, row.token.id)).limit(1);
      return {
        active: true, client_id: client.clientId, scope: pair?.scope ?? "", token_type: "Bearer",
        exp: seconds(row.token.expiresAt), iat: seconds(row.token.createdAt), iss: origin,
      };
    },
  );
}

/**
 * Remove registrations no company ever approved, a week after they were made.
 * Across every company in one statement through a definer function, because
 * a registration belongs to none of them; the worker calls it about hourly.
 */
export async function purgeUnusedClients(db: Database): Promise<number> {
  const [row] = await db.execute<{ removed: number }>(sql`select app.oauth_purge_unused_clients(7, 1000) as removed`);
  return Number(row?.removed ?? 0);
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
    revocation_endpoint: `${origin}/api/oauth/revoke`,
    introspection_endpoint: `${origin}/api/oauth/introspect`,
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: [rules.CHALLENGE_METHOD],
    token_endpoint_auth_methods_supported: [...AUTH_METHODS],
    revocation_endpoint_auth_methods_supported: [...AUTH_METHODS],
    introspection_endpoint_auth_methods_supported: [...AUTH_METHODS],
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
