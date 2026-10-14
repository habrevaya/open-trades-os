import { sql } from "drizzle-orm";
import { pgTable, pgEnum, uuid, text, jsonb, integer, index, uniqueIndex, timestamp } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";
import { organization, user } from "./tenancy";
import { connectedApp } from "./integrations";
import { jobType } from "./work";

/**
 * PLUGINS A CONNECTED APPLICATION REGISTERED
 *
 * What an application may add to how a company runs, and only as data: a
 * job workflow for one job type, a pricing rule, a report type. Never code:
 * the definition is checked by core (`core/plugins`) against a closed
 * vocabulary before it is written, and read back by the services that act
 * on it.
 *
 * ONE TABLE FOR THE THREE, because the questions an operator asks about them
 * are the same questions: which application added this, when, which version
 * is in force, and is it on. Three tables would be three answers to "what
 * has this app changed here", and the Applications screen would have to
 * remember to ask all of them.
 *
 * ON WITH THE APPLICATION, NEVER APART FROM IT. A plugin is in force while
 * its application is active, and that is a join on every read rather than a
 * flag copied here, so turning an application off turns everything it added
 * off at the same moment, by the same row.
 */
export const pluginKind = pgEnum("plugin_kind", ["job_workflow", "pricing_rule", "report_type"]);

export const appPlugin = pgTable("app_plugin", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  /**
   * The application that registered it. Null only on a sandbox's copy of a
   * job workflow: a sandbox has no applications (its integrations are not
   * copied), so the copy stands on its own there and says whose it was.
   */
  appId: uuid("app_id").references(() => connectedApp.id, { onDelete: "cascade" }),
  /** The application's name when it registered, kept for a sandbox's copy and for history. */
  appName: text("app_name").notNull(),
  kind: pluginKind("kind").notNull(),
  /** The application's own name for it, the same on every version. */
  key: text("key").notNull(),
  name: text("name").notNull(),
  /** The job type a job workflow is for. Null for the other two kinds. */
  jobTypeId: uuid("job_type_id").references(() => jobType.id, { onDelete: "cascade" }),
  /** The version in force, which is the newest. */
  version: integer("version").notNull().default(1),
  /** The version in force, as core checked it. Copied from `app_plugin_version`. */
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  /** Removed by its application. Kept, because lines and reports name it. */
  retiredAt: timestamp("retired_at", { withTimezone: true }),
  /**
   * Turned off by the company, on its own, without turning the application
   * off. A different thing from `retired_at` and kept apart on purpose: the
   * application removes a plugin and can register it again, the company
   * turns one off and only the company turns it back on, so a new version
   * from the application never switches back on what somebody there decided
   * to stop. Null is on.
   */
  disabledAt: timestamp("disabled_at", { withTimezone: true }),
  /** Who turned it off, for the screen and the audit line. Null when nobody has, or when they have since left. */
  disabledByUserId: uuid("disabled_by_user_id").references(() => user.id, { onDelete: "set null" }),
  /** What they said when they did, shown beside it. */
  disabledReason: text("disabled_reason"),
  ...timestamps,
}, (t) => ({
  /** One plugin of a kind per key per application: registering the key again is a new version. */
  keyIdx: uniqueIndex("app_plugin_key_idx").on(t.organizationId, t.appId, t.kind, t.key),
  /**
   * ONE WORKFLOW PER JOB TYPE. Two applications each deciding how an install
   * moves would leave the job page showing one set of stages and the gate
   * check applying the other, depending on which row a query met first.
   */
  jobTypeIdx: uniqueIndex("app_plugin_job_type_idx").on(t.organizationId, t.jobTypeId)
    .where(sql`kind = 'job_workflow' and retired_at is null`),
  appIdx: index("app_plugin_app_idx").on(t.organizationId, t.appId),
}));

/**
 * Every version a plugin has had, as registered. Versioned like an
 * automation: a registration with the same key is the next version, and
 * the older ones stay, so "what was this rule when that invoice was
 * priced" has an answer (the line names the version).
 */
export const appPluginVersion = pgTable("app_plugin_version", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  pluginId: uuid("plugin_id").notNull().references(() => appPlugin.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  name: text("name").notNull(),
  definition: jsonb("definition").$type<Record<string, unknown>>().notNull(),
  ...timestamps,
}, (t) => ({
  versionIdx: uniqueIndex("app_plugin_version_idx").on(t.pluginId, t.version),
}));
