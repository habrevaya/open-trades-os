import { notFound } from "next/navigation";
import { requireSetupUser } from "@/lib/auth";
import { getDb } from "@/lib/db";
import { dashboards, reports, NotFoundError } from "@opentradesos/api/services";
import { can } from "@opentradesos/core";
import { DashboardTile, tileSpan } from "@/components/DashboardTile";
import { PageHeader, Empty } from "@/components/Table";
import { AddTile, TileControls, type ReportOption } from "./TileEditor";
import { DeleteDashboard } from "./DeleteDashboard";

export const dynamic = "force-dynamic";

export default async function SavedDashboardPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await requireSetupUser();
  const { id } = await params;
  const ctx = { actor: user.actor, db: getDb() };

  const { definition, tiles } = await dashboards.getSaved(ctx, { id })
    .catch((error: unknown) => {
      if (error instanceof NotFoundError) notFound();
      throw error;
    });

  const edits = can(user.actor, "report:build");

  /**
   * The stored tiles travel with every form on the page, so a change is a
   * write of the whole list rather than a read and an append. They are the
   * stored shape rather than the drawn one: a tile whose report was deleted
   * still has to survive a reorder of the tiles around it.
   */
  const stored = edits ? JSON.stringify(await storedTiles(ctx, id)) : "[]";

  const options: ReportOption[] = edits
    ? [
        ...reports.builtIn(ctx).map((report) => ({
          value: `builtIn:${report.slug}`, label: report.name, group: "Reports that ship",
        })),
        ...(await reports.list(ctx)).map((report) => ({
          value: `saved:${report.id}`, label: report.name, group: "Your reports",
        })),
      ]
    : [];

  return (
    <div className="mx-auto max-w-6xl px-4 py-8 lg:px-6">
      <PageHeader title={definition.name} />
      {definition.description && (
        <p className="mt-1 text-sm text-ink-500">{definition.description}</p>
      )}

      {edits && (
        <div className="mt-5 rounded-lg border border-steel-200 bg-canvas p-4">
          <h2 className="text-sm font-medium text-ink-700">Add a tile</h2>
          <p className="mt-0.5 text-xs text-ink-500">
            A tile points at a report rather than copying it, so correcting the
            report corrects every dashboard showing it.
          </p>
          <AddTile id={id} tiles={stored} reports={options} />
        </div>
      )}

      {tiles.length === 0 ? (
        <div className="mt-5">
          <Empty title="Nothing on it yet">
            {edits
              ? "Pick a report above and choose how to draw it."
              : "Somebody who can build reports can put something on this."}
          </Empty>
        </div>
      ) : (
        <div className="mt-5 grid grid-cols-12 items-start gap-4">
          {tiles.map((tile, index) => (
            <div key={tile.key} className={`col-span-12 ${tileSpan(tile.width)}`}>
              <DashboardTile tile={tile} />
              {edits && (
                <div className="mt-1 flex justify-end">
                  <TileControls
                    id={id} tiles={stored} tileKey={tile.key}
                    first={index === 0} last={index === tiles.length - 1}
                  />
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {edits && (
        <div className="mt-10 border-t border-steel-200 pt-5">
          <DeleteDashboard id={id} name={definition.name} />
        </div>
      )}
    </div>
  );
}

/** The stored tiles, read straight rather than through the resolver. */
async function storedTiles(
  ctx: { actor: Parameters<typeof dashboards.list>[0]["actor"]; db: ReturnType<typeof getDb> },
  id: string,
) {
  const all = await dashboards.list(ctx);
  return (all.find((row) => row.id === id)?.tiles ?? []) as unknown as dashboards.StoredTile[];
}
