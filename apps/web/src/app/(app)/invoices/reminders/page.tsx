import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agents, agentCollections } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { PageHeader, Empty } from "@/components/Table";
import { ActionForm, TextArea } from "@/components/ActionForm";
import { formatIn } from "@/lib/dates";
import { checkNow, sendReminder, setReminderAside } from "./actions";

export const dynamic = "force-dynamic";

/**
 * INVOICES → REMINDERS
 *
 * What the collections agent drafted for overdue invoices, at the steps the
 * company set, each with the amount it owes and the words it would send. Edit
 * them, send them, or set them aside; a step set aside is not drafted again.
 */

interface Reminder {
  invoiceId: string; invoiceNumber: number; customerName: string; channel: "email" | "text";
  to: string; body: string; stepDays: number; amountOwed: string; daysOverdue: number; edited?: boolean;
}

export default async function RemindersPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "invoice:read")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
        <PageHeader title="Reminders" />
        <Empty title="Not shown to your role">Reminders are about invoices, which need the View invoices permission.</Empty>
      </div>
    );
  }

  const [on, waiting, sent] = await Promise.all([
    agents.isOn(ctx, "collections"),
    agentCollections.handlers.listCollectionReminders(ctx, { status: ["proposed"], limit: 100 }),
    agentCollections.handlers.listCollectionReminders(ctx, { status: ["applied"], limit: 20 }),
  ]);
  const sends = can(user.actor, "invoice:send");

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <PageHeader title="Reminders" count={waiting.drafts.length} />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        The collections agent writes a reminder when an invoice reaches one of your steps, in your tone and for
        exactly what is owed. By email it goes with the invoice and its payment button; by text, with the payment
        link, and never in your quiet hours. Steps and tone are under{" "}
        <a href="/settings/agents" className="underline underline-offset-4">Settings, AI agents</a>.
      </p>
      {on && sends ? <ActionForm action={checkNow} submit="Check for overdue invoices now" tone="quiet" className="mt-4" /> : null}
      {!on ? <Empty title="The collections agent is off">Nothing is drafted until an owner turns it on.</Empty> : null}

      {waiting.drafts.length > 0 ? (
        <ul className="mt-6 space-y-4">
          {waiting.drafts.map((draft) => {
            const r = draft.draft as unknown as Reminder;
            return (
              <li key={draft.id} className="rounded-md border border-steel-200 p-4">
                <div className="flex flex-wrap items-baseline gap-2">
                  <a href={`/invoices/${r.invoiceId}`} className="font-medium hover:underline">Invoice {r.invoiceNumber}</a>
                  <span className="text-sm">{r.customerName}</span>
                  <Money value={r.amountOwed} />
                  <Chip tone="warning">{r.daysOverdue} days overdue</Chip>
                  <span className="text-xs text-ink-500">{r.stepDays} day step, by {r.channel} to {r.to}</span>
                </div>
                {draft.note ? <p className="mt-2 text-sm text-red-600">{draft.note}</p> : null}
                {sends ? (
                  <div className="mt-3 flex flex-wrap items-end gap-3">
                    <ActionForm action={sendReminder} submit="Send" hidden={{ id: draft.id }} className="w-full space-y-3">
                      <TextArea label="The reminder" name="body" rows={3} defaultValue={r.body} maxLength={500} />
                    </ActionForm>
                    <ActionForm action={setReminderAside} submit="Set aside" hidden={{ id: draft.id }} tone="quiet" />
                  </div>
                ) : <p className="mt-2 whitespace-pre-wrap text-sm">{r.body}</p>}
              </li>
            );
          })}
        </ul>
      ) : on ? <Empty title="Nothing waiting">Reminders appear here as invoices reach your steps.</Empty> : null}

      {sent.drafts.length > 0 ? (
        <section aria-label="Sent lately" className="mt-10">
          <h2 className="text-base font-semibold">Sent lately</h2>
          <ul className="mt-3 divide-y divide-steel-200 rounded-md border border-steel-200">
            {sent.drafts.map((draft) => {
              const r = draft.draft as unknown as Reminder;
              return (
                <li key={draft.id} className="flex flex-wrap items-baseline gap-2 p-3 text-sm">
                  <a href={`/invoices/${r.invoiceId}`} className="hover:underline">Invoice {r.invoiceNumber}</a>
                  <span>{r.customerName}</span>
                  <span className="text-ink-500">{r.stepDays} day step by {r.channel}</span>
                  {draft.appliedAutomatically ? <Chip tone="info">Sent on its own</Chip> : null}
                  {draft.decidedAt ? <span className="ml-auto text-xs text-ink-500">{formatIn(draft.decidedAt, user.organizationTimezone)}</span> : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
