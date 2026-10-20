import { doNotMail, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm, TextField } from "@/components/ActionForm";
import { addCustomerToDoNotMail, takeCustomerOffDoNotMail } from "./do-not-mail-actions";

/**
 * WHETHER THIS CUSTOMER GETS MAIL
 *
 * Postcards and letters to the list you own are the one channel a customer
 * cannot reply STOP to. When they ring to say they do not want them, or the
 * address is on the list for somebody else's say so, this says so and why, and
 * the office can put them on the list (or take them off) from here. The list
 * itself is under Direct mail.
 */
export async function DoNotMail({ ctx, customerId }: { ctx: ServiceContext; customerId: string }) {
  /** Whoever takes the call may put a name on the list; seeing it and taking one off are the mailing's permissions. */
  const reads = can(ctx.actor, "campaign:read");
  const entries = reads ? await doNotMail.list(ctx, { customerId }) : [];
  const mine = entries.find((e) => e.customerId === customerId);
  const door = entries.find((e) => e.customerId !== customerId);
  const adds = can(ctx.actor, "customer:write");
  const removes = can(ctx.actor, "campaign:write");
  return (
    <section className="mt-8 rounded-md border border-steel-200 p-4" aria-label="Mail">
      <h2 className="font-medium text-ink-900">Mail</h2>
      {!reads ? (
        <p className="mt-1 text-sm text-ink-700">If they ask not to get postcards or letters, record it here.</p>
      ) : mine ? (
        <p className="mt-1 text-sm text-ink-700">
          On your do not mail list{mine.reason ? `: ${mine.reason}` : ""}. No mailing posts to them, wherever they live.
        </p>
      ) : door ? (
        <p className="mt-1 text-sm text-ink-700">
          Their address ({door.address}) is on your do not mail list{door.reason ? `: ${door.reason}` : ""}. No mailing posts to it.
        </p>
      ) : (
        <p className="mt-1 text-sm text-ink-700">They get your mailings, when they match the people a mailing is for.</p>
      )}
      {adds && !mine ? (
        <ActionForm action={addCustomerToDoNotMail} submit="Do not mail this customer" tone="quiet" hidden={{ id: customerId }}
                    className="mt-3 flex flex-wrap items-end gap-3">
          <TextField label="Why (printed on any piece it stops)" name="reason" maxLength={200} placeholder="Asked on the phone, 3 June" className="w-72" />
        </ActionForm>
      ) : null}
      {removes && mine ? (
        <ActionForm action={takeCustomerOffDoNotMail} submit="Take them off the list" tone="quiet" hidden={{ id: mine.id, customerId }} className="mt-3" />
      ) : null}
    </section>
  );
}
