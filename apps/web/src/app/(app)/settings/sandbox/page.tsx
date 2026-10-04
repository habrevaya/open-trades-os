import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { sandbox } from "@opentradesos/api/services";
import { can, sandbox as rules } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { copyBack, makeSandbox, switchCompany, throwAway } from "./actions";

export const dynamic = "force-dynamic";

const ACTION_WORDS = { create: "New there", update: "Changes it there", same: "Already the same" } as const;

/**
 * SETTINGS, SANDBOX
 *
 * From the real company: make a practice copy of the settings (and,
 * optionally, sample work with invented people), open it, or throw it away.
 * From inside the sandbox: tick the settings worth keeping and copy them
 * back, after checking what each would do.
 */
export default async function SandboxPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Sandbox" />
        <Empty title="Settings are not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  const status = await sandbox.current(ctx);
  const manages = can(user.actor, "sandbox:manage");

  if (status.isSandbox && status.production) {
    const plan = manages ? await sandbox.plan(ctx).catch(() => null) : null;
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Sandbox" />
        <p className="mt-2 max-w-2xl text-sm text-ink-700">
          You are in the sandbox for {status.production.name}. Nothing here reaches a real customer: there are no real
          customers in it and nothing connected to send with. Settings you are happy with can be copied back.
        </p>
        <ActionForm action={switchCompany} tone="quiet" submit={`Back to ${status.production.name}`}
                    hidden={{ organizationId: status.production.id }} />

        <section className="mt-10" aria-labelledby="copy-back">
          <h2 id="copy-back" className="text-base font-semibold">Copy settings back to {status.production.name}</h2>
          {!plan ? (
            <p className="mt-2 text-sm text-ink-500">
              Copying back needs the Sandbox permission in {status.production.name}.
            </p>
          ) : plan.available.length === 0 ? (
            <p className="mt-2 text-sm text-ink-500">Nothing here to copy yet.</p>
          ) : (
            <ActionForm action={copyBack} submit="Copy the ticked settings back" className="mt-3 space-y-3">
              <Table label="Settings in the sandbox" head={<><Th>{""}</Th><Th>Setting</Th><Th>What</Th><Th>In {status.production.name}</Th></>}>
                {plan.available.map((item) => (
                  <tr key={item.id}>
                    <Td>
                      <input type="checkbox" name="items" value={item.id} aria-label={`Copy back ${item.label}`}
                             disabled={item.action === "same"} className="h-4 w-4" />
                    </Td>
                    <Td className="font-medium">{item.label}</Td>
                    <Td className="text-ink-700">{rules.SETTING_LABEL[item.kind]}</Td>
                    <Td>
                      <Chip tone={item.action === "same" ? "neutral" : item.action === "create" ? "info" : "warning"}>
                        {ACTION_WORDS[item.action]}
                      </Chip>
                    </Td>
                  </tr>
                ))}
              </Table>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="check" className="h-4 w-4" />
                Only check it: say what would change and copy nothing
              </label>
              <p className="text-xs text-ink-500">
                All of the ticked ones are copied or none are. Each is checked by {status.production.name}&apos;s own rules
                as you, so a field that would contradict values already stored there is refused here too.
              </p>
            </ActionForm>
          )}
        </section>
      </div>
    );
  }

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Sandbox" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        A practice copy of your settings to try automations, kinds of record, custom fields and proposal layouts in,
        without any of your customers. Its job types, fields, kinds of record, saved reports, proposal layouts and
        automations are copied; every automation arrives switched off. Your integrations are not, so nothing in it can
        text, email or charge anybody. You can copy chosen settings back when they work.
      </p>
      {!manages ? (
        <p className="mt-4 text-sm text-ink-500">Making and opening a sandbox needs the Sandbox permission.</p>
      ) : status.sandbox ? (
        <section className="mt-6 space-y-4" aria-labelledby="the-sandbox">
          <h2 id="the-sandbox" className="text-base font-semibold">{status.sandbox.name}</h2>
          <p className="text-sm text-ink-700">Made {formatIn(status.sandbox.createdAt, user.organizationTimezone)}.</p>
          <ActionForm action={switchCompany} submit="Open the sandbox" hidden={{ organizationId: status.sandbox.id }} />
          <ActionForm action={throwAway} tone="danger" submit="Throw the sandbox away" className="mt-6 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" name="sure" className="h-4 w-4" />
              Throw it away for good. Copy back anything worth keeping first.
            </label>
          </ActionForm>
        </section>
      ) : (
        <ActionForm action={makeSandbox} submit="Make a sandbox" className="mt-6 space-y-3">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="sampleData" className="h-4 w-4" />
            Add sample jobs to try things on: up to {rules.MAX_SAMPLE} like your latest ones, each with an invented customer,
            street, email and phone number. Only the town is real.
          </label>
        </ActionForm>
      )}
    </div>
  );
}
