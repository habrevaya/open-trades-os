import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { peopleRecords, roles } from "@opentradesos/api/services";
import { ROLE_PRESETS, ROLE_IDS, can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { addTemplateItemAction, removeTemplateItemAction } from "../actions";

export const dynamic = "force-dynamic";

const KIND: Record<string, string> = { document: "Document", training: "Training", equipment: "Equipment", other: "Other" };

/**
 * WHAT EVERY NEW PERSON IN A ROLE GOES THROUGH
 *
 * A checklist per role: the documents to collect, the training to give and
 * the equipment to hand over. Starting somebody's onboarding copies it onto
 * them, so changing it here changes it for the next hire and not for anybody
 * already part way through.
 */
export default async function OnboardingPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "user:read")) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Onboarding" />
        <Empty title="The staff list is not part of your access">Somebody who can change roles can turn this on for you.</Empty>
      </div>
    );
  }
  const writes = can(user.actor, "user:write");
  const [items, custom] = await Promise.all([
    peopleRecords.onboardingTemplate(ctx),
    can(user.actor, "role:write") ? roles.list(ctx) : Promise.resolve([]),
  ]);
  const roleOptions = [
    ...ROLE_IDS.filter((r) => r !== "readonly").map((r) => ({ value: r, label: ROLE_PRESETS[r].label })),
    ...custom.map((r) => ({ value: `custom:${r.id}`, label: r.name })),
  ];
  const byRole = new Map<string, typeof items>();
  for (const item of items) byRole.set(item.roleLabel, [...(byRole.get(item.roleLabel) ?? []), item]);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Onboarding" />
      {byRole.size === 0 ? (
        <Empty title="No checklist yet">Add the first line for a role below.</Empty>
      ) : (
        [...byRole.entries()].map(([role, lines]) => (
          <section key={role} className="mt-6">
            <h2 className="text-base font-semibold">{role}</h2>
            <ul className="mt-2 space-y-1 text-sm">
              {lines.map((line) => (
                <li key={line.id} className="flex flex-wrap items-center gap-2">
                  <span className="w-24 text-ink-500">{KIND[line.kind] ?? line.kind}</span>
                  <span>{line.label}</span>
                  {line.required ? null : <span className="text-ink-500">(optional)</span>}
                  {writes ? <ActionForm action={removeTemplateItemAction} submit="Remove" tone="quiet" className="inline-flex" hidden={{ id: line.id }} /> : null}
                </li>
              ))}
            </ul>
          </section>
        ))
      )}
      {writes ? (
        <ActionForm action={addTemplateItemAction} submit="Add line" className="mt-8 flex flex-wrap items-end gap-3">
          <Select label="Role" name="role" className="w-48" options={roleOptions} />
          <Select label="Kind" name="kind" className="w-36" options={Object.entries(KIND).map(([value, label]) => ({ value, label }))} />
          <TextField label="What" name="label" className="w-72" required placeholder="Fall protection training" />
          <label className="flex items-center gap-2 pb-2 text-sm">
            <input type="checkbox" name="required" defaultChecked /> Required
          </label>
        </ActionForm>
      ) : null}
    </div>
  );
}
