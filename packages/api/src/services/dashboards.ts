import { and, eq, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, permissionsFor, dashboard, pdf, reporting } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, timezoneOf, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import { CATALOGUE } from "./report-catalogue";
import { catalogueFor } from "./report-company";
import { BUILT_IN } from "./report-built-in";
import { BUILT_IN_DASHBOARDS, type BuiltInDashboard } from "./dashboard-built-in";
import { run, type ReportResult } from "./reports";
import { companyOf, RENDER, type PdfFile } from "./documents";

export { BUILT_IN_DASHBOARDS };

/**
 * RUNNING A DASHBOARD
 *
 * Every tile goes through `reports.run`, which is the point. A dashboard has
 * no query of its own, so scope, permission and field redaction cannot be
 * weaker here than on the reports screen, and a tile cannot drift into
 * disagreeing with the report behind it about what a number means.
 *
 * The tiles run in parallel. They are independent reads inside one request,
 * and a money dashboard with six tiles run one after another is a screen
 * somebody watches assemble itself.
 */

export interface TileResult {
  key: string;
  title: string;
  caption?: string;
  kind: dashboard.TileKind;
  width: number;
  /** The measure being drawn, resolved. */
  measure?: { key: string; label: string; type: string };
  /** The dimension it is drawn against, for anything that is not a number. */
  dimension?: { key: string; label: string; type: string; sortPrefix?: boolean };
  /**
   * The report's second grouping, which each bar or column is cut by, and how
   * the parts are set out. Only on a tile that is broken down.
   */
  breakdown?: {
    key: string; label: string; type: string; sortPrefix?: boolean;
    arrange: reporting.ChartArrangement;
  };
  /**
   * Whether the measure drawn adds up (a count or a sum), which is what lets
   * the chart stack it. Said by the catalogue, not guessed by the screen.
   */
  additive?: boolean;
  result?: ReportResult;
  /**
   * The report the tile drew, so a bar or a number can open the records
   * behind it. Carried on the result rather than looked up again by the
   * screen, because a saved dashboard's tile points at a report somebody may
   * have edited since, and the drill has to open what was DRAWN.
   */
  definition?: reporting.ReportDefinition;
  /**
   * Why this tile has nothing on it.
   *
   * Only ever a broken tile. A tile the reader may not run is gone from the
   * list entirely, the same way the navigation drops a link somebody cannot
   * open: a gap reading "you need report.financial:read" teaches a dispatcher
   * the shape of what is being kept from them.
   */
  problem?: string;
}

export function catalogue(ctx: ServiceContext): BuiltInDashboard[] {
  const held = permissionsFor(ctx.actor);
  return BUILT_IN_DASHBOARDS.filter((definition) => {
    const decision = dashboard.resolveDashboard(definition, CATALOGUE, held);
    /**
     * A dashboard with nothing left on it is not listed. The money dashboard
     * is every tile behind one permission, so for a dispatcher it is an empty
     * page with a title, and a link to an empty page is worse than no link.
     */
    return decision.tiles.length > 0;
  });
}

/**
 * How a dashboard's tiles are run.
 *
 * In parallel on a screen, where each tile has a connection of its own from
 * the pool. One after another inside a transaction somebody else opened (a
 * delivery, which claims its occurrence first and sends in the same
 * transaction): every tile then shares one connection, and savepoints opened
 * on it at the same moment would interleave.
 */
export interface DrawOptions {
  inOrder?: boolean | undefined;
}

async function drawAll(
  ctx: ServiceContext, entries: dashboard.TileDecision[], options: DrawOptions,
): Promise<TileResult[]> {
  if (!options.inOrder) return Promise.all(entries.map((entry) => drawTile(ctx, entry)));
  const drawn: TileResult[] = [];
  for (const entry of entries) drawn.push(await drawTile(ctx, entry));
  return drawn;
}

