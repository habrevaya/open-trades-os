export * from "./provider";
export { csvSpendSource } from "./spend-csv";
export {
  webhookLeadSource, signLeadWebhook,
  SIGNATURE_HEADER, TIMESTAMP_HEADER, MAX_SKEW_MS,
  type LeadFieldMap,
} from "./lead-webhook";

/**
 * Adapters are imported for their side effect of registering themselves.
 *
 * A deployment that writes its own for a regional marketplace drops this
 * barrel and imports `./provider` plus their adapter: nothing in the intake
 * path names any of these.
 */
import "./spend-csv";
import "./lead-webhook";
