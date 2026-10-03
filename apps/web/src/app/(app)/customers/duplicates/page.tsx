import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { customerDuplicates } from "@opentradesos/api/services";
import { assertCan } from "@opentradesos/core";
import { Phone } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { ActionForm } from "@/components/ActionForm";
import { Crumb } from "@/components/Detail";
import { mergePair, notDuplicate } from "./actions";

export const dynamic = "force-dynamic";

/**
 * LIKELY DUPLICATES, ACROSS EVERY CUSTOMER
 *
 * The same matcher a customer's own page uses, run over every pair at once:
 * the same phone number, the same email, or a name close enough that a person
 * should look, strongest first. A company finds out it has duplicates when a
 * customer is billed twice; this is the list that finds them first.
 *
 * Each pair offers both directions of the merge, named for the record kept,
 * because "merge" alone makes somebody guess which one survives. And "not the
 * same person" is remembered, because a landlord and her tenant share a
 * number and will be here every morning otherwise.
 */
export default async function DuplicatesPage({
  searchParams,
}: {
  searchParams: Promise<{ after?: string }>;
}) {
  const user = await requireSetupUser();
  assertCan(user.actor, "customer:merge");
  const { after } = await searchParams;
  const ctx = { actor: user.actor, db: getDb() };
  const page = await customerDuplicates.sweep(ctx, { limit: 25, ...(after ? { cursor: after } : {}) });
  const setAside = await customerDuplicates.dismissedCount(ctx);

  const side = (c: { id: string; name: string; phone: string | null; email: string | null }) => (
    <div>
      <a href={`/customers/${c.id}`} className="font-medium hover:underline">{c.name}</a>
      <div className="text-sm text-ink-500">
        {c.phone ? <Phone value={c.phone} /> : null}
        {c.phone && c.email ? " · " : null}
        {c.email}
      </div>
    </div>
  );

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <Crumb href="/customers">Customers</Crumb>
      <div className="mt-1"><PageHeader title="Likely duplicates" /></div>
      <p className="mt-2 max-w-prose text-sm text-ink-700">
        Pairs that share a phone number or an email, or whose names are close. Merging moves
        everything onto the record you keep, and the other one points at it so old links still work.
        {setAside > 0 ? ` ${setAside === 1 ? "One pair has" : `${setAside} pairs have`} been marked as different people and are not shown.` : ""}
      </p>

      {page.data.length === 0 ? (
        <Empty title={after ? "No more pairs" : "Nothing looks like a duplicate"}>
          {after
            ? <a href="/customers/duplicates" className="underline underline-offset-4">Back to the start</a>
            : "No two customers share a phone number or an email, or have names close enough to check."}
        </Empty>
      ) : (
        <ul className="mt-6 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {page.data.map((pair) => (
            <li key={`${pair.a.id}:${pair.b.id}`} aria-label={`${pair.a.name} and ${pair.b.name}`} className="bg-canvas p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-ink-500">{pair.because}</p>
              <div className="mt-2 grid gap-4 sm:grid-cols-2">
                {side(pair.a)}
                {side(pair.b)}
              </div>
              <div className="mt-3 flex flex-wrap items-start gap-3">
                <ActionForm action={mergePair} submit={`Keep ${pair.a.name}, merge the other in`} tone="quiet"
                            hidden={{ keepId: pair.a.id, mergeId: pair.b.id }} className="flex flex-wrap gap-2" />
                <ActionForm action={mergePair} submit={`Keep ${pair.b.name}, merge the other in`} tone="quiet"
                            hidden={{ keepId: pair.b.id, mergeId: pair.a.id }} className="flex flex-wrap gap-2" />
                <ActionForm action={notDuplicate} submit="Not the same person" tone="quiet"
                            hidden={{ customerId: pair.a.id, otherId: pair.b.id }}
                            className="flex flex-wrap items-center gap-2">
                  <input name="reason" maxLength={500} placeholder="Why, if you know (landlord and tenant)"
                         aria-label={`Why ${pair.a.name} and ${pair.b.name} are different people`}
                         className="h-9 w-64 rounded border border-steel-300 bg-canvas px-3 text-sm" />
                </ActionForm>
              </div>
            </li>
          ))}
        </ul>
      )}

      {page.hasMore && page.nextCursor ? (
        <p className="mt-4 text-sm">
          <a href={`/customers/duplicates?after=${encodeURIComponent(page.nextCursor)}`}
             className="underline underline-offset-4">The next {25} pairs</a>
        </p>
      ) : null}
    </div>
  );
}
