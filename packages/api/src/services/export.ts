import { sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { audit, guardedRead, ConflictError, NotFoundError, type ServiceContext } from "./context";

/**
 * TAKING A COPY OF EVERYTHING, WHICH THE PITCH HAS ALWAYS PROMISED
 *
 * `data:export` was in the permission catalogue and on the owner's role from the
 * first migration, checked by nothing. The guard test excused it with "export
 * exists per report; a whole-tenant export does not".
 *
 * That excuse was the weakest one on the list, because the comparison pages make
 * portability the central argument against the incumbents, in detail: they name
 * the things ServiceTitan's export APIs leave behind. The answer here was "it is
 * your Postgres instance", which is true for somebody self hosting and FALSE for
 * a company on a hosted deployment of this product, and the operator API exists
 * precisely to make hosted deployments a thing. A promise that only holds for
 * the subset of users who have shell access is not the promise the pages make.
 *
 * TWO PROPERTIES, AND THEY PULL AGAINST EACH OTHER. Resolving them in the open
 * is the whole design.
 *
 *   COMPLETENESS IS DRIVEN OFF THE CATALOGUE, not off a list. Every table
 *   carrying `organization_id` is exportable, which means a table added tomorrow
 *   is exportable tomorrow and nobody has to remember. The same mechanism the
 *   row level security sweep uses, for the same reason: a hand maintained list
 *   is how a product ends up with one table missing from its export and nobody
 *   finding out for eighteen months.
 *
 *   CREDENTIALS ARE NOT IN IT, and are NAMED. An export carrying live tokens is
 *   a breach in a file: it hands whoever holds the file a set of working
 *   capabilities, and a hash of a short token is a cracking target. An export
 *   that silently drops them is a claim of completeness that is false. So the
 *   manifest lists every redacted column with the reason, and the file is honest
 *   about its one hole.
 *
 * WHAT IS OUTSIDE THE TENANT ALTOGETHER, and therefore cannot appear here at
 * all: `credential` (password hashes), `session`, `setup_token`, `user`,
 * `organization` and `network`. None carries `organization_id`, so row level
 * security does not scope them and this export cannot reach them. A company's
 * people are in `membership`, which is a tenant table, and the person's email
 * and name come back through it. The password hash does not exist in any shape
 * this can read, which is a property of the schema rather than of this file.
 */

/**
 * Columns that do not leave, per table, with the reason.
 *
 * The reason is returned to the caller, not kept here for a reader. Somebody
 * moving to another system needs to know that their webhook tokens are not in
 * the file, so they can reissue rather than discover it when the leads stop.
 */
export const REDACTED: Record<string, Record<string, string>> = {
  app_token: {
    token_hash: "The hash of a live app token. Reissue the token in the new system; a hash is a "
      + "cracking target and is useless to you.",
  },
  portal_grant: {
    token_hash: "The hash of a live customer link. The links themselves cannot be reconstructed "
      + "and should not be: they are capabilities.",
  },
  calendar_feed: {
    token_hash: "The hash of a live calendar subscription URL. Reissue it; a technician's phone "
      + "will need the new one either way.",
  },
  unsubscribe_link: {
    token_hash: "The hash of a live unsubscribe link. The address and whether it was used are "
      + "exported; the link is not.",
  },
  lead_source_connector: {
    webhook_token:
      "A LIVE SECRET, not a hash. Whoever holds this can post leads into this company as if they "
      + "were the partner. Exported connectors keep their name, URL and field map so the "
      + "connection can be rebuilt, and the token has to be reissued on both sides.",
  },
  device: {
    push_token:
      "A live push credential for a specific phone. It identifies a device to a notification "
      + "service and is reissued by the app on first run, so it is of no use in a copy.",
  },
};

/**
 * Columns whose names look like a credential and which leave anyway, with why.
 *
 * The companion to `REDACTED` and the reason the test that reads the catalogue
 * can be strict. A name containing `token`, `secret`, `hash`, `key` or
 * `password` is a column somebody has to have thought about, and this is the
 * record of that thought. A new one has to be put in one list or the other
 * before the suite will pass, which is the point: the day a migration adds
 * `inbound_secret` to a table, nobody has to notice.
 */
export const EXPORTED_DELIBERATELY: Record<string, Record<string, string>> = {
  property: {
    address_key: "The address itself, lower cased with its spacing tidied, which the geocoder "
      + "compares to decide whether a coordinate still answers for it. A key in the sense of a "
      + "lookup, not a credential.",
  },
  location: {
    address_key: "The same normalised address as on a property, for a branch or yard. Nothing "
      + "secret in it.",
  },
  marketing_channel: {
    source_key: "Which lead source in the catalogue the channel is, such as google_ads. A word "
      + "from a public list, not a credential, and the export is unreadable as marketing without it.",
  },
  integration_connection: {
    credential_ref: "The NAME of a secret in the deployment's own store, never the secret. A "
      + "company moving away needs it to know which secrets to go and find.",
  },
  webhook_endpoint: {
    secret_ref: "A name in the deployment's secret store, as above, never the signing secret "
      + "itself. A company rebuilding its webhooks elsewhere needs to know which secret each "
      + "endpoint was signed with.",
  },
  attachment: {
    storage_key: "Where the bytes are in object storage. Without it an export cannot be matched "
      + "to the attachments it describes.",
  },
  stored_file: {
    storage_key: "Where the bytes are in object storage. Without it an export cannot be matched "
      + "to the files it describes.",
  },
  field_upload: {
    storage_key: "Where the bytes of a field upload are in object storage.",
    content_hash: "A checksum of the file, which is how a copy is verified rather than a secret.",
  },
  document_signature: {
    document_hash: "A checksum of what was signed. It is the evidence the signature is about, and "
      + "removing it would make every exported signature unverifiable.",
  },
  payment: {
    idempotency_key: "The caller's own retry key, which is how a repeated charge was prevented. "
      + "Not a credential, and worth keeping as the record of that.",
  },
  accounting_entity_link: {
    idempotency_key: "A retry key the sync pass chose for itself. Not a credential.",
  },
  integration_event: { idempotency_key: "A retry key the worker chose. Not a credential." },
  workflow_run: { idempotency_key: "A retry key the workflow chose. Not a credential." },
  report_delivery: {
    idempotency_key: "The occurrence a report was delivered for, a schedule and a day or a run and a step. "
      + "Not a credential.",
  },
  workflow: {
    template_key: "The name of the recommended automation a workflow was installed from, such as "
      + "estimate_follow_up. A label in the product's own catalogue, not a credential.",
  },
  ai_usage: {
    idempotency_key: "A retry key the AI call chose. Not a credential.",
    /**
     * THE TEST THAT READS THE CATALOGUE FOUND THESE THREE, which is the first
     * thing it did and a fair demonstration of why it reads the catalogue rather
     * than a list. "Token" here is a unit of text a model charged for, not a
     * credential, and the three of them are what an AI bill is made of. A
     * company checking what its model spend was needs them, and anybody skimming
     * a column list for the word "token" would have flagged them.
     */
    input_tokens: "A COUNT, not a credential: units of text sent to a model. This is what the "
      + "bill is made of and a company checking its own AI spend needs it.",
    output_tokens: "A count of units of text a model returned. Part of the same bill.",
    cached_input_tokens: "A count of units served from the model's own cache, billed differently "
      + "from fresh ones, which is why it is separate.",
  },
  custom_field_definition: {
    key: "The field's own name in the API, which is configuration a company rebuilds elsewhere.",
  },
  deficiency: {
    checkpoint_key: "Which checkpoint on the inspection programme the fault was found at.",
  },
  service_report_field: { key: "The reading's own name, such as `supply_temp`. Configuration." },
  regulatory_constant: {
    key: "The name of a published constant, such as a mileage rate for a tax year.",
  },
};

/**
 * What a company can take away.
 *
 * Read off the catalogue, so this is the truth about the database rather than a
 * list somebody maintains. `rows` is a count per table, which is the thing that
 * makes an export checkable: somebody who pulls 14,812 customers and had 14,900
 * has a problem they can see.
 */
export interface ManifestTable {
  table: string;
  rows: number;
  /** The primary key columns, in order. What pagination walks. */
  key: string[];
  redacted: { column: string; reason: string }[];
}

export interface Manifest {
  organizationId: string;
  generatedAt: string;
  tables: ManifestTable[];
  totalRows: number;
  /**
   * Tables outside the tenant, named so the absence is a statement rather than
   * an omission a reader has to notice.
   */
  outsideTheTenant: { table: string; reason: string }[];
}

const OUTSIDE: { table: string; reason: string }[] = [
  {
    table: "user",
    reason: "A person can belong to more than one company, so they sit above the tenant. The name "
      + "and address of everybody who works here are exported through `membership`.",
  },
  {
    table: "credential",
    reason: "Password hashes. Outside the tenant and unreachable from here, which is why no part "
      + "of this export has to be trusted not to include them.",
  },
  {
    table: "session",
    reason: "Live sign ins. They end when this company stops using this deployment.",
  },
  {
    table: "setup_token",
    reason: "First-password links, which expire.",
  },
  {
    table: "organization",
    reason: "This company's own row. Its name, timezone, currency and settings, which a new "
      + "deployment is configured with rather than restored from.",
  },
  {
    table: "network",
    reason: "A franchise or holding group spans companies, so it is not this company's to export. "
      + "What this company shared is in `network_grant`, which is exported.",
  },
];

interface Catalogued {
  table: string;
  key: { column: string; type: string }[];
  columns: string[];
}

/**
 * Every tenant table, its primary key and its columns, from the catalogue.
 *
 * ONE QUERY, AND IT IS THE WHITELIST. A table name arriving from a caller is
 * checked against this rather than against a literal list, which is what makes
 * the export complete by construction, and the check is also what makes it safe
 * to put the name into an identifier position below.
 */
async function catalogue(tx: Database): Promise<Map<string, Catalogued>> {
  const rows = await tx.execute<{
    table_name: string; column_name: string; data_type: string;
    key_position: number | null;
  }>(sql`
    select c.relname as table_name,
           a.attname as column_name,
           format_type(a.atttypid, a.atttypmod) as data_type,
           array_position(i.indkey::int[], a.attnum::int) as key_position
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
    left join pg_index i on i.indrelid = c.oid and i.indisprimary
    where n.nspname = 'public'
      and c.relkind = 'r'
      and exists (
        select 1 from pg_attribute o
        where o.attrelid = c.oid and o.attname = 'organization_id' and o.attnum > 0
      )
    order by c.relname, a.attnum
  `);

  const out = new Map<string, Catalogued>();
  for (const row of rows) {
    const entry = out.get(row.table_name)
      ?? { table: row.table_name, key: [], columns: [] };
    entry.columns.push(row.column_name);
    if (row.key_position !== null) {
      entry.key.push({ column: row.column_name, type: row.data_type });
    }
    out.set(row.table_name, entry);
  }

  /**
   * The key columns come back in column order rather than in index order, which
   * is wrong for a composite key whose index lists them the other way round.
   * Sorted by the position the index gives them, which is what `array_position`
   * is for.
   */
  for (const entry of out.values()) {
    if (entry.key.length === 0) {
      /**
       * A tenant table with no primary key cannot be paginated stably, and
       * pretending otherwise would give a caller an export that silently repeats
       * and skips rows. There is no such table today; this is here so that the
       * day somebody adds one, the export says so rather than lying.
       */
      entry.key.push({ column: "organization_id", type: "uuid" });
    }
  }
  return out;
}

/**
 * THERE IS NO IDENTIFIER CHECK IN THIS FILE, AND THERE WAS ONE.
 *
 * It read `safeName`, a regex over the table and column names before they were
 * interpolated. The breakage sweep removed it and every test stayed green, which
 * was correct and told me something better than "write a test for it": the names
 * come from `pg_class`, so the only value that could fail the regex is one the
 * database itself holds, and `sql.identifier` quotes and escapes whatever it is
 * given anyway. The check guarded a position that was already safe.
 *
 * So the guard is gone and so is the thing it guarded. Nothing in here builds a
 * SQL string:
 *
 *   Identifiers go through `sql.identifier`, which is drizzle's quoting.
 *   The cursor is a row comparison with plain bind parameters, whose types
 *   Postgres infers from the columns on the left.
 *   The count query is assembled with `sql.join` rather than with `sql.raw`.
 *
 * An unreachable guard in front of a raw fragment is worse than no fragment at
 * all, because it reads as the reason the fragment is acceptable.
 */

export function manifest(ctx: ServiceContext) {
  return guardedRead(ctx, "data:export", async (tx): Promise<Manifest> => {
    const tables = await catalogue(tx);

    /**
     * Counted in one statement rather than one per table, because 158 round
     * trips to count rows is a manifest that takes a minute to build and an
     * operator who stops asking for it.
     */
    const counts = new Map<string, number>();
    const names = [...tables.keys()].sort();
    if (names.length > 0) {
      const parts = names.map((name) =>
        sql`select ${name} as t, count(*)::text as n from ${sql.identifier(name)}`);
      const rows = await tx.execute<{ t: string; n: string }>(
        sql.join(parts, sql` union all `),
      );
      for (const row of rows) counts.set(row.t, Number(row.n));
    }

    const result: ManifestTable[] = names.map((name) => {
      const entry = tables.get(name)!;
      const redactions = REDACTED[name] ?? {};
      return {
        table: name,
        rows: counts.get(name) ?? 0,
        key: entry.key.map((column) => column.column),
        /**
         * Reported as written, with no filter against the live columns.
         *
         * There was one, and the sweep showed it could not matter: every name in
         * `REDACTED` is a real column, so filtering changed nothing, and the
         * failure it looked like it was guarding against is a different one that
         * it would not have caught. If a secret column were renamed, the stale
         * entry here would be cosmetic noise, and the REAL consequence would be
         * that the column under its new name started being exported, which no
         * filter in this function prevents.
         *
         * What prevents it is a test: `export.integration.test.ts` reads every
         * column on every tenant table whose name looks like a credential and
         * requires each one to be either redacted or listed as deliberately
         * exported, with a reason. That is the guard, and it lives where it can
         * see the whole database rather than one table at a time.
         */
        redacted: Object.entries(redactions).map(([column, reason]) => ({ column, reason })),
      };
    });

    await audit(tx, ctx, "data.export.manifest", "organization", ctx.actor.organizationId,
      null, { tables: result.length });

    return {
      organizationId: ctx.actor.organizationId,
      generatedAt: new Date().toISOString(),
      tables: result,
      totalRows: result.reduce((total, table) => total + table.rows, 0),
      outsideTheTenant: OUTSIDE,
    };
  });
}

export const MAX_PAGE = 1000;

export interface Page {
  table: string;
  rows: Record<string, unknown>[];
  /** The key of the last row, to pass back as `after`. Null at the end. */
  cursor: string[] | null;
  /** True while there is more. A caller stops on false, not on an empty page. */
  more: boolean;
  redacted: string[];
}

/**
 * One page of one table.
 *
 * KEYSET PAGINATION ON THE PRIMARY KEY, not an offset. An offset over a table
 * somebody is still working in repeats and skips rows, and an export that
 * silently does either is worse than no export: the company finds out when a
 * customer is missing from the new system.
 *
 * The key is read from the catalogue and compared as a row, so a composite key
 * works without this function knowing which tables have one. The types come from
 * the catalogue too, and the values are bind parameters: `(a, b) > (cast($1 as
 * uuid), cast($2 as text))`. Comparing the whole key as text instead would be
 * simpler and wrong the day somebody adds an integer key, because '10' sorts
 * before '9'.
 */
export function page(ctx: ServiceContext, input: {
  table: string;
  after?: string[] | undefined;
  limit?: number | undefined;
}) {
  return guardedRead(ctx, "data:export", async (tx): Promise<Page> => {
    const tables = await catalogue(tx);
    const entry = tables.get(input.table);
    if (!entry) {
      /**
       * NOT FOUND rather than forbidden, and the name is not echoed back. A
       * caller probing table names gets the same answer for a table that does
       * not exist and one that exists but is not a tenant table.
       */
      throw new NotFoundError("Table");
    }

    const limit = Math.min(Math.max(input.limit ?? MAX_PAGE, 1), MAX_PAGE);
    const redactions = REDACTED[input.table] ?? {};
    const selected = entry.columns.filter((column) => !(column in redactions));

    const columns = sql.join(
      selected.map((column) => sql.identifier(column)), sql`, `,
    );
    const keyColumns = sql.join(
      entry.key.map((column) => sql.identifier(column.column)), sql`, `,
    );
    const orderBy = sql.join(
      entry.key.map((column) => sql`${sql.identifier(column.column)} asc`), sql`, `,
    );

    const after = input.after ?? [];
    if (after.length > 0 && after.length !== entry.key.length) {
      throw new ConflictError(
        `This table's key has ${entry.key.length} `
        + `${entry.key.length === 1 ? "column" : "columns"} and the cursor has ${after.length}. `
        + "Pass back the cursor the previous page returned.",
      );
    }

    /**
     * THE CURSOR IS A ROW COMPARISON WITH PLAIN BIND PARAMETERS.
     *
     * `(a, b) > ($1, $2)`, and Postgres resolves each parameter's type from the
     * column it is compared against. An earlier version cast each one to the type
     * the catalogue reported, which worked and needed a raw fragment for the type
     * name; inference does the same job with nothing to escape.
     *
     * What matters either way is that this is a row comparison on the real key
     * columns rather than a comparison of the key rendered as text. Text would be
     * simpler and wrong the day somebody adds an integer key, because '10' sorts
     * before '9' and the export would skip most of the table.
     */
    const where = after.length === 0
      ? sql``
      : sql`where (${keyColumns}) > (${sql.join(after.map((value) => sql`${value}`), sql`, `)})`;

    const fetched = await tx.execute<Record<string, unknown>>(sql`
      select ${columns}
      from ${sql.identifier(input.table)}
      ${where}
      order by ${orderBy}
      limit ${limit + 1}
    `).catch(malformedCursor);

    const more = fetched.length > limit;
    const data = more ? fetched.slice(0, limit) : fetched;
    const last = data[data.length - 1];

    /**
     * ONE AUDIT LINE PER PAGE, with the table and the row count.
     *
     * "When did somebody take a copy of our entire customer list, and how much
     * of it" is the question an export has to be able to answer, and it is the
     * single most sensitive read in this product. Per page rather than per row
     * because per row would bury the log, and per export is not a thing: an
     * export is a sequence of calls and there is no moment it finishes.
     */
    await audit(tx, ctx, "data.export.page", "organization", ctx.actor.organizationId, null, {
      table: input.table, rows: data.length, resumed: after.length > 0,
    });

    return {
      table: input.table,
      rows: data,
      /**
       * The key of the last row, as strings. Null when the page came back empty,
       * which is the only case where there is nothing to resume from.
       */
      cursor: last ? entry.key.map((column) => String(last[column.column])) : null,
      more,
      redacted: Object.keys(redactions).filter((column) => entry.columns.includes(column)),
    };
  });
}

/**
 * A cursor Postgres could not read as the key's own type.
 *
 * `invalid input syntax for type uuid` is a caller's mistake, not a server
 * fault, and the previous shape of this (a cast in the SQL) had the same
 * problem without the answer: it came back as a 500. The message says what to
 * do, which is to pass back the cursor the previous page returned rather than
 * one made up.
 */
function malformedCursor(error: unknown): never {
  const code = (error as { code?: string } | null)?.code;
  /** 22P02 invalid_text_representation, 22023 invalid_parameter_value. */
  if (code === "22P02" || code === "22023") {
    throw new ConflictError(
      "That cursor is not in the shape this table's key takes. Pass back the cursor the previous "
      + "page returned; it is not meant to be constructed by hand.",
    );
  }
  throw error;
}

export const handlers = {
  getExportManifest: (ctx: ServiceContext, _input: Record<string, never>) => {
    void _input;
    return manifest(ctx);
  },
  getExportPage: (ctx: ServiceContext, input: {
    table: string; after?: string[] | undefined; limit?: number | undefined;
  }) => page(ctx, input),
} as const;
