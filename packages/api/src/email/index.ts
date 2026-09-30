export * from "./provider";
/**
 * Adapters are imported for their side effect of registering themselves.
 *
 * A deployment that sends through neither of these can drop this barrel and
 * import `./provider` plus its own adapter: nothing in the send path names
 * Resend or SMTP.
 *
 * `./smtp` is what makes the rest of the email catalogue optional, and it is
 * the reason nodemailer is a dependency of this package. A deployment sending
 * through Resend that wants to keep it out of the bundle imports `./provider`
 * and `./resend` directly.
 */
import "./resend";
import "./smtp";
