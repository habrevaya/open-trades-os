import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { forms, NotFoundError } from "@opentradesos/api/services";
import { can, marketing as mk } from "@opentradesos/core";
import { Crumb } from "@/components/Detail";
import { FormBuilder } from "./FormBuilder";

export const dynamic = "force-dynamic";

/**
 * ONE FORM, EDITED
 *
 * The fields, in order, with the few rules core lets a definition name; the
 * consent boxes with what each agrees to; the honeypot; and what happens after
 * a good submission. What it has refused is under it, counted by field.
 */
export default async function FormPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { slug } = await params;
  const form = await forms.definitionOf(ctx, decodeURIComponent(slug)).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });
  const refusals = await forms.refusalCounts(ctx, form.id);
  const sources = mk.LEAD_SOURCES.filter((s) => s.key !== "unknown").map((s) => ({ value: s.key, label: s.label }));

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/marketing/forms">Lead forms</Crumb>
      <h1 className="mt-1 text-xl font-semibold">{form.title}</h1>
      {form.publicKey ? (
        <p className="mt-1 text-sm">
          Hosted at <a href={`/f/${form.publicKey}`} className="font-mono underline underline-offset-4">/f/{form.publicKey}</a>
        </p>
      ) : null}
      <FormBuilder
        form={JSON.parse(JSON.stringify(form)) as typeof form}
        sources={sources}
        writes={can(user.actor, "adspend:write")}
      />
      {refusals.length > 0 && (
        <section className="mt-8">
          <h2 className="text-base font-semibold">What it has refused</h2>
          <ul className="mt-2 text-sm text-ink-700">
            {refusals.map((r) => <li key={`${r.field}:${r.reason}`}>{r.field || "the whole form"}: {r.reason.replace(/_/g, " ")}, {r.count}</li>)}
          </ul>
        </section>
      )}
    </div>
  );
}
