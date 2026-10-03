import { referrals, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm, TextField } from "@/components/ActionForm";
import { setReferrer } from "./referral-actions";

/**
 * THIS CUSTOMER'S REFERRALS
 *
 * Their code and the link to hand them (it books with the company and names
 * them), who sent them, and who they have sent. The office can write in a
 * referrer the customer mentioned on the phone, by the referrer's code.
 */
export async function Referral({ ctx, customerId }: { ctx: ServiceContext; customerId: string }) {
  const mine = await referrals.forCustomer(ctx, customerId);
  return (
    <section className="mt-8 rounded-md border border-steel-200 p-4">
      <h2 className="font-medium text-ink-900">Referrals</h2>
      <p className="mt-1 text-sm text-ink-700">
        Code <span className="font-mono font-medium">{mine.code}</span>. Their link:{" "}
        <span className="break-all font-mono text-xs">{mine.link}</span>
      </p>
      <p className="mt-1 text-sm text-ink-700">
        {mine.referredBy
          ? <>Referred by <a href={`/customers/${mine.referredBy.id}`} className="underline underline-offset-4">{mine.referredBy.name}</a>.</>
          : "Nobody is recorded as referring them."}
      </p>
      {mine.referred.length > 0 && (
        <ul className="mt-2 text-sm">
          {mine.referred.map((r) => (
            <li key={r.id}>
              Sent <a href={`/customers/${r.id}`} className="underline underline-offset-4">{r.name}</a>
              {r.reward ? `, rewarded (${r.reward.state})` : ", no reward yet"}
            </li>
          ))}
        </ul>
      )}
      {can(ctx.actor, "customer:write") && !mine.referredBy && (
        <ActionForm action={setReferrer} submit="Record referrer" tone="quiet" hidden={{ id: customerId }}
                    className="mt-3 flex flex-wrap items-end gap-3">
          <TextField label="Referred by (their code)" name="code" placeholder="KQ7M2P" className="w-48" />
        </ActionForm>
      )}
    </section>
  );
}
