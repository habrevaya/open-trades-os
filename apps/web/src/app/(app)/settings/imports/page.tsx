import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { spreadsheetImports } from "@opentradesos/api/services";
import { can, imports as rules } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm } from "@/components/ActionForm";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { UploadForm } from "./UploadForm";
import { forgetMapping } from "./actions";
import { STATUS_TONE, STATUS_WORDS } from "./status";

export const dynamic = "force-dynamic";

/**
 * SETTINGS, BRING IN A SPREADSHEET
 *
 * For an owner moving here with files exported from wherever they were
 * before and nobody to write a program. Upload a file, say which column is
 * which, check it, load it. Every row goes in through the same creates the
 * API uses, so it is held to the same rules as the migration toolkit.
 * `data:import`, like the toolkit's token: loading a file of invoices is
 * recording history.
 */
export default async function ImportsPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "data:import")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Bring in a spreadsheet" />
        <Empty title="This is the owner's to do">
          Bringing in past invoices and payments writes history into the books, so only the owner can bring in a file.
        </Empty>
      </div>
    );
  }
  const ctx = { actor: user.actor, db: getDb() };
  const [{ imports: runs }, { mappings }] = await Promise.all([spreadsheetImports.list(ctx), spreadsheetImports.mappings(ctx)]);
  const zone = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Bring in a spreadsheet" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Bring in customers, equipment, price book items, past jobs or past invoices from a file. You match the columns,
        we check every row and show you anything that will not go in and why, and only then is anything loaded.
        Bringing in the same file twice does not make copies.
      </p>
      <p className="mt-2 max-w-2xl text-sm text-ink-500">
        CSV files only. In your spreadsheet program choose Save As or Download and pick CSV. A file can be up to 5 MB
        and {rules.MAX_ROWS.toLocaleString("en-US")} rows. Bring in customers first: jobs, equipment and invoices are
        matched to them.
      </p>

      <section className="mt-6" aria-labelledby="upload">
        <h2 id="upload" className="text-base font-semibold">Upload a file</h2>
        <UploadForm />
      </section>

      <section className="mt-10" aria-labelledby="files">
        <h2 id="files" className="text-base font-semibold">Files brought in</h2>
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">None yet.</p>
        ) : (
          <Table label="Files brought in" head={<>
            <Th>File</Th><Th>Holds</Th><Th>Uploaded</Th><Th>Where it stands</Th>
            <Th className="text-right">Loaded</Th><Th className="text-right">Already here</Th><Th className="text-right">Refused</Th>
          </>}>
            {runs.map((run) => (
              <tr key={run.id}>
                <Td><a href={`/settings/imports/${run.id}`} className="text-blue-600 underline underline-offset-4">{run.fileName}</a></Td>
                <Td>{rules.KIND_LABEL[run.kind].label}</Td>
                <Td>{formatIn(run.createdAt, zone)}</Td>
                <Td><Chip tone={STATUS_TONE[run.status]}>{STATUS_WORDS[run.status]}</Chip></Td>
                <Td className="text-right tabular-nums">{run.counts.loaded}</Td>
                <Td className="text-right tabular-nums">{run.counts.already}</Td>
                <Td className="text-right tabular-nums">{run.counts.refused}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="mt-10" aria-labelledby="mappings">
        <h2 id="mappings" className="text-base font-semibold">Saved column matches</h2>
        <p className="mt-1 max-w-2xl text-sm text-ink-500">
          A file with the same column headings as one you saved is matched by itself.
        </p>
        {mappings.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">None saved.</p>
        ) : (
          <ul className="mt-3 max-w-2xl divide-y divide-steel-200 rounded-md border border-steel-200 text-sm">
            {mappings.map((saved) => (
              <li key={saved.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                <span>
                  {saved.name}
                  <span className="ml-2 text-xs text-ink-500">
                    {rules.KIND_LABEL[saved.kind].label}, from {saved.source}
                  </span>
                </span>
                <ActionForm action={forgetMapping} tone="quiet" submit={`Forget ${saved.name}`} hidden={{ id: saved.id }} className="" />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
