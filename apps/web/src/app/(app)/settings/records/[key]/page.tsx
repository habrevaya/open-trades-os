import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customFields, customObjects } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { ActionForm } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { PageHeader } from "@/components/Table";
import { FieldManager } from "../../custom-fields/FieldManager";
import { KindFields } from "../KindFields";
import { retireKind, updateKind } from "../actions";

export const dynamic = "force-dynamic";

/**
 * ONE KIND OF RECORD: what it is, and its fields.
 *
 * Its fields are ordinary custom fields on `object:<key>`, managed by the
 * same component as the fields on a customer, so adding a date, retiring a
 * choice or making one required means exactly what it means there.
 */
export default async function KindPage({ params }: { params: Promise<{ key: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  if (!can(user.actor, "settings:read")) notFound();
  const { key } = await params;
  const kind = (await customObjects.definedKinds(ctx)).find((k) => k.key === key);
  if (!kind) notFound();
  const entityType = `object:${kind.key}`;
  const usage = await customFields.usage(ctx, { entityType });
  const writes = can(user.actor, "customfield:write");

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <Crumb href="/settings/records">Kinds of record</Crumb>
      <div className="mt-2">
        <PageHeader title={kind.pluralLabel} count={kind.records} action={
          <a href={`/records/${kind.key}`} className="text-sm underline underline-offset-4">Open the list</a>
        } />
      </div>

      <section className="mt-8" aria-labelledby="kind-fields">
        <h2 id="kind-fields" className="text-base font-semibold">Fields on each {kind.label.toLowerCase()}</h2>
        <p className="mt-1 text-sm text-ink-700">
          Every {kind.label.toLowerCase()} also has its {kind.titleLabel.toLowerCase()}, which names it on lists.
        </p>
        <FieldManager records={[{ key: entityType, label: kind.pluralLabel }]} usage={usage} writes={writes} heading={false} />
      </section>

      {writes ? (
        <>
          <section className="mt-12" aria-labelledby="kind-edit">
            <h2 id="kind-edit" className="text-base font-semibold">What it is</h2>
            <ActionForm action={updateKind} submit={`Save ${kind.pluralLabel}`} hidden={{ id: kind.id }}
                        className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2">
              <KindFields kind={kind} />
            </ActionForm>
          </section>
          <section className="mt-12" aria-labelledby="kind-retire">
            <h2 id="kind-retire" className="text-base font-semibold">Retire it</h2>
            <ActionForm action={retireKind} tone="danger" submit={`Retire ${kind.pluralLabel}`} hidden={{ id: kind.id }}
                        className="mt-3 space-y-2">
              {kind.records > 0 ? (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" name="force" className="h-4 w-4" />
                  Retire it anyway. {kind.records} on file stop showing anywhere until it is defined again.
                </label>
              ) : null}
            </ActionForm>
          </section>
        </>
      ) : null}
    </div>
  );
}
