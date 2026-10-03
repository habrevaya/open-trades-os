import { sql } from "drizzle-orm";
import type { Database } from "@opentradesos/db";
import type { ServiceContext } from "../services/context";

/**
 * A DRY RUN: DO IT, LOOK, AND TAKE IT BACK
 *
 * A bulk operation is the one an agent most needs to check before it acts:
 * "rename this tag" reaches every customer carrying it, "move these jobs"
 * reaches five hundred jobs, and a model reasoning about what that means is a
 * model guessing. So a route that declares `dryRun` can be asked what it would
 * change, and the answer is not a prediction. The route runs, exactly as it
 * would, inside a transaction that is then rolled back, and what comes back is
 * what it would have returned and what it actually wrote before the rollback:
 * rows by table, from Postgres's own per transaction counters, and the audit
 * lines, which name each record and what it became.
 *
 * WHY RUN IT RATHER THAN DESCRIBE IT. A second code path that predicts what a
 * route does is a second implementation of the route, and the first time the
 * route changes and the prediction does not, the preview lies. Running the
 * real code makes that impossible: the preview IS the route.
 *
 * WHY ONLY DECLARED ROUTES. Rolling back undoes the database and nothing else.
 * Every route marked `dryRun` in the contracts writes only to the database; a
 * route that charges a card or sends a text is never marked, and a dry run
 * asked of one is refused rather than performed.
 */

export const DRY_RUN_HEADER = "x-otos-dry-run";

/** Whether a request asks for a dry run. Absent, empty or "false" is a real run. */
export function wantsDryRun(request: Request): boolean {
  const value = request.headers.get(DRY_RUN_HEADER)?.trim().toLowerCase() ?? "";
  return value === "1" || value === "true" || value === "yes";
}

export interface DryRunReport {
  dryRun: true;
  /** What the route would have answered. */
  wouldReturn: unknown;
  /** Rows the route wrote before the rollback, per table. Nothing here was kept. */
  tables: Array<{ table: string; inserted: number; updated: number; deleted: number }>;
  /** The audit lines it would have left, at most `AUDIT_LIMIT` of them. */
  audit: Array<{ action: string; entityType: string; entityId: string | null }>;
  /** How many audit lines there were in all, so a cut list says it was cut. */
  auditTotal: number;
}

const AUDIT_LIMIT = 200;

class Rollback extends Error {
  constructor(readonly report: DryRunReport) {
    super("dry run rolled back");
  }
}

export async function dryRun(
  ctx: ServiceContext,
  run: (ctx: ServiceContext) => Promise<unknown>,
): Promise<DryRunReport> {
  try {
    await ctx.db.transaction(async (tx) => {
      const db = tx as unknown as Database;
      /**
       * The service opens its own transaction inside this one, which Postgres
       * makes a savepoint, so the route behaves exactly as it does for real:
       * the same role, the same tenant, the same row level security.
       */
      const wouldReturn = await run({ ...ctx, db });

      const tables = await db.execute<{ relname: string; ins: number; upd: number; del: number }>(sql`
        select relname, n_tup_ins::int as ins, n_tup_upd::int as upd, n_tup_del::int as del
        from pg_stat_xact_user_tables
        where schemaname = 'public' and (n_tup_ins + n_tup_upd + n_tup_del) > 0
        order by relname`);

      /**
       * `now()` is the start of this transaction, and every audit line written
       * inside it carries that time, so this finds exactly the lines the
       * route wrote. The organization is named explicitly as well, because a
       * route that never entered its tenant would leave none to find anyway.
       */
      const audit = await db.execute<{ action: string; entity_type: string; entity_id: string | null }>(sql`
        select action, entity_type, entity_id from public.audit_log
        where organization_id = ${ctx.actor.organizationId} and created_at = now()`);

      throw new Rollback({
        dryRun: true,
        wouldReturn,
        tables: tables.map((row) => ({
          table: row.relname, inserted: Number(row.ins), updated: Number(row.upd), deleted: Number(row.del),
        })),
        audit: audit.slice(0, AUDIT_LIMIT).map((row) => ({
          action: row.action, entityType: row.entity_type, entityId: row.entity_id,
        })),
        auditTotal: audit.length,
      });
    });
  } catch (error) {
    if (error instanceof Rollback) return error.report;
    throw error;
  }
  /* The transaction above always throws; reaching here would mean it committed. */
  throw new Error("A dry run reached the end of its transaction without rolling back.");
}