export async function get(
  ctx: ServiceContext, input: { slug: string }, options: DrawOptions = {},
): Promise<{ definition: BuiltInDashboard; tiles: TileResult[]; leftOut: string[] }> {
  const found = BUILT_IN_DASHBOARDS.find((d) => d.slug === input.slug);
  if (!found) throw new NotFoundError("Dashboard");

  const held = permissionsFor(ctx.actor);
  const decision = dashboard.resolveDashboard(found, CATALOGUE, held);
  /**
   * Nothing visible reads as missing rather than forbidden, the same as any
   * other out-of-scope read in this product. "You may not see this dashboard"
   * answers a question the caller was not allowed to ask.
   */
  if (decision.tiles.length === 0) throw new NotFoundError("Dashboard");

  const tiles = await drawAll(ctx, decision.tiles, options);
  return { definition: found, tiles, leftOut: decision.hidden.map((tile) => tile.title) };
}

/**
 * One tile, run.
 *
 * Shared by the dashboards that ship and the ones people assemble, because
 * the two must not be able to render differently. A saved dashboard that
 * looked like a slightly worse version of a built-in one would make
 * "copy this and change it" the wrong move, which is the move the whole
 * feature is for.
 */
async function drawTile(
  ctx: ServiceContext, entry: dashboard.TileDecision,
): Promise<TileResult> {
  const base = {
    key: entry.tile.key,
    title: entry.tile.title,
    kind: entry.tile.kind,
    width: entry.tile.width,
    ...(entry.tile.caption ? { caption: entry.tile.caption } : {}),
  };

  if (!entry.ok) {
    // `hidden` tiles never reach here; `resolveDashboard` drops them.
    return { ...base, problem: "detail" in entry ? entry.detail : "Unavailable." };
  }

  const measure = entry.report.measures.find((m) => m.key === entry.measure)!;
  const dimension = entry.report.dimensions[0];
  /** `checkShape` has already held a tile broken down to exactly two groupings. */
  const split = entry.tile.breakdown ? entry.report.dimensions[1] : undefined;

  try {
    const result = await run(ctx, entry.tile.definition);
    return {
      ...base,
      measure: { key: measure.key, label: measure.label, type: measure.type },
      ...(dimension
        ? {
            dimension: {
              key: dimension.key, label: dimension.label, type: dimension.type,
              ...(dimension.sortPrefix ? { sortPrefix: true } : {}),
            },
          }
        : {}),
      ...(split && entry.tile.breakdown
        ? {
            breakdown: {
              key: split.key, label: split.label, type: split.type,
              ...(split.sortPrefix ? { sortPrefix: true } : {}),
              arrange: entry.tile.breakdown,
            },
          }
        : {}),
      additive: dashboard.addsUp(measure.kind),
      result,
      definition: entry.tile.definition,
    };
  } catch (error) {
    /**
     * One tile failing does not take the page down. A dashboard is six
     * independent questions, and five answers plus one stated failure is
     * more use than an error page, particularly when the failure is a
     * report somebody edited and nobody has opened since.
     */
    return { ...base, problem: error instanceof Error ? error.message : "This tile failed to run." };
  }
}


// ---------------------------------------------------------------------------
// Dashboards somebody assembled
// ---------------------------------------------------------------------------

/**
 * A TILE POINTS AT A REPORT. IT DOES NOT COPY ONE.
 *
 * This is the whole design of a saved dashboard, and the thing worth being
 * strict about. A tile holding its own copy of a definition keeps showing
 * last quarter's version of a number after somebody corrects the report, and
 * the reader has no way to tell which of the two is right.
 *
 * So a stored tile is a pointer plus a shape: which report, drawn how, how
 * wide. No filters, no date range, no overrides, because every one of those
 * is a way for a tile and its report to end up disagreeing.
 */
export interface StoredTile {
  key: string;
  kind: dashboard.TileKind;
  width: 3 | 6 | 12;
  /** Exactly one of these. A saved report, or one that ships. */
  reportId?: string;
  builtIn?: string;
  /** Overrides the report's own name on this dashboard. Optional. */
  title?: string;
  caption?: string;
  /**
   * Cut each bar or column by the report's second grouping, stacked or side
   * by side. How the tile is drawn, like `kind`, and so stored on the tile
   * rather than on the report it points at.
   */
  breakdown?: reporting.ChartArrangement;
}

const WIDTHS = [3, 6, 12] as const;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KINDS: dashboard.TileKind[] = ["number", "bars", "trend"];
const BREAKDOWNS: reporting.ChartArrangement[] = ["stacked", "grouped"];

