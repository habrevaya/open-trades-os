import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dataExport } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Empty, PageHeader } from "@/components/Table";
import { Tables, Outside } from "./ExportView";

export const dynamic = "force-dynamic";

/**
 * TAKE A COPY OF EVERYTHING
 *
 * The comparison pages make portability the central argument against
 * ServiceTitan, naming what their exports leave behind. The answer here was
 * "it is your Postgres instance", which is true for somebody self hosting and
 * not an answer for anybody else, and even for a self hoster "run pg_dump"
 * is not a feature.
 *
 * The manifest is shown BEFORE the download rather than packed inside it,
 * because the number that matters is the one somebody checks against their old
 * system, and a count they have to unzip a file to find is a count they do not
 * check. An export without row counts is a file and a hope.
 *
 * Owner only, by `data:export`. A whole company in one file is the single most
 * valuable object this product can produce, and it is also how a departing
 * manager takes the customer list.
 */
export default async function ExportPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "data:export")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Take a copy" />
        <Empty title="This is the owner's to take">
          A whole company in one file is the most valuable thing this product can produce, so it
          needs the export permission rather than the one that reads the screens.
        </Empty>
      </div>
    );
  }

  const manifest = await dataExport.manifest(ctx);
  const withRows = manifest.tables.filter((table) => table.rows > 0).length;
  const heldBack = manifest.tables.reduce((total, table) => total + table.redacted.length, 0);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader
        title="Take a copy"
        action={
          /*
            A plain link rather than a form, because it is a read. It streams,
            so a company with a hundred thousand rows gets a file that starts
            arriving immediately rather than a request that times out while the
            server builds one in memory.
          */
          <div className="flex flex-wrap gap-2">
            <a
              href="/settings/export/archive"
              className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white hover:bg-ink-700"
            >
              Download as spreadsheets
            </a>
            <a
              href="/settings/export/download"
              className="inline-flex h-9 items-center rounded border border-steel-300 px-3 text-sm font-medium hover:bg-steel-100"
            >
              Download as one data file
            </a>
          </div>
        }
      />

      <p className="mt-4 max-w-2xl text-sm text-ink-700">
        {manifest.totalRows.toLocaleString("en-US")} rows across {withRows}{" "}
        {withRows === 1 ? "table" : "tables"} that hold something, of{" "}
        {manifest.tables.length} that belong to this company, and{" "}
        {manifest.files.count.toLocaleString("en-US")} {manifest.files.count === 1 ? "photo or document" : "photos and documents"}.
        Nothing here is a format anybody has to license to read.
      </p>

      <ul className="mt-2 max-w-2xl list-disc space-y-1 pl-5 text-sm text-ink-700">
        <li>
          <span className="font-medium">Spreadsheets</span> is a zip with one CSV file per table, every photograph
          and document, and a README saying what each column holds. It opens in Excel or Google Sheets, and each
          file loads straight into a database.
        </li>
        <li>
          <span className="font-medium">One data file</span> is newline delimited JSON: the first line is this
          list, every line after it is one row tagged with its table, then the files. It keeps every value exactly
          as it is, which is what another program wants.
        </li>
      </ul>

      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        Either one restores into a new, empty company, here or on another copy of OpenTradesOS, from{" "}
        <a href="/setup/restore" className="text-blue-600 underline underline-offset-4">Restore a copy</a>.
        To have a copy written to a bucket of your own every night, set up{" "}
        <a href="/settings/backups" className="text-blue-600 underline underline-offset-4">Backups</a>.
      </p>

      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        The table list is read off the database catalogue rather than off a list somebody
        maintains, so a table added in the next release is in the export in the next release
        without anybody remembering to add it.
      </p>

      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        {/*
          How to tell a whole file from a truncated one, said on the screen
          rather than left in a comment. A download that stops part way cannot
          come back as an error status, because the status went out with the
          first byte, so the file has to carry its own proof.
        */}
        The last line of a finished data file reads <code className="font-mono text-xs">
        {"{\"complete\": true, \"rows\": n}"}</code>, and the last thing in a finished zip is{" "}
        <code className="font-mono text-xs">complete.json</code>; nothing else does. If it is not there the
        download stopped part way, whatever the browser said: start it again. Every table is read at the same
        moment, so the count there matches the{" "}
        {manifest.totalRows.toLocaleString("en-US")} above, even with the office working while it runs.
      </p>

      <h2 className="mt-8 text-sm font-medium text-ink-700">
        What is in it{heldBack > 0 ? `, and the ${heldBack} columns that are not` : ""}
      </h2>
      <Tables manifest={manifest} />

      <h2 className="mt-10 text-sm font-medium text-ink-700">What is outside this company</h2>
      <p className="mt-1 max-w-2xl text-sm text-ink-500">
        Named rather than silently absent. A credential that left in an export would be a breach
        in a file, and an export that dropped one without saying so would be a false claim of
        completeness.
      </p>
      <Outside manifest={manifest} />
    </div>
  );
}
