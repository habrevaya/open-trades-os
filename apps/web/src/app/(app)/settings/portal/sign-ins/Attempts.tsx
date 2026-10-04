import { Chip } from "@opentradesos/ui";
import { Table, Th, Td } from "@/components/Table";
import { formatIn } from "@/lib/dates";

export interface AttemptRow {
  id: string;
  at: string;
  channel: "email" | "sms";
  address: string;
  outcome: "signed_in" | "waiting" | "wrong_code" | "too_many_attempts" | "replaced" | "expired" | "no_account";
  wrongCodes: number;
  delivery: string | null;
  requestedIp: string | null;
  signedInIp: string | null;
  customers: { id: string; name: string }[];
  contactName: string | null;
}

const OUTCOME: Record<AttemptRow["outcome"], { text: string; tone: "success" | "warning" | "danger" | "neutral" }> = {
  signed_in: { text: "Signed in", tone: "success" },
  waiting: { text: "Code sent, not used yet", tone: "neutral" },
  wrong_code: { text: "Wrong code typed", tone: "warning" },
  too_many_attempts: { text: "Stopped after five wrong codes", tone: "danger" },
  replaced: { text: "Replaced by a newer code", tone: "neutral" },
  expired: { text: "Code never used", tone: "neutral" },
  no_account: { text: "Not an address on file", tone: "neutral" },
};

/**
 * What the message did, in words. `queued` means it went to the company's
 * sender; anything else is the sender's own reason it could not go, which
 * is the answer to "the code never came".
 */
const delivered = (delivery: string | null) =>
  delivery === null ? "Not sent" : delivery === "queued" ? "Sent" : `Not sent: ${delivery}`;

/**
 * SIGN IN ATTEMPTS, as a table. Shared by the company wide screen and the
 * customer's page, so both say the same thing about the same attempt.
 */
export function Attempts({ attempts, timezone, showCustomer = true, label = "Sign in attempts" }: {
  attempts: AttemptRow[];
  timezone: string;
  showCustomer?: boolean;
  label?: string;
}) {
  return (
    <Table label={label} head={(
      <>
        <Th>When</Th>
        {showCustomer && <Th>Customer</Th>}
        <Th>Sent to</Th>
        <Th>What happened</Th>
        <Th>Message</Th>
        <Th>From</Th>
      </>
    )}>
      {attempts.map((a) => (
        <tr key={a.id} className="hover:bg-steel-100">
          <Td className="whitespace-nowrap text-ink-700">{formatIn(a.at, timezone)}</Td>
          {showCustomer && (
            <Td>
              {a.customers.length === 0 ? <span className="text-ink-500">Nobody</span> : a.customers.map((c, i) => (
                <span key={c.id}>
                  {i > 0 ? ", " : ""}
                  <a href={`/customers/${c.id}`} className="hover:underline">{c.name}</a>
                </span>
              ))}
              {a.contactName && <span className="block text-xs text-ink-500">as {a.contactName}</span>}
            </Td>
          )}
          <Td>
            {a.address}
            <span className="block text-xs text-ink-500">{a.channel === "sms" ? "Text" : "Email"}</span>
            {!showCustomer && a.contactName && <span className="block text-xs text-ink-500">{a.contactName}</span>}
          </Td>
          <Td>
            <Chip tone={OUTCOME[a.outcome].tone}>{OUTCOME[a.outcome].text}</Chip>
            {a.wrongCodes > 0 && a.outcome !== "too_many_attempts" && (
              <span className="block text-xs text-ink-500">
                {a.wrongCodes === 1 ? "1 wrong code" : `${a.wrongCodes} wrong codes`}
              </span>
            )}
          </Td>
          <Td className="text-ink-700">{delivered(a.delivery)}</Td>
          <Td className="font-mono text-xs text-ink-700">{a.signedInIp ?? a.requestedIp ?? ""}</Td>
        </tr>
      ))}
    </Table>
  );
}
