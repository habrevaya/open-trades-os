import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { jobs } from "@opentradesos/api/services";
import { Chip } from "@opentradesos/ui";
import { JOB_STATUS, JOB_TONE, label, tone } from "@/lib/labels";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

export default async function JobsPage() {
  const user = await requireSetupUser();

  const page = await jobs.list({ actor: user.actor, db: getDb() }, { limit: 100 });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Jobs" count={page.data.length} />

      {page.data.length === 0 ? (
        <Empty title="No jobs yet">
          Book one from a customer, or let a customer book themselves from the
          online booking page.
        </Empty>
      ) : (
        <Table head={<><Th className="w-20">Number</Th><Th>Summary</Th><Th>Customer</Th><Th>Address</Th><Th>Status</Th></>}>
          {page.data.map((job) => (
            <tr key={job.id} className="hover:bg-steel-100">
              {/* Mono, because a job number gets read aloud over a phone. */}
              <Td className="font-mono tabular-nums text-ink-700">{job.number}</Td>
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
