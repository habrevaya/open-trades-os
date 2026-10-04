import { oauthEndpoints } from "@opentradesos/api/http";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * RFC 7662: whether one of the calling client's own tokens is still live.
 * Anything else, including another client's token, is `active: false`.
 */
export const POST = (request: Request) => oauthEndpoints.handleIntrospect(request, getDb());
export const OPTIONS = oauthEndpoints.preflight;
