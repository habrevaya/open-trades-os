import { sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { events, time, SYSTEM_USER_ID, type Actor } from "@opentradesos/core";
import { inTenant, timezoneOf, type ServiceContext } from "./context";
import { emit } from "./events";
import { fire, type RunSummary } from "./workflow-runner";
import { within } from "./workflow-schedule";

/**
 * WORK THAT HAS BEEN SITTING THERE TOO LONG
 *
 * The third trigger kind, and the one the other two cannot express. An event
 * fires when something happens; a schedule fires on a clock. Neither of them
 * fires when something has NOT happened, and "the estimate nobody answered"
 * is the single most valuable automation a contractor can have, because it is
 * money that quietly did not arrive and leaves no record that it was
 * supposed to.
 *
 * `trigger_kind` has had `dwell` in it since the first migration and nothing
 * fired one.
 *
 * THE SHAPES ARE DECLARED HERE, NOT WRITTEN BY THE WORKFLOW. A workflow says
 * "estimates nobody answered, after five days", and this file owns the query.
 * The alternative is letting a workflow name a table and a column, which is
 * the same argument as the report catalogue and the workflow conditions: a
 * builder in a product people self host must not be a way to write a query.
 *
 * EVERY SHAPE NEEDS A TIMESTAMP THAT MEANS "ENTERED THIS STATE". `updated_at`
 * is the tempting one and it is wrong: anything that touches the row resets
 * it, so an estimate somebody opened on day four looks one day old, and the
 * chase never fires. Only shapes with a real column are offered.
 */

export interface DwellShape {
  key: string;
  label: string;
  /** The question, in the words somebody would ask it. */
  question: string;
  entityType: string;
  /**
   * Written here, never assembled from input. A shape that counts SINCE takes
   * one parameter, `$cutoff`; a shape that counts UNTIL takes `$today` and
   * `$horizon`, the company's dates today and that many days ahead.
   */
  sql: string;
  /**
   * Which way the days are counted. `since` (the default) fires once a record
   * has sat in a state that long. `until` fires that many days BEFORE a date
   * on the record, which is the shape of everything that is about to happen
   * rather than everything that did not: a warranty running out.
   */
  counts?: "since" | "until" | undefined;
  /**
   * The event this raises, which is what a workflow's conditions see.
   *
   * From the catalogue rather than a string, so a shape cannot raise an
   * event name nothing can subscribe to. Dwell events are marked
   * unsubscribable there: they carry their own trigger kind, and offering
   * them as an event subscription produces a workflow waiting on a sweep
   * nobody configured.
   */
  eventName: events.EventName;
}

export const SHAPES: DwellShape[] = [
  {
    key: "estimate_unanswered",
    label: "An estimate nobody answered",
    question: "Which quotes have gone quiet?",
    entityType: "estimate",
    eventName: "estimate.dwelling",
    /**
     * `sent_at`, not `updated_at`. A customer opening the estimate sets
     * `viewed_at` and touches the row, and dwelling on `updated_at` would
     * reset the clock every time they looked at it without deciding, which
     * is exactly the customer worth chasing.
     */
    sql: `select e.id, e.customer_id, e.number, e.sent_at as since
          from public.estimate e
          where e.status in ('sent', 'viewed')
            and e.sent_at is not null
            and e.sent_at < $cutoff
            and e.deleted_at is null`,
  },
  {
    key: "invoice_overdue",
    label: "An invoice past its due date",
    question: "Who has owed us money for a while?",
    entityType: "invoice",
    eventName: "invoice.dwelling",
    /**
     * Not while a bank payment for it is on its way: the customer has paid,
     * and the bank says in a few days whether the money came. Chased then if
     * it did not, since the invoice is still open.
     */
    sql: `select i.id, i.customer_id, i.number, i.due_on::timestamptz as since
          from public.invoice i
          where i.status in ('open', 'partially_paid')
            and i.balance > 0
            and i.due_on is not null
            and i.due_on::timestamptz < $cutoff
            and i.deleted_at is null
            and not exists (
              select 1 from public.integration_event ev
               where ev.organization_id = i.organization_id
                 and ev.direction = 'outbound' and ev.event_type = 'payment.intent' and ev.status = 'in_flight'
                 and exists (select 1 from jsonb_array_elements(ev.request_payload->'allocations') a
                              where a->>'invoiceId' = i.id::text))`,
  },
  {
    key: "task_unclaimed",
    label: "A task nobody has taken",
    question: "What has been sitting in the queue?",
    entityType: "task",
    eventName: "task.dwelling",
    sql: `select t.id, null::uuid as customer_id, null::int as number, t.created_at as since
          from public.task t
          where t.status = 'open'
            and t.assignee_user_id is null
            and t.created_at < $cutoff`,
  },
  {
    key: "job_not_invoiced",
    label: "Work finished and not invoiced",
    question: "What did we do and never bill for?",
    entityType: "job",
    eventName: "job.dwelling",
    sql: `select j.id, j.customer_id, j.number, j.completed_at as since
          from public.job j
          where j.status = 'completed'
            and j.completed_at is not null
            and j.completed_at < $cutoff
            and j.deleted_at is null`,
  },
  {
    key: "warranty_lapsing",
    label: "A unit's warranty about to run out",
    question: "Whose cover ends soon, while there is still time to offer a plan or a replacement?",
    entityType: "equipment",
    eventName: "equipment.warranty_lapsing",
    counts: "until",
    /**
     * The NEXT expiry, parts or labour, that has not passed yet: a furnace
     * whose labour ended in 2019 and whose parts run to 2028 is lapsing in
     * 2028, not overdue since 2019, which is the same rule the register's
     * warranty column follows. The customer is the one linked to the address
     * now, primary first and owners before tenants, so a task the automation
     * raises names who to ring. Retired units are not on a register and are
     * not anybody's call to make.
     */
    sql: `select e.id,
                 (select cp.customer_id from public.customer_property cp
                    join public.customer c on c.id = cp.customer_id
                   where cp.property_id = e.property_id and cp.ended_on is null and c.deleted_at is null
                   order by cp.is_primary desc, (cp.role = 'owner') desc, cp.created_at
                   limit 1) as customer_id,
                 null::int as number,
                 least(
                   case when e.warranty_parts_expires_on >= $today then e.warranty_parts_expires_on end,
                   case when e.warranty_labor_expires_on >= $today then e.warranty_labor_expires_on end
                 )::timestamptz as since
          from public.equipment e
          where e.deleted_at is null
            and e.active
            and least(
                  case when e.warranty_parts_expires_on >= $today then e.warranty_parts_expires_on end,
                  case when e.warranty_labor_expires_on >= $today then e.warranty_labor_expires_on end
                ) <= $horizon`,
  },
];

const byKey = new Map(SHAPES.map((shape) => [shape.key, shape]));

export interface DwellResult {
  workflowId: string;
  organizationId: string;
  shape: string;
  /** Records that had been sitting there long enough. */
  matched: number;
  runs: RunSummary[];
  reason?: string;
}

function dwellActor(organizationId: string): Actor {
  return {
    userId: SYSTEM_USER_ID,
    organizationId,
    roles: [],
    grants: [],
    agentId: "dwell",
  };
}

interface DwellWorkflowRow extends Record<string, unknown> {
  organization_id: string;
  workflow_id: string;
  dwell: { shape: string; afterDays: number } | null;
}

/**
 * One workflow's sweep.
 *
 * Exported so a test can drive it without reaching across tenants, and so the
 * pass is a loop over this rather than a second copy of the decision.
 */
export async function sweepOne(
  db: Database,
  row: DwellWorkflowRow,
  now: Date,
): Promise<DwellResult> {
  const base = { workflowId: row.workflow_id, organizationId: row.organization_id };
  const spec = row.dwell;
  if (!spec) return { ...base, shape: "", matched: 0, runs: [], reason: "no_dwell" };

  const shape = byKey.get(spec.shape);
  if (!shape) {
    /**
     * Refused rather than skipped, and named. A workflow pointing at a shape
     * this build does not have is a workflow that silently never fires, and
     * silently never firing is the automation failure nobody notices until a
     * customer does.
     */
    return { ...base, shape: spec.shape, matched: 0, runs: [], reason: "unknown_shape" };
  }

  const days = Number(spec.afterDays);
  if (!Number.isFinite(days) || days < 0) {
    return { ...base, shape: shape.key, matched: 0, runs: [], reason: "bad_period" };
  }

  const ctx: ServiceContext = { actor: dwellActor(row.organization_id), db };
  const cutoff = new Date(now.getTime() - days * 86_400_000);
  const until = shape.counts === "until";

  return inTenant(ctx, async (tx) => {
    /**
     * Dates for an `until` shape are the COMPANY's: a warranty ending on the
     * 30th ends on the 30th in Austin, and a server clock in UTC would fire a
     * day early every evening after seven.
     */
    const today = until ? time.dateIn(now, await timezoneOf(tx, row.organization_id)) : "";
    const horizon = until ? time.addDays(today, days) : "";
    const text = until
      ? shape.sql.replaceAll("$today", `'${today}'::date`).replaceAll("$horizon", `'${horizon}'::date`)
      : shape.sql.replace("$cutoff", `'${cutoff.toISOString()}'::timestamptz`);
    const records = await tx.execute<{
      id: string; customer_id: string | null; number: number | null; since: Date;
    }>(sql.raw(text));

    const runs: RunSummary[] = [];
    for (const record of records) {
      /**
       * ONE RUN PER RECORD, EVER.
       *
       * A dwell sweep runs every pass and the same estimate is still
       * unanswered on the next one, so without a key on the RECORD this
       * would chase the same customer every few minutes until somebody
       * turned it off. The key is derived rather than stored, so the unique
       * index on (organization, key) does the work and a second worker
       * sweeping at the same moment inserts nothing.
       */
      /**
       * An `until` record is keyed on its date as well: the parts cover
       * lapsing in May and the labour cover lapsing in November are two calls
       * to make, and a warranty somebody extended is a new date to warn about.
       */
      const sinceDay = record.since instanceof Date
        ? record.since.toISOString().slice(0, 10) : String(record.since).slice(0, 10);
      const key = until
        ? `dwell:${row.workflow_id}:${shape.key}:${record.id}:${sinceDay}`
        : `dwell:${row.workflow_id}:${shape.key}:${record.id}`;
      const [seen] = await tx.select({ id: schema.workflowRun.id })
        .from(schema.workflowRun)
        .where(sql`${schema.workflowRun.idempotencyKey} = ${key}`)
        .limit(1);
      if (seen) continue;

      const event = await emit(tx, ctx, {
        name: shape.eventName,
        entityType: shape.entityType,
        entityId: record.id,
        payload: {
          shape: shape.key,
          ...(until ? { daysBefore: days, until: sinceDay } : { afterDays: days }),
          [shape.entityType]: {
            id: record.id,
            ...(record.customer_id ? { customerId: record.customer_id } : {}),
            ...(record.number !== null ? { number: record.number } : {}),
          },
          since: record.since instanceof Date ? record.since.toISOString() : String(record.since),
        },
      });

      runs.push(await fire(tx, ctx, {
        workflowId: row.workflow_id,
        eventId: event.id,
        idempotencyKey: key,
      }));
    }

    return { ...base, shape: shape.key, matched: records.length, runs };
  });
}

/**
 * One pass over every dwell workflow, across every tenant.
 *
 * The cross tenant read goes through `app.dwell_workflows`, which returns ids
 * and the spec and nothing else, and is not callable by the role the request
 * path uses.
 */
export async function sweep(
  db: Database,
  options: { now?: Date; limit?: number; shouldStop?: () => boolean; only?: readonly string[] } = {},
): Promise<DwellResult[]> {
  const now = options.now ?? new Date();
  const rows = within(options.only, await db.execute<DwellWorkflowRow>(
    sql`select * from app.dwell_workflows(${options.limit ?? 100})`,
  ));

  const results: DwellResult[] = [];
  for (const row of rows) {
    // Between items, never inside one: see `shouldStop` on runPass.
    if (options.shouldStop?.()) break;
    try {
      results.push(await sweepOne(db, row, now));
    } catch (error) {
      // One tenant's broken sweep must not stop the rest.
      results.push({
        workflowId: row.workflow_id,
        organizationId: row.organization_id,
        shape: row.dwell?.shape ?? "",
        matched: 0,
        runs: [],
        reason: (error as Error).message,
      });
    }
  }
  return results;
}
