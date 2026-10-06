import { oauthEndpoints } from "@opentradesos/api/http";
import { getDb } from "@/lib/db";

export const dynamic = "force-dynamic";

/**
 * Dynamic client registration for remote MCP clients (RFC 7591). Public
 * clients only, and a registration grants nothing: everything is decided when
 * a person at a company approves the client on `/oauth/authorize`.
 */
export const POST = (request: Request) => oauthEndpoints.handleRegister(request, getDb());
export const OPTIONS = oauthEndpoints.preflight;
