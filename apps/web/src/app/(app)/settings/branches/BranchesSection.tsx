import { branches, jobs, type ServiceContext } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { ActionForm, TextField } from "@/components/ActionForm";
import { Table, Th, Td, Empty } from "@/components/Table";
import { createBranch, renameBranch, setBranchActive, moveJobs } from "./actions";

/**
 * A COMPANY'S BRANCHES, AND THE WORK THAT IS IN NONE
 *
 * Drawn on Settings, Branches and on the setup wizard's team step, from the
 * same services, so a company dividing itself up during setup and one doing
 * it a year later get the same screen.
 *
 * A branch is retired rather than deleted: every job, invoice and ledger
 * entry that names it keeps naming it, so last year's revenue by branch does
 * not change the day a shop closes.
 */
export async function BranchesSection({ ctx, compact = false }: { ctx: ServiceContext; compact?: boolean }) {
  const view = await branches.overview(ctx);
  const writes = can(ctx.actor, "settings:write");
  const moves = can(ctx.actor, "job:write") && !(await branches.options(ctx)).narrowed;
  const live = view.branches.filter((b) => b.active);
  const unsorted = moves && live.length > 0 && view.unassigned.jobs > 0
    ? (await jobs.list(ctx, { limit: 50, businessUnitId: "none" })).data
    : [];

  return (
    <div>
      {view.branches.length === 0 ? (
        <Empty title="One company, no branches">
          Most companies never need one. Add a branch when a second shop or a second set of books
          wants its managers to see their own work, and only their own.
        </Empty>
      ) : (
        <Table head={<><Th>Branch</Th><Th className="text-right">People</Th><Th className="text-right">Open jobs</Th><Th className="text-right">All jobs</Th><Th>{""}</Th></>}>
          {view.branches.map((b) => (
            <tr key={b.id}>
              <Td>
                <span className="font-medium">{b.name}</span>
                {b.code ? <span className="ml-2 font-mono text-xs text-ink-500">{b.code}</span> : null}
                {!b.active ? <span className="ml-2"><Chip tone="neutral">Retired</Chip></span> : null}
              </Td>
              <Td className="text-right tabular-nums">{b.people}</Td>
              <Td className="text-right tabular-nums">{b.openJobs}</Td>
              <Td className="text-right tabular-nums">{b.jobs}</Td>
              <Td>
                {writes ? (
                  <div className="flex flex-wrap items-start gap-2">
                    {!compact ? (
                      <ActionForm action={renameBranch} tone="quiet" submit={`Rename ${b.name}`}
                                  hidden={{ id: b.id }} className="flex flex-wrap items-end gap-2">
                        <TextField label="Name" name="name" defaultValue={b.name} required maxLength={200} className="w-40" />
                        <TextField label="Code" name="code" defaultValue={b.code ?? ""} maxLength={50} className="w-24" />
                      </ActionForm>
                    ) : null}
                    <ActionForm
                      action={setBranchActive} tone={b.active ? "danger" : "quiet"}
                      submit={b.active ? `Retire ${b.name}` : `Bring ${b.name} back`}
                      hidden={{ id: b.id, active: b.active ? "false" : "true" }}
                      className="flex items-end gap-2"
                    />
                  </div>
                ) : null}
              </Td>
            </tr>
          ))}
        </Table>
      )}

      {writes ? (
        <ActionForm action={createBranch} submit="Add a branch" done="Added." className="mt-4 flex flex-wrap items-end gap-3">
          <TextField label="Branch name" name="name" required maxLength={200} placeholder="Houston" className="w-56" />
          <TextField label="Short code (optional)" name="code" maxLength={50} placeholder="HOU" className="w-40" />
        </ActionForm>
      ) : null}

      {view.branches.length > 0 ? (
        <p className="mt-4 text-sm text-ink-700">
          {view.peopleWithoutBranch === 0
            ? "Everybody belongs to a branch."
            : `${view.peopleWithoutBranch} ${view.peopleWithoutBranch === 1 ? "person has" : "people have"} no branch. That is right for an owner who sees everything; somebody limited to their branch needs one.`}
          {" "}People are put in a branch on <a href="/settings/team" className="underline underline-offset-4">Team</a>.
        </p>
      ) : null}

      {view.unassigned.jobs > 0 && live.length > 0 ? (
        <section className="mt-8" aria-labelledby="unsorted">
          <h2 id="unsorted" className="text-base font-semibold">Work in no branch</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">
            {view.unassigned.jobs} {view.unassigned.jobs === 1 ? "job is" : "jobs are"} in no branch
            ({view.unassigned.openJobs} still open). Only people who see the whole company see them. A job
            booked from now on goes in the branch of whoever books it.
          </p>
          {unsorted.length > 0 ? (
            <ActionForm action={moveJobs} submit="Move the ticked jobs" className="mt-3 space-y-3">
              <ul className="max-h-80 divide-y divide-steel-200 overflow-y-auto rounded-md border border-steel-200">
                {unsorted.map((job) => (
                  <li key={job.id} className="bg-canvas px-3 py-2">
                    <label className="flex items-center gap-3 text-sm">
                      <input type="checkbox" name="jobId" value={job.id} className="h-4 w-4" />
                      <span className="font-mono tabular-nums text-ink-500">{job.number}</span>
                      <span className="font-medium">{job.summary}</span>
                      <span className="text-ink-500">{job.customerName}</span>
                    </label>
                  </li>
                ))}
              </ul>
              <label className="block text-sm">
                <span className="font-medium text-ink-700">Into</span>
                <select name="businessUnitId" required className="mt-1 block h-9 rounded border border-steel-300 px-2">
                  {live.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            </ActionForm>
          ) : null}
          {view.unassigned.jobs > unsorted.length && unsorted.length > 0 ? (
            <p className="mt-2 text-xs text-ink-500">The newest fifty are listed. Move these and the next fifty appear.</p>
          ) : null}
        </section>
      ) : null}
    </div>
  );
}
