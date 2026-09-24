import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { reviews, ConflictError } from "@opentradesos/api/services";
import { Chip } from "@opentradesos/ui";
import { formatIn } from "@/lib/dates";
import { Empty, PageHeader } from "@/components/Table";
import { Respond } from "./Respond";

export const dynamic = "force-dynamic";

/**
 * THE REPLY QUEUE
 *
 * For a local trades company the listing is worth more than the website, and
 * the reply under the worst review is the only part of that conversation the
 * company controls.
 *
 * THE ORDERING IS NOT WORST FIRST, and this screen says so, because everybody
 * expects it to be. It is most overdue first, measured against each review's
 * own deadline: four business hours for a one star, a calendar week for a
 * five. A five star ignored for three weeks is further past its clock than a
 * one star from this morning, and it has been sitting unanswered on a public
 * profile for three weeks.
 *
 * THE RATING IS SHOWN THREE WAYS. Not because three numbers are better than
 * one, but because no single one is honest: the mean is wrong about time,
 * the recent average is wrong about volume, and the confidence figure is
 * wrong about how good you are, deliberately and always downward. Each
 * carries its caveat on the screen rather than in a tooltip.
 */
export default async function ReviewsPage() {
  const user = await requireSetupUser();
  const ctx = { actor: user.actor, db: getDb() };

  /**
   * A missing policy is the ordinary first state of this screen, not an
   * error. The service refuses to decide anything without one, on purpose,
   * so the screen says what to do rather than showing a stack trace.
   */
  let rating = null;
  let items: Awaited<ReturnType<typeof reviews.workList>> = [];
  let withheld: Awaited<ReturnType<typeof reviews.withheld>> = [];
  let needsPolicy = false;

  try {
    [rating, items, withheld] = await Promise.all([
      reviews.rating(ctx),
      reviews.workList(ctx),
      reviews.withheld(ctx),
    ]);
  } catch (error) {
    if (!(error instanceof ConflictError)) throw error;
    needsPolicy = true;
  }

  if (needsPolicy) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
        <PageHeader title="Reviews" />
        <Empty title="Set a review policy first">
          How soon after a visit to ask, how often at most, and how late in
          the evening are all decisions about how you talk to your customers.
          The product will not guess them: a default sends messages at nine at
          night to somebody who had four jobs that week.
        </Empty>
      </div>
    );
  }

  const owed = items.filter((item) => item.recoveryDueAt && !item.recoveredAt);

  return (
    <div className="mx-auto max-w-4xl px-4 py-8 lg:px-6">
      <PageHeader title="Reviews" count={items.length} />

      {rating && rating.count > 0 ? (
        <dl className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-3">
          <Figure
            label={`Average of ${rating.count}`}
            value={rating.mean!.toFixed(2)}
            caveat={rating.caveats.mean}
          />
          <Figure
            label="Weighted to recent"
            value={rating.recentMean!.toFixed(2)}
            caveat={rating.caveats.recentMean}
          />
          <Figure
            label="For ordering only"
            value={rating.confidence!.toFixed(2)}
            caveat={rating.caveats.confidence}
          />
        </dl>
      ) : (
        <p className="mt-6 text-sm text-ink-700">
          {/*
            Not "0.0". A business with no reviews does not have a rating of
            zero, and a 0.0 on a screen is a catastrophe rendered as a fact.
          */}
          No reviews recorded yet, which is not the same as a rating of zero.
        </p>
      )}

      {owed.length > 0 && (
        <p className="mt-6 rounded-md border border-red-600/20 bg-red-tint p-3 text-sm text-ink-900">
          {owed.length === 1 ? "One customer is" : `${owed.length} customers are`} owed
          a phone call. The review they leave is not the point of the call.
        </p>
      )}

      {items.length === 0 ? (
        <Empty title="Nothing owed a reply">
          Replies appear here as reviews are recorded, in the order to work
          them: most overdue first, against each one&rsquo;s own clock.
        </Empty>
      ) : (
        <ul className="mt-6 divide-y divide-steel-200 overflow-hidden rounded-md border border-steel-200">
          {items.map((item) => (
            <li key={item.id} className="bg-canvas p-4">
              <div className="flex flex-wrap items-baseline gap-2">
                <span className="font-medium tabular-nums">
                  {"★".repeat(item.rating)}
                  <span className="text-ink-500">{"☆".repeat(5 - item.rating)}</span>
                </span>
                <span className="text-sm text-ink-700">{item.authorName ?? "Anonymous"}</span>
                <span className="text-xs text-ink-500">{item.platform}</span>
                {item.overdue
                  ? <Chip tone="danger">Reply overdue</Chip>
                  : <Chip tone="neutral">Due {formatIn(item.dueAt, user.organizationTimezone)}</Chip>}
                {item.recoveryDueAt && !item.recoveredAt && (
                  <Chip tone="warning">Call owed</Chip>
                )}
              </div>

              {item.body && <p className="mt-2 text-sm text-ink-900">{item.body}</p>}

              {/*
                The band's own reason, not a generic label. A clock with no
                why is a rule people quietly stop following.
              */}
              <p className="mt-2 text-sm text-ink-500">{item.reason}</p>

              <Respond
                id={item.id}
                callOwed={Boolean(item.recoveryDueAt && !item.recoveredAt)}
              />
            </li>
          ))}
        </ul>
      )}

      {withheld.length > 0 && (
        <section className="mt-10">
          <h2 className="text-base font-semibold">Customers who were not asked</h2>
          <p className="mt-1 max-w-2xl text-sm text-ink-700">
            Kept because &ldquo;why did this customer never get asked&rdquo;
            is a question worth answering. An open complaint and a callback
            still running are both things somebody can act on today.
          </p>
          <ul className="mt-3 flex flex-wrap gap-2">
            {withheld.map((row) => (
              <li
                key={row.reason}
                className="rounded border border-steel-200 px-3 py-1 text-sm text-ink-700"
              >
                {row.reason.replace(/_/g, " ")}: {row.count}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function Figure({ label, value, caveat }: { label: string; value: string; caveat: string }) {
  return (
    <div className="rounded-md border border-steel-200 p-4">
      <dt className="text-sm text-ink-700">{label}</dt>
      <dd className="mt-1 text-xl font-semibold tabular-nums">{value}</dd>
      {/*
        On the screen, not in a tooltip. A rating shown without its caveat is
        the thing that gets painted on the side of a truck.
      */}
      <p className="mt-2 text-xs text-ink-500">{caveat}</p>
    </div>
  );
}
