import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dashboards, NotFoundError } from "@opentradesos/api/services";
import { DashboardTile } from "@/components/DashboardTile";
import { PageHeader } from "@/components/Table";

export const dynamic = "force-dynamic";

export default async function DashboardPage({ params }: { params: Promise<{ slug: string }> }) {
  const user = await requireSetupUser();
  const { slug } = await params;
  const ctx = { actor: user.actor, db: getDb() };

  const { definition, tiles } = await dashboards.get(ctx, { slug })
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
      <PageHeader title={definition.title} />
      <p className="mt-1 text-sm text-ink-500">{definition.description}</p>

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
        {tiles.map((tile) => <DashboardTile key={tile.key} tile={tile} />)}
      </div>
    </div>
  );
}
