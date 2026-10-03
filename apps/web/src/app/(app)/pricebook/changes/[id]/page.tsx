import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { repricing, NotFoundError } from "@opentradesos/api/services";
import { Money } from "@opentradesos/ui";
import { Table, Th, Td } from "@/components/Table";
import { Crumb } from "@/components/Detail";
import { formatIn } from "@/lib/dates";

export const dynamic = "force-dynamic";

/** One bulk change, item by item: what each price was and what it became. */
export default async function PriceChangePage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const change = await repricing.lines({ actor: user.actor, db: getDb() }, { id }).catch((error: unknown) => {
    if (error instanceof NotFoundError) notFound();
    throw error;
  });

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <Crumb href="/pricebook/changes">Change prices</Crumb>
      <h1 className="mt-1 text-xl font-semibold">{change.description}</h1>
      <p className="mt-1 text-sm text-ink-700">
        {formatIn(change.appliedAt, user.organizationTimezone)}.
        {change.reversesId ? <> It undid <a href={`/pricebook/changes/${change.reversesId}`} className="underline underline-offset-4">an earlier change</a>.</> : null}
        {change.reversedById ? <> It was <a href={`/pricebook/changes/${change.reversedById}`} className="underline underline-offset-4">undone</a> later.</> : null}
      </p>
      <Table label="Prices" head={<><Th>Code</Th><Th>Name</Th><Th className="text-right">Before</Th><Th className="text-right">After</Th></>}>
        {change.lines.map((line) => (
          <tr key={line.itemId}>
            <Td className="font-mono text-ink-700">{line.code}</Td>
            <Td>{line.name}</Td>
            <Td className="text-right"><Money value={line.priceBefore} /></Td>
            <Td className="text-right"><Money value={line.priceAfter} /></Td>
          </tr>
        ))}
      </Table>
    </div>
  );
}
