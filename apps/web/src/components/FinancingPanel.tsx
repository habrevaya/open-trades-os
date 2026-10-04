import type { financing } from "@opentradesos/api/services";
import { Chip, Money } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Table, Th, Td } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { offerFinancing, checkFinancing } from "@/app/(app)/invoices/financing/actions";

type Application = financing.ApplicationView;

/** Where an application stands, as a chip's tone. */
export const FINANCING_TONE: Record<string, "neutral" | "info" | "success" | "warning" | "danger"> = {
  sent: "neutral", applied: "info", approved: "success", funded: "success",
  declined: "danger", expired: "warning", cancelled: "warning",
};

const CHANNELS = [
  { value: "sms", label: "Text it to the customer" },
  { value: "email", label: "Email it to the customer" },
  { value: "link", label: "Just give me the link" },
];

const VIA: Record<string, string> = {
  portal: "from their own link", sms: "texted", email: "emailed", office_link: "link handed over",
};

/**
 * FINANCING ON AN INVOICE OR AN ESTIMATE, for the office.
 *
 * The monthly figure is shown only inside its sentence, which says it is
 * subject to the lender's approval, because that sentence is what the
 * customer will read and the office should be quoting the same words.
 */
export function FinancingPanel({
  subject, connected, lender, offers, applications, canSend, timezone,
}: {
  subject: { invoiceId: string } | { estimateId: string };
  connected: boolean;
  lender: string | null;
  /** One offer for an invoice; one per option for an estimate. */
  offers: { optionId: string | null; name: string | null; total: string; sentence: string | null; applicable: boolean }[];
  applications: Application[];
  canSend: boolean;
  timezone: string;
}) {
  const hidden: Record<string, string> = "invoiceId" in subject ? { invoiceId: subject.invoiceId } : { estimateId: subject.estimateId };
  const sendable = offers.filter((o) => o.applicable);

  return (
    <section aria-label="Financing" className="mt-8 rounded-md border border-steel-200 p-4">
      <h2 className="text-base font-semibold">Financing</h2>
      {!connected ? (
        <p className="mt-1 text-sm text-ink-700">
          Let customers pay over time by connecting a lender under{" "}
          <a href="/settings/integrations" className="underline underline-offset-4">Settings, Integrations</a>.
        </p>
      ) : (
        <>
          {offers.some((o) => o.sentence) ? (
            <ul className="mt-2 space-y-1 text-sm text-ink-700">
              {offers.filter((o) => o.sentence).map((o) => (
                <li key={o.optionId ?? "invoice"}>
                  {o.name ? <span className="font-medium text-ink-900">{o.name}: </span> : null}
                  {o.sentence}
                </li>
              ))}
            </ul>
          ) : (
            <p className="mt-1 text-sm text-ink-700">
              {sendable.length > 0
                ? `${lender ?? "The lender"} can finance this. No monthly figure is shown because no plans are entered on the connection, or the company turned the figure off.`
                : `${lender ?? "The lender"} does not finance this amount.`}
            </p>
          )}

          {canSend && sendable.length > 0 ? (
            <ActionForm action={offerFinancing} submit="Send the application link" hidden={hidden}
                        className="mt-3 flex flex-wrap items-end gap-3">
              {sendable.length > 1 || sendable[0]?.optionId ? (
                <Select label="Finance" name="optionId" className="w-56"
                        options={sendable.map((o) => ({ value: o.optionId ?? "", label: `${o.name ?? "This"}, $${Number(o.total).toFixed(2)}` }))} />
              ) : null}
              <Select label="How" name="channel" options={CHANNELS} className="w-56" />
              <TextField label="To (leave empty for what is on file)" name="to" className="w-64" />
            </ActionForm>
          ) : null}
        </>
      )}

      {applications.length > 0 && (
        <Table label="Financing applications" head={
          <><Th>Opened</Th><Th>Status</Th><Th className="text-right">Asked</Th><Th className="text-right">Approved</Th><Th>Offer chosen</Th><Th className="text-right">Funded</Th><Th className="text-right">Fee</Th><Th>{""}</Th></>
        }>
          {applications.map((a) => (
            <tr key={a.id}>
              <Td>
                {formatIn(a.createdAt, timezone, { dateStyle: "medium" })}
                <span className="block text-xs text-ink-500">{VIA[a.sentVia] ?? a.sentVia}{a.sentTo ? ` to ${a.sentTo}` : ""}</span>
              </Td>
              <Td>
                <Chip tone={FINANCING_TONE[a.status] ?? "neutral"}>{a.statusLabel}</Chip>
                {a.attention ? <span className="mt-1 block text-xs text-amber-700">{a.attention}</span> : null}
              </Td>
              <Td className="text-right"><Money value={a.amount} /></Td>
              <Td className="text-right">{a.approvedAmount ? <Money value={a.approvedAmount} /> : null}</Td>
              <Td className="text-ink-700">
                {a.chosenOffer ? `${a.chosenOffer.months} months at ${a.chosenOffer.aprPercent}% APR` : null}
              </Td>
              <Td className="text-right">{a.fundedAmount ? <Money value={a.fundedAmount} /> : null}</Td>
              <Td className="text-right">
                {a.status === "funded" ? (a.feeAmount ? <Money value={a.feeAmount} /> : <span className="text-ink-500">Not reported</span>) : null}
              </Td>
              <Td>
                {canSend && (a.status === "sent" || a.status === "applied" || a.status === "approved") ? (
                  <ActionForm action={checkFinancing} submit="Ask the lender" tone="quiet"
                              hidden={{ ...hidden, applicationId: a.id }} className="flex items-center gap-2" />
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </section>
  );
}
