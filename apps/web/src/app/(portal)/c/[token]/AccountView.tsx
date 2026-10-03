import type { ReactNode } from "react";

export interface AccountViewData {
  organizationName: string;
  customerName: string;
  properties: { id: string; line1: string; line2: string | null; city: string; state: string; postalCode: string }[];
  jobs: { id: string; number: number; summary: string; status: string; completedAt: string | null }[];
  visits: {
    id: string; jobNumber: number; summary: string; status: string;
    windowStart: string | null; windowEnd: string | null; technicianName: string | null;
  }[];
  invoices: {
    id: string; number: number; status: string; issuedOn: string | null; dueOn: string | null;
    currency: string; total: string; balance: string; payable: boolean;
    tipping: { available: boolean; presets: { percent: number; amount: string }[]; for: string[] };
  }[];
  estimates: { id: string; number: number; title: string | null; status: string; sentAt: string | null }[];
  agreements: { id: string; planName: string; status: string; startedOn: string; endsOn: string | null }[];
  deposits: { id: string; status: string; amountRequested: string; amountReceived: string; currency: string }[];
  onlinePaymentAvailable: boolean;
}

export const money = (value: string, currency: string) =>
  Number(value).toLocaleString("en-US", { style: "currency", currency });

const day = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

const time = (iso: string) =>
  new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });

const VISIT: Record<string, string> = {
  unassigned: "Being scheduled", scheduled: "Scheduled", dispatched: "Scheduled",
  en_route: "On the way", working: "In progress", completed: "Done",
  completed_after_cancellation: "Done", cancelled: "Cancelled", no_show: "Missed",
};

const INVOICE: Record<string, string> = {
  open: "Due", partially_paid: "Part paid", paid: "Paid", void: "Cancelled", written_off: "Closed",
};

const ESTIMATE: Record<string, string> = {
  sent: "Waiting for you", viewed: "Waiting for you", approved: "Approved", converted: "Approved",
  declined: "Declined", expired: "Expired",
};

const JOB: Record<string, string> = {
  scheduled: "Booked", in_progress: "Under way", on_hold: "On hold",
  completed: "Done", invoiced: "Done", paid: "Done",
};

const AGREEMENT: Record<string, string> = {
  pending: "Starting", active: "Active", past_due: "Payment due", paused: "Paused",
  lapsed: "Lapsed", cancelled: "Cancelled", completed: "Finished",
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="rounded-md border border-steel-200 bg-canvas p-5">
      <h2 className="text-xs uppercase tracking-[0.08em] text-ink-500">{title}</h2>
      {children}
    </section>
  );
}

/**
 * Everything a customer has with the company, from one link.
 *
 * Separate from the page so it renders in a test without a database. `pay`
 * builds the card control for one invoice; it is a client component bound
 * to the token and the invoice on the server.
 */
