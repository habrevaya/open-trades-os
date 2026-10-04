import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { estimates, branches } from "@opentradesos/api/services";
import { Chip, Money } from "@opentradesos/ui";
import { money } from "@opentradesos/core";
import { ESTIMATE_STATUS, ESTIMATE_TONE, label, tone } from "@/lib/labels";
import { Table, Th, Td, Empty, PageHeader } from "@/components/Table";
import { BranchFilter, chosenBranch } from "@/components/BranchFilter";

export const dynamic = "force-dynamic";

/**
 * ESTIMATES, newest first. The total shown is the largest option, which is
 * what the work is worth if the customer says yes to the best of it.
 */
export default async function EstimatesPage({
  searchParams,
}: {
  searchParams: Promise<{ sort?: string; branch?: string }>;
}) {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const params = await searchParams;
  const sort = params.sort === "value" ? "value" as const : "age" as const;
  const options = await branches.options(ctx);
  const branch = chosenBranch(options, params.branch);
  const [page, waiting] = await Promise.all([
    estimates.list(ctx, { limit: 100, ...(branch ? { businessUnitId: branch } : {}) }),
    estimates.unsold(ctx, { sort, limit: 50 }),
  ]);
  const waitingTotal = money.toString(money.sum(waiting.map((e) => money.money(e.value)), "USD"));

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 lg:px-6">
      <PageHeader title="Estimates" count={page.data.length} />

      {/*
        UNSOLD: sent, not approved or declined, not expired. The pipeline a
        company can still close, and the list a follow up is worked from. The
        total is the recommended option of each, or the largest, never every
        option added up, which would count one job two or three times.
      */}
      <section aria-labelledby="unsold" className="mt-6">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="unsold" className="text-base font-semibold">
            Unsold estimates
            {waiting.length > 0 ? (
              <span className="ml-2 text-sm font-normal text-ink-500">
                {waiting.length} waiting, worth{" "}
                <Money value={waitingTotal} />
              </span>
            ) : null}
          </h2>
          <div className="flex gap-2 text-sm" role="group" aria-label="Order">
            <a href="/estimates?sort=age" aria-current={sort === "age" ? "page" : undefined}
               className={sort === "age" ? "font-medium text-ink-900" : "text-ink-500 hover:underline"}>
              Oldest first
            </a>
            <a href="/estimates?sort=value" aria-current={sort === "value" ? "page" : undefined}
               className={sort === "value" ? "font-medium text-ink-900" : "text-ink-500 hover:underline"}>
              Largest first
            </a>
          </div>
        </div>
        {waiting.length === 0 ? (
          <p className="mt-2 text-sm text-ink-500">Nothing sent is waiting for an answer.</p>
        ) : (
          <Table head={<><Th className="w-20">Number</Th><Th>Customer</Th><Th>Sent</Th><Th>Opened</Th><Th className="text-right">Worth</Th></>}>
            {waiting.map((e) => (
              <tr key={e.id} className="hover:bg-steel-100">
                <Td className="font-mono tabular-nums text-ink-700">
                  <a href={`/estimates/${e.id}`} className="hover:underline">{e.number}</a>
                </Td>
                <Td>
                  <a href={`/estimates/${e.id}`} className="font-medium hover:underline">{e.customerName}</a>
                  {e.title ? <span className="block text-xs text-ink-500">{e.title}</span> : null}
                </Td>
                <Td className={e.ageDays >= 7 ? "text-red-600" : "text-ink-700"}>
                  {e.ageDays === 0 ? "Today" : `${e.ageDays} ${e.ageDays === 1 ? "day" : "days"} ago`}
                </Td>
                <Td className="text-ink-700">{e.viewedAt ? "Yes" : "Not yet"}</Td>
                <Td className="text-right"><Money value={e.value} /></Td>
              </tr>
            ))}
          </Table>
        )}
      </section>

      <h2 className="mt-10 text-base font-semibold">Every estimate</h2>
      {/*
        Under this heading rather than the page's, because it narrows this
        list: an estimate belongs to a branch through its job, and the unsold
        pipeline above is the company's follow up list.
      */}
      <BranchFilter options={options} action="/estimates" current={branch} keep={{ sort: params.sort }} />
      {page.data.length === 0 ? (
        branch ? (
          <Empty title="No estimates in that branch">
            An estimate belongs to a branch through its job. One written before there was a job is in none.
          </Empty>
        ) : (
          <Empty title="No estimates yet">
            Write one from a customer&apos;s page: good, better and best, and the customer chooses.
          </Empty>
        )
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
