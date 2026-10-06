import { notFound } from "next/navigation";
import { Money } from "@opentradesos/ui";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { deliverySchedules, statementDelivery } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Empty, PageHeader, Table, Th, Td } from "@/components/Table";
import { formatDay, formatIn } from "@/lib/dates";
import { enumText } from "@/lib/labels";
import { setMonthlyStatements } from "./actions";

export const dynamic = "force-dynamic";

const DOLLARS = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/**
 * STATEMENTS
 *
 * Two things: whether every customer with a balance is sent one each month,
 * and what has been sent, by hand or by that run. The list is the answer to
 * "did they get it", so a statement that did not go is on it with the reason
 * rather than missing from it.
 */
export default async function StatementsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "invoice:read")) notFound();

  const monthly = await deliverySchedules.statementSchedule(ctx);
  const sent = await statementDelivery.deliveries(ctx, { limit: 100 });
  const sends = can(user.actor, "invoice:send");
  const zone = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Statements" />
      <p className="mt-1 text-sm text-ink-700">
        A statement goes as a link to the customer&apos;s own account page, which shows what they owe when
        they open it. Send one from a customer&apos;s statement page, or let the monthly run do it.
      </p>

      <section className="mt-6 rounded-md border border-steel-200 bg-canvas p-4" aria-label="Monthly statements">
        <h2 className="text-sm font-medium text-ink-700">Monthly statements</h2>
        <p className="mt-1 text-sm text-ink-700">
          {monthly.enabled
            ? `On. Every customer owing more than ${DOLLARS.format(Number(monthly.minimumBalance))} is sent their statement for the month before on the ${monthly.dayOfMonth}${suffix(monthly.dayOfMonth)} at ${monthly.time}.`
            : "Off. Nobody is sent a statement unless somebody sends it."}
          {monthly.enabled && monthly.textWhenPreferred
            ? " By text to customers whose main contact prefers texts, by email to everybody else." : ""}
          {monthly.enabled && monthly.nextRunAt ? ` Next: ${formatIn(monthly.nextRunAt, zone)}.` : ""}
        </p>
        {monthly.lastError ? <p className="mt-1 text-sm text-red-600">{monthly.lastError}</p> : null}
        {sends ? (
          <ActionForm action={setMonthlyStatements} submit="Save" done="Saved." className="mt-3 space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={monthly.enabled} />
              Send every customer with a balance their statement each month
            </label>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="textWhenPreferred" defaultChecked={monthly.textWhenPreferred} />
              Text it to customers whose main contact prefers texts, and email everybody else
            </label>
            <div className="grid gap-3 sm:grid-cols-3">
              <TextField label="Day of the month (1 to 28)" name="dayOfMonth" type="number" min={1} max={28}
                         defaultValue={String(monthly.dayOfMonth)} />
              <TextField label={`Time (${zone})`} name="time" type="time" defaultValue={monthly.time} />
              <TextField label="Only if they owe more than ($)" name="minimumBalance" inputMode="decimal"
                         defaultValue={String(Number(monthly.minimumBalance))} />
            </div>
            <p className="text-xs text-ink-500">
              Owed is counted on open invoices by whoever pays them, so a property manager paying for a tenant
              is the one sent it. Each customer is sent at most one a month. A text that cannot go (they asked
              not to be texted, or there is no mobile number) is emailed instead, and the list below says so.
            </p>
          </ActionForm>
        ) : null}
      </section>

      <h2 className="mt-8 text-sm font-medium text-ink-700">Sent</h2>
      {sent.length === 0 ? (
        <Empty title="No statements sent yet">
          Open a customer, then Statement, then Email statement or Text statement.
        </Empty>
      ) : (
        <Table
          label="Statements sent"
          head={<><Th>Customer</Th><Th>Period</Th><Th>To</Th><Th className="text-right">Owed then</Th><Th>What happened</Th><Th>When</Th></>}
        >
          {sent.map((row) => (
            <tr key={row.id}>
              <Td><a href={`/customers/${row.customerId}/statement`} className="hover:underline">{row.customerName}</a></Td>
              <Td>
                {formatDay(row.periodFrom, zone)} to {formatDay(row.periodTo, zone)}
                {row.period ? <span className="block text-xs text-ink-500">Monthly run</span> : null}
              </Td>
              <Td>
                {row.destination ?? <span className="text-ink-500">No address</span>}
                <span className="block text-xs text-ink-500">{row.channel === "sms" ? "By text" : "By email"}</span>
              </Td>
              <Td className="text-right"><Money value={row.closingBalance} /></Td>
              <Td>
                {row.error
                  ? <span className="text-red-600">Not sent. {row.error}</span>
                  : enumText(row.messageStatus ?? "queued")}
                {row.note ? <span className="block text-xs text-ink-500">{row.note}</span> : null}
              </Td>
              <Td>{formatIn(row.createdAt, zone)}</Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}

function suffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return "th";
  return ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
}
