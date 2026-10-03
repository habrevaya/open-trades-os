import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { portalSettings } from "@opentradesos/api/services";
import { can, assertCan } from "@opentradesos/core";
import { PageHeader } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { saveJobPhotos, saveTipping } from "./actions";

export const dynamic = "force-dynamic";

/**
 * WHAT CUSTOMERS CAN DO FOR THEMSELVES
 *
 * Where a customer signs in, whether they are offered a tip for the
 * technicians when they pay, and which job photographs they can see. Both
 * choices start off: a tip prompt nobody chose is a surprise on somebody's
 * bill, and a photograph somebody did not choose to share is private.
 */
export default async function PortalSettingsPage() {
  const user = await requireSetupUser();
  assertCan(user.actor, "settings:read");
  const settings = await portalSettings.get({ actor: user.actor, db: getDb() });
  const writes = can(user.actor, "settings:write");

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Customer portal" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Customers sign in here with the email address or mobile number on their record. They get a
        six digit code, not a password, and see their visits, invoices, estimates and plans, pay
        with a card they saved, and ask to move a visit. Put the address on your website and on
        your invoices.
      </p>
      <pre className="mt-3 overflow-x-auto rounded-md border border-steel-200 bg-steel-100 p-3 text-xs">
        <code aria-label="The sign in address">{settings.signInUrl}</code>
      </pre>
      <p className="mt-2 max-w-2xl text-sm text-ink-500">
        A customer with no email address or mobile number on their record cannot be sent a code.
        The links you send (an estimate, an invoice, their account) keep working without signing in.
      </p>

      <section className="mt-8">
        <h2 className="text-base font-semibold">Tips</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          When this is on, a customer paying an invoice online can add a tip. It is split evenly
          between the technicians on the job&apos;s visits, held for them (it is not your income),
          and shows on their pay register and payroll export for the period it arrived in. Pay it
          out from the pay period once it is closed.
        </p>
        {writes ? (
          <ActionForm action={saveTipping} submit="Save tips" className="mt-3 space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="enabled" defaultChecked={settings.tipping.enabled} />
              Offer customers a tip when they pay online
            </label>
            <TextField
              label="Suggested tips, in percent"
              name="presets"
              defaultValue={settings.tipping.presets.join(", ")}
              className="block w-64"
            />
          </ActionForm>
        ) : (
          <p className="mt-3 text-sm">
            {settings.tipping.enabled ? `On, suggesting ${settings.tipping.presets.join("%, ")}%.` : "Off."}
          </p>
        )}
      </section>

      <section className="mt-8">
        <h2 className="text-base font-semibold">Job photos</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          Customers see job photos on the job&apos;s page, from a link you sent or from their account.
          Choosing them one by one means a photo stays private until somebody presses Show the
          customer on the job. A technician photographs an alarm code as readily as a finished install.
        </p>
        {writes ? (
          <ActionForm action={saveJobPhotos} submit="Save photos" className="mt-3 space-y-3">
            <Select
              label="Which photos customers see"
              name="jobPhotos"
              defaultValue={settings.jobPhotos}
              options={[
                { value: "chosen", label: "Only the ones we choose" },
                { value: "all", label: "Every photo on the job" },
              ]}
              className="block w-72"
            />
          </ActionForm>
        ) : (
          <p className="mt-3 text-sm">
            {settings.jobPhotos === "all" ? "Every photo on the job." : "Only the ones chosen on the job."}
          </p>
        )}
      </section>
    </div>
  );
}