export function AccountView({
  account, pay, returned = null, statementHref, changeHref, open, top, after,
  closing = "Questions? Reply to the message that brought you here.",
}: {
  account: AccountViewData;
  /** Where asking to move or cancel one coming visit opens, when the page offers it. */
  changeHref?: (visitId: string) => string;
  /** Where the customer's statement opens, when there is one to show. */
  statementHref?: string;
  /** Stripe's redirect outcome, which is the browser's account and changes nothing. */
  returned?: string | null;
  pay: (invoice: AccountViewData["invoices"][number]) => ReactNode;
  /**
   * A control that opens one estimate, job or invoice on its own page. Only a
   * signed in customer gets one: an account link must not hand out an
   * approval link, so the link page leaves this out.
   */
  open?: (kind: "estimate" | "job" | "invoice", id: string, label: string) => ReactNode;
  /** Above everything else, under the name: who is signed in, and signing out. */
  top?: ReactNode;
  /** After the history, before the closing line: saved cards, for a signed in customer. */
  after?: ReactNode;
  /** The last line. A signed in customer did not arrive from a message, so is told something else. */
  closing?: string;
}) {
  const now = Date.now();
  const upcoming = account.visits
    .filter((v) => v.windowStart && new Date(v.windowStart).getTime() >= now
      && v.status !== "cancelled" && v.status !== "completed")
    .reverse();
  const past = account.visits.filter((v) => !upcoming.includes(v)).slice(0, 10);
  const owed = account.invoices.filter((i) => i.payable);
  const settled = account.invoices.filter((i) => !i.payable);

  return (
    <>
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{account.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">{account.customerName}</h1>
        {statementHref && account.invoices.length > 0 && (
          <a href={statementHref} className="mt-2 inline-block text-sm text-blue-600 underline underline-offset-4">
            Your statement
          </a>
        )}
        {top}
      </header>

      {(returned === "succeeded" || returned === "processing") && (
        <p className="rounded-md border border-steel-200 bg-canvas p-4 text-center text-sm text-ink-700" role="status">
          {returned === "succeeded"
            ? "Thank you. Your payment went through and will show here in a moment."
            : "Your payment is processing. It will show here once your bank confirms it."}
        </p>
      )}
      {returned === "failed" && (
        <p className="rounded bg-red-tint px-3 py-2 text-center text-sm text-red-600" role="alert">
          That payment did not go through. You have not been charged.
        </p>
      )}

      {owed.length > 0 && (
        <Section title="To pay">
          <ul className="mt-3 space-y-4">
            {owed.map((invoice) => (
              <li key={invoice.id}>
                <div className="flex justify-between gap-4 text-sm">
                  <span>
                    Invoice #{invoice.number}
                    {invoice.dueOn && <span className="text-ink-500">, due {day(invoice.dueOn)}</span>}
                  </span>
                  <span className="shrink-0 font-mono tabular-nums">{money(invoice.balance, invoice.currency)}</span>
                </div>
                {account.onlinePaymentAvailable && <div className="mt-2">{pay(invoice)}</div>}
              </li>
            ))}
          </ul>
          {!account.onlinePaymentAvailable && (
            <p className="mt-3 text-sm text-ink-700">
              {account.organizationName} does not take card payments online yet. Reply to the message
              that brought you here and they will tell you how to pay.
            </p>
          )}
        </Section>
      )}

      <Section title="Coming up">
        {upcoming.length === 0 ? (
          <p className="mt-3 text-sm text-ink-500">Nothing scheduled.</p>
        ) : (
          <ul className="mt-3 space-y-2 text-sm">
            {upcoming.map((v) => (
              <li key={v.id} className="flex justify-between gap-4">
                <span>
                  {v.summary}
                  {v.technicianName && <span className="text-ink-500">, with {v.technicianName.split(" ")[0]}</span>}
                </span>
                <span className="shrink-0 text-right text-ink-700">
                  {day(v.windowStart!)}
                  <span className="block text-xs text-ink-500">
                    {time(v.windowStart!)}{v.windowEnd ? ` to ${time(v.windowEnd)}` : ""}
                  </span>
                  {changeHref && v.status !== "en_route" && v.status !== "working" ? (
                    <a href={changeHref(v.id)} className="block text-xs text-ink-700 underline underline-offset-4">
                      Change or cancel
                    </a>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      {account.jobs.length > 0 && (
        <Section title="Your work">
          <ul className="mt-3 space-y-2 text-sm">
            {account.jobs.slice(0, 20).map((j) => (
              <li key={j.id} className="flex items-start justify-between gap-4">
                <span>
                  {j.summary}
                  <span className="block text-xs text-ink-500">
                    Job #{j.number}{j.completedAt ? `, done ${day(j.completedAt)}` : ""}
                  </span>
                </span>
                <span className="shrink-0 text-right text-ink-700">
                  {JOB[j.status] ?? "In progress"}
                  {open ? <span className="block">{open("job", j.id, "Details and photos")}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {past.length > 0 && (
        <Section title="Visits">
          <ul className="mt-3 space-y-2 text-sm">
            {past.map((v) => (
              <li key={v.id} className="flex justify-between gap-4">
                <span>{v.summary}</span>
                <span className="shrink-0 text-ink-700">
                  {v.windowStart ? day(v.windowStart) : ""} · {VISIT[v.status] ?? v.status}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {settled.length > 0 && (
        <Section title="Invoices">
          <ul className="mt-3 space-y-2 text-sm">
            {settled.map((i) => (
              <li key={i.id} className="flex justify-between gap-4">
                <span>Invoice #{i.number}{i.issuedOn ? `, ${day(i.issuedOn)}` : ""}</span>
                <span className="shrink-0 text-right text-ink-700">
                  <span className="font-mono tabular-nums">{money(i.total, i.currency)}</span>
                  {" · "}{INVOICE[i.status] ?? i.status}
                  {open ? <span className="block">{open("invoice", i.id, "See invoice")}</span> : null}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {account.estimates.length > 0 && (
        <Section title="Estimates">
          <ul className="mt-3 space-y-2 text-sm">
            {account.estimates.map((e) => (
              <li key={e.id} className="flex justify-between gap-4">
                <span>Estimate #{e.number}{e.title ? `, ${e.title}` : ""}</span>
                <span className="shrink-0 text-right text-ink-700">
                  {ESTIMATE[e.status] ?? e.status}
                  {open ? (
                    <span className="block">
                      {open("estimate", e.id, e.status === "sent" || e.status === "viewed" ? "Look and approve" : "See estimate")}
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {account.agreements.length > 0 && (
        <Section title="Plans">
          <ul className="mt-3 space-y-2 text-sm">
            {account.agreements.map((a) => (
              <li key={a.id} className="flex justify-between gap-4">
                <span>{a.planName}</span>
                <span className="shrink-0 text-ink-700">
                  {AGREEMENT[a.status] ?? a.status}
                  {a.endsOn ? `, renews ${day(a.endsOn)}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {account.deposits.some((d) => d.status === "held") && (
        <Section title="Deposits held">
          <ul className="mt-3 space-y-2 text-sm">
            {account.deposits.filter((d) => d.status === "held").map((d) => (
              <li key={d.id} className="flex justify-between gap-4">
                <span>Held against upcoming work</span>
                <span className="shrink-0 font-mono tabular-nums">{money(d.amountReceived, d.currency)}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {account.properties.length > 0 && (
        <Section title={account.properties.length === 1 ? "Your home" : "Your homes"}>
          <ul className="mt-3 space-y-2 text-sm">
            {account.properties.map((p) => (
              <li key={p.id}>
                {p.line1}{p.line2 ? `, ${p.line2}` : ""}
                <span className="block text-ink-500">{p.city}, {p.state} {p.postalCode}</span>
              </li>
            ))}
          </ul>
        </Section>
      )}

      {after}

      <p className="text-center text-sm text-ink-700">{closing}</p>
    </>
  );
}
