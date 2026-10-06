import { notFound } from "next/navigation";
import { getDb } from "@/lib/db";
import { forms } from "@opentradesos/api/services";
import { HostedForm } from "./HostedForm";

export const dynamic = "force-dynamic";

/**
 * A LEAD FORM, ON ITS OWN PAGE
 *
 * The link an ad, a flyer or a QR code on a van points at. Public, and it
 * works with no snippet on any website: how the visitor arrived is read from
 * this page's own address. When they came through a page carrying the
 * snippet, the link has their visitor id on it as `otv`, and the visit they
 * made on the company's site joins this submission.
 */
export default async function HostedFormPage({ params }: { params: Promise<{ key: string }> }) {
  const { key } = await params;
  const form = await forms.hosted(getDb(), { key }).catch(() => null);
  if (!form) notFound();
  return (
    <div className="space-y-6">
      <header className="text-center">
        <p className="text-sm text-ink-500">{form.organizationName}</p>
        <h1 className="mt-1 text-2xl font-semibold">{form.title}</h1>
      </header>
      <HostedForm
        organizationSlug={form.organizationSlug}
        formSlug={form.formSlug}
        fields={form.fields.map((f) => ({
          key: f.key, label: f.label, type: f.type, required: f.required,
          help: f.help ?? null, options: f.options ?? [],
        }))}
      />
    </div>
  );
}
