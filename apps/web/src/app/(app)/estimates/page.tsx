import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { estimates } from "@opentradesos/api/services";
import { Chip, Money } from "@opentradesos/ui";
import { ESTIMATE_STATUS, ESTIMATE_TONE, label, tone } from "@/lib/labels";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * ESTIMATES, newest first. The total shown is the largest option, which is
 * what the work is worth if the customer says yes to the best of it.
 */
export default async function EstimatesPage() {
  const user = await requireSetupUser();
  const page = await estimates.list({ actor: user.actor, db: getDb() }, { limit: 100 });

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Estimates" count={page.data.length} />
      {page.data.length === 0 ? (
        <Empty title="No estimates yet">
          Write one from a customer&apos;s page: good, better and best, and the customer chooses.
        </Empty>
      ) : (
        <Table head={<><Th className="w-20">Number</Th><Th>Title</Th><Th>Customer</Th><Th>Status</Th><Th className="text-right">Up to</Th></>}>
          {page.data.map((e) => (
            <tr key={e.id as string} className="hover:bg-steel-100">
              <Td className="font-mono tabular-nums text-ink-700">{e.number as number}</Td>
              <Td>
                <a href={`/estimates/${e.id as string}`} className="font-medium hover:underline">
                  {(e.title as string | null) ?? "Untitled"}
                </a>
              </Td>
              <Td className="text-ink-700">{e.customerName as string}</Td>
              <Td><Chip tone={tone(ESTIMATE_TONE, e.status as string)}>{label(ESTIMATE_STATUS, e.status as string)}</Chip></Td>
              <Td className="text-right"><Money value={e.total as string} /></Td>
            </tr>
          ))}
        </Table>
      )}
    </div>
  );
}
