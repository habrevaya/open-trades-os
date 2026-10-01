import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { invoiceDelivery } from "@opentradesos/api/services";
import { PortalBrand } from "../../PortalBrand";
import { PayNow } from "../../PayNow";
import { startPayment } from "./actions";

export const dynamic = "force-dynamic";

type Invoice = Awaited<ReturnType<typeof invoiceDelivery.viewInvoice>>;

const money = (value: string, currency: string) =>
  Number(value).toLocaleString("en-US", { style: "currency", currency });

const day = (iso: string) =>
  new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso).toLocaleDateString("en-US", {
    month: "long", day: "numeric", year: "numeric",
  });

const METHOD: Record<string, string> = {
  card: "Card", card_present: "Card", ach: "Bank transfer", cash: "Cash",
  check: "Cheque", financing: "Financing", credit: "Account credit", other: "Payment",
};

/**
 * The invoice, from the link in the email.
 *
 * Every emailed invoice has linked here since invoices could be sent, and
 * until this page existed the link opened a 404: the customer was asked to
 * "view and pay" an invoice and could do neither.
 *
 * Resolved from the token alone, like the estimate and tracking pages. The
 * grant is peeked rather than spent, because a customer opens an invoice,
 * goes to find a card and comes back. Expired, revoked, never issued and a
 * suspended company all land on the same 404, for the reason the estimate
 * page gives: saying which one it was tells somebody which tokens were real.
 */
export default async function InvoicePage({
  params, searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { token } = await params;
  const query = await searchParams;

  let invoice: Invoice;
  try {
    invoice = await invoiceDelivery.viewInvoice(getDb(), { token });
  } catch {
    notFound();
  }

  /**
   * Stripe sends the customer back here with the outcome in the query
   * string. That is the browser's account of it, so it changes nothing: the
   * balance moves when the processor's signed webhook arrives, which is
   * usually a second or two later. The page says so rather than showing a
   * balance that looks as if the payment did not take.
   */
  const returned = typeof query["redirect_status"] === "string" ? query["redirect_status"] : null;

  return (
    <PortalBrand token={token}>
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{invoice.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">Invoice #{invoice.number}</h1>
        {invoice.propertyAddress && (
          <p className="mt-1 text-sm text-ink-500">{invoice.propertyAddress}</p>
        )}
        <p className="mt-1 text-sm text-ink-500">
          {invoice.issuedOn && <>Issued {day(invoice.issuedOn)}</>}
          {invoice.issuedOn && invoice.dueOn && " · "}
          {invoice.dueOn && <>Due {day(invoice.dueOn)}</>}
        </p>
      </header>

      <Summary invoice={invoice} returned={returned} />

      {invoice.payable && returned !== "succeeded" && returned !== "processing" && (
        invoice.onlinePaymentAvailable ? (
          <PayNow
            start={startPayment.bind(null, token)}
            balance={money(invoice.balance, invoice.currency)}
          />
        ) : (
          <div className="rounded-md border border-steel-200 bg-canvas p-5 text-sm text-ink-700">
            <p className="font-medium text-ink-900">How to pay</p>
            {/*
              No processor is connected, so there is no card form to show.
              Saying exactly that is better than a button that fails.
            */}
            <p className="mt-1">
              {invoice.organizationName} does not take card payments online yet. Reply to the
              message that brought you here and they will tell you how to pay, by cheque, bank
              transfer or card over the phone.
            </p>
          </div>
        )
      )}

      <Lines invoice={invoice} />

      {invoice.payments.length > 0 && (
        <section className="rounded-md border border-steel-200 bg-canvas p-5">
          <h2 className="text-xs uppercase tracking-[0.08em] text-ink-500">Payments received</h2>
          <ul className="mt-3 space-y-2 text-sm">
            {invoice.payments.map((p, i) => (
              <li key={`${p.receivedAt}-${i}`} className="flex justify-between gap-4">
                <span className="text-ink-700">
                  {METHOD[p.method] ?? "Payment"}, {day(p.receivedAt)}
                </span>
                <span className="shrink-0 font-mono tabular-nums">
                  {money(p.amount, invoice.currency)}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <p className="text-center text-sm text-ink-700">
        Questions about this invoice? Reply to the message that brought you here.
      </p>
    </PortalBrand>
  );
}

function Summary({ invoice, returned }: { invoice: Invoice; returned: string | null }) {
  const settled = invoice.status === "paid";
  const voided = invoice.status === "void" || invoice.status === "written_off";

  return (
    <div className="rounded-md border border-steel-200 bg-canvas p-6 text-center">
      {voided ? (
        <p className="text-lg font-medium">
          This invoice was {invoice.status === "void" ? "cancelled" : "closed"}. Nothing is owed on it.
        </p>
      ) : settled ? (
        <>
          <p className="text-lg font-medium">Paid in full. Thank you.</p>
          <p className="mt-1 font-mono text-sm tabular-nums text-ink-700">
            {money(invoice.total, invoice.currency)}
          </p>
        </>
      ) : (
        <>
          <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Balance due</p>
          <p className="mt-2 font-mono text-3xl font-semibold tabular-nums">
            {money(invoice.balance, invoice.currency)}
          </p>
          {returned === "succeeded" || returned === "processing" ? (
            <p className="mt-3 text-sm text-ink-700">
              {returned === "succeeded"
                ? "Thank you. Your payment went through and will show here in a moment."
                : "Your payment is processing. It will show here once your bank confirms it."}
            </p>
          ) : returned === "failed" ? (
            <p className="mt-3 rounded bg-red-tint px-3 py-2 text-sm text-red-600">
              That payment did not go through. You have not been charged.
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}

function Lines({ invoice }: { invoice: Invoice }) {
  const c = invoice.currency;
  const discount = Number(invoice.discountTotal) > 0;
  const tax = Number(invoice.taxTotal) > 0;

  return (
    <section className="rounded-md border border-steel-200 bg-canvas p-5">
      <ul className="space-y-3 text-sm">
        {invoice.lines.map((line) => (
          <li key={line.id} className="flex justify-between gap-4">
            <span className="min-w-0">
              <span className="text-ink-900">
                {Number(line.quantity) !== 1 && `${Number(line.quantity)} × `}
                {line.name}
              </span>
              {line.description && (
                <span className="block text-ink-500">{line.description}</span>
              )}
            </span>
            <span className="shrink-0 font-mono tabular-nums text-ink-700">
              {money(line.lineTotal, c)}
            </span>
          </li>
        ))}
      </ul>

      <dl className="mt-4 space-y-1 border-t border-steel-200 pt-4 text-sm">
        <Row label="Subtotal" value={money(invoice.subtotal, c)} />
        {discount && <Row label="Discount" value={`−${money(invoice.discountTotal, c)}`} />}
        <Row label="Tax" value={tax ? money(invoice.taxTotal, c) : money("0", c)} />
        <Row label="Total" value={money(invoice.total, c)} strong />
        {Number(invoice.amountPaid) > 0 && (
          <Row label="Paid" value={`−${money(invoice.amountPaid, c)}`} />
        )}
        <Row label="Balance" value={money(invoice.balance, c)} strong />
      </dl>
    </section>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className={`flex justify-between ${strong ? "font-medium text-ink-900" : "text-ink-700"}`}>
      <dt>{label}</dt>
      <dd className="font-mono tabular-nums">{value}</dd>
    </div>
  );
}
