import { connectors } from "@opentradesos/core";

/* ---------------------------------------------------------------- endpoints */

/**
 * Whether a connection may say where its provider's requests go.
 *
 * Only the test suites set this. See `endpoint` in core's connector settings.
 */
export function providerEndpointOverridesAllowed(): boolean {
  return process.env["ALLOW_PROVIDER_BASE_URL"] === "1";
}

const warnedAboutStoredEndpoint = new Set<string>();

/**
 * The settings an adapter is built with: stored endpoint overrides removed
 * unless the deployment allows them. Called by every provider registry, so
 * no adapter can be handed a `baseUrl` from a row.
 */
export function adapterSettings(provider: string, settings: Record<string, unknown>): Record<string, unknown> {
  const allowed = providerEndpointOverridesAllowed();
  const safe = connectors.withoutEndpointOverrides(provider, settings, { allowEndpointOverrides: allowed });
  if (safe !== settings && !warnedAboutStoredEndpoint.has(provider)) {
    warnedAboutStoredEndpoint.add(provider);
    console.warn(
      `[secrets] A ${provider} connection has an endpoint override stored in its settings. It was `
      + "ignored, and requests go to the provider's own address. Remove it from the connection.",
    );
  }
  return safe;
}
