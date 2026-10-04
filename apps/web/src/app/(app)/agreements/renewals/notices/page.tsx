import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { agreementNotices } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm, Select, TextArea, TextField } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader } from "@/components/Table";
import { saveRenewalNotices } from "./actions";

export const dynamic = "force-dynamic";

const SITUATION = {
  renews: { title: "When the plan renews on its own", help: "Say the date, the price and how to stop it." },
  ends: { title: "When it does not renew on its own", help: "Say the last day of cover and how to renew." },
} as const;

/**
 * RENEWAL NOTICES: HOW THEY GO AND WHAT THEY SAY
 *
 * The notice a plan owes before a term ends, in the company's own words. Two
 * situations, each a text and an email, and one choice of how they go. A
 * company that never opens this sends the wording the product always sent.
 */
export default async function RenewalNoticesPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
        <PageHeader title="Renewal notices" />
        <Empty title="Company settings are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }
  const settings = await agreementNotices.settings({ actor: user.actor, db: getDb() });
  const writes = can(user.actor, "settings:write");

  const fields = (["renews", "ends"] as const).map((situation) => (
    <fieldset key={situation} className="space-y-3 rounded-md border border-steel-200 p-4">
      <legend className="px-1 text-sm font-semibold">{SITUATION[situation].title}</legend>
      <p className="text-xs text-ink-500">{SITUATION[situation].help}</p>
      {settings.templates.filter((t) => t.situation === situation).map((t) => (
        <div key={t.code} className="space-y-2">
          {t.channel === "email" ? (
            <TextField label="Email subject" name={`${t.code}:subject`} defaultValue={t.subject ?? ""}
                       maxLength={200} required disabled={!writes} />
          ) : null}
          <TextArea label={t.channel === "sms" ? "Text message" : "Email"} name={`${t.code}:body`}
                    defaultValue={t.body} rows={t.channel === "sms" ? 3 : 5} maxLength={2000} required disabled={!writes} />
        </div>
      ))}
    </fieldset>
  ));

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/agreements/renewals">Ending soon</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Renewal notices</h1>
      <p className="mt-2 text-sm text-ink-700">
        Each plan says how many days before the end a member is told. This is how they are told, and the words.
        A notice that cannot go the first way goes the other way, and if it cannot go at all the office gets a task.
      </p>
      <p className="mt-2 text-xs text-ink-500">
        You can put these in the words: {settings.variables.map((v) => `{{ ${v} }}`).join(", ")}.
      </p>
      {writes ? (
        <ActionForm action={saveRenewalNotices} submit="Save notices" done="Saved." className="mt-6 space-y-5">
          <Select label="Send them" name="channel" defaultValue={settings.channel} className="block max-w-sm" options={[
            { value: "text_first", label: "By text, or by email when they cannot be texted" },
            { value: "email_first", label: "By email, or by text when they have no email" },
            { value: "both", label: "By text and by email" },
          ]} />
          {fields}
        </ActionForm>
      ) : (
        <div className="mt-6 space-y-5">
          {fields}
          <p className="text-sm text-ink-500">Somebody who can change company settings can change these.</p>
        </div>
      )}
    </div>
  );
}
