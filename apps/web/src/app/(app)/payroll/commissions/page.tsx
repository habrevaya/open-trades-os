import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commissions } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Money } from "@opentradesos/ui";
import { Empty, PageHeader, Table, Th, Td } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { Plans, Bases } from "./CommissionView";
import { ActionForm } from "./ActionForm";

export const dynamic = "force-dynamic";

const input = "h-8 rounded border border-steel-300 px-2 text-sm";

/**
 * COMMISSION PLANS
 *
 * In the API with no screen, which for commissions is worse than usual: the
 * numbers already appear on the payroll register, so a company could see what was
 * owed and not see the rule that produced it.
 *
 * THE CAVEAT IS ON THE SCREEN WHERE THE CHOICE IS MADE. Every basis rewards
 * something, what it rewards is usually not what the owner meant, and core carries
 * a sentence per basis saying what it is wrong about. The service publishes those
 * sentences rather than keeping them for a help page, and this screen shows them
 * beside the radio buttons rather than behind a link. Somebody picking a basis is
 * writing the instruction their technicians will follow for years, usually in
 * about ninety seconds.
 *
 * `commission:read` to look, `commission:configure` to declare. Those are separate
 * permissions in core on purpose: the person who runs the payroll export is
 * usually not the person entitled to decide what people are paid.
 */
