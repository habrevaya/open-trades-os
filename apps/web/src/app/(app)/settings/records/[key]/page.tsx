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
import { retireKind, setFieldForCustomer, updateKind } from "../actions";

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
  const kinds = await customObjects.definedKinds(ctx);
  const kind = kinds.find((k) => k.key === key);
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

      {/*
        WHAT THE CUSTOMER SEES. Each field is marked on its own, off unless
        somebody marks it, and none of it shows at all until the kind itself is
        shown to customers. A field added later starts unmarked.
      */}
      <section className="mt-12" aria-labelledby="kind-portal">
        <h2 id="kind-portal" className="text-base font-semibold">What the customer sees</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-700">
          {kind.customerVisible
            ? `A customer sees the ${kind.pluralLabel.toLowerCase()} about them on their portal: each one's ${kind.titleLabel.toLowerCase()} and the fields marked here, and nothing else.`
            : `Customers see none of these. Tick "The customer may see these" below to show them, then mark the fields they may read.`}
        </p>
        {kind.fields.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">No fields yet.</p>
        ) : (
          <ul className="mt-2 max-w-2xl divide-y divide-steel-200 rounded-md border border-steel-200 text-sm">
            {kind.fields.map((f) => (
              <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  {f.label}
                  <span className="ml-2 text-xs text-ink-500">{f.customerVisible ? "The customer sees this" : "Office only"}</span>
                </span>
                {writes ? (
                  <ActionForm action={setFieldForCustomer} tone="quiet"
                              submit={f.customerVisible ? `Keep ${f.label} in the office` : `Show ${f.label} to the customer`}
                              hidden={{ id: f.id, customerVisible: f.customerVisible ? "0" : "1" }} />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      {writes ? (
        <>
          <section className="mt-12" aria-labelledby="kind-edit">
            <h2 id="kind-edit" className="text-base font-semibold">What it is</h2>
            <ActionForm action={updateKind} submit={`Save ${kind.pluralLabel}`} hidden={{ id: kind.id }}
                        className="mt-3 grid max-w-3xl gap-3 sm:grid-cols-2">
              <KindFields kind={kind} others={kinds.map((k) => ({ key: k.key, label: k.pluralLabel }))} />
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
