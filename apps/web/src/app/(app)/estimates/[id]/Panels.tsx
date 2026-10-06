import { Money } from "@opentradesos/ui";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import type { FormState } from "@/lib/actions";

type Action = (previous: FormState, form: FormData) => Promise<FormState>;

export interface EstimateView {
  id: string;
  customerId: string;
  status: string;
  jobId: string | null;
  options: {
    id: string; name: string; isRecommended: boolean; total: string; optionalTotal: string;
    lines: {
      id: string; name: string; quantity: string; unitPrice: string; lineTotal: string; isOptional: boolean;
      discountAmount?: string; memberDiscountAmount?: string; memberAgreementId?: string | null;
    }[];
  }[];
}

export interface DepositView { id: string; status: string; amountRequested: string; amountReceived: string }

/**
 * THE OPTIONS, as the customer is shown them: most expensive first with
 * the recommended one pulled up, optional lines priced and outside the
 * total. The service orders them; this only draws them.
 */
export function Options({
  estimate, plans = new Map(),
}: {
  estimate: EstimateView;
  /** The plan behind each agreement a line was member priced from. */
  plans?: ReadonlyMap<string, string>;
}) {
  return (
    <div className="mt-6 grid gap-4 md:grid-cols-2">
      {estimate.options.map((option) => (
        <section key={option.id} aria-label={option.name} className="rounded-md border border-steel-200 p-4">
          <div className="flex items-baseline justify-between gap-3">
            <h2 className="font-semibold">
              {option.name}
              {option.isRecommended ? <span className="ml-2 text-xs font-normal text-ink-500">recommended</span> : null}
            </h2>
            <span className="font-medium"><Money value={option.total} /></span>
          </div>
          <ul className="mt-3 space-y-1 text-sm">
            {option.lines.map((line) => (
              <li key={line.id}>
                <div className="flex justify-between gap-3">
                  <span>
                    {line.name}
                    {Number(line.quantity) !== 1 ? <span className="text-ink-500"> × {Number(line.quantity)}</span> : null}
                    {line.isOptional ? <span className="ml-1 text-xs text-ink-500">(optional)</span> : null}
                  </span>
                  <Money value={line.lineTotal} />
                </div>
                {/*
                  Never silently. A member discount is said on the line it came
                  off, with the plan that gave it, so the office and the
                  customer can both see why this line is cheaper than the price
                  book says.
                */}
                {Number(line.memberDiscountAmount ?? "0") > 0 ? (
                  <p className="text-xs text-ink-500">
                    Member discount
                    {line.memberAgreementId && plans.get(line.memberAgreementId)
                      ? `, ${plans.get(line.memberAgreementId)}`
                      : ""}: <Money value={`-${line.memberDiscountAmount}`} />
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
          {Number(option.optionalTotal) > 0 && (
            <p className="mt-2 text-xs text-ink-500">
              Optional extras worth <Money value={option.optionalTotal} /> are not in the total.
            </p>
          )}
        </section>
      ))}
    </div>
  );
}

/**
 * WHAT THE OFFICE CAN DO WITH IT, by state and by permission. The actions
 * are passed in so this renders in a test.
 */
export function EstimateActions({
  action, estimate, deposits, allowed, contact = { email: null, phone: null },
}: {
  action: Action;
  estimate: EstimateView;
  deposits: DepositView[];
  allowed: { send: boolean; deposit: boolean; approve: boolean; write: boolean; convert: boolean };
  /** The customer's address and number on file, so the form can say where it will go. */
  contact?: { email: string | null; phone: string | null };
}) {
  const hidden = { estimateId: estimate.id, customerId: estimate.customerId };
  // Expired is still open to a yes, a no, a deposit and a resend: a date is a nudge, not a cliff.
  const open = ["draft", "sent", "viewed", "expired"].includes(estimate.status);

  return (
    <div className="mt-8 space-y-4">
      {deposits.length > 0 && (
        <p className="text-sm text-ink-700">
          Deposit:{" "}
          {deposits.map((d) => (
            <span key={d.id} className="mr-3">
              <Money value={d.amountRequested} /> {d.status === "requested" ? "asked for" : d.status}
              {Number(d.amountReceived) > 0 ? <> (<Money value={d.amountReceived} /> received)</> : null}
            </span>
          ))}
        </p>
      )}

      {open && allowed.send && (
        <section aria-label="Send" className="rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">Send it</h2>
          <p className="mt-1 text-sm text-ink-700">
            The customer gets a link to the proposal where they choose an option, tick extras, sign and approve,
            without an account. An email or a text goes into their conversation in the inbox, so a reply lands
            beside it. Sending again withdraws the last link once the new one has gone.
          </p>
          <ActionForm action={action} submit="Send estimate" hidden={{ ...hidden, op: "send" }}
                      className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              {/*
                Both at once is offered only when the customer has both, and
                is then the default: the text is what gets read today, the
                email is what gets found next week, and one link serves both.
              */}
              <Select label="How" name="channel"
                      defaultValue={contact.email && contact.phone ? "both" : contact.email ? "email" : contact.phone ? "sms" : "link"}
                      options={[
                ...(contact.email && contact.phone
                  ? [{ value: "both", label: `Email and text, to ${contact.email} and ${contact.phone}` }]
                  : []),
                { value: "email", label: contact.email ? `Email to ${contact.email}` : "Email" },
                { value: "sms", label: contact.phone ? `Text to ${contact.phone}` : "Text" },
                { value: "link", label: "Just give me the link to hand over" },
              ]} />
              <TextField label="To a different address or number" name="to" maxLength={320}
                         placeholder="Leave empty for the one on file. One channel only." />
            </div>
            <TextArea label="A line from you, above the link" name="message" rows={2} maxLength={2000} />
          </ActionForm>
        </section>
      )}

      {open && allowed.deposit && deposits.length === 0 && (
        <details className="rounded-md border border-steel-200 p-4">
          <summary className="cursor-pointer text-sm font-medium">Ask for a deposit</summary>
          <p className="mt-2 text-sm text-ink-700">
            Held as a liability when it arrives, and applied to the invoice when the work is billed.
          </p>
          <ActionForm action={action} submit="Ask for deposit" hidden={{ ...hidden, op: "deposit" }}
                      className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <TextField label="Deposit amount" name="amount" inputMode="decimal" placeholder="500.00" />
              <TextField label="Or a percent of the chosen option" name="percent" inputMode="decimal" placeholder="25" />
            </div>
          </ActionForm>
        </details>
      )}

      {open && allowed.approve && (
        <details className="rounded-md border border-steel-200 p-4">
          <summary className="cursor-pointer text-sm font-medium">Record a yes given in person or by phone</summary>
          <ActionForm action={action} submit="Record approval" hidden={{ ...hidden, op: "approve" }}
                      className="mt-3 space-y-3">
            <div className="grid gap-3 sm:grid-cols-3">
              <Select label="Option chosen" name="optionId"
                      options={estimate.options.map((o) => ({ value: o.id, label: o.name }))} />
              <TextField label="Who said yes" name="signerName" required maxLength={200} />
              <Select label="How" name="capturedVia" options={[
                { value: "in_person", label: "In person" }, { value: "phone", label: "On the phone" },
                { value: "email", label: "By email" }, { value: "text", label: "By text" },
              ]} />
            </div>
          </ActionForm>
        </details>
      )}

      {open && allowed.write && (
        <details className="rounded-md border border-steel-200 p-4">
          <summary className="cursor-pointer text-sm font-medium">Record that they said no</summary>
          <ActionForm action={action} submit="Record decline" tone="danger" hidden={{ ...hidden, op: "decline" }}
                      className="mt-3 space-y-3">
            <TextField label="What they said" name="reason" maxLength={1000} />
          </ActionForm>
        </details>
      )}

      {estimate.status === "approved" && allowed.convert && (
        <section aria-label="Convert" className="rounded-md border border-steel-200 p-4">
          <h2 className="text-sm font-semibold">Approved. Turn it into work</h2>
          <p className="mt-1 text-sm text-ink-700">
            The job is booked from the option they chose, at the prices they approved, and any deposit follows it.
          </p>
          <ActionForm action={action} submit="Convert to job" hidden={{ ...hidden, op: "convert" }}
                      className="mt-3 space-y-3">
            <label className="inline-flex items-center gap-2 text-sm">
              <input type="checkbox" name="createInvoice" value="1" />
              Also write the invoice now, as a draft
            </label>
          </ActionForm>
        </section>
      )}

      {estimate.jobId && (
        <p className="text-sm">
          <a href={`/jobs/${estimate.jobId}`} className="underline underline-offset-4">Open the job</a>
        </p>
      )}
    </div>
  );
}

export interface DeliveryView {
  id: string; channel: string; destination: string | null; state: string; error: string | null; createdAt: string;
}

const DELIVERY_STATE: Record<string, string> = {
  queued: "waiting to go", sent: "sent", delivered: "delivered", bounced: "bounced",
  failed: "failed", refused: "not sent", link_issued: "link handed over", interrupted: "did not finish",
};

/**
 * EVERY TIME IT WAS SENT, and what became of it, read from the message rather
 * than stored. A bounce or a refusal is said in red, because an estimate the
 * customer never received is one nobody should be chasing them about.
 */
export function Deliveries({ deliveries, when }: { deliveries: DeliveryView[]; when: (iso: string) => string }) {
  if (deliveries.length === 0) return null;
  return (
    <section aria-label="Sent" className="mt-6">
      <h2 className="text-sm font-semibold">Sent</h2>
      <ul className="mt-2 space-y-1 text-sm text-ink-700">
        {deliveries.map((d) => {
          const bad = ["bounced", "failed", "refused", "interrupted"].includes(d.state);
          return (
            <li key={d.id}>
              {when(d.createdAt)},{" "}
              {d.channel === "email" ? `by email to ${d.destination}` : d.channel === "sms" ? `by text to ${d.destination}` : "as a link"}:{" "}
              <span className={bad ? "text-red-600" : "text-ink-900"}>{DELIVERY_STATE[d.state] ?? d.state}</span>
              {d.error ? <span className="text-red-600">. {d.error}</span> : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
