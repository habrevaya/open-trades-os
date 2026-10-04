import { requireUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { restore } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Logo } from "@/components/Logo";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Table, Th, Td } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { RestoreForm } from "./RestoreForm";
import { fromBucket } from "./actions";

export const dynamic = "force-dynamic";

const OUTCOME = {
  checked: { tone: "success", words: "It would restore" },
  restored: { tone: "success", words: "Restored" },
  refused: { tone: "danger", words: "Not restored" },
} as const;

const PERSON = {
  you: "You. You stay the owner.",
  new: "Restored. They choose a password from a link you send on Settings, Team.",
  linked: "Already has an account here, linked to this company.",
  elsewhere: "Has an account with a company you do not run, so cannot be added from a file.",
  no_address: "Has no email address in the copy.",
} as Record<string, string>;

/**
 * RESTORE A COPY
 *
 * In setup rather than in Settings, because a copy is restored into a new,
 * empty company, and a new company's first screen is setup. It loads a copy
 * from Take a copy (either file) or from a bucket the scheduled copies went to,
 * checks it first if asked (the restore itself, rolled back), and shows what
 * happened: every table's count, the people, and what has to be set up again.
 *
 * `data:import`, the owner's, because loading a copy writes years of history
 * into the books.
 */
export default async function RestorePage({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const user = await requireUser();
  const { run } = await searchParams;

  if (!can(user.actor, "data:import")) {
    return (
      <Frame>
        <h1 className="mt-10 text-2xl font-semibold">Restore a copy</h1>
        <p className="mt-3 max-w-prose text-ink-700">
          Restoring a copy writes years of history into the books, so it is the owner&apos;s to do.
        </p>
      </Frame>
    );
  }
  const ctx = { actor: user.actor, db: getDb() };
  const [readiness, shown] = await Promise.all([
    restore.readiness(ctx),
    run ? restore.getRun(ctx, run).catch(() => null) : Promise.resolve(null),
  ]);
  const zone = user.organizationTimezone;

  return (
    <Frame>
      <h1 className="mt-10 text-2xl font-semibold">Restore a copy</h1>
      <p className="mt-3 max-w-prose text-ink-700">
        Bring a whole company back from a copy taken on Take a copy or by Backups, from this OpenTradesOS or any
        other: customers, jobs, invoices and the books behind them, photographs, the people and the settings. Check
        the copy first; a check does everything a restore does and then undoes it, so it tells you exactly what
        would happen.
      </p>

      {shown ? <Report run={shown} zone={zone} /> : null}

      {!readiness.empty && shown?.outcome !== "restored" ? (
        <p role="alert" className="mt-6 rounded border border-amber-700 bg-amber-tint px-3 py-2 text-sm text-ink-900">
          {user.organizationName} already has records ({readiness.held.slice(0, 6).join(", ")}
          {readiness.held.length > 6 ? ", and more" : ""}). A copy is only restored into an empty company, so nothing
          is ever merged into somebody&apos;s real work. Make a new company and restore into that.
        </p>
      ) : null}

      {readiness.empty ? (
        <>
          <section className="mt-8 rounded-md border border-steel-200 bg-canvas p-5" aria-labelledby="from-file">
            <h2 id="from-file" className="text-base font-semibold">From a file</h2>
            <RestoreForm canRestore={readiness.empty} />
          </section>

          <section className="mt-6 rounded-md border border-steel-200 bg-canvas p-5" aria-labelledby="from-bucket">
            <h2 id="from-bucket" className="text-base font-semibold">From a bucket</h2>
            <p className="mt-1 text-sm text-ink-500">
              Where Backups wrote its copies, or anywhere you put a copy too large to upload. Leave Copy empty to see
              the copies that are there. The secret key is named, not typed: it is kept in this deployment&apos;s
              secret store.
            </p>
            <ActionForm action={fromBucket} submit="Look in the bucket, or check the copy">
              <TextField label="Service address" name="endpoint" required placeholder="https://s3.us-east-1.amazonaws.com" />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Bucket" name="bucket" required />
                <TextField label="Region" name="region" required defaultValue="us-east-1" />
              </div>
              <TextField label="Folder in the bucket (optional)" name="prefix" />
              <div className="grid gap-4 sm:grid-cols-2">
                <TextField label="Access key id" name="accessKeyId" required autoComplete="off" />
                <TextField label="Name of the secret key" name="secretKeyRef" required autoComplete="off" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="hostStyle" className="h-4 w-4" />
                The service wants the bucket in the address (bucket.service.com), not after it
              </label>
              <TextField label="Copy" name="key" placeholder="opentradesos/acme/opentradesos-acme-20261004T070000Z.zip" />
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="restore" className="h-4 w-4" />
                Restore it, not only check it
              </label>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" name="keepSending" className="h-4 w-4" />
                Let texts, emails and webhooks go out straight away
              </label>
            </ActionForm>
          </section>
        </>
      ) : null}

      <a href="/setup" className="mt-8 inline-flex h-10 items-center rounded border border-steel-300 bg-canvas px-4 text-sm font-medium text-ink-700 hover:bg-steel-100">
        Back to setup
      </a>
    </Frame>
  );
}

function Report({ run, zone }: { run: restore.RestoreRunView; zone: string }) {
  const report = run.report;
  const outcome = OUTCOME[run.outcome as keyof typeof OUTCOME] ?? OUTCOME.refused;
  return (
    <section className="mt-8 rounded-md border border-steel-200 bg-canvas p-5" aria-labelledby="report">
      <div className="flex flex-wrap items-center gap-3">
        <h2 id="report" className="text-base font-semibold">
          {run.dryRun ? "Checked" : "Restore"}: {run.sourceName}
        </h2>
        <Chip tone={outcome.tone}>{outcome.words}</Chip>
      </div>
      <p className="mt-1 text-sm text-ink-500">
        {formatIn(run.createdAt, zone)}
        {report.source.name ? `. ${report.source.name}, taken ${report.source.generatedAt ? formatIn(report.source.generatedAt, zone) : "at an unknown time"}` : ""}.
      </p>

      {report.refusals.length > 0 ? (
        <div role="alert" className="mt-4 space-y-1 text-sm text-red-600">
          {report.refusals.map((refusal) => <p key={refusal}>{refusal}</p>)}
          <p className="text-ink-700">Nothing was restored.</p>
        </div>
      ) : (
        <p className="mt-4 text-sm text-ink-700">
          {run.dryRun ? "It would restore " : "Restored "}
          {report.restoredRows.toLocaleString("en-US")} of {report.totalRows.toLocaleString("en-US")} rows and{" "}
          {report.files.restored.toLocaleString("en-US")} files.{" "}
          {report.ids === "renumbered"
            ? "The company it came from is still on this deployment, so every record gets a new id."
            : "Every record keeps its id."}
          {run.dryRun ? " Nothing has been restored yet." : ""}
        </p>
      )}
      {report.notes.map((note) => <p key={note} className="mt-2 text-sm text-ink-500">{note}</p>)}

      {report.people.length > 0 ? (
        <>
          <h3 className="mt-6 text-sm font-medium text-ink-700">The people</h3>
          <ul className="mt-2 space-y-1 text-sm">
            {report.people.map((person) => (
              <li key={person.email}>
                <span className="font-medium">{person.name ?? person.email}</span>
                {person.name ? <span className="text-ink-500"> ({person.email})</span> : null}: {PERSON[person.outcome] ?? person.outcome}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {report.setUpAgain.length > 0 || report.held.connections + report.held.webhooks > 0 || report.secretNames.length > 0 ? (
        <>
          <h3 className="mt-6 text-sm font-medium text-ink-700">To set up again</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-ink-700">
            {report.held.connections > 0 ? (
              <li>{report.held.connections} connected {report.held.connections === 1 ? "service waits" : "services wait"} for you to check {report.held.connections === 1 ? "it" : "them"} on Settings, Integrations before anything is sent.</li>
            ) : null}
            {report.held.webhooks > 0 ? (
              <li>{report.held.webhooks} {report.held.webhooks === 1 ? "webhook is" : "webhooks are"} switched off. Give each receiver its new signing secret from Settings, Webhooks, then switch it on.</li>
            ) : null}
            {report.secretNames.length > 0 ? (
              <li>
                This deployment needs these secrets in its store, under the same names:{" "}
                {report.secretNames.map((name) => <code key={name} className="mr-1 font-mono text-xs">{name}</code>)}
              </li>
            ) : null}
            {report.setUpAgain.map((item) => (
              <li key={`${item.table}.${item.column}`}>
                <code className="font-mono text-xs">{item.table}</code>: {item.reason}
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {report.tables.length > 0 ? (
        <div className="mt-6">
          <Table label="Rows by table" head={<><Th>Table</Th><Th className="text-right">In the copy</Th><Th className="text-right">{run.dryRun ? "Would restore" : "Restored"}</Th><Th>Notes</Th></>}>
            {report.tables.map((table) => (
              <tr key={table.table}>
                <Td><span className="font-mono text-xs">{table.table}</span></Td>
                <Td className="text-right tabular-nums">{table.inCopy.toLocaleString("en-US")}</Td>
                <Td className="text-right tabular-nums">{table.restored.toLocaleString("en-US")}</Td>
                <Td className="text-ink-700">{table.notes.join(" ")}</Td>
              </tr>
            ))}
          </Table>
        </div>
      ) : null}
    </section>
  );
}

function Frame({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-canvas-raised">
      <div className="mx-auto max-w-3xl px-6 py-12">
        <div className="flex items-center gap-2.5">
          <Logo className="h-7 w-7" />
          <span className="text-lg font-semibold tracking-[-0.01em]">OpenTradesOS</span>
        </div>
        {children}
      </div>
    </div>
  );
}
