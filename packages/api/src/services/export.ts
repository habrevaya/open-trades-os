import { and, asc, eq, gt, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan } from "@opentradesos/core";
import { audit, guardedRead, inTenant, ConflictError, NotFoundError, type ServiceContext } from "./context";
import { bytesOf, HELD } from "./files";

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
 * all: `credential` (password hashes), `session`, `setup_token`,
 * `sign_in_code`, `user`, `organization` and `network`. None carries `organization_id`, so row level
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
  purchase_order_send: {
    link_token_hash: "The hash of a live link a vendor opens an emailed purchase order with. The "
      + "order and every send of it are exported; the link is a capability and is not.",
  },
  portal_sign_in: {
    code_hash: "The salted hash of a customer's six digit sign in code. Six digits are a million "
      + "guesses away from it, which is why it is kept from the file even though every code is "
      + "dead within ten minutes. Who signed in, when and from where is exported.",
  },
  sealed_credential: {
    sealed_token:
      "An ad platform's live grant, sealed under this deployment's key. Useless anywhere without "
      + "that key and dangerous anywhere with it, so it never leaves: sign in to each platform again "
      + "in the new system. Which platform, what was granted and when are exported.",
  },
  oauth_authorization: {
    state_hash: "The hash of a sign in's single use state. Dead within a quarter of an hour, and a "
      + "cracking target for nothing.",
  },
  /**
   * THESE WERE EXPORTED, on the strength of a comment calling `secret_ref` the
   * NAME of a secret. It is not: the delivery code has to reproduce a signature
   * on every delivery, so the column holds the signing secret itself (see the
   * top of `services/webhooks.ts`), and an export carried every receiver's
   * secret in a file. Found when rotation added a second one beside it.
   */
  webhook_endpoint: {
    secret_ref: "A LIVE SECRET: the key every delivery to this endpoint is signed with. Whoever "
      + "holds it can forge deliveries the receiver will trust. The endpoint's address and events "
      + "are exported; give the receiver a new secret from the new system.",
    previous_secret_ref: "The secret before the last rotation, which still signs until the overlap "
      + "ends. A live secret for the same reason.",
  },
  connected_app: {
    claim_hash: "The hash of the secret an app was given when it asked to be installed, which "
      + "collects its credential once. A hash is a cracking target and is useless to you; who "
      + "asked, for what, and what was decided is exported.",
  },
  oauth_code: {
    code_hash: "The hash of a one time authorization code that lived ten minutes. Which client "
      + "was approved, by whom and for what is exported.",
  },
  oauth_refresh_token: {
    token_hash: "The hash of a live refresh token for a connected AI assistant. It connects again "
      + "to the new system; a hash is a cracking target and is useless to you.",
  },
  calendar_feed: {
    token_hash: "The hash of a live calendar subscription URL. Reissue it; a technician's phone "
      + "will need the new one either way.",
  },
  unsubscribe_link: {
    token_hash: "The hash of a live unsubscribe link. The address and whether it was used are "
      + "exported; the link is not.",
  },
  lead_inbox: {
    token:
      "A LIVE SECRET. It is the part of the lead inbox address that decides which company a forwarded "
      + "lead email lands in, so whoever holds it can put leads on this company's board by email. "
      + "A new inbox has a new address, and the forwarding rules are changed to it.",
  },
  lead_source_connector: {
    webhook_token:
      "A LIVE SECRET, not a hash. Whoever holds this can post leads into this company as if they "
      + "were the partner. Exported connectors keep their name, URL and field map so the "
      + "connection can be rebuilt, and the token has to be reissued on both sides.",
  },
  conversation: {
    reply_token:
      "A LIVE SECRET. It is the part of an email thread's reply address that decides which "
      + "thread an incoming email lands in, so whoever holds it can put words into that "
      + "customer's conversation. A new system mints its own reply addresses.",
  },
  ai_chat_session: {
    token_hash: "The hash of a website visitor's live chat link. The chat itself is exported with the "
      + "conversation it belongs to; the link cannot be reconstructed and should not be.",
  },
  voice_agent_session: {
    token_hash: "The hash of the address the carrier opened one phone assistant conversation on. "
      + "It is dead once the call ends; what was said and done on the call is exported.",
  },
  device: {
    push_token:
      "A live push credential for a specific phone. It identifies a device to a notification "
      + "service and is reissued by the app on first run, so it is of no use in a copy.",
    session_token_hash:
      "The hash of the phone app's live sign in on this device. Phones sign in again against "
      + "the new system; a hash is a cracking target and is useless to you.",
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
  customer_tag: {
    tag_key: "A customer's tag lower cased with its spaces tidied, which the tag filter compares by. "
      + "A key in the sense of a lookup, not a credential.",
  },
  staff_document: {
    body_hash: "SHA-256 of a document's title and words, which every signature against it carries. "
      + "A fingerprint of text the export also contains, so it opens nothing, and the export is how a "
      + "company proves which words somebody signed.",
  },
  sealed_credential: {
    key_fingerprint: "Twelve hex characters of a hash of the deployment's sealing key, which say which key "
      + "sealed a grant and nothing about the key itself.",
  },
  setup_step: {
    step_key: "Which setup step a row is about, such as payments or tax. A word from the "
      + "product's own list of steps, not a key to anything.",
  },
  travel_time: {
    origin_key: "A point on the map rounded to four decimal places, which a cached drive time starts "
      + "from. A key in the sense of a lookup, not a credential.",
    destination_key: "The point the same cached drive time ends at, rounded the same way.",
  },
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
    previous_secret_expires_at: "A time: when the old secret stops signing. Not a credential.",
    secret_rotated_at: "A time: when the current secret was made. Not a credential.",
  },
  oauth_code: {
    issued_token_id: "The id of the app token an authorization produced, so a replayed code can "
      + "revoke it. An id, not the token.",
  },
  oauth_refresh_token: {
    access_token_id: "The id of the app token issued beside a refresh token. An id, not the token.",
  },
  portal_sign_in: {
    request_key: "The key a customer's browser sent with a press of Send me a code, so a double "
      + "press sends one code. Chosen by the browser for that one press, and grants nothing.",
  },
  attachment: {
    storage_key: "Where the bytes are in object storage. Without it an export cannot be matched "
      + "to the attachments it describes.",
  },
  stored_file: {
    storage_key: "Where the bytes are in object storage. Without it an export cannot be matched "
      + "to the files it describes.",
    object_key: "The name of the file's object in this deployment's bucket, when it is kept in one. "
      + "A location, not a credential: reading it needs the deployment's own keys.",
  },
  backup_destination: {
    access_key_id: "The identifier half of the bucket's key pair, which says whose key it is and opens "
      + "nothing on its own. The secret half is held by name, below.",
    secret_key_ref: "The NAME of the secret holding the bucket's secret key in the deployment's own store, "
      + "never the key. A company moving away needs it to know which secret to go and find.",
  },
  backup_run: {
    object_key: "The name a copy was written under in the company's own bucket, so each copy can be found. "
      + "Not a credential.",
  },
  call: {
    recording_storage_key: "Which stored file holds the call's recording, kept here because the "
      + "recording check allowed it. A pointer to bytes in the same export, not a credential.",
    voicemail_storage_key: "Which stored file holds the voicemail the caller left. A pointer, as above.",
  },
  web_form: {
    public_key: "The address of the form's hosted page, which is printed on flyers and linked "
      + "from websites. Public by design, and a company rebuilding its forms needs the old address.",
  },
  field_upload: {
    storage_key: "Where the bytes of a field upload are in object storage.",
    content_hash: "A checksum of the file, which is how a copy is verified rather than a secret.",
  },
  document_signature: {
    document_hash: "A checksum of what was signed. It is the evidence the signature is about, and "
      + "removing it would make every exported signature unverifiable.",
  },
  project_change_order: {
    document_hash: "A checksum of the change order as it was sent and signed. The same evidence "
      + "the signature record carries, and an export without it could not show what was agreed.",
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
  ai_agent_proposal: {
    idempotency_key: "The retry key of the request that asked an agent for a draft. Not a credential.",
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
  custom_object_type: {
    key: "The name a company's own kind of record goes by in the API, such as permit. Configuration.",
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
 * Columns that leave, but not inside the table's rows.
 *
 * A stored file's bytes are a photograph, a signature, a call recording: a
 * thousand of them inside one page of JSON would be gigabytes in one response,
 * and the first version of this export did exactly that, as an array of
 * numbers. So the bytes travel beside the rows instead, one file at a time:
 * under `files/` in the archive, as `file` lines in the newline delimited copy,
 * and through `GET /v1/export-files/{id}` for a program walking the API. Named
 * here, with where to find them, for the reason every redaction is named.
 */
export const HELD_APART: Record<string, Record<string, string>> = {
  stored_file: {
    bytes: "The file itself, carried beside the rows rather than inside them: in the archive at "
      + "files/ followed by the storage key, in the newline delimited copy as a `file` line, and "
      + "through GET /v1/export-files/{id}. Each one is checked against `sha256` on the way back in.",
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
export interface ManifestColumn {
  name: string;
  /** Postgres's own name for the type, such as `uuid`, `numeric(14,4)` or `jsonb`. */
  type: string;
  nullable: boolean;
  /** The table a foreign key on this column points at, when it has one. */
  references: string | null;
}

export interface ManifestTable {
  table: string;
  rows: number;
  /** The primary key columns, in order. What pagination walks. */
  key: string[];
  redacted: { column: string; reason: string }[];
  /** Columns that leave beside the rows rather than in them. */
  apart: { column: string; reason: string }[];
  /** Every column that is in the rows, in order, which is also the order of the archive's CSV. */
  columns: ManifestColumn[];
}

/** Somebody who works here, as the copy carries them: who, not how they sign in. */
export interface ManifestPerson {
  userId: string;
  email: string;
  name: string | null;
}

export interface Manifest {
  /** What this file is, so a reader can tell it from any other JSON. */
  format: "opentradesos-export";
  /** The shape of the file. Bumped when a reader would need to change. */
  version: 1;
  organizationId: string;
  generatedAt: string;
  tables: ManifestTable[];
  totalRows: number;
  /**
   * The company's own row: its name, its address, its timezone, its settings.
   * Outside the tenant like every company's row, and carried here because a
   * copy restored into a new company should come back as the same business,
   * not as the new company's defaults.
   */
  company: Record<string, unknown>;
  /**
   * Who works here, by name and address. A person sits above the company (one
   * person can work for two), so their row is not a tenant table; without this
   * a copy would hold memberships naming nobody. Never a password or a sign in.
   */
  people: ManifestPerson[];
  /** The stored files carried beside the rows, and how many bytes they come to. */
  files: { count: number; bytes: number };
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
      + "and address of everybody with a `membership` here are in the manifest's `people`, which is "
      + "how a restore knows who they are; nothing about how they sign in is.",
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
    table: "sign_in_code",
    reason: "One time codes for signing the field app in, kept as hashes, which expire in ten minutes.",
  },
  {
    table: "organization",
    reason: "Every company's own row. This company's name, address, timezone, currency and settings "
      + "are in the manifest's `company`; its address on this deployment and anything the operator "
      + "set are not, because they belong to the deployment rather than the business.",
  },
  {
    table: "public_rate_limit",
    reason: "A count of requests to the public endpoints per key and minute, kept for a day. It "
      + "names no customer, holds nothing but a number, and is counted before any company is known.",
  },
  {
    table: "oauth_client",
    reason: "Remote AI assistants that registered themselves with this deployment before any "
      + "company was chosen. A registration names no company and grants nothing; what this "
      + "company approved is the connected app, which is exported.",
  },
  {
    table: "network",
    reason: "A franchise or holding group spans companies, so it is not this company's to export. "
      + "What this company shared is in `network_grant`, which is exported.",
  },
];

/** The company row's columns a copy carries. Not its id, its address here, or what the operator set. */
const COMPANY_COLUMNS = [
  "name", "legal_name", "ein", "timezone", "currency", "logo_url", "brand_color", "primary_trade",
  "setup_completed_at", "settings", "phone", "email", "address_line1", "address_line2", "city",
  "state", "postal_code", "created_at",
] as const;
export const CARRIED_COMPANY_COLUMNS: readonly string[] = COMPANY_COLUMNS;

export interface CatalogColumn {
  name: string;
  type: string;
  nullable: boolean;
  /** Computed by the database from other columns, so a restore never writes it. */
  generated: boolean;
  references: string | null;
}

export interface Catalogued {
  table: string;
  key: { column: string; type: string }[];
  columns: CatalogColumn[];
  /** Whether a trigger runs before each insert, which can change what is written. */
  insertTrigger: boolean;
}

/**
 * Every tenant table, its primary key and its columns, from the catalogue.
 *
 * ONE QUERY, AND IT IS THE WHITELIST. A table name arriving from a caller is
 * checked against this rather than against a literal list, which is what makes
 * the export complete by construction, and the check is also what makes it safe
 * to put the name into an identifier position below.
 *
 * Exported for the restore, which loads by the same catalogue: what one side
 * writes is exactly what the other side can read.
 */
export async function catalogue(tx: Database): Promise<Map<string, Catalogued>> {
  const rows = await tx.execute<{
    table_name: string; column_name: string; data_type: string; not_null: boolean;
    generated: boolean; key_position: number | null; references_table: string | null;
    insert_trigger: boolean;
  }>(sql`
    select c.relname as table_name,
           a.attname as column_name,
           format_type(a.atttypid, a.atttypmod) as data_type,
           a.attnotnull as not_null,
           a.attgenerated <> '' as generated,
           array_position(i.indkey::int[], a.attnum::int) as key_position,
           (select r.relname from pg_constraint f join pg_class r on r.oid = f.confrelid
             where f.conrelid = c.oid and f.contype = 'f' and f.conkey = array[a.attnum]::smallint[]
             limit 1) as references_table,
           exists (select 1 from pg_trigger t
             where t.tgrelid = c.oid and not t.tgisinternal
               and (t.tgtype & 2) <> 0 and (t.tgtype & 4) <> 0) as insert_trigger
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
  const positions = new Map<string, number>();
  for (const row of rows) {
    const entry = out.get(row.table_name)
      ?? { table: row.table_name, key: [], columns: [], insertTrigger: row.insert_trigger };
    entry.columns.push({
      name: row.column_name, type: row.data_type, nullable: !row.not_null,
      generated: row.generated, references: row.references_table,
    });
    if (row.key_position !== null) {
      entry.key.push({ column: row.column_name, type: row.data_type });
      positions.set(`${row.table_name}.${row.column_name}`, row.key_position);
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
    entry.key.sort((a, b) =>
      (positions.get(`${entry.table}.${a.column}`) ?? 0) - (positions.get(`${entry.table}.${b.column}`) ?? 0));
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
 *   Type names decide which of three fixed expressions a column is read with;
 *   they are compared, never interpolated.
 *
 * An unreachable guard in front of a raw fragment is worse than no fragment at
 * all, because it reads as the reason the fragment is acceptable.
 */

/** The columns a page carries: everything but what is redacted or held apart. */
function carried(entry: Catalogued): CatalogColumn[] {
  const redactions = REDACTED[entry.table] ?? {};
  const apart = HELD_APART[entry.table] ?? {};
  return entry.columns.filter((column) => !(column.name in redactions) && !(column.name in apart));
}

const isTimestamp = (type: string) => type.startsWith("timestamp");
const NATIVE = new Set(["jsonb", "json", "boolean", "integer", "smallint", "bigint", "double precision", "real"]);

/**
 * How one column is read, so a value survives the trip out and back exactly.
 *
 * The driver's own parsing was not good enough for a copy, and three things
 * were wrong in the first version: a timestamp came back as a JavaScript date,
 * which keeps milliseconds and Postgres keeps microseconds; a `date` came back
 * as midnight in the server's zone, a day early for anybody west of it; and a
 * `bytea` came back as an array of numbers. Now:
 *
 *   A timestamp is ISO 8601 with every digit Postgres holds, in UTC.
 *   jsonb, booleans and integers are themselves.
 *   An array is a JSON array.
 *   Everything else is Postgres's own text for it: a date is `2026-10-04`, a
 *   decimal keeps its trailing zeros, and bytes are `\x` and hex.
 *
 * `textual` is the archive's CSV, where every value is Postgres's text except a
 * timestamp, which is the same ISO form. Each of them loads back through
 * Postgres's own input functions, which is what the restore relies on and what
 * lets `\copy` load the CSV with nothing written here.
 */
function readAs(column: CatalogColumn, textual: boolean) {
  const id = sql.identifier(column.name);
  if (isTimestamp(column.type)) return sql`(to_jsonb(${id}) #>> '{}') as ${id}`;
  if (textual) return sql`${id}::text as ${id}`;
  if (column.type.endsWith("[]")) return sql`to_jsonb(${id}) as ${id}`;
  if (NATIVE.has(column.type)) return id;
  return sql`${id}::text as ${id}`;
}

/** Inside a transaction already in the tenant, without the audit line the API's call writes. */
async function manifestWithin(
  tx: Database, ctx: ServiceContext, tables: Map<string, Catalogued>,
): Promise<Manifest> {
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
    const apart = HELD_APART[name] ?? {};
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
      apart: Object.entries(apart).map(([column, reason]) => ({ column, reason })),
      columns: carried(entry).map(({ name: column, type, nullable, references }) =>
        ({ name: column, type, nullable, references })),
    };
  });

  const columns = sql.join(COMPANY_COLUMNS.map((column) => sql.identifier(column)), sql`, `);
  const [company] = await tx.execute<{ company: Record<string, unknown> }>(sql`
    select to_jsonb(c) as company from (
      select ${columns} from public.organization where id = ${ctx.actor.organizationId}
    ) c
  `);
  const people = await tx.execute<{ user_id: string; name: string | null; email: string }>(
    sql`select distinct user_id, name, email from app.organization_people() order by email`,
  );
  const [files] = await tx.execute<{ count: string; bytes: string }>(sql`
    select count(*)::text as count, coalesce(sum(size_bytes), 0)::text as bytes
    from public.stored_file where deleted_at is null
  `);

  return {
    format: "opentradesos-export",
    version: 1,
    organizationId: ctx.actor.organizationId,
    generatedAt: new Date().toISOString(),
    tables: result,
    totalRows: result.reduce((total, table) => total + table.rows, 0),
    company: company?.company ?? {},
    people: people.map((person) => ({ userId: person.user_id, email: person.email, name: person.name })),
    files: { count: Number(files?.count ?? 0), bytes: Number(files?.bytes ?? 0) },
    outsideTheTenant: OUTSIDE,
  };
}

export function manifest(ctx: ServiceContext) {
  return guardedRead(ctx, "data:export", async (tx): Promise<Manifest> => {
    await tx.execute(sql`set local time zone 'UTC'`);
    const result = await manifestWithin(tx, ctx, await catalogue(tx));
    await audit(tx, ctx, "data.export.manifest", "organization", ctx.actor.organizationId,
      null, { tables: result.tables.length });
    return result;
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
 * One page of one table, inside a transaction already in the tenant.
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
async function pageWithin(tx: Database, tables: Map<string, Catalogued>, input: {
  table: string;
  after?: string[] | undefined;
  limit?: number | undefined;
  textual?: boolean | undefined;
}): Promise<Page> {
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
  const selected = carried(entry);

  const columns = sql.join(selected.map((column) => readAs(column, input.textual === true)), sql`, `);
  const keyColumns = sql.join(
    entry.key.map((column) => sql.identifier(column.column)), sql`, `,
  );
  const orderBy = sql.join(
    entry.key.map((column) => sql`${sql.identifier(column.column)} asc`), sql`, `,
  );
  /** The key as the cursor needs it, whatever the columns above made of it. */
  const keyText = sql.join(
    entry.key.map((column, i) => sql`${sql.identifier(column.column)}::text as ${sql.identifier(`__key${i}`)}`), sql`, `,
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
    select ${columns}, ${keyText}
    from ${sql.identifier(input.table)}
    ${where}
    order by ${orderBy}
    limit ${limit + 1}
  `).catch(malformedCursor);

  const more = fetched.length > limit;
  const data = more ? fetched.slice(0, limit) : fetched;
  const last = data[data.length - 1];
  const cursor = last ? entry.key.map((_, i) => String(last[`__key${i}`])) : null;
  for (const row of data) {
    for (let i = 0; i < entry.key.length; i++) delete row[`__key${i}`];
  }

  return {
    table: input.table,
    rows: data,
    /**
     * The key of the last row, as strings. Null when the page came back empty,
     * which is the only case where there is nothing to resume from.
     */
    cursor,
    more,
    redacted: Object.keys(redactions).filter((column) => entry.columns.some((c) => c.name === column)),
  };
}

/**
 * One page of one table, for the API.
 *
 * ONE AUDIT LINE PER PAGE, with the table and the row count. "When did
 * somebody take a copy of our entire customer list, and how much of it" is the
 * question an export has to be able to answer, and it is the single most
 * sensitive read in this product. Per page rather than per row because per row
 * would bury the log, and per export is not a thing here: through the API an
 * export is a sequence of calls and there is no moment it finishes.
 */
export function page(ctx: ServiceContext, input: {
  table: string;
  after?: string[] | undefined;
  limit?: number | undefined;
}) {
  return guardedRead(ctx, "data:export", async (tx): Promise<Page> => {
    await tx.execute(sql`set local time zone 'UTC'`);
    const result = await pageWithin(tx, await catalogue(tx), input);
    const after = input.after ?? [];
    await audit(tx, ctx, "data.export.page", "organization", ctx.actor.organizationId, null, {
      table: input.table, rows: result.rows.length, resumed: after.length > 0,
    });
    return result;
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

/* ------------------------------------------------------------- the files */

/** A stored file as the copy carries it, without its bytes. */
export interface ExportedFile {
  id: string;
  storageKey: string;
  sha256: string;
  contentType: string;
  sizeBytes: number;
}

async function filesWithin(tx: Database, after: string | undefined, limit: number) {
  const rows = await tx.select({
    id: schema.storedFile.id, storageKey: schema.storedFile.storageKey, sha256: schema.storedFile.sha256,
    contentType: schema.storedFile.contentType, sizeBytes: schema.storedFile.sizeBytes,
  }).from(schema.storedFile)
    .where(and(isNull(schema.storedFile.deletedAt), after ? gt(schema.storedFile.id, after) : undefined))
    .orderBy(asc(schema.storedFile.id))
    .limit(limit + 1);
  const more = rows.length > limit;
  const files = more ? rows.slice(0, limit) : rows;
  return { files, cursor: files[files.length - 1]?.id ?? null, more };
}

async function bytesWithin(tx: Database, id: string): Promise<Buffer> {
  const [row] = await tx.select(HELD).from(schema.storedFile)
    .where(and(eq(schema.storedFile.id, id), isNull(schema.storedFile.deletedAt))).limit(1);
  if (!row) throw new NotFoundError("File");
  return bytesOf(row);
}

/**
 * One stored file with its bytes, for a program taking a copy through the API.
 *
 * The one place this product hands bytes back inside JSON. Everywhere else a
 * file is served from its own address so an image tag can point at it; an
 * export is read by a program that wants the file and its checksum in one
 * answer, and checks the one against the other.
 */
export function file(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "data:export", async (tx) => {
    const [row] = await tx.select().from(schema.storedFile)
      .where(and(eq(schema.storedFile.id, input.id), isNull(schema.storedFile.deletedAt))).limit(1);
    if (!row) throw new NotFoundError("File");
    const bytes = await bytesOf(row);
    await audit(tx, ctx, "data.export.file", "stored_file", row.id, null, { sizeBytes: row.sizeBytes });
    return {
      id: row.id, storageKey: row.storageKey, sha256: row.sha256, contentType: row.contentType,
      sizeBytes: row.sizeBytes, bytes: bytes.toString("base64"),
    };
  });
}

/* ---------------------------------------------------------- one moment */

/**
 * The whole company as it stood at one moment, for a writer to walk.
 *
 * What the archive, the newline delimited file and the scheduled copy are all
 * written from. Injected into the writers rather than imported by them, so
 * their failures can be staged in a test without a database.
 */
export interface ExportSource {
  manifest: Manifest;
  page(table: string, after: string[] | undefined, textual: boolean): Promise<Page>;
  files(after: string | undefined): Promise<{ files: ExportedFile[]; cursor: string | null; more: boolean }>;
  bytes(file: ExportedFile): Promise<Buffer>;
}

/**
 * Read the whole company in ONE transaction, at one moment.
 *
 * The first version read each page in a transaction of its own, which is right
 * for the API and wrong for a copy: a customer and their first job added while
 * the export was between the `customer` table and the `job` table left a job in
 * the file pointing at a customer who was not, and the copy could not be loaded
 * back. `repeatable read` makes every table the same instant, so a copy is
 * always one the database could have held, and the manifest's counts are
 * exactly what follows them.
 *
 * THE AUDIT TRAIL IS WRITTEN OUTSIDE IT, before and after, each in its own
 * transaction. A line written inside would vanish with a download that broke
 * halfway, which is exactly the export somebody will later ask about. So the
 * start is recorded before the first row is read, and the end, finished or
 * stopped, with how many rows of each table were read, whatever happened.
 */
export async function withSnapshot<T>(
  ctx: ServiceContext,
  purpose: "download" | "archive" | "backup",
  fn: (source: ExportSource) => Promise<T>,
): Promise<T> {
  assertCan(ctx.actor, "data:export");
  await inTenant(ctx, (tx) => audit(tx, ctx, "data.export.started", "organization", ctx.actor.organizationId,
    null, { purpose }));

  const read = new Map<string, number>();
  let files = 0;
  let finished = false;
  try {
    const result = await inTenant(ctx, async (tx) => {
      await tx.execute(sql`set local time zone 'UTC'`);
      const tables = await catalogue(tx);
      const source: ExportSource = {
        manifest: await manifestWithin(tx, ctx, tables),
        page: async (table, after, textual) => {
          const result = await pageWithin(tx, tables, { table, after, textual });
          read.set(table, (read.get(table) ?? 0) + result.rows.length);
          return result;
        },
        files: (after) => filesWithin(tx, after, 500),
        bytes: async (exported) => {
          files += 1;
          return bytesWithin(tx, exported.id);
        },
      };
      return fn(source);
    }, { isolationLevel: "repeatable read" });
    finished = true;
    return result;
  } finally {
    await inTenant(ctx, (tx) => audit(tx, ctx, finished ? "data.export.finished" : "data.export.stopped",
      "organization", ctx.actor.organizationId, null, {
        purpose, rows: [...read.values()].reduce((a, b) => a + b, 0), tables: Object.fromEntries(read), files,
      })).catch((error: unknown) => {
      console.error("[export] could not record the end of an export:", (error as Error).message);
    });
  }
}

export const handlers = {
  getExportManifest: (ctx: ServiceContext, _input: Record<string, never>) => {
    void _input;
    return manifest(ctx);
  },
  getExportPage: (ctx: ServiceContext, input: {
    table: string; after?: string[] | undefined; limit?: number | undefined;
  }) => page(ctx, input),
  getExportFile: (ctx: ServiceContext, input: { id: string }) => file(ctx, input),
} as const;
