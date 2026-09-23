import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobs, NotFoundError } from "@opentradesos/api/services";
import { Chip } from "@opentradesos/ui";
import { Facts, Fact, Crumb } from "@/components/Detail";
import { Table, Th, Td, Empty } from "@/components/Table";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;

  const job = await jobs.get({ actor: user.actor, db: getDb() }, { id })
    .catch((error: unknown) => {
      // Out of scope reads as missing, not as forbidden. "You may not see
      // this job" answers a question the caller was not allowed to ask.
      if (error instanceof NotFoundError) notFound();
      throw error;
    });

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/jobs">Jobs</Crumb>
      <div className="mt-1 flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-xl font-semibold">
          <span className="font-mono tabular-nums text-ink-500">{job.number}</span>{" "}
          {job.summary ?? "Untitled"}
        </h1>
        <Chip tone={job.status === "completed" ? "success" : "info"}>{job.status}</Chip>
      </div>

      <Facts>
        <Fact label="Priority">{job.priority}</Fact>
        <Fact label="Description">{job.description}</Fact>
        <Fact label="Customer said">{job.customerComplaint}</Fact>
        <Fact label="PO number">{job.purchaseOrderNumber}</Fact>
      </Facts>

      <h2 className="mt-10 text-base font-semibold">Visits</h2>
      {job.visits.length === 0 ? (
        <Empty title="Not scheduled yet">
          A job becomes work when it has a visit on the board.
        </Empty>
      ) : (
        <Table head={<><Th className="w-16">#</Th><Th>Window</Th><Th>Status</Th></>}>
          {job.visits.map((visit) => (
            <tr key={visit.id}>
              <Td className="font-mono tabular-nums text-ink-700">{visit.sequence}</Td>
              <Td className="text-ink-700">
                {/*
                  In the company's timezone, always. A dispatcher in Denver
                  looking at a Texas company has to see the window the Texas
                  customer was given, and formatting in the viewer's zone
                  silently shows them a different appointment.
                */}
                {visit.windowStart
                  ? formatIn(visit.windowStart, user.organizationTimezone)
                  : "Unscheduled"}
              </Td>
              <Td><Chip tone={visit.status === "completed" ? "success" : "neutral"}>{visit.status}</Chip></Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
