import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { backups } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, Select, TextField } from "@/components/ActionForm";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { formatIn } from "@/lib/dates";
import { backUpNow, saveDestination, stopBackups } from "./actions";

export const dynamic = "force-dynamic";

const HOURS = Array.from({ length: 24 }, (_, h) => ({
  value: String(h),
  label: h === 0 ? "Midnight" : h === 12 ? "Noon" : h < 12 ? `${h} in the morning` : `${h - 12} in the ${h < 18 ? "afternoon" : "evening"}`,
}));
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]
  .map((label, i) => ({ value: String(i), label }));
const STATUS = { running: "info", succeeded: "success", failed: "danger" } as const;
const STATUS_WORDS = { running: "Writing", succeeded: "In the bucket", failed: "Failed" } as const;

const size = (bytes: number | null) => (bytes === null ? "" : bytes < 1024 * 1024
  ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`);

/**
 * SETTINGS, BACKUPS
 *
 * A copy of the whole company, written every night or every week to a bucket
 * the owner controls, so the business survives this deployment going away.
 * The same zip as Take a copy, kept to the number the owner chooses, and every
 * attempt listed with what happened to it. `data:export`, like the download:
 * where the whole company is sent is the owner's decision.
 */
export default async function BackupsPage() {
  const user = await requireSetupUser();
  if (!can(user.actor, "data:export")) {
    return (
      <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
        <PageHeader title="Backups" />
        <Empty title="This is the owner's to set up">
          A copy of the whole company sent somewhere else needs the export permission, the same as downloading one.
        </Empty>
      </div>
    );
  }
  const ctx = { actor: user.actor, db: getDb() };
  const [destination, runs] = await Promise.all([backups.destination(ctx), backups.runs(ctx)]);
  const zone = user.organizationTimezone;

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Backups" />
      <p className="mt-2 max-w-2xl text-sm text-ink-700">
        A copy of everything, written to a bucket you own on a schedule: Amazon S3, Cloudflare R2, Backblaze B2,
        Wasabi, or a MinIO on your own server. It is the same zip as{" "}
        <a href="/settings/export" className="text-blue-600 underline underline-offset-4">Take a copy</a>, and a
        new company here or on any other OpenTradesOS can be restored from it.
      </p>

      {destination ? (
        <div className="mt-4 rounded-md border border-steel-200 bg-canvas p-4 text-sm">
          {destination.lastCheckError ? (
            <p role="alert" className="text-red-600">The bucket did not take a test copy: {destination.lastCheckError}</p>
          ) : (
            <p className="text-ink-700">
              {destination.frequency === "off"
                ? "Copies are only taken when you ask."
                : `Next copy ${destination.nextRunAt ? formatIn(destination.nextRunAt, zone) : "when the schedule says"}, `
                  + `into ${destination.bucket}${destination.prefix ? `/${destination.prefix}` : ""}, keeping the newest ${destination.keep}.`}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-3">
            <ActionForm action={backUpNow} submit="Take a copy now" className="" />
            <ActionForm action={stopBackups} submit="Stop taking copies" tone="danger" className="" />
          </div>
        </div>
      ) : null}

      <section className="mt-8 max-w-2xl" aria-labelledby="where">
        <h2 id="where" className="text-base font-semibold">{destination ? "Where copies go" : "Set where copies go"}</h2>
        <p className="mt-1 text-sm text-ink-500">
          The secret key is never typed here. It is kept in this company&apos;s own secrets (Settings, Integrations);
          you type the name it is kept under, the same way every other connection works.
        </p>
        <ActionForm action={saveDestination} submit="Save and check the bucket">
          <TextField label="Service address" name="endpoint" required placeholder="https://s3.us-east-1.amazonaws.com"
                     defaultValue={destination?.endpoint ?? ""} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Bucket" name="bucket" required defaultValue={destination?.bucket ?? ""} />
            <TextField label="Region" name="region" required defaultValue={destination?.region ?? "us-east-1"} />
          </div>
          <TextField label="Folder in the bucket (optional)" name="prefix" placeholder="opentradesos/"
                     defaultValue={destination?.prefix ?? ""} />
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField label="Access key id" name="accessKeyId" required autoComplete="off"
                       defaultValue={destination?.accessKeyId ?? ""} />
            <TextField label="Name of the secret key" name="secretKeyRef" required autoComplete="off"
                       placeholder="BACKUP_SECRET_KEY" defaultValue={destination?.secretKeyRef ?? ""} />
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="hostStyle" className="h-4 w-4" defaultChecked={destination ? !destination.pathStyle : false} />
            The service wants the bucket in the address (bucket.service.com), not after it
          </label>
          <div className="grid gap-4 sm:grid-cols-3">
            <Select label="How often" name="frequency" defaultValue={destination?.frequency ?? "daily"} options={[
              { value: "daily", label: "Every night" },
              { value: "weekly", label: "Once a week" },
              { value: "off", label: "Only when I ask" },
            ]} />
            <Select label="At" name="hour" defaultValue={String(destination?.hour ?? 2)} options={HOURS} />
            <Select label="On (for once a week)" name="weekday" defaultValue={String(destination?.weekday ?? 0)} options={DAYS} />
          </div>
          <TextField label="Copies to keep" name="keep" type="number" min={1} max={365} required
                     defaultValue={String(destination?.keep ?? 14)} />
        </ActionForm>
      </section>

      <section className="mt-10" aria-labelledby="copies">
        <h2 id="copies" className="text-base font-semibold">Copies taken</h2>
        {runs.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">None yet.</p>
        ) : (
          <Table label="Copies taken" head={<><Th>Started</Th><Th>What happened</Th><Th>Where</Th><Th className="text-right">Size</Th><Th className="text-right">Rows</Th></>}>
            {runs.map((run) => (
              <tr key={run.id}>
                <Td>{formatIn(run.startedAt, zone)}{run.trigger === "person" ? " (asked for)" : ""}</Td>
                <Td>
                  <Chip tone={run.prunedAt ? "neutral" : STATUS[run.status as keyof typeof STATUS] ?? "neutral"}>
                    {run.prunedAt ? "Deleted to keep newer ones" : STATUS_WORDS[run.status as keyof typeof STATUS_WORDS] ?? run.status}
                  </Chip>
                  {run.error ? <p className="mt-1 text-xs text-red-600">{run.error}</p> : null}
                </Td>
                <Td><span className="break-all font-mono text-xs">{run.bucket}/{run.objectKey}</span></Td>
                <Td className="text-right tabular-nums">{size(run.sizeBytes)}</Td>
                <Td className="text-right tabular-nums">{run.rows?.toLocaleString("en-US") ?? ""}</Td>
              </tr>
            ))}
          </Table>
        )}
      </section>
    </div>
  );
}
