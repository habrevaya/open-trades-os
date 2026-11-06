import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dashboards, NotFoundError, ConflictError } from "@opentradesos/api/services";
import { DashboardTile, tileSpan } from "@/components/DashboardTile";
import { PageHeader } from "@/components/Table";
import { can } from "@opentradesos/core";
import { DashboardActions } from "../DashboardActions";
import { DashboardDates, choiceOf, choiceQuery } from "../DashboardDates";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireSetupUser();
  const { slug } = await params;
  const query = await searchParams;
  const ctx = { actor: user.actor, db: getDb() };

  /** The days chosen on this screen, refused in words when they make no sense, and then not used. */
  let refusal: string | null = null;
  const dates = await dashboards.chosenDates(ctx, choiceOf(query)).catch((error: unknown) => {
    if (error instanceof ConflictError) { refusal = error.message; return undefined; }
    throw error;
  });
  const kept = choiceQuery(query);

  const { definition, tiles } = await dashboards.get(ctx, { slug }, dates ? { dates } : {})
    .catch((error: unknown) => {
      /**
       * A dashboard with nothing on it the reader may see is missing rather
       * than forbidden, same as every other out-of-scope read here. "You may
       * not see this" answers a question they were not allowed to ask.
       */
      if (error instanceof NotFoundError) notFound();
      throw error;
    });

  const others = dashboards.catalogue(ctx).filter((d) => d.slug !== slug);

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader
        title={definition.title}
        action={
          <DashboardActions
            pdf={`/dashboards/${slug}/pdf${dates ? kept : ""}`}
            schedule={can(user.actor, "report:build")
              ? `/reports/schedules/new?report=${encodeURIComponent(`dashboard:${slug}`)}`
              : null}
          />
        }
      />
      <p className="mt-1 text-sm text-ink-500">{definition.description}</p>
      <DashboardDates
        action={`/dashboards/${slug}`} params={query} label={dates?.label ?? null} refusal={refusal}
        followers={tiles.filter((t) => t.followsDates).length}
        keepsOwn={dates ? tiles.filter((t) => !t.followsDates && !t.problem).map((t) => t.title) : []}
        editable={false}
      />

      {/*
        Named as links rather than left as bare words. The first version was
        a row of titles under the description, which reads as a subtitle
        somebody forgot to finish.
      */}
      {others.length > 0 && (
        <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-ink-500">
          <span>Also:</span>
          {others.map((other) => (
            <a key={other.slug} href={`/dashboards/${other.slug}`}
               className="rounded border border-steel-200 bg-canvas px-2 py-1 text-ink-700 hover:bg-steel-100">
              {other.title}
            </a>
          ))}
        </p>
      )}

      {/*
        Twelve columns on a desktop and one on a phone. The widths in the
        definition are a layout for a wide screen; stacking is the only thing
        that works on a narrow one, and half a tile is not a tile.
      */}
      {/*
        `items-start`, so a tile is as tall as what is on it. Stretching
        makes every tile in a row as tall as the tallest, and a headline
        number sitting in the top corner of a card with four inches of
        nothing under it reads as a tile that failed to load the rest.
      */}
      <div className="mt-5 grid grid-cols-12 items-start gap-4">
        {tiles.map((tile) => (
          <div key={tile.key} className={`col-span-12 ${tileSpan(tile.width)}`}>
            <DashboardTile tile={tile} back={`/dashboards/${slug}${dates ? kept : ""}`} />
          </div>
        ))}
      </div>
    </div>
  );
}
