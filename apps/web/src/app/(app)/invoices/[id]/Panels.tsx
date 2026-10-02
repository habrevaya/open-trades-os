import { ActionForm, TextField } from "@/components/ActionForm";
import type { FormState } from "@/lib/actions";

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

export interface InvoiceForActions {
  id: string;
  number: number;
  status: string;
  amountPaid: string;
  balance: string;
}

export interface Allowed {
  write: boolean;
  send: boolean;
  void: boolean;
  writeOff: boolean;
}

/**
 * WHAT CAN BE DONE WITH THIS INVOICE, by whoever is looking.
 *
 * Each control appears only when its permission is held and the invoice is
 * in a state the service would accept. The service still decides: a
 * refusal it gives (a payment against an invoice being voided) is its own
 * sentence under the form. The action is passed in so this renders in a
 * test without a request behind it.
 */
export function InvoiceActions({
  action, invoice, allowed, customerEmail, sentBefore,
}: {
  action: Action;
  invoice: InvoiceForActions;
  allowed: Allowed;
  customerEmail: string | null;
  sentBefore: boolean;
}) {
  const hidden = { invoiceId: invoice.id };
  const draft = invoice.status === "draft";
  const owed = (invoice.status === "open" || invoice.status === "partially_paid") && Number(invoice.balance) > 0;
  const live = !draft && invoice.status !== "void" && invoice.status !== "written_off";

  return (
    <div className="mt-8 space-y-4">
      {draft && allowed.write && (
        <section aria-label="Draft" className="rounded-md border border-steel-200 p-4">
          <p className="text-sm text-ink-700">
            A draft: nothing is owed and nothing is posted until it is issued.
          </p>
          <div className="mt-3 flex flex-wrap items-start gap-3">
            <a href={`/invoices/${invoice.id}/edit`}
               className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100">
              Edit draft
            </a>
            <ActionForm action={action} submit="Issue invoice" hidden={{ ...hidden, op: "issue" }} className="space-y-2" />
            <ActionForm action={action} submit="Delete draft" tone="danger" hidden={{ ...hidden, op: "delete" }}
                        className="space-y-2" />
          </div>
        </section>
      )}

      {live && allowed.send && (
        <section aria-label="Send" className="rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">Send it</h2>
          <p className="mt-1 text-sm text-ink-700">
            Emails the invoice with a link that opens it and takes a card, without an account.
          </p>
          <ActionForm action={action} submit="Email invoice" hidden={{ ...hidden, op: "send", channel: "email" }}
                      className="mt-3 space-y-3">
            <TextField label="Send to" name="to" type="email"
                       placeholder={customerEmail ?? "The customer has no email on file"} />
            {sentBefore && (
              <label className="inline-flex items-center gap-2 text-sm">
                <input type="checkbox" name="resend" value="1" />
                It has been sent before. Send it again.
              </label>
            )}
          </ActionForm>
          <ActionForm action={action} submit="Get a link instead" tone="quiet"
                      hidden={{ ...hidden, op: "send", channel: "portal_link", ...(sentBefore ? { resend: "1" } : {}) }}
                      className="mt-3 space-y-2" />
        </section>
      )}

      {owed && allowed.writeOff && (
        <details className="rounded-md border border-steel-200 p-4">
          <summary className="cursor-pointer text-sm font-medium">Write off what is owed</summary>
          <p className="mt-2 text-sm text-ink-700">
            The money is owed and will not arrive. The balance goes to bad debt; the revenue stays.
          </p>
          <ActionForm action={action} submit="Write off" tone="danger" hidden={{ ...hidden, op: "write-off" }}
                      className="mt-3 space-y-3">
            <TextField label="Why it is being written off" name="reason" required maxLength={500} />
          </ActionForm>
        </details>
      )}

      {live && allowed.void && Number(invoice.amountPaid) === 0 && (
        <details className="rounded-md border border-steel-200 p-4">
          <summary className="cursor-pointer text-sm font-medium">Void this invoice</summary>
          <p className="mt-2 text-sm text-ink-700">
            It should never have been raised. The posting is reversed, the job goes back to
            waiting to be billed, and anything used on it can be billed again.
          </p>
          <ActionForm action={action} submit="Void invoice" tone="danger" hidden={{ ...hidden, op: "void" }}
                      className="mt-3 space-y-3">
            <TextField label="Why it is being voided" name="reason" required maxLength={500} />
          </ActionForm>
        </details>
      )}
    </div>
  );
}