/** What a stored tile resolves to: a name and a definition, or nothing. */
interface Source {
  title: string;
  definition: reporting.ReportDefinition;
}

async function sourceFor(tx: Database, tile: StoredTile): Promise<Source | null> {
  if (tile.builtIn !== undefined) {
    const found = BUILT_IN.find((r) => r.slug === tile.builtIn);
    return found ? { title: found.name, definition: found.definition } : null;
  }
  if (tile.reportId === undefined) return null;

  const [saved] = await tx.select().from(schema.report)
    .where(and(eq(schema.report.id, tile.reportId), isNull(schema.report.deletedAt)))
    .limit(1);
  return saved
    ? { title: saved.name, definition: saved.definition as unknown as reporting.ReportDefinition }
    : null;
}

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "report:read", async (tx) =>
    tx.select().from(schema.dashboard)
      .where(isNull(schema.dashboard.deletedAt))
      .orderBy(schema.dashboard.name));
}

export async function create(
  ctx: ServiceContext, input: { name: string; description?: string },
) {
  const name = input.name.trim();
  if (name === "") throw new ConflictError("A dashboard needs a name");

  return guardedWrite(ctx, "report:build", async (tx) => {
    /** The same collision as a report's name, refused the same way. */
    const [created] = await refusingDuplicate(
      "dashboard_name_idx",
      `There is already a dashboard called "${name}".`,
      () => tx.insert(schema.dashboard).values({
        organizationId: ctx.actor.organizationId,
        name,
        description: input.description?.trim() || null,
        // Empty, and it opens on an empty state telling you to add something.
        // A dashboard that arrived pre-filled would be somebody else's idea of
        // what this one is for.
        tiles: [],
        createdByUserId: ctx.actor.userId,
      }).returning(),
    );

    await audit(tx, ctx, "dashboard.created", "dashboard", created!.id, null, created);
    return created!;
  });
}

