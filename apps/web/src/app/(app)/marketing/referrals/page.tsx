import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { referrals } from "@opentradesos/api/services";
import { can, referrals as rf } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { saveReferralSettings, settleReward } from "./actions";

export const dynamic = "force-dynamic";

const STATE_LABEL: Record<string, string> = {
  credited: "On their account", owed: "Owed", paid: "Paid", void: "Withdrawn",
};

/**
 * REFERRALS
 *
 * Who sends the company work, who they sent, and what each referral earned.
 * A referral arrives through a customer's link (on their account page and on
 * their customer record) or is written in by the office, and the reward is
 * granted when the person they sent pays for their first job.
 */
export default async function ReferralsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const view = await referrals.overview(ctx);
  const settles = can(user.actor, "invoice:credit");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title="Referrals" count={view.referred.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Every customer has a link that books with you and names them as the referrer. Visits, forms,
        calls and bookings through it are credited to customer referrals, by name.
      </p>

      {can(user.actor, "settings:write") && (
        <section className="mt-6">
          <h2 className="text-base font-semibold">What a referral earns</h2>
          <ActionForm action={saveReferralSettings} submit="Save" className="mt-3 flex flex-wrap items-end gap-3">
            <Select label="Reward" name="reward" defaultValue={view.settings.reward}
                    options={rf.REWARD_KINDS.map((k) => ({ value: k, label: rf.REWARD_KIND[k].label }))} />
            <TextField label="Amount" name="amount" inputMode="decimal" defaultValue={view.settings.reward === "none" ? "" : view.settings.amount} className="w-32" />
          </ActionForm>
          <p className="mt-2 text-xs text-ink-500">
            Given once, when the referred customer&rsquo;s first job is paid in full. {rf.REWARD_KIND[view.settings.reward].meaning}
          </p>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-base font-semibold">Referrers</h2>
        {view.referrers.length === 0 ? (
          <Empty title="No referrals yet">Share a customer&rsquo;s link from their record or their account page.</Empty>
        ) : (
          <Table label="Referrers" head={<><Th>Customer</Th><Th>Referred</Th><Th>Rewarded</Th></>}>
            {view.referrers.map((r) => (
              <tr key={r.id}>
                <Td><a href={`/customers/${r.id}`} className="underline underline-offset-4">{r.name}</a></Td>
                <Td>{r.referred}</Td>
                <Td>{r.rewarded}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold">Referred customers and rewards</h2>
        {view.referred.length === 0 ? null : (
          <Table label="Referred customers" head={<><Th>Customer</Th><Th>Sent by</Th><Th>Reward</Th><Th>{settles ? "Settle" : ""}</Th></>}>
            {view.referred.map((r) => (
              <tr key={r.id}>
                <Td><a href={`/customers/${r.id}`} className="underline underline-offset-4">{r.name}</a></Td>
                <Td>{r.referrerName}</Td>
                <Td>
                  {r.reward ? (
                    <span className="flex items-center gap-2">
                      <Money value={r.reward.amount} />
                      <Chip tone={r.reward.state === "owed" ? "warning" : r.reward.state === "void" ? "neutral" : "success"}>
                        {STATE_LABEL[r.reward.state] ?? r.reward.state}
                      </Chip>
                      {r.reward.creditNoteId ? <a href={`/invoices/credit-notes/${r.reward.creditNoteId}`} className="text-xs underline underline-offset-4">Credit note</a> : null}
                    </span>
                  ) : <span className="text-ink-500">Not yet: their first job is not paid</span>}
                </Td>
                <Td>
                  {settles && r.reward && r.reward.state !== "void" ? (
                    <div className="flex gap-2">
                      {r.reward.state === "owed" ? (
                        <ActionForm action={settleReward} submit="Mark paid" tone="quiet" hidden={{ id: r.reward.id, action: "paid" }} className="" />
                      ) : null}
                      <ActionForm action={settleReward} submit="Withdraw" tone="danger" hidden={{ id: r.reward.id, action: "void" }} className="" />
                    </div>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