export default async function CommissionsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "commission:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Commission plans" />
        <Empty title="Not shown to your role">
          Commissions need the permission that reads them, and declaring a plan needs a second one.
        </Empty>
      </div>
    );
  }

  const [plans, bases, itemRule, onPayment] = await Promise.all([
    commissions.plans(ctx),
    commissions.bases(ctx),
    commissions.itemRule(ctx),
    commissions.onPayment(ctx),
  ]);
  const day = (at: Date) => formatIn(at, user.organizationTimezone, { month: "short", day: "numeric", year: "numeric" });
  const chosen = itemRule.rules.find((r) => r.rule === itemRule.rule)!;
  const configures = can(user.actor, "commission:configure");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Commission plans" count={plans.length} action={
        <a href="/payroll/commissions/splits" className="text-sm font-medium underline underline-offset-4">Shared commission</a>
      } />

      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        What a technician earns on top of their hours. A plan is superseded rather than edited, so
        there is no edit button: editing one reprices commissions already earned, and on a plan
        edited downward, already paid.
      </p>

      <Plans
        plans={plans}
        controls={configures ? (plan) => (
          plan.active
            ? <ActionForm op="supersede" label="Supersede" quiet hidden={{ id: plan.id }} />
            : null
        ) : undefined}
      />

      {/*
        THE COMPANY'S CHOICE OF HOW AN ITEM'S OWN RATE AND THE PLAN COMBINE.
        Shown to everybody who reads commission, because it decides what a line
        pays; changed only with the permission that declares a plan. Each choice
        is one sentence an owner can say to a technician, beside the button.
      */}
      <section aria-label="When an item has its own rate" className="mt-10">
        <h2 className="text-base font-semibold">When an item has its own rate</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          An item in the price book can have its own commission rate. This says how it works with the plan on
          an invoice line for that item. The rate used is the one the item had when the line was priced.
        </p>
        <p className="mt-2 text-sm" data-testid="item-rule">
          <span className="font-medium">Now: {chosen.label}.</span> <span className="text-ink-700">{chosen.meaning}</span>
        </p>
        {configures ? (
          <ActionForm op="itemRule" label="Save the choice" className="mt-3 space-y-2">
            <fieldset className="space-y-2">
              <legend className="sr-only">How an item&apos;s own rate works with the plan</legend>
              {itemRule.rules.map((r) => (
                <label key={r.rule} className="flex items-start gap-2 text-sm">
                  <input type="radio" name="rule" value={r.rule} defaultChecked={r.rule === itemRule.rule} className="mt-1" />
                  <span>
                    <span className="font-medium">{r.label}</span>
                    <span className="block text-ink-700">{r.meaning}</span>
                  </span>
                </label>
              ))}
            </fieldset>
            <p className="text-xs text-ink-500">
              A change counts from the next commission settled. Commission already settled keeps the choice it was
              worked out under.
            </p>
          </ActionForm>
        ) : null}
      </section>

      {/*
        SETTLING BY ITSELF WHEN AN INVOICE IS PAID IN FULL. Off unless turned
        on. Only a plan that pays on what was collected earns on payment, so
        the screen says plainly when turning it on would do nothing. What it
        left for a person is listed with why, until somebody settles it.
      */}
      <section aria-label="When an invoice is paid in full" className="mt-10">
        <h2 className="text-base font-semibold">When an invoice is paid in full</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          The commission can settle by itself when the customer has paid the whole invoice. It is split the way the
          shared commission page proposes, with any standing shares, exactly as if you settled it there. Anything that
          needs a person to decide is left for you below, with the reason.
        </p>
        <p className="mt-2 text-sm" data-testid="on-payment">
          {onPayment.on && onPayment.since
            ? <span className="font-medium">On since {day(onPayment.since)}. Invoices paid in full from then on settle by themselves.</span>
            : <span className="font-medium">Off. A person settles every commission.</span>}
        </p>
        {onPayment.earnsOnPayment.length === 0 ? (
          <p className="mt-1 max-w-2xl text-sm text-ink-500">
            Only a plan that pays a share of what was collected is earned on payment, and none is in force, so this
            settles nothing until there is one.
          </p>
        ) : null}
        {configures ? (
          <ActionForm op="onPayment" label={onPayment.on ? "Turn it off" : "Turn it on"} className="mt-3"
                      quiet={onPayment.on} hidden={{ on: onPayment.on ? "off" : "on" }} />
        ) : null}

        {onPayment.left.length > 0 ? (
          <>
            <h3 className="mt-6 text-sm font-medium text-ink-700">Left for you</h3>
            <Table label="Left for you" head={<><Th>Invoice</Th><Th>Customer</Th><Th>Why it was left</Th><Th>{""}</Th></>}>
              {onPayment.left.map((row) => (
                <tr key={row.invoiceId}>
                  <Td>
                    <span className="font-medium">{row.invoiceNumber}</span>
                    <span className="block text-xs text-ink-500">Paid {day(row.at)}</span>
                  </Td>
                  <Td>{row.customerName}</Td>
                  <Td className="text-ink-700">{row.reason}</Td>
                  <Td>
                    <a href={`/payroll/commissions/splits/${row.invoiceId}`} className="text-sm font-medium underline underline-offset-4">Settle it</a>
                  </Td>
                </tr>
              ))}
            </Table>
          </>
        ) : null}

        {onPayment.settled.length > 0 ? (
          <>
            <h3 className="mt-6 text-sm font-medium text-ink-700">Settled by itself lately</h3>
            <Table label="Settled by itself lately" head={<><Th>Invoice</Th><Th>Customer</Th><Th className="text-right">Commission</Th></>}>
              {onPayment.settled.map((row) => (
                <tr key={row.invoiceId}>
                  <Td>
                    <a href={`/payroll/commissions/splits/${row.invoiceId}`} className="font-medium underline underline-offset-4">{row.invoiceNumber}</a>
                    <span className="block text-xs text-ink-500">{day(row.at)}</span>
                  </Td>
                  <Td>{row.customerName}</Td>
                  <Td className="text-right"><Money value={row.total} /></Td>
                </tr>
              ))}
            </Table>
          </>
        ) : null}
      </section>

      {configures && (
        <section className="mt-10">
          <h2 className="text-base font-semibold">Declare a plan</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-500">
            Pick the basis with its caveat in front of you. The percentage or the flat amount,
            whichever the basis needs: the other one is refused rather than ignored, so a figure in
            the wrong box is answered instead of silently dropped.
          </p>

          <ActionForm op="declare" label="Declare" className="mt-3 space-y-3">
            <div className="flex flex-wrap items-end gap-2">
              <input name="label" required placeholder="Service commission" className={input}
                     aria-label="What this plan is called" />
              <select name="basis" required className={input} aria-label="Basis">
                {bases.map((basis) => (
                  <option key={basis.key} value={basis.key}>{basis.label}</option>
                ))}
              </select>
              <input name="rate" inputMode="decimal" placeholder="0.08"
                     aria-label="Rate, as a decimal" className={`${input} w-24`} />
              <input name="flatAmount" inputMode="decimal" placeholder="Flat amount"
                     aria-label="Flat amount" className={`${input} w-28`} />
            </div>
            {/*
              The note is required by the service and it is not decoration: it is
              what a technician is shown when they ask how the number was worked
              out, which is the question a commission scheme generates most.
            */}
            <label className="flex flex-col gap-1 text-sm">
              <span className="text-ink-700">What a technician is told when they ask</span>
              <input name="note" required className={`${input} w-full max-w-xl`}
                     placeholder="Eight per cent of what the job invoiced, paid when the invoice is paid." />
            </label>
          </ActionForm>

          <h3 className="mt-8 text-sm font-medium text-ink-700">The four bases</h3>
          <Bases bases={bases} />
        </section>
      )}
    </div>
  );
}