export async function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "report:build", async (tx) => {
    const [before] = await tx.select().from(schema.dashboard)
      .where(and(eq(schema.dashboard.id, input.id), isNull(schema.dashboard.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Dashboard");

    await tx.update(schema.dashboard).set({ deletedAt: new Date() })
      .where(eq(schema.dashboard.id, input.id));
    await audit(tx, ctx, "dashboard.deleted", "dashboard", input.id, before, null);
  });
}

/**
 * Add a tile, or move or remove one. Always a write of the whole list.
 *
 * The order IS the data, so it is stored as an array and written whole. A
 * sort column on rows is what ends up with two tiles both claiming position
 * three, and a dashboard that renders in a different order each time is one
 * nobody trusts.
 */
export async function setTiles(
  ctx: ServiceContext, input: { id: string; tiles: StoredTile[] },
) {
  return guardedWrite(ctx, "report:build", async (tx) => {
    const [before] = await tx.select().from(schema.dashboard)
      .where(and(eq(schema.dashboard.id, input.id), isNull(schema.dashboard.deletedAt))).limit(1);
    if (!before) throw new NotFoundError("Dashboard");

    const seen = new Set<string>();
    for (const tile of input.tiles) {
      if ((tile.reportId === undefined) === (tile.builtIn === undefined)) {
        /**
         * Exactly one source. Neither is a tile that draws nothing; both is a
         * tile whose meaning depends on which branch the reader happens to
         * check first, and the two can say different things.
         */
        throw new ConflictError("A tile shows one report, either a saved one or one that ships.");
      }
      if (!KINDS.includes(tile.kind)) {
        throw new ConflictError(`There is no tile shape called "${tile.kind}".`);
      }
      if (!WIDTHS.includes(tile.width as 3 | 6 | 12)) {
        throw new ConflictError(`A tile is 3, 6 or 12 columns wide, not ${tile.width}.`);
      }
      if (tile.breakdown !== undefined && !BREAKDOWNS.includes(tile.breakdown)) {
        throw new ConflictError(`A tile is broken down stacked or side by side, not "${String(tile.breakdown)}".`);
      }
      if (seen.has(tile.key)) {
        // Keys address a tile for removal and reordering. Two tiles with one
        // key means a remove takes both of them.
        throw new ConflictError("Two tiles share a key.");
      }
      seen.add(tile.key);

      const source = await sourceFor(tx, tile);
      if (!source) {
        /**
         * Refused at save rather than drawn as a broken tile later. A tile
         * pointing at a report that does not exist is a typo or a deleted
         * report, and both are worth hearing about now.
         */
        throw new ConflictError("That tile points at a report that does not exist.");
      }

      /** The company's catalogue, so a tile on a saved report grouped by a custom field is checked against it. */
      const dataset = (await catalogueFor(tx, ctx.actor.organizationId)).find((d) => d.key === source.definition.dataset);
      if (!dataset) throw new ConflictError("That tile's report is about something this company no longer has.");
      const decision = dashboard.checkShape(
        {
          key: tile.key, title: tile.title ?? source.title, kind: tile.kind, width: tile.width, definition: source.definition,
          ...(tile.breakdown ? { breakdown: tile.breakdown } : {}),
        },
        dataset,
      );
      if (!decision.ok) throw new ConflictError(decision.detail);
    }

    const [after] = await tx.update(schema.dashboard)
      .set({ tiles: input.tiles as unknown as Record<string, unknown>[], updatedAt: new Date() })
      .where(eq(schema.dashboard.id, input.id))
      .returning();

    await audit(tx, ctx, "dashboard.updated", "dashboard", input.id, before, after);
    return after!;
  });
}

/**
 * Run a saved dashboard.
 *
 * Its tiles are turned into definitions here and then handed to exactly the
 * same resolver the built-in ones go through, so a saved dashboard and a
 * shipped one cannot behave differently. The lookup lives here rather than in
 * core because core takes data and returns a decision, and a database read is
 * neither.
 */
export async function getSaved(
  ctx: ServiceContext, input: { id: string }, options: DrawOptions = {},
): Promise<{ definition: { id: string; name: string; description: string | null }; tiles: TileResult[]; leftOut: string[] }> {
  const resolved = await inTenant(ctx, (tx) => resolveSaved(tx, ctx.actor, input.id));
  if (!resolved) throw new NotFoundError("Dashboard");
  const { saved, stored, decision, missing } = resolved;

  const drawn = await drawAll(ctx, decision.tiles, options);
  /**
   * The missing ones go back where they were, by key, rather than on the
   * end. A tile that moves to the bottom of the page the day its report is
   * deleted takes the rest of the layout with it.
   */
  const byKey = new Map([...drawn, ...missing].map((tile) => [tile.key, tile]));
  const tiles = stored.map((tile) => byKey.get(tile.key)).filter((tile) => tile !== undefined);

  return {
    definition: { id: saved.id, name: saved.name, description: saved.description },
    tiles,
    leftOut: decision.hidden.map((tile) => tile.title),
  };
}

/**
 * A saved dashboard's tiles turned into definitions and resolved for this
 * actor, without running any of them. Shared by the screen and by the check
 * a schedule makes of whether somebody could open the dashboard at all.
 */
async function resolveSaved(tx: Database, actor: ServiceContext["actor"], id: string) {
  // An id off a URL that is not one is a dashboard that does not exist, not a database error.
  if (!UUID.test(id)) return null;
  const [saved] = await tx.select().from(schema.dashboard)
    .where(and(eq(schema.dashboard.id, id), isNull(schema.dashboard.deletedAt))).limit(1);
  if (!saved) return null;

  const stored = saved.tiles as unknown as StoredTile[];
  const sources: (Source | null)[] = [];
  for (const tile of stored) sources.push(await sourceFor(tx, tile));
  const companyCatalogue = await catalogueFor(tx, actor.organizationId);

  const resolvable: dashboard.Tile[] = [];
  const missing: TileResult[] = [];
  for (const [index, tile] of stored.entries()) {
    const source = sources[index];
    if (!source) {
      /**
       * The report was deleted after the tile was added. Said in place
       * rather than dropped: the tile is somebody's, they put it there on
       * purpose, and a dashboard that silently loses one is a dashboard
       * that has quietly stopped answering a question.
       */
      missing.push({
        key: tile.key, title: tile.title ?? "A deleted report", kind: tile.kind, width: tile.width,
        problem: "The report this tile showed has been deleted.",
      });
      continue;
    }
    resolvable.push({
      key: tile.key,
      title: tile.title ?? source.title,
      kind: tile.kind,
      width: tile.width,
      definition: source.definition,
      ...(tile.caption ? { caption: tile.caption } : {}),
      ...(tile.breakdown ? { breakdown: tile.breakdown } : {}),
    });
  }

  const decision = dashboard.resolveDashboard(
    { key: saved.id, title: saved.name, description: saved.description ?? "", tiles: resolvable },
    companyCatalogue,
    permissionsFor(actor),
  );
  return { saved, stored, decision, missing };
}

// ---------------------------------------------------------------------------
// A whole dashboard as one PDF
// ---------------------------------------------------------------------------

/**
 * A dashboard, by what a schedule or a link names: one that ships, by slug,
 * or one somebody assembled, by id.
 */
export type DashboardSource = { builtInDashboard: string } | { dashboardId: string };

/** A dashboard a schedule points at, as it is now, or null when it has gone. */
export async function dashboardSourceOf(tx: Database, source: DashboardSource): Promise<{
  name: string;
  description: string | null;
  /** Where it lives in the app. */
  path: string;
} | null> {
  if ("builtInDashboard" in source) {
    const found = BUILT_IN_DASHBOARDS.find((d) => d.slug === source.builtInDashboard);
    return found ? { name: found.title, description: found.description, path: `/dashboards/${found.slug}` } : null;
  }
  if (!UUID.test(source.dashboardId)) return null;
  const [saved] = await tx.select().from(schema.dashboard)
    .where(and(eq(schema.dashboard.id, source.dashboardId), isNull(schema.dashboard.deletedAt))).limit(1);
  return saved ? { name: saved.name, description: saved.description, path: `/dashboards/saved/${saved.id}` } : null;
}

export interface DrawnDashboard {
  name: string;
  description: string | null;
  tiles: TileResult[];
  /** The titles of the tiles this reader may not see, in layout order. */
  leftOut: string[];
}

/**
 * A dashboard drawn as this reader sees it, through exactly the path the
 * screen takes (`get` or `getSaved`), so a printed copy and the screen cannot
 * disagree about a tile. NotFound when the reader may see none of it, as the
 * screen says.
 */
export async function drawDashboard(
  ctx: ServiceContext, source: DashboardSource, options: DrawOptions = {},
): Promise<DrawnDashboard> {
  if ("builtInDashboard" in source) {
    const drawn = await get(ctx, { slug: source.builtInDashboard }, options);
    return { name: drawn.definition.title, description: drawn.definition.description, tiles: drawn.tiles, leftOut: drawn.leftOut };
  }
  const drawn = await getSaved(ctx, { id: source.dashboardId }, options);
  /**
   * A saved dashboard with tiles on it and none the reader may see is gone
   * for them, as a built-in one is: a PDF of a title and a list of what they
   * may not see is the same disclosure the screen avoids.
   */
  if (drawn.tiles.length === 0 && drawn.leftOut.length > 0) throw new NotFoundError("Dashboard");
  return { name: drawn.definition.name, description: drawn.definition.description, tiles: drawn.tiles, leftOut: drawn.leftOut };
}

/**
 * Whether this person could open this dashboard and see something on it,
 * decided without running a tile: null when they could, the reason in words
 * when they could not. The question a schedule asks of each person it would
 * email, at its save and again on the day it goes.
 */
export async function couldOpen(
  tx: Database, actor: ServiceContext["actor"], source: DashboardSource,
): Promise<string | null> {
  const held = permissionsFor(actor);
  if (!held.has("report:read")) return "may not read reports";
  if ("builtInDashboard" in source) {
    const found = BUILT_IN_DASHBOARDS.find((d) => d.slug === source.builtInDashboard);
    if (!found) return "cannot open a dashboard that does not exist";
    const decision = dashboard.resolveDashboard(found, CATALOGUE, held);
    return decision.tiles.length > 0 ? null : "may not see anything on this dashboard";
  }
  const resolved = await resolveSaved(tx, actor, source.dashboardId);
  if (!resolved) return "cannot open a dashboard that has been deleted";
  /** The same line `drawDashboard` draws: refused only when something is there and none of it is theirs. */
  const { decision } = resolved;
  return decision.tiles.length === 0 && decision.hidden.length > 0 ? "may not see anything on this dashboard" : null;
}

const NUMBER = new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 });

