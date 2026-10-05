import { oauthEndpoints } from "@opentradesos/api/http";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * A confidential client rotates its own secret, proven with the current one.
 * The new one is shown once and only its hash is kept; everything it decides
 * is in `services/oauth.ts`, where the tests reach it.
 */
export const POST = (request: Request) => oauthEndpoints.handleRotateSecret(request, getDb());
export const OPTIONS = oauthEndpoints.preflight;
