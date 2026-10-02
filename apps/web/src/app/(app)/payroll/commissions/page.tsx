import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { commissions } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
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

  const [plans, bases] = await Promise.all([
    commissions.plans(ctx),
    commissions.bases(ctx),
  ]);
  const configures = can(user.actor, "commission:configure");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Commission plans" count={plans.length} />

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
