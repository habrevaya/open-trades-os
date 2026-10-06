import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { expenses } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { Empty } from "@/components/Table";
import { formatDay, todayIn } from "@/lib/dates";
import { addReceipt, recordExpense } from "../actions";

export const dynamic = "force-dynamic";

/**
 * MONEY I SPENT FOR THE COMPANY
 *
 * What the person paid out of their own pocket, with a photograph of the
 * receipt, and what the office said about each. An approved one is paid back
 * with their pay and no tax is taken from it; a refused one says why. The same
 * thing the phone app and `/my-day` offer, for somebody at a desk.
 *
 * Only ever their own: the page asks for nobody by id.
 */
export default async function MyExpensesPage() {
  const user = await requireSetupUser();
  const zone = user.organizationTimezone;
  const header = (
    <>
      <Crumb href="/me">My record</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Money I spent</h1>
    </>
  );
  if (!can(user.actor, "expense:own")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        {header}
        <Empty title="Not part of your access">Ask the office to give your role record what you paid for the company.</Empty>
      </div>
    );
  }
  const own = await expenses.mine({ actor: user.actor, db: getDb() });
  if (!own.technician) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-6">
        {header}
        <Empty title="Nobody to pay this back to here">
          Paying back what you spent goes through the board. Ask the office to pay you another way.
        </Empty>
      </div>
    );
  }
  const today = todayIn(zone);

  return (
    <div className="mx-auto max-w-3xl px-4 py-6">
      {header}
      <p className="mt-1 text-sm text-ink-700">
        Paid for something for the company out of your own pocket? Put it here with a photo of the receipt.
        The office says yes or no, and an approved one is paid back with your pay with no tax taken off it.
      </p>

      <section className="mt-4" aria-labelledby="put-in">
        <h2 id="put-in" className="text-base font-semibold">Put one in</h2>
        <ActionForm action={recordExpense} submit="Save it" className="mt-3 grid gap-3 sm:grid-cols-2">
          <TextField label="What you paid (dollars)" name="amount" inputMode="decimal" required placeholder="42.50" />
          <TextField label="Day you paid it" name="spentOn" type="date" required defaultValue={today} max={today} />
          <TextField label="What it was for" name="description" required maxLength={300}
                     placeholder="Capacitor from the supply house" className="block sm:col-span-2" />
          <TextField label="Job number (if it was for a job)" name="jobNumber" inputMode="numeric" placeholder="1042" />
          <label className="block">
            <span className="text-sm font-medium text-ink-700">Photo of the receipt</span>
            <input type="file" name="receipt" accept="image/*,application/pdf" capture="environment"
                   aria-label="Photo of the receipt" className="mt-2 block text-sm" />
          </label>
        </ActionForm>
      </section>

      <section className="mt-8" aria-labelledby="mine">
        <h2 id="mine" className="text-base font-semibold">What you have put in</h2>
        {own.expenses.length === 0 ? (
          <p className="mt-1 text-sm text-ink-700">Nothing yet.</p>
        ) : (
          <ul className="mt-2 divide-y divide-steel-200 text-sm">
            {own.expenses.map((e) => (
              <li key={e.id} className="py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium"><Money value={e.amount} /></span>
                  <span>{e.description}</span>
                  {e.status === "approved" ? <Chip tone="success">Approved</Chip>
                    : e.status === "refused" ? <Chip tone="danger">Not approved</Chip>
                    : <Chip tone="warning">Waiting for the office</Chip>}
                </div>
                <p className="text-ink-500">
                  {formatDay(e.spentOn, zone)}{e.jobNumber ? `, job ${e.jobNumber}` : ", not for a job"}
                  {e.receipts > 0
                    ? <>{", "}<a href={`/me/expenses/${e.id}/receipt`} target="_blank" rel="noreferrer" className="text-blue-600 underline underline-offset-4">receipt</a></>
                    : ", no receipt"}
                </p>
                {e.status === "refused" && e.decisionReason ? <p className="text-ink-700">{e.decisionReason}</p> : null}
                {e.status === "approved" ? (
                  <p className="text-ink-700">
                    {e.paidIn ? `Paid back with ${e.paidIn.label}.` : "It will be paid back with your pay once a pay period covers it."}
                  </p>
                ) : null}
                {e.status === "pending" ? (
                  <ActionForm action={addReceipt} submit="Add a photo" tone="quiet" hidden={{ id: e.id }} className="mt-2 flex items-end gap-2">
                    <input type="file" name="receipt" accept="image/*,application/pdf" required
                           aria-label={`Photo for ${e.description}`} className="block text-sm" />
                  </ActionForm>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {own.perDiems.length > 0 ? (
        <section className="mt-8" aria-labelledby="away">
          <h2 id="away" className="text-base font-semibold">Days away you are paid for</h2>
          <ul className="mt-2 space-y-1 text-sm">
            {own.perDiems.map((d) => (
              <li key={d.id}>
                {formatDay(d.day, zone)}, job {d.jobNumber}: <Money value={d.amount} />
                <span className="text-ink-500">{d.paidIn ? `, with ${d.paidIn.label}` : ""}</span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