/**
 * One tile as the PDF prints it: a number tile's number as the screen shows
 * it, a chart tile's chart planned by `chartFor` with the same choices the
 * screen's tile makes (columns over time, cut by the second grouping when the
 * tile is broken down), and its rows for the table under the chart.
 */
export function printedTile(tile: TileResult): pdf.DashboardPdfTile {
  const base = { title: tile.title, caption: tile.caption ?? null };
  if (tile.problem) return { ...base, note: tile.problem };
  const measure = tile.measure;
  const rows = tile.result?.rows ?? [];
  if (!measure || !tile.result) return { ...base, note: "Nothing to show yet." };

  if (tile.kind === "number") {
    const value = rows[0]?.[measure.key] ?? (measure.type === "money" ? "0" : 0);
    const figure = value === null
      ? "None"
      : measure.type === "money" ? pdf.reportCell({ type: "money" }, value) : NUMBER.format(Number(value));
    return { ...base, figure };
  }
  if (rows.length === 0) return { ...base, note: "Nothing to show yet." };

  const columns = [
    ...(tile.dimension ? [{ ...tile.dimension, role: "dimension" as const }] : []),
    ...(tile.breakdown
      ? [{
          key: tile.breakdown.key, label: tile.breakdown.label, type: tile.breakdown.type, role: "dimension" as const,
          ...(tile.breakdown.sortPrefix ? { sortPrefix: true } : {}),
        }]
      : []),
    { key: measure.key, label: measure.label, type: measure.type, role: "measure" as const },
  ];
  const decision = reporting.chartFor({ columns, rows }, {
    measure: measure.key,
    prefer: "columns",
    split: tile.breakdown?.key,
    arrange: tile.breakdown?.arrange,
    additive: () => tile.additive ?? false,
  });
  return {
    ...base,
    chart: decision.ok ? decision.plan : null,
    ...(decision.ok ? {} : { note: decision.reason }),
    table: { columns, rows },
  };
}

