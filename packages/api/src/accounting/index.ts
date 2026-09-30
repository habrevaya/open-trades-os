export * from "./provider";
/**
 * Adapters are imported for their side effect of registering themselves.
 *
 * A deployment that runs Xero can drop this barrel and import `./provider`
 * plus its own adapter: nothing in `services/accounting.ts` names QuickBooks.
 */
import "./quickbooks";
