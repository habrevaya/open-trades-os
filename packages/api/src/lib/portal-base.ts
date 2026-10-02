/**
 * WHERE A CUSTOMER'S LINK POINTS
 *
 * Every link a customer is handed (an estimate to approve, a deposit to pay,
 * an invoice, their account, a booking, the "on my way" tracking page) is
 * built on this.
 *
 * It used to read `PORTAL_BASE_URL` and nothing else, a variable that is in
 * no example file and no guide, and fall back to `https://portal.example.com`.
 * So a deployment configured the documented way, with `PUBLIC_URL`, sent its
 * customers to a domain that is not theirs: the approval link in the email,
 * the deposit page a customer is redirected to the moment they sign, and the
 * tracking link in the text a technician sends from the driveway. Nothing
 * failed on our side; the customer just landed somewhere else.
 *
 * `PORTAL_BASE_URL` still wins, for somebody serving the portal from its own
 * host. Otherwise the deployment's own address, the same one the webhooks
 * sign over and first-password links use. The example domain is left only
 * for a process with neither set, which is a test.
 */
export function portalBase(env: Record<string, string | undefined> = process.env): string {
  const value = env["PORTAL_BASE_URL"] || env["PUBLIC_URL"] || env["AUTH_URL"];
  return (value || "https://portal.example.com").replace(/\/+$/, "");
}
