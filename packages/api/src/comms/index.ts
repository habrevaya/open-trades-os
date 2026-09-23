export * from "./provider";
/**
 * Adapters are imported for their side effect of registering themselves.
 *
 * A deployment that uses a different carrier can drop this barrel and import
 * `./provider` plus its own adapter: nothing in the send path names Twilio.
 */
import "./twilio";
