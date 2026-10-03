/**
 * @opentradesos/sdk
 *
 * A typed client for every operation in the OpenTradesOS API, generated from
 * its OpenAPI document; a helper that verifies a webhook delivery; and, as
 * the `opentradesos-mcp` command, a bridge that lets a desktop MCP client talk
 * to a hosted instance. README.md says how to use each.
 */
export { OpenTradesOS, OpenTradesOSError, type ClientOptions, type DryRunReport } from "./client";
export {
  verifyWebhook, WebhookVerificationError, SIGNATURE_HEADER, TIMESTAMP_HEADER, DELIVERY_HEADER, EVENT_HEADER,
  type WebhookEvent, type VerifyInput,
} from "./webhooks";
export * from "./generated";
