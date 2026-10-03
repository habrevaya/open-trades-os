import { ads } from "@opentradesos/core";
import {
  AuthorizationLostError, PlatformRefusedError, PlatformUnavailableError, jsonOf,
  type HttpTransport, type TokenSource,
} from "./provider";

/**
 * SIGNING IN, AND STAYING SIGNED IN
 *
 * The two halves of OAuth this product needs, for the two families it speaks
 * to: trading the code a person brings back from the consent screen for a
 * lasting grant, and turning that grant into a live access token whenever an
 * adapter asks for one.
 *
 * The two families are not the same shape and pretending otherwise would hide
 * the difference that matters to an owner.
 *
 *   Google hands back a REFRESH TOKEN that lasts until somebody revokes it.
 *   Access tokens last an hour and are minted from it as needed, in memory,
 *   never stored.
 *
 *   Meta has no refresh token. The code becomes a token that lasts an hour or
 *   two, which is traded at once for a long lived one that lasts about sixty
 *   days and cannot be extended without the person signing in again. So the
 *   grant carries its expiry, the screen counts down to it, and a token past
 *   it is "sign in again" rather than a mystery 400 in a log. A company that
 *   wants no countdown uses a Meta system user token instead, kept in its own
 *   secret store and named as the connection's credential.
 *
 * NO TOKEN IS EVER PUT IN AN ERROR MESSAGE. Token endpoints echo request
 * parameters in some failures, and the request parameter is the token; an
 * error message is the most copied string in any system. A status and the
 * platform's error code are all that is said.
 */

/** The app the operator registered with the platform, from their secret store. */
export interface OAuthClient {
  clientId: string;
  clientSecret: string;
}

/**
 * The OAuth client, parsed strictly from ONE secret holding both halves as
 * JSON, the same convention the accounting connectors use: a credential split
 * across two names is two things to rotate and one of them forgotten.
 */
export function parseOAuthClient(secret: string): OAuthClient {
  let parsed: unknown;
  try {
    parsed = JSON.parse(secret);
  } catch {
    throw new PlatformRefusedError(
      "The OAuth client secret must be one JSON value with clientId and clientSecret, "
      + "as {\"clientId\": \"...\", \"clientSecret\": \"...\"}.",
    );
  }
  const value = (parsed ?? {}) as Partial<OAuthClient>;
  for (const field of ["clientId", "clientSecret"] as const) {
    if (typeof value[field] !== "string" || value[field].trim() === "") {
      throw new PlatformRefusedError(`The OAuth client secret is missing "${field}".`);
    }
  }
  return { clientId: value.clientId!.trim(), clientSecret: value.clientSecret!.trim() };
}

/** What a sign in leaves behind: the lasting credential and what it covers. */
export interface Grant {
  /** Google's refresh token, or Meta's long lived token. */
  credential: string;
  scopes: string[];
  /** Null for a grant that lasts until revoked. */
  expiresAt: Date | null;
}

const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

/** The platform's error code from a token endpoint, and nothing else from the body. */
function errorCode(body: unknown): string {
  const value = body as { error?: unknown };
  if (typeof value.error === "string") return value.error;
  if (value.error && typeof value.error === "object") {
    const nested = value.error as { code?: unknown; type?: unknown };
    return [nested.type, nested.code].filter((part) => part !== undefined).join(" ");
  }
  return "no error code";
}

/**
 * Trade the code the person brought back for a lasting grant.
 *
 * `redirectUri` has to be the exact one the authorize request carried, or
 * both platforms refuse the trade; it is passed in rather than rebuilt here
 * so it cannot drift from the one the person was sent with.
 */
