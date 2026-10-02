import Link from "next/link";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customers, projects } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip, Money } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { PROJECT_STATUS } from "./ProjectView";

export const dynamic = "force-dynamic";

/**
 * PROJECTS
 *
 * Work bigger than a job: a remodel, an install in phases, a build billed in
 * draws. Each project is phases that wait for each other, the jobs that do
 * them, and a billing schedule against the contract value.
 */
export default async function ProjectsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const { projects: rows } = await projects.handlers.listProjects(ctx, {});
  const names = new Map(await Promise.all([...new Set(rows.map((p) => p.customerId))].map(async (customerId) =>
    [customerId, await customers.get(ctx, { id: customerId }).then((c) => c.name).catch(() => null)] as const)));

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <PageHeader title="Projects" count={rows.length} />
        {can(user.actor, "job:write") && (
          <Link href="/projects/new" className="inline-flex h-9 items-center rounded bg-ink-900 px-3 text-sm font-medium text-white">
            Start a project
          </Link>
        )}
      </div>
      {rows.length === 0 ? (
        <Empty title="No projects yet">
          A project groups phased work under one contract and bills it in stages.
        </Empty>
      ) : (
        <ul className="mt-6 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {rows.map((p) => (
            <li key={p.id}>
              <Link href={`/projects/${p.id}`} className="flex flex-wrap items-center gap-3 bg-canvas p-4 hover:bg-steel-100">
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{p.name}</span>
                  <span className="block text-sm text-ink-500">
                    {names.get(p.customerId) ?? "Customer"} · {p.phases} {p.phases === 1 ? "phase" : "phases"} · {p.jobs} {p.jobs === 1 ? "job" : "jobs"}
                  </span>
                </span>
                {p.contractValue && <span className="tabular-nums"><Money value={p.contractValue} /></span>}
                <Chip tone={p.status === "active" ? "info" : p.status === "completed" ? "success" : "neutral"}>
                  {PROJECT_STATUS[p.status] ?? p.status}
                </Chip>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
