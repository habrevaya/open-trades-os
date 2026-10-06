import { oauthEndpoints } from "@opentradesos/api/http";

export const dynamic = "force-dynamic";

/** RFC 8414: where to register, authorize and exchange, and that only S256 PKCE is accepted. */
export const GET = (request: Request) => oauthEndpoints.handleAuthorizationServerMetadata(request);
export const OPTIONS = oauthEndpoints.preflight;
