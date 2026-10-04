import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobs, branches, customFields } from "@opentradesos/api/services";
import { Chip } from "@opentradesos/ui";
import { can, work } from "@opentradesos/core";
import { JOB_STATUS, JOB_TONE, label, tone } from "@/lib/labels";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { BranchFilter, chosenBranch } from "@/components/BranchFilter";
import { CustomFieldFilter } from "@/components/CustomFieldFilter";
import { fieldFrom, withFieldFilter } from "@/lib/field-filter";

export const dynamic = "force-dynamic";

export default async function JobsPage({
  searchParams,
}: {
  searchParams: Promise<{ branch?: string; field?: string | string[]; value?: string | string[] }>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const options = await branches.options(ctx);
  /**
   * `none` is offered here and only here: the job list is where the work
   * nobody has put in a branch is found and sorted (Settings, Branches moves
   * it in bulk).
   */
  const params = await searchParams;
  const branch = chosenBranch(options, params.branch, true);
  const named = options.branches.find((b) => b.id === branch)?.name;
  const declared = await customFields.formFields(ctx, "job");
  const { pairs, keep: fieldKeep, byField } = fieldFrom(params);

  const { page, refusal } = await withFieldFilter((withField) => jobs.list(ctx, {
    limit: 100, ...(branch ? { businessUnitId: branch } : {}), ...(withField ? byField : {}),
  }));

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader
        title="Jobs" count={page.data.length}
        action={can(user.actor, "job:write") ? (
          <a href="/jobs/new"
             className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white">
            Book a job
          </a>
        ) : undefined}
      />
      <BranchFilter options={options} action="/jobs" current={branch} none keep={fieldKeep} />
      <CustomFieldFilter action="/jobs" declared={declared} keep={{ branch }} pairs={pairs}
                         refusal={refusal} noun="jobs" />

      {page.data.length === 0 ? (
        branch ? (
          <Empty title={branch === "none" ? "Every job is in a branch" : `No jobs in ${named ?? "that branch"}`}>
            Choose every branch to see the whole company&apos;s work.
          </Empty>
        ) : (
          <Empty title="No jobs yet">
            Book one from a customer, or let a customer book themselves from the
            online booking page.
          </Empty>
        )
      ) : (
        <Table head={<><Th className="w-20">Number</Th><Th>Summary</Th><Th>Customer</Th><Th>Address</Th><Th>Status</Th></>}>
          {page.data.map((job) => (
            <tr key={job.id} className="hover:bg-steel-100">
              {/* Mono, because a job number gets read aloud over a phone. */}
              <Td className="font-mono tabular-nums text-ink-700">{work.documentNumber(job.numberPrefix, job.number)}</Td>
              <Td>
                <a href={`/jobs/${job.id}`} className="font-medium text-ink-900 hover:underline">
                  {job.summary ?? "Untitled"}
                </a>
              </Td>
              <Td className="text-ink-700">{job.customerName}</Td>
              <Td className="text-ink-700">{job.propertyAddress}</Td>
              <Td>
                <Chip tone={tone(JOB_TONE, job.status)}>{label(JOB_STATUS, job.status)}</Chip>
              </Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
