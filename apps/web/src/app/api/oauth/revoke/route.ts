import { oauthEndpoints } from "@opentradesos/api/http";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * RFC 7009: a client hands back a token it no longer wants. A refresh token
 * takes everything descended from the same approval with it. Everything it
 * decides is in `services/oauth.ts`, where the tests reach it.
 */
export const POST = (request: Request) => oauthEndpoints.handleRevoke(request, getDb());
export const OPTIONS = oauthEndpoints.preflight;
