import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { contracts } from "@opentradesos/api/services";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

/**
 * WHOSE PRICE GOVERNS
 *
 * This screen exists to answer one question before somebody quotes: for this
 * client, is our price book the authority or is theirs?
 *
 * TWO NUMBERS DECIDE WHETHER A CONTRACT IS REAL, and both are on the row:
 * how many cards are in force today, and how many priced lines those cards
 * carry between them. A contract with a card and no lines is the quiet
 * failure this screen is built around. It looks complete. Every item quoted
 * against it comes back out of scope, and the person quoting reads that as
 * a fussy client rather than as a schedule nobody loaded.
 *
 * IN FORCE IS READ FROM THE DATES, never from the active flag alone. A
 * contract that ended in March is not the authority in September because
 * nobody remembered to untick it, and a screen that showed it as live would
 * have somebody quoting last year's rates.
 */
export default async function ContractsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };
  const rows = await contracts.overview(ctx);

  const live = rows.filter((row) => row.inForce);

  return (
    <div className="mx-auto max-w-5xl px-4 py-8 lg:px-6">
      <PageHeader title="Contracts" count={rows.length} />

      <p className="mt-4 max-w-2xl text-sm text-ink-700">
        A rate card is a price authority that is not ours. Where one applies,
        it is the agreement: an item on the card is charged at the card&rsquo;s
        price, and an item that is not on it is out of scope until the client
        agrees one. Our own cost still comes from our own records either way,
        so margin stays true on work we did not price.
      </p>

      {rows.length === 0 ? (
        <Empty title="No contracts yet">
          Until a client has a contract with a rate card on it, your price
          book is the authority for everything you sell them, which is the
          right answer for residential work and the wrong one for most
          commercial.
        </Empty>
      ) : (
        <ul className="mt-6 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {rows.map((row) => (
            <li key={row.id} className="bg-canvas p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium text-ink-900">{row.customerName}</span>
                <span className="text-sm text-ink-700">{row.name}</span>
                {row.contractNumber && (
                  <span className="text-xs tabular-nums text-ink-500">{row.contractNumber}</span>
                )}
                {row.inForce
                  ? <Chip tone="success">In force</Chip>
                  : row.ended
                    ? <Chip tone="neutral">Ended {row.endsOn}</Chip>
                    : <Chip tone="neutral">Not started</Chip>}
                {row.autoRenews && <Chip tone="neutral">Auto renews</Chip>}
              </div>

              <p className="mt-1 text-xs text-ink-500">
                {row.startsOn ?? "No start date"} to {row.endsOn ?? "no end date"}
                {row.purchaseOrderNumber ? ` · PO ${row.purchaseOrderNumber}` : ""}
              </p>

              {row.coveredScope && (
                <p className="mt-2 text-sm text-ink-900">{row.coveredScope}</p>
              )}

              {/*
                The warning that earns this screen its place. A card with no
                lines prices nothing, and nothing else in the product would
                ever tell you: quoting simply comes back out of scope, over
                and over, and reads as the client being difficult.
              */}
              {row.inForce && row.cards.length > 0 && row.pricedLines === 0 && (
                <p className="mt-3 rounded-md border border-red-600/20 bg-red-tint p-3 text-sm text-ink-900">
                  This contract has a rate card with no lines on it. Every item
                  quoted to this client will come back out of scope until the
                  schedule is loaded.
                </p>
              )}

              {row.inForce && row.cards.length === 0 && (
                <p className="mt-3 rounded-md border border-amber-700/20 bg-amber-tint p-3 text-sm text-ink-900">
                  No rate card on this contract, so your own price book prices
                  this client. That is fine if the agreement is about terms and
                  ceilings rather than rates.
                </p>
              )}

              {row.cards.length > 0 && (
                <ul className="mt-3 space-y-1">
                  {row.cards.map((card) => (
                    <li key={card.id} className="flex flex-wrap items-baseline gap-2 text-sm">
                      <span className="text-ink-900">{card.name}</span>
                      <span className="text-xs text-ink-500">
                        {/* The authority, spelled out. A warranty schedule and a client contract are not the same promise. */}
                        {card.authority.replace(/_/g, " ")}
                      </span>
                      <span className="text-xs tabular-nums text-ink-700">
                        {card.lines === 0 ? "no lines" : card.lines === 1 ? "1 line" : `${card.lines} lines`}
                      </span>
                      {!card.inForce && <Chip tone="neutral">Not in force today</Chip>}
                    </li>
                  ))}
                </ul>
              )}

              {row.sites.length > 0 && (
                <dl className="mt-3 grid grid-cols-1 gap-x-4 gap-y-1 text-sm sm:grid-cols-2">
                  {row.sites.map((site) => (
                    <div key={site.id} className="flex items-baseline justify-between gap-2">
                      <dt className="truncate text-ink-700">
                        {site.siteNumber ? `${site.siteNumber} · ` : ""}{site.address}
                      </dt>
                      <dd className="shrink-0 tabular-nums text-ink-900">
                        {site.notToExceed ? `$${site.notToExceed}` : "no limit"}
                        {/*
                          Said out loud, because the two differ by design: a
                          thousand at the distribution centre and two hundred
                          at the retail unit, under one agreement. Somebody
                          approving work needs to know which limit they are
                          reading.
                        */}
                        {site.notToExceed && (
                          <span className="ml-1 text-xs text-ink-500">
                            {site.fromSite ? "site" : "contract"}
                          </span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}

      {rows.length > 0 && live.length === 0 && (
        <p className="mt-6 text-sm text-ink-700">
          Nothing is in force today, so your price book is the authority for
          every customer listed here.
        </p>
      )}
    </div>
  );
}
