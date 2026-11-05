import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { estimateExtendedNotice } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm, TextArea, TextField } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { Empty, PageHeader } from "@/components/Table";
import { saveExtendedWords } from "./actions";

export const dynamic = "force-dynamic";

/**
 * THE WORDS THAT TELL A CUSTOMER THEY WERE GIVEN LONGER
 *
 * When the office gives a customer longer to answer an estimate and ticks
 * "Tell the customer", this is what they read: a line above the link, by text
 * and by email. A company that never opens this sends the product's own words.
 */
export default async function GivenLongerWordsPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
        <PageHeader title="Words for giving longer" />
        <Empty title="Company settings are not part of your access">
          Somebody who can change roles can turn this on for you.
        </Empty>
      </div>
    );
  }
  const words = await estimateExtendedNotice.words({ actor: user.actor, db: getDb() });
  const writes = can(user.actor, "settings:write");

  const fields = (
    <fieldset className="space-y-4 rounded-md border border-steel-200 p-4">
      <legend className="px-1 text-sm font-semibold">When a customer is given longer</legend>
      {words.templates.map((t) => (
        <div key={t.code} className="space-y-2">
          {t.channel === "email" ? (
            <TextField label="Email subject" name={`${t.code}:subject`} defaultValue={t.subject ?? ""}
                       maxLength={200} required disabled={!writes} />
          ) : null}
          <TextArea label={t.channel === "sms" ? "Text message" : "Email"} name={`${t.code}:body`}
                    defaultValue={t.body} rows={t.channel === "sms" ? 3 : 5} maxLength={2000} required disabled={!writes} />
          {t.isDefault ? <p className="text-xs text-ink-500">Nobody here has written this one, so our own words are sent.</p> : null}
        </div>
      ))}
    </fieldset>
  );

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <Crumb href="/estimates">Estimates</Crumb>
      <h1 className="mt-1 text-xl font-semibold">Words for giving longer</h1>
      <p className="mt-2 text-sm text-ink-700">
        When you give a customer longer to answer an estimate and tick &ldquo;Tell the customer&rdquo;, they get the
        estimate again with this line above the link. A text is not sent in the hours we do not text people. It is
        kept and goes in the morning.
      </p>
      <p className="mt-2 text-xs text-ink-500">
        You can put these in the words: {words.variables.map((v) => `{{ ${v} }}`).join(", ")}.
      </p>
      {writes ? (
        <ActionForm action={saveExtendedWords} submit="Save the words" done="Saved." className="mt-6 space-y-5">
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
