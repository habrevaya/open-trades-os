export * from "./provider";
/**
 * Adapters are imported for their side effect of registering themselves.
 *
 * A deployment whose merchant account is elsewhere can drop this barrel and
 * import `./provider` plus its own adapter: nothing in the charge path names
 * Stripe.
 */
import "./stripe";
