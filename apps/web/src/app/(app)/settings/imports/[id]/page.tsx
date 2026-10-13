import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { spreadsheetImports } from "@opentradesos/api/services";
import { can, imports as rules } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { saveColumns } from "../actions";
import { Runner } from "../Runner";
import { STATUS_TONE, STATUS_WORDS } from "../status";

export const dynamic = "force-dynamic";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * ONE FILE: MATCH THE COLUMNS, CHECK, LOAD, AND WHAT HAPPENED.
 *
 * The columns stay editable until the first row is loaded. Below them, the
 * first rows as they will land and every row that will not, with the reason,
 * so the owner fixes the file before anything is in the books rather than
 * after. Checking runs every row through the real loads and keeps nothing;
 * loading is only offered once every row has been checked.
 */
export default async function ImportPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  if (!can(user.actor, "data:import")) notFound();
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const ctx = { actor: user.actor, db: getDb() };
  const run = await spreadsheetImports.get(ctx, { id }).catch((error: unknown) => {
    if (error instanceof Error && error.name === "NotFoundError") return null;
    throw error;
  });
  if (!run) notFound();

  const one = rules.KIND_LABEL[run.kind].row;
  const editable = run.status !== "loading" && run.status !== "finished";
  const options = [{ value: "", label: "Leave this column out" }, ...run.fields.map((f) => ({ value: f.key, label: f.label }))];
  const shown = rules.fieldsOf(run.kind).filter((f) => run.preview.some((p) => p.values[f.key] !== undefined));
  const c = run.counts;
  /**
   * Rows, for a file where several rows can be one invoice or one payment:
   * "Load 3 invoices" for two invoices would be a promise the count breaks.
   */
  const loadNoun = (n: number) => (rules.isGrouped(run.kind) ? (n === 1 ? "row" : "rows") : n === 1 ? one : `${one}s`);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <Crumb href="/settings/imports">Bring in a spreadsheet</Crumb>
      <div className="mt-2">
        <PageHeader title={run.fileName} action={<Chip tone={STATUS_TONE[run.status]}>{STATUS_WORDS[run.status]}</Chip>} />
      </div>
      <p className="mt-1 text-sm text-ink-700">
        {rules.KIND_LABEL[run.kind].label}. {run.rows.toLocaleString("en-US")} rows
        {run.mappingName ? `, matched with your saved columns "${run.mappingName}"` : ""}.
      </p>

      {run.holdAutomations ? (
        <p className="mt-3 max-w-3xl text-sm text-ink-700">
          Automations will not start for anything this file brings in.
        </p>
      ) : (
        <p className="mt-3 max-w-3xl rounded-md border border-amber-700 bg-amber-tint p-3 text-sm text-ink-900">
          Automations will start for what this file brings in, the same as for records typed in. If any of them text or
          email customers, they will go to everybody on the file. Tick &quot;Do not start automations&quot; below to stop that.
        </p>
      )}

      {editable ? (
        <section className="mt-8" aria-labelledby="columns">
          <h2 id="columns" className="text-base font-semibold">Match the columns</h2>
          <p className="mt-1 max-w-3xl text-sm text-ink-500">
            We guessed each column from its heading. Change any that are wrong. A column you leave out is not read.
          </p>
          <ActionForm action={saveColumns} submit="Save the columns and read every row again"
                      hidden={{ id: run.id, width: String(run.header.length) }} className="mt-4 space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
              {run.header.map((heading, i) => (
                <div key={i}>
                  <Select label={heading || `Column ${i + 1}`} name={`column-${i}`} options={options}
                          defaultValue={run.columns[i] ?? ""} />
                  <p className="mt-1 truncate text-xs text-ink-500">
                    {run.samples[i] ? `For example: ${run.samples[i]}` : "Empty in the first rows"}
                  </p>
                </div>
              ))}
            </div>
            <div className="grid max-w-3xl gap-4 sm:grid-cols-2">
              <TextField label="Where these came from" name="source" defaultValue={run.source} required
                         placeholder="old-system" />
              <Select label="Dates in this file are written" name="dayFirst" defaultValue={run.dayFirst ? "1" : "0"}
                      options={[{ value: "0", label: "Month first (3/14/2024)" }, { value: "1", label: "Day first (14/3/2024)" }]} />
            </div>
            <p className="max-w-3xl text-xs text-ink-500">
              Use the same name for every file from the same place. That is how a job finds the customer you brought in
              earlier, and how a file brought in twice is recognised.
            </p>
            <TextField label="Save these columns as (optional)" name="saveAs" placeholder="From the old office system"
                       className="block max-w-md" />
            <label className="flex max-w-3xl items-start gap-2 text-sm">
              <input type="checkbox" name="holdAutomations" value="1" defaultChecked={run.holdAutomations} className="mt-1 h-4 w-4" />
              <span>
                <span className="font-medium">Do not start automations for what this file brings in</span>
                <span className="block text-ink-500">
                  A welcome text, a review request or anything else under{" "}
                  <a href="/automations" className="underline underline-offset-4">Automations</a> starts only for records typed in.
                </span>
              </span>
            </label>
          </ActionForm>
        </section>
      ) : null}

      {run.problems.length > 0 ? (
        <div role="alert" className="mt-6 max-w-3xl rounded-md border border-red-600 bg-red-tint p-3 text-sm text-red-600">
          <p className="font-medium">Before the rows can be checked:</p>
          <ul className="mt-1 list-disc pl-5">{run.problems.map((p) => <li key={p}>{p}</li>)}</ul>
        </div>
      ) : null}

      <section className="mt-10" aria-labelledby="next">
        <h2 id="next" className="text-base font-semibold">
          {run.status === "finished" ? "What happened" : run.status === "checked" || run.status === "loading" ? "Load it" : "Check every row"}
        </h2>
        <p className="mt-1 text-sm text-ink-700">
          {c.loaded > 0 || run.status === "finished" ? `${c.loaded.toLocaleString("en-US")} loaded. ` : ""}
          {c.ready > 0 ? `${c.ready.toLocaleString("en-US")} ready to load. ` : ""}
          {c.waiting > 0 && run.problems.length === 0 ? `${c.waiting.toLocaleString("en-US")} not checked yet. ` : ""}
          {c.already > 0 ? `${c.already.toLocaleString("en-US")} skipped because they are already here. ` : ""}
          {c.refused > 0 ? `${c.refused.toLocaleString("en-US")} refused.` : ""}
        </p>
        {(run.status === "mapping" || run.status === "checking") && run.problems.length === 0 ? (
          <>
            <p className="mt-1 max-w-3xl text-sm text-ink-500">
              Each row is tried exactly as it would be loaded, and then undone. Nothing is kept but the answers.
            </p>
            <Runner id={run.id} step="check" rows={run.rows}
                    label={run.status === "checking" ? "Carry on checking" : `Check all ${run.rows.toLocaleString("en-US")} rows`} />
          </>
        ) : null}
        {(run.status === "checked" || run.status === "loading") && c.ready > 0 ? (
          <>
            <p className="mt-1 max-w-3xl text-sm text-ink-500">
              Rows go in {rules.BATCH_SIZE} at a time, and each batch goes in whole or not at all.
            </p>
            <Runner id={run.id} step="load" rows={run.rows}
                    label={run.status === "loading" ? "Carry on loading" : `Load ${c.ready.toLocaleString("en-US")} ${loadNoun(c.ready)}`} />
          </>
        ) : null}
      </section>

      <section className="mt-10" aria-labelledby="preview">
        <h2 id="preview" className="text-base font-semibold">The first rows, as they will be saved</h2>
        {run.preview.length === 0 || shown.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">No row can be shown yet.</p>
        ) : (
          <Table label="The first rows" head={<><Th>Row</Th>{shown.map((f) => <Th key={f.key}>{f.label}</Th>)}</>}>
            {run.preview.map((p) => (
              <tr key={p.row}>
                <Td className="tabular-nums">{p.row}</Td>
                {shown.map((f) => (
                  <Td key={f.key}>{f.type === "money" && p.values[f.key] ? rules.trimMoney(p.values[f.key]!) : p.values[f.key] ?? ""}</Td>
                ))}
              </tr>
            ))}
          </Table>
        )}
      </section>

      <section className="mt-10" aria-labelledby="refused">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="refused" className="text-base font-semibold">Rows that will not go in</h2>
          {c.refused > 0 ? (
            <a href={`/settings/imports/${run.id}/refused`} className="text-sm text-blue-600 underline underline-offset-4">
              Download them to fix and bring in again
            </a>
          ) : null}
        </div>
        {run.refused.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">None{c.waiting > 0 ? " so far" : ""}.</p>
        ) : (
          <>
            <Table label="Rows that will not go in" head={<><Th>Row</Th><Th>Why</Th></>}>
              {run.refused.map((r) => (
                <tr key={r.row}><Td className="tabular-nums">{r.row}</Td><Td>{r.reason}</Td></tr>
              ))}
            </Table>
            {c.refused > run.refused.length ? (
              <p className="mt-2 text-sm text-ink-500">The first {run.refused.length} of {c.refused}. The download has them all.</p>
            ) : null}
          </>
        )}
      </section>

      {run.skipped.length > 0 ? (
        <section className="mt-10" aria-labelledby="skipped">
          <h2 id="skipped" className="text-base font-semibold">Skipped, because they are already here</h2>
          <Table label="Skipped rows" head={<><Th>Row</Th><Th>Already here as</Th></>}>
            {run.skipped.map((r) => (
              <tr key={r.row}><Td className="tabular-nums">{r.row}</Td><Td>{r.recordLabel}</Td></tr>
            ))}
          </Table>
        </section>
      ) : null}

      {run.status === "finished" && c.loaded === 0 && c.already === 0 ? (
        <Empty title="Nothing was loaded">Every row was refused. Download them, fix them and bring the file in again.</Empty>
      ) : null}
    </div>
  );
}
