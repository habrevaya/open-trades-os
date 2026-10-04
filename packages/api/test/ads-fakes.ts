import type { HttpTransport } from "../src/ads/index";

/**
 * A FAKE OF EVERY AD PLATFORM, AT THE ONE SEAM THEY ALL SHARE
 *
 * Every adapter takes its HTTP transport as a parameter, so these tests run
 * the real adapters, the real token handling and the real services against a
 * table of routes that answer the way Google and Meta document. Nothing here
 * reaches a network, and nothing here is a real key.
 *
 * Each call is recorded whole, so a test can assert on exactly what left:
 * which click id, which hash, which consent signal, and that no token or
 * email ever appeared in a request it should not have.
 */

export interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface Answer {
  status: number;
  body?: unknown;
}

type Route = { method: string; match: RegExp; answer: (call: Call) => Answer | Promise<Answer> };

export function fakePlatform() {
  const calls: Call[] = [];
  const routes: Route[] = [];

  const transport: HttpTransport = async (url, init) => {
    const call: Call = { url, method: init.method, headers: init.headers, body: init.body ?? "" };
    calls.push(call);
    const route = routes.find((r) => r.method === init.method && r.match.test(url));
    const answer = route
      ? await route.answer(call)
      : { status: 404, body: { error: { message: `The fake has no ${init.method} ${url}` } } };
    const text = answer.body === undefined ? "" : typeof answer.body === "string" ? answer.body : JSON.stringify(answer.body);
    return { status: answer.status, headers: { get: () => null }, text: async () => text };
  };

  return {
    transport,
    calls,
    /** Later routes win, so a test can override one answer for a step. */
    on(method: string, match: RegExp, answer: (call: Call) => Answer | Promise<Answer>) {
      routes.unshift({ method, match, answer });
    },
    callsTo(match: RegExp) {
      return calls.filter((c) => match.test(c.url));
    },
    reset() {
      calls.length = 0;
    },
  };
}

export type FakePlatform = ReturnType<typeof fakePlatform>;

/** A form body as a map. */
export const formOf = (body: string) => Object.fromEntries(new URLSearchParams(body));

/** 32 bytes, base64. Not a real key: it seals test fixtures and nothing else. */
export const SEALING_KEY = Buffer.alloc(32, 7).toString("base64");

export const SECRETS: Record<string, string> = {
  GOOGLE_OAUTH_CLIENT: JSON.stringify({ clientId: "client-id.apps.example", clientSecret: "client-secret-not-real" }),
  META_OAUTH_CLIENT: JSON.stringify({ clientId: "1234567890", clientSecret: "meta-secret-not-real" }),
  GOOGLE_ADS_DEVELOPER_TOKEN: "developer-token-not-real",
  GA4_API_SECRET: "ga4-api-secret-not-real",
};

export const readSecret = async (ref: string): Promise<string> => {
  const value = SECRETS[ref];
  if (!value) throw new Error(`No secret named ${ref} in the test store`);
  return value;
};

export const ENV = { PUBLIC_URL: "https://ots.test", CREDENTIAL_SEALING_KEY: SEALING_KEY };

/**
 * Google's OAuth endpoints: a code becomes a refresh token, a refresh token
 * becomes an hour's access token, and a revoked one is `invalid_grant`.
 */
export function fakeGoogleOAuth(fake: FakePlatform, options: { refreshToken?: string } = {}) {
  const state = { revoked: false, refreshes: 0, refreshToken: options.refreshToken ?? "google-refresh-token-1" };
  fake.on("POST", /^https:\/\/oauth\.fake\/token/, (call) => {
    const form = formOf(call.body);
    if (form["grant_type"] === "authorization_code") {
      if (form["code"] !== "good-code") return { status: 400, body: { error: "invalid_grant" } };
      return {
        status: 200,
        body: { access_token: "access-1", expires_in: 3599, refresh_token: state.refreshToken, scope: "https://www.googleapis.com/auth/adwords", token_type: "Bearer" },
      };
    }
    if (form["grant_type"] === "refresh_token") {
      state.refreshes += 1;
      if (state.revoked || form["refresh_token"] !== state.refreshToken) return { status: 400, body: { error: "invalid_grant" } };
      return { status: 200, body: { access_token: `access-${state.refreshes + 1}`, expires_in: 3599, token_type: "Bearer" } };
    }
    return { status: 400, body: { error: "unsupported_grant_type" } };
  });
  return state;
}

/** The address a sign in returns to, with whatever the platform put on it. */
export const stateOf = (url: string) => new URL(url).searchParams.get("state")!;