export async function exchangeCode(input: {
  family: ads.OAuthFamily;
  client: OAuthClient;
  code: string;
  redirectUri: string;
  /** Overridable so a test exchanges against a fake. */
  tokenUrl?: string | undefined;
  transport: HttpTransport;
  now?: Date;
}): Promise<Grant> {
  const tokenUrl = input.tokenUrl ?? ads.OAUTH_ENDPOINTS[input.family].token;
  const now = input.now ?? new Date();

  if (input.family === "google") {
    const response = await input.transport(tokenUrl, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: form({
        grant_type: "authorization_code",
        code: input.code,
        client_id: input.client.clientId,
        client_secret: input.client.clientSecret,
        redirect_uri: input.redirectUri,
      }),
    });
    const body = await jsonOf(response, "Google");
    if (response.status < 200 || response.status >= 300) {
      throw new PlatformRefusedError(`Google refused the sign in (HTTP ${response.status}, ${errorCode(body)}). Try signing in again.`);
    }
    const payload = body as { refresh_token?: unknown; scope?: unknown };
    if (typeof payload.refresh_token !== "string" || payload.refresh_token === "") {
      /**
       * Google sends no refresh token to an account that already granted this
       * client once and was not shown the consent screen again. The authorize
       * request forces the screen, so this is rare, and the fix is the one
       * Google's own documentation gives.
       */
      throw new PlatformRefusedError(
        "Google signed you in but sent back no lasting access. Remove this app at "
        + "myaccount.google.com/permissions and sign in again, so Google asks for consent afresh.",
      );
    }
    return {
      credential: payload.refresh_token,
      scopes: typeof payload.scope === "string" ? payload.scope.split(" ").filter(Boolean) : [],
      expiresAt: null,
    };
  }

  /* Meta: the code for a short lived token, then that for a long lived one. */
  const shortResponse = await input.transport(`${tokenUrl}?${form({
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    redirect_uri: input.redirectUri,
    code: input.code,
  })}`, { method: "GET", headers: { Accept: "application/json" } });
  const shortBody = await jsonOf(shortResponse, "Meta");
  const short = (shortBody as { access_token?: unknown }).access_token;
  if (shortResponse.status < 200 || shortResponse.status >= 300 || typeof short !== "string") {
    throw new PlatformRefusedError(`Meta refused the sign in (HTTP ${shortResponse.status}, ${errorCode(shortBody)}). Try signing in again.`);
  }
  const longResponse = await input.transport(`${tokenUrl}?${form({
    grant_type: "fb_exchange_token",
    client_id: input.client.clientId,
    client_secret: input.client.clientSecret,
    fb_exchange_token: short,
  })}`, { method: "GET", headers: { Accept: "application/json" } });
  const longBody = await jsonOf(longResponse, "Meta");
  const long = longBody as { access_token?: unknown; expires_in?: unknown };
  if (longResponse.status < 200 || longResponse.status >= 300 || typeof long.access_token !== "string") {
    throw new PlatformRefusedError(`Meta would not extend the sign in (HTTP ${longResponse.status}, ${errorCode(longBody)}).`);
  }
  const seconds = typeof long.expires_in === "number" ? long.expires_in : 60 * 86_400;
  return {
    credential: long.access_token,
    scopes: [...ads.PROVIDERS.meta_ads.scopes],
    expiresAt: new Date(now.getTime() + seconds * 1000),
  };
}

/**
 * A live access token whenever an adapter asks, for one connection.
 *
 * Google's is minted from the refresh token and kept in memory for its hour,
 * less a minute, so a token that expires between the check and the request is
 * not the cause of a refused write. `invalid_grant` is the grant gone, which
 * needs a person; anything else from the token endpoint is the platform
 * having a bad minute.
 *
 * A refresh token handed back in place of the old one is passed to
 * `onRotated`, because dropping it is the bug that kills a connection days
 * later in the middle of a night. Google rarely rotates; the hook is there
 * because "rarely" is not "never".
 */
export function tokenSource(input: {
  family: ads.OAuthFamily;
  credential: string;
  expiresAt: Date | null;
  client: OAuthClient | null;
  tokenUrl?: string | undefined;
  transport: HttpTransport;
  onRotated?: ((credential: string) => Promise<void>) | undefined;
  now?: () => Date;
}): TokenSource {
  const clock = input.now ?? (() => new Date());

  if (input.family === "meta") {
    return {
      async accessToken() {
        if (input.expiresAt && input.expiresAt.getTime() <= clock().getTime()) {
          throw new AuthorizationLostError(
            `Meta's sign in ran out on ${input.expiresAt.toISOString().slice(0, 10)}. Meta does not extend one `
            + "without the person signing in again, so sign in again, or use a system user token that does not expire.",
          );
        }
        return input.credential;
      },
    };
  }

  let refreshToken = input.credential;
  let cached: { token: string; expiresAt: number } | null = null;

  return {
    async accessToken() {
      if (cached && cached.expiresAt > clock().getTime()) return cached.token;
      if (!input.client) throw new AuthorizationLostError("There is no OAuth client to refresh this sign in with.");
      let response;
      try {
        response = await input.transport(input.tokenUrl ?? ads.OAUTH_ENDPOINTS.google.token, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
          body: form({
            grant_type: "refresh_token",
            refresh_token: refreshToken,
            client_id: input.client.clientId,
            client_secret: input.client.clientSecret,
          }),
        });
      } catch (error) {
        throw new PlatformUnavailableError(`Google's sign in service could not be reached: ${(error as Error).message}`);
      }
      const body = await jsonOf(response, "Google");
      if (response.status < 200 || response.status >= 300) {
        const code = errorCode(body);
        if (code === "invalid_grant" || code === "unauthorized_client" || code === "invalid_client") {
          throw new AuthorizationLostError(
            `Google no longer accepts this connection's sign in (${code}). It was revoked, expired or the OAuth client `
            + "changed. Sign in again.",
          );
        }
        throw new PlatformUnavailableError(`Google's sign in service answered HTTP ${response.status} (${code}).`);
      }
      const payload = body as { access_token?: unknown; expires_in?: unknown; refresh_token?: unknown };
      if (typeof payload.access_token !== "string") {
        throw new PlatformUnavailableError("Google's sign in service returned no access token.");
      }
      const seconds = typeof payload.expires_in === "number" ? payload.expires_in : 3600;
      cached = { token: payload.access_token, expiresAt: clock().getTime() + Math.max(0, seconds - 60) * 1000 };
      if (typeof payload.refresh_token === "string" && payload.refresh_token !== "" && payload.refresh_token !== refreshToken) {
        refreshToken = payload.refresh_token;
        await input.onRotated?.(refreshToken);
      }
      return cached.token;
    },
  };
}
