import { oauthEndpoints } from "@opentradesos/api/http";

export const dynamic = "force-dynamic";

/**
 * RFC 9728: the MCP endpoint and who issues tokens for it. Served at the bare
 * path and with the resource's own path after it (`/api/mcp`), because MCP
 * clients ask for either.
 */
export const GET = (request: Request) => oauthEndpoints.handleProtectedResourceMetadata(request);
export const OPTIONS = oauthEndpoints.preflight;
