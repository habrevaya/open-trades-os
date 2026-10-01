export * from "./provider";
/**
 * Adapters are imported for their side effect of registering themselves.
 *
 * A deployment that runs neither can drop this barrel and import `./provider`
 * plus its own adapter: nothing in `services/accounting.ts` names either of
 * the two below, which is the property the Xero adapter was built to test.
 */
import "./quickbooks";
import "./xero";
