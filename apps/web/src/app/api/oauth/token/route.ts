import { oauthEndpoints } from "@opentradesos/api/http";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * The OAuth token endpoint: an authorization code with its PKCE verifier, or
 * a refresh token, for an app token an hour long. Everything it decides is in
 * `services/oauth.ts`, where the tests reach it.
 */
export const POST = (request: Request) => oauthEndpoints.handleToken(request, getDb());
export const OPTIONS = oauthEndpoints.preflight;
