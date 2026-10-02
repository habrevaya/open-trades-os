import type { ReactNode } from "react";

export interface DepositViewData {
  organizationName: string;
  estimateNumber: number | null;
  estimateTitle: string | null;
  status: string;
  currency: string;
  amountRequested: string;
  amountReceived: string;
  outstanding: string;
  payable: boolean;
  onlinePaymentAvailable: boolean;
}

export const money = (value: string, currency: string) =>
  Number(value).toLocaleString("en-US", { style: "currency", currency });

/**
 * What a deposit link shows, apart from the card form.
 *
 * Separate from the page so it renders in a test without a database. The
 * pay control is passed in, because it is a client component bound to the
 * token on the server.
 */
export function DepositView({ deposit, returned, pay }: {
  deposit: DepositViewData;
  returned: string | null;
  pay: ReactNode;
}) {
  const c = deposit.currency;
  const settled = !deposit.payable && Number(deposit.outstanding) === 0
    && (deposit.status === "held" || deposit.status === "applied");
  const closed = deposit.status === "refunded" || deposit.status === "forfeited";
  const justPaid = returned === "succeeded" || returned === "processing";

  return (
    <>
      <header className="text-center">
        <p className="text-sm font-medium text-ink-700">{deposit.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">Deposit</h1>
        {deposit.estimateNumber !== null && (
          <p className="mt-1 text-sm text-ink-500">
            For estimate #{deposit.estimateNumber}
            {deposit.estimateTitle ? `, ${deposit.estimateTitle}` : ""}
          </p>
        )}
      </header>

      <div className="rounded-md border border-steel-200 bg-canvas p-6 text-center">
        {closed ? (
          <p className="text-lg font-medium">
            This deposit was {deposit.status === "refunded" ? "refunded" : "closed"}. Nothing is owed on it.
          </p>
        ) : settled ? (
          <>
            <p className="text-lg font-medium">Deposit received. Thank you.</p>
            <p className="mt-1 font-mono text-sm tabular-nums text-ink-700">
              {money(deposit.amountReceived, c)}
            </p>
          </>
        ) : (
          <>
            <p className="text-xs uppercase tracking-[0.08em] text-ink-500">Deposit due</p>
            <p className="mt-2 font-mono text-3xl font-semibold tabular-nums">
              {money(deposit.outstanding, c)}
            </p>
            {Number(deposit.amountReceived) > 0 && (
              <p className="mt-1 text-sm text-ink-500">
                {money(deposit.amountReceived, c)} of {money(deposit.amountRequested, c)} received so far
              </p>
            )}
            {justPaid ? (
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

      {deposit.payable && !justPaid && (
        deposit.onlinePaymentAvailable ? pay : (
          <div className="rounded-md border border-steel-200 bg-canvas p-5 text-sm text-ink-700">
            <p className="font-medium text-ink-900">How to pay</p>
            <p className="mt-1">
              {deposit.organizationName} does not take card payments online yet. Reply to the
              message that brought you here and they will tell you how to pay.
            </p>
          </div>
        )
      )}

      <p className="text-center text-sm text-ink-700">
        A deposit is held against the work and taken off your invoice when it is done.
      </p>
    </>
  );
}
