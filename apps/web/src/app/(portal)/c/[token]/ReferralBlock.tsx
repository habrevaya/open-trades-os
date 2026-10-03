/**
 * SEND US A NEIGHBOUR
 *
 * The customer's own link, to copy and share, what the company gives for a
 * referral when it gives something, and the first names of the people they
 * have sent. Nothing about anybody else's account.
 */
export function ReferralBlock({ referral }: {
  referral: {
    code: string; link: string;
    reward: { kind: string; amount: string } | null;
    referred: { firstName: string; rewarded: boolean }[];
  };
}) {
  const amount = referral.reward
    ? new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(Number(referral.reward.amount))
    : null;
  return (
    <section className="mt-6 rounded-md border border-steel-200 bg-canvas p-5" aria-labelledby="refer-heading">
      <h2 id="refer-heading" className="text-base font-semibold">Know somebody who needs us?</h2>
      <p className="mt-1 text-sm text-ink-700">
        Share your link. When they book through it we will know you sent them
        {amount
          ? referral.reward?.kind === "credit_note"
            ? `, and once their first job is paid we will put ${amount} on your account.`
            : `, and once their first job is paid we will send you ${amount}.`
          : "."}
      </p>
      <p className="mt-3 break-all rounded border border-steel-200 bg-steel-100 p-2 font-mono text-xs" data-testid="referral-link">
        {referral.link}
      </p>
      <p className="mt-1 text-xs text-ink-500">Your code is {referral.code}, if they would rather tell us on the phone.</p>
      {referral.referred.length > 0 && (
        <p className="mt-3 text-sm text-ink-700">
          You have sent us {referral.referred.map((r) => r.firstName).join(", ")}. Thank you.
        </p>
      )}
    </section>
  );
}
