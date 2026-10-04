import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customObjects, NotFoundError } from "@opentradesos/api/services";
import { PermissionError } from "@opentradesos/core";
import { ActionForm, TextArea } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { PageHeader } from "@/components/Table";
import { importRecords } from "../../actions";

export const dynamic = "force-dynamic";

/**
 * LOAD A SPREADSHEET OF RECORDS
 *
 * Checked first, then loaded, and either all of it goes in or none of it
 * does, with every row's problem listed: half a spreadsheet loaded is one
 * nobody can load again without making duplicates of the half that went in.
 */
export default async function ImportPage({ params }: { params: Promise<{ type: string }> }) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { type } = await params;
  const kind = await customObjects.getKind(ctx, { key: type }).catch((error: unknown) => {
    if (error instanceof NotFoundError || error instanceof PermissionError) notFound();
    throw error;
  });
  if (!kind.canWrite) notFound();
  const headings = [kind.titleLabel, ...kind.fields.map((f) => f.label),
    ...(kind.links.includes("job") ? ["Job number"] : []),
    ...kind.links.filter((l) => l !== "job").map((l) => `${l} id`)];

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href={`/records/${type}`}>{kind.pluralLabel}</Crumb>
      <div className="mt-2"><PageHeader title={`Load ${kind.pluralLabel.toLowerCase()} from a CSV`} /></div>
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        A header row, then one {kind.label.toLowerCase()} per row. Columns are matched by name:{" "}
        <span className="font-mono text-xs">{headings.join(", ")}</span>. The file this page&apos;s list downloads
        loads back unchanged. A list of choices is separated by semicolons; yes or no is Yes or No.
      </p>
      <ActionForm action={importRecords} submit="Load the file" hidden={{ type }} className="mt-6 space-y-3">
        <label className="block">
          <span className="text-sm font-medium text-ink-700">CSV file</span>
          <input type="file" name="file" accept=".csv,text/csv" className="mt-1 block text-sm" />
        </label>
        <TextArea label="Or paste it" name="csv" rows={4} />
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" name="check" value="1" className="h-4 w-4" />
          Only check it: say what would be loaded and load nothing
        </label>
      </ActionForm>
    </div>
  );
}
