import { taxRates, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Empty, Table, Th, Td } from "@/components/Table";
import { formatDay } from "@/lib/dates";
import { addRate, changeRate, retireRate, saveTaxSettings } from "./actions";

/**
 * THE SALES TAX RATES THE COMPANY CHARGES
 *
 * Drawn on Settings and on the setup wizard's tax step, one form rather than a
 * copy. Each rate is a name and a percentage from a day; a new percentage is a
 * change from a day, so invoices already raised keep what they charged. The
 * usual rate is charged wherever a customer or an address names none, and a
 * company that charges no sales tax says so once here.
 *
 * The product does not look a rate up from an address (BUILD.md): these are
 * the rates the company already knows it charges.
 */
export async function TaxRatesSection({ ctx, timeZone }: { ctx: ServiceContext; timeZone: string }) {
  if (!can(ctx.actor, "settings:read")) {
    return <Empty title="Not shown to your role">Sales tax rates are company settings.</Empty>;
  }
  const view = await taxRates.list(ctx);
  const writes = can(ctx.actor, "settings:write");
  const live = view.rates.filter((r) => !r.retired);
  const usual = live.find((r) => r.isDefault);

  return (
    <div className="space-y-8">
      <section aria-labelledby="tax-answer">
        <h2 id="tax-answer" className="text-base font-semibold">Do you charge sales tax?</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          {!view.chargesTax
            ? "You have said you charge no sales tax, so nothing is taxed anywhere."
            : usual
              ? `Taxable lines are charged ${usual.name} at ${usual.current?.percent ?? "?"}% unless the customer or the address says otherwise.`
              : live.length > 0
                ? "No usual rate yet, so only customers and addresses with a rate of their own are taxed."
                : "No rates yet, so nothing is taxed. Add the rate you charge below."}
        </p>
        {writes ? (
          <ActionForm action={saveTaxSettings} submit="Save" tone="quiet" className="mt-3 grid gap-3 sm:grid-cols-2">
            <Select label="Sales tax" name="chargesTax" defaultValue={view.chargesTax ? "yes" : "no"} options={[
              { value: "yes", label: "We charge sales tax" },
              { value: "no", label: "We charge no sales tax at all" },
            ]} />
            <Select label="Usual rate" name="defaultTaxRateId" defaultValue={view.defaultTaxRateId ?? ""} options={[
              { value: "", label: "None" },
              ...live.map((r) => ({ value: r.id, label: `${r.name}${r.current ? ` ${r.current.percent}%` : ""}` })),
            ]} />
          </ActionForm>
        ) : null}
      </section>

      <section aria-labelledby="tax-rates">
        <h2 id="tax-rates" className="text-base font-semibold">Your rates</h2>
        {view.rates.length === 0 ? (
          <Empty title="No rates yet">Add the rate you charge, like Travis County 8.25%.</Empty>
        ) : (
          <Table label="Sales tax rates" head={<><Th>Rate</Th><Th className="text-right">Now</Th><Th>History</Th><Th>Used by</Th><Th>{""}</Th></>}>
            {view.rates.map((r) => (
              <tr key={r.id}>
                <Td>
                  <span className="font-medium">{r.name}</span>
                  {r.isDefault ? <Chip tone="success" className="ml-2">Usual</Chip> : null}
                  {r.retired ? <Chip tone="neutral" className="ml-2">Retired</Chip> : null}
                </Td>
                <Td className="text-right font-mono tabular-nums">{r.current ? `${r.current.percent}%` : "Not yet"}</Td>
                <Td className="text-sm text-ink-700">
                  <ul>
                    {r.versions.map((v) => (
                      <li key={v.id}>
                        {v.percent}% from {formatDay(v.effectiveFrom, timeZone)}
                        {v.state === "scheduled" ? " (coming)" : v.state === "current" ? " (now)" : ""}
                        {v.note ? `, ${v.note}` : ""}
                      </li>
                    ))}
                  </ul>
                </Td>
                <Td className="text-sm text-ink-700">
                  {r.customers === 0 && r.addresses === 0 ? "Nobody named" : `${r.customers} customers, ${r.addresses} addresses`}
                </Td>
                <Td>
                  {writes && !r.retired ? (
                    <div className="space-y-2">
                      <ActionForm action={changeRate} submit="Change from a day" tone="quiet" hidden={{ id: r.id }}
                                  className="flex flex-wrap items-end gap-2">
                        <TextField label={`New percent for ${r.name}`} name="percent" inputMode="decimal" placeholder="8.25" required className="w-28" />
                        <TextField label="From" name="effectiveFrom" type="date" defaultValue={view.today} required className="w-40" />
                      </ActionForm>
                      {!r.isDefault ? (
                        <ActionForm action={retireRate} submit={`Retire ${r.name}`} tone="danger" hidden={{ id: r.id }} className="flex" />
                      ) : null}
                    </div>
                  ) : null}
                </Td>
              </tr>
            ))}
          </Table>
        )}
        <p className="mt-2 max-w-2xl text-xs text-ink-500">
          Retiring a rate takes it off every list. Invoices that charged it keep it, and customers and addresses that named
          it are charged the usual rate from then on.
        </p>
      </section>

      {writes ? (
        <section aria-labelledby="tax-add" className="rounded-md border border-steel-200 p-4">
          <h2 id="tax-add" className="text-base font-semibold">Add a rate</h2>
          <ActionForm action={addRate} submit="Add rate" className="mt-3 grid gap-3 sm:grid-cols-2">
            <TextField label="Name" name="name" placeholder="Travis County" required maxLength={100} />
            <TextField label="Percent" name="percent" inputMode="decimal" placeholder="8.25" required />
            <TextField label="Charged from" name="effectiveFrom" type="date" defaultValue={view.today} required />
            <label className="flex items-end gap-2 pb-2 text-sm">
              <input type="checkbox" name="makeDefault" value="1" />
              Make this the usual rate
            </label>
          </ActionForm>
        </section>
      ) : (
        <p className="text-sm text-ink-500">Changing these needs the Edit company settings permission.</p>
      )}
    </div>
  );
}
