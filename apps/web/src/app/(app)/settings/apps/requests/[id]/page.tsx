import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { apps } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { Chip } from "@opentradesos/ui";
import { Empty, PageHeader } from "@/components/Table";
import { standing } from "../../AppsView";
import { Decide } from "../../Decide";

export const dynamic = "force-dynamic";

/**
 * AN APPLICATION ASKING TO BE LET IN
 *
 * The page an app sends somebody at the company to. It says who the app says
 * it is, where it came from, and every permission it asks for in the words
 * the catalogue already uses, with the ones that expose money marked and the
 * ones the person looking does not hold named. The answer is yes to all of
 * it, yes to part of it, or no. Nothing can be added, because approving
 * something the app never asked for, under its name, would be a grant nobody
 * requested. Once approved, what was left out stays listed here.
 *
 * Whether the person may approve it is decided by the service, through the
 * same function as installing by hand, and the page only reads the answer.
 */
export default async function AppRequestPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };

  if (!can(user.actor, "settings:read")) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
        <PageHeader title="An application is asking to be let in" />
        <Empty title="Settings are not part of your access">
          Ask an owner to open this page. Nothing is granted until somebody who may approve it does.
        </Empty>
      </div>
    );
  }

  const review = await apps.review(ctx, { id }).catch((error: Error) => {
    if (error.name === "NotFoundError") notFound();
    throw error;
  });
  const { app } = review;
  const state = standing(app);

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 lg:px-6">
      <p className="text-sm"><a href="/settings/apps" className="text-blue-600 underline underline-offset-4">Applications</a></p>
      <PageHeader title={`${app.name} is asking to be let in`} />
      <p className="mt-2 flex flex-wrap items-center gap-2 text-sm text-ink-700">
        <Chip tone={state.tone}>{state.label}</Chip>
        {app.publisher ? <span>Made by {app.publisher}</span> : <span>No publisher named</span>}
        {app.homepageUrl ? <span className="font-mono text-xs">{app.homepageUrl}</span> : null}
      </p>
      {app.description ? (
        <blockquote className="mt-3 border-l-2 border-steel-300 pl-3 text-sm text-ink-700">
          {app.description}
          <span className="mt-1 block text-xs text-ink-500">In the app&apos;s own words.</span>
        </blockquote>
      ) : null}
      <p className="mt-3 text-sm text-ink-500">
        {app.request?.requestedFrom ? `Asked from ${app.request.requestedFrom}. ` : ""}
        {app.request?.returnsTo ? `After you decide you are sent back to ${app.request.returnsTo}. ` : ""}
        {app.request?.expiresAt ? `The request ends on ${app.request.expiresAt.slice(0, 10)} if nobody answers.` : ""}
      </p>

      <h2 className="mt-6 text-base font-semibold">It asks to</h2>
      <ul className="mt-2 divide-y divide-steel-200 rounded-md border border-steel-200" aria-label="What it asks for">
        {review.asks.map((ask) => (
          <li key={ask.permission} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
            <span>
              {ask.label}
              <span className="ml-2 font-mono text-xs text-ink-500">{ask.permission}</span>
            </span>
            <span className="flex gap-1.5">
              {ask.sensitive ? <Chip tone="warning">Shows money</Chip> : null}
              {ask.granted === false ? <Chip tone="neutral">Left out</Chip> : null}
              {ask.granted === null && !ask.held ? <Chip tone="danger">You do not hold this</Chip> : null}
            </span>
          </li>
        ))}
      </ul>

      <h2 className="mt-6 text-base font-semibold">Which records it reaches</h2>
      {review.reach.length === 0 ? (
        <p className="mt-1 text-sm text-ink-500">
          It names no record scope, so every list it reads comes back empty: an app is not a technician, and
          the narrowest default matches nothing.
        </p>
      ) : (
        <ul className="mt-1 text-sm text-ink-700">
          {review.reach.map((item) => (
            <li key={item.resource}>
              {item.resource}: {item.scope === "all" ? "everything" : item.scope}
              {item.widerThanYours ? <span className="ml-2 text-red-600">wider than your own</span> : null}
            </li>
          ))}
        </ul>
      )}

      {app.status === "pending" && review.blockedBecause ? (
        <p role="alert" className="mt-6 text-sm text-red-600">{review.blockedBecause}</p>
      ) : null}
      {app.status === "active" || app.status === "refused" ? (
        <div className="mt-6 rounded-md border border-steel-200 bg-canvas p-4">
          <p role="status" className="text-sm font-medium">
            {app.status === "active"
              ? review.leftOut.length > 0
                ? `Approved in part. ${app.name} collects its credential itself, once, and is told what was left out: `
                  + `${review.leftOut.map((l) => l.label.toLowerCase()).join(", ")}.`
                : `Approved. ${app.name} collects its credential itself, once, with the secret it was given when it asked.`
              : `Refused. ${app.name} holds nothing and is told no when it asks.`}
          </p>
          {review.returnTo ? (
            <p className="mt-2 text-sm">
              <a href={review.returnTo} className="text-blue-600 underline underline-offset-4">
                Go back to {app.request?.returnsTo ?? "the app"}
              </a>
            </p>
          ) : null}
        </div>
      ) : null}
      {app.status === "pending" && !app.request?.expired && can(user.actor, "integration:write") ? (
        <Decide id={app.id} name={app.name} approvable={review.approvable}
                asks={review.asks.map(({ permission, label, held }) => ({ permission, label, held }))} />
      ) : null}
    </div>
  );
}