/** A dashboard as a file name: its name, and the day it was drawn. */
export function dashboardFilename(name: string, day: string): string {
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "dashboard";
  return `${slug}-${day}.pdf`;
}

/** When a dashboard was drawn, in the company's own time: "October 18, 2026 at 7:00 AM". */
export function asOfWords(at: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", { dateStyle: "long", timeStyle: "short", timeZone: timezone }).format(at);
}

/** A drawn dashboard as its PDF. Nothing here reads anything: the drawing did. */
export function dashboardFile(input: {
  company: pdf.Company;
  drawn: DrawnDashboard;
  ranAs: string | null;
  at: Date;
  timezone: string;
}): PdfFile {
  return {
    filename: dashboardFilename(input.drawn.name, reporting.deliveryDay(input.at, input.timezone)),
    bytes: pdf.dashboardPdf({
      company: input.company,
      name: input.drawn.name,
      description: input.drawn.description,
      asOf: asOfWords(input.at, input.timezone),
      ranAs: input.ranAs,
      tiles: input.drawn.tiles.map(printedTile),
      leftOut: input.drawn.leftOut,
      generatedAt: input.at,
    }, RENDER),
  };
}

/**
 * THE DASHBOARD AS ONE PDF, for the person looking at it.
 *
 * Every tile they may see, drawn as they see it on the screen; the tiles they
 * may not see named at the end of the file and never drawn. `report:read`,
 * because a dashboard is a page of reports and the dashboards list asks for
 * it; each tile then asks for what its own report needs, as on the screen.
 */
export async function dashboardPdf(ctx: ServiceContext, source: DashboardSource): Promise<PdfFile> {
  assertCan(ctx.actor, "report:read");
  const drawn = await drawDashboard(ctx, source);
  return inTenant(ctx, async (tx) => {
    const timezone = await timezoneOf(tx, ctx.actor.organizationId);
    const company = await companyOf(tx, ctx.actor.organizationId);
    const [person] = await tx.execute<{ name: string | null; email: string }>(
      sql`select name, email from app.organization_people() where user_id = ${ctx.actor.userId}`,
    );
    return dashboardFile({
      company, drawn, ranAs: person ? person.name ?? person.email : null, at: new Date(), timezone,
    });
  });
}
