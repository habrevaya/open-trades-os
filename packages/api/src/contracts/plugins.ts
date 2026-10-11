import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * PLUGINS: WHAT A CONNECTED APPLICATION ADDS, AS DATA
 *
 * An application acting with its own token can register three things, each
 * a shape of data core checks before it is kept, never code: a job workflow
 * (stages over the job statuses for one job type, with gates to leave each),
 * a pricing rule (one of four kinds), and a report type (a cut of one of the
 * report builder's datasets). Registering a key again is its next version;
 * sending the same thing again changes nothing. Each is listed under its
 * application on Settings, Applications, every registration is in the audit
 * log, and turning the application off turns all of them off.
 *
 * The schemas here are loose on purpose where core is strict: a stage's
 * statuses and a rule's kind are strings, so an application that sends the
 * wrong one is told in core's sentences what is wrong with all of it at
 * once, rather than one schema error at a time.
 */

export const PluginKind = z.enum(["job_workflow", "pricing_rule", "report_type"]);

export const PluginView = z.object({
  id: Uuid,
  /** The application that registered it. Null only on a sandbox's copy of a workflow. */
  appId: Uuid.nullable(),
  appName: z.string(),
  kind: PluginKind,
  key: z.string(),
  name: z.string(),
  /** The version in force. */
  version: z.number().int(),
  /** The job type a workflow is for. */
  jobTypeId: Uuid.nullable(),
  /** The definition in force, as core checked it. */
  definition: z.record(z.unknown()),
  summary: z.string(),
  /** In force: its application is active and it has not been removed. */
  on: z.boolean(),
  retiredAt: z.string().nullable(),
  registeredAt: z.string(),
  changedAt: z.string(),
});

const Registered = z.object({
  plugin: PluginView,
  /** False when what was sent is what was already in force, so no new version was made. */
  changed: z.boolean(),
});

const PluginKey = z.string().min(1).max(48);

export const listPlugins = defineRoute({
  method: "get",
  path: "/v1/plugins",
  summary: "The plugins this application registered",
  description:
    "Every job workflow, pricing rule and report type the application behind the bearer token has registered with this company, removed ones included, with the version in force and whether it is on. Needs no permission, because it answers only about the caller. A signed-in person calling it gets a 404: there is no application behind a session, and the company's whole list is on `GET /v1/apps`.",
  module: "M28",
  permissions: [],
  input: z.object({}),
  output: z.object({ plugins: z.array(PluginView) }),
});

export const registerJobWorkflow = defineRoute({
  method: "post",
  path: "/v1/plugins/job-workflows",
  summary: "Register a job workflow for a job type",
  description:
    "Named stages in order for one job type, each covering some of the nine job statuses (every status in exactly one stage), and gates a job has to meet before it leaves a stage: `{ \"kind\": \"checklist\", \"itemId\" }` for an item on the job type's checklist ticked on a visit, `{ \"kind\": \"field\", \"key\" }` for one of the company's job fields filled in. Moving a job forward past a gate not met is then refused in words; moving it back, inside a stage, or to cancelled never is. Only an application may register one, holding `settings:write` and `job:read`, and `visit:read` for a checklist gate. One workflow per job type: another application's in force is refused, and one whose application is turned off is replaced. Registering the same key again is the next version.",
  module: "M28",
  idempotent: true,
  permissions: ["settings:write", "job:read"],
  input: z.object({
    key: PluginKey,
    name: z.string().min(1).max(120),
    jobTypeId: Uuid,
    stages: z.array(z.object({
      key: z.string().max(48),
      name: z.string().max(60),
      statuses: z.array(z.string()),
      gates: z.array(z.object({
        kind: z.string(),
        itemId: z.string().optional(),
        key: z.string().optional(),
      })).optional(),
    })).max(12),
  }),
  output: Registered,
});

export const retireJobWorkflow = defineRoute({
  method: "delete",
  path: "/v1/plugins/job-workflows/{key}",
  summary: "Remove a job workflow this application registered",
  description: "No longer in force from this call. Kept as a record, and registering the key again brings it back as the next version.",
  module: "M28",
  permissions: ["settings:write"],
  input: z.object({ key: PluginKey }),
  output: z.object({ plugin: PluginView }),
});

export const registerPricingRule = defineRoute({
  method: "post",
  path: "/v1/plugins/pricing-rules",
  summary: "Register a pricing rule",
  description:
    "One of four kinds: `customer_tag` (with `tag`), `job_type` (with `jobTypeId`) and `time_window` (with `window`, either \"outside_hours\" or `{ days, from, to }` in the company's zone), each with exactly one of a signed `percent` or a signed `amount` for the document; or `minimum_charge` (with `minimum`). Applied when an estimate or an invoice is priced, after member pricing and before tax, to lines priced from the company's own price book, in this order: percentages, each from the price after member pricing; then amounts spread over the lines; never below nothing; then the largest minimum. Each line it touched records the rule. Only an application may register one, holding `pricebook:write`, and the permission that reads what the rule asks about: `customer:read` for a tag, `job:read` for a job type, `visit:read` for a time.",
  module: "M28",
  idempotent: true,
  permissions: ["pricebook:write"],
  input: z.object({
    key: PluginKey,
    name: z.string().min(1).max(120),
    rule: z.object({
      kind: z.string(),
      tag: z.string().optional(),
      jobTypeId: z.string().optional(),
      window: z.union([
        z.literal("outside_hours"),
        z.object({ days: z.array(z.number().int()), from: z.string(), to: z.string() }),
      ]).optional(),
      percent: z.string().optional(),
      amount: z.string().optional(),
      minimum: z.string().optional(),
    }),
  }),
  output: Registered,
});

export const retirePricingRule = defineRoute({
  method: "delete",
  path: "/v1/plugins/pricing-rules/{key}",
  summary: "Remove a pricing rule this application registered",
  description: "Not applied to anything priced after this call. Lines it already touched keep their record of it.",
  module: "M28",
  permissions: ["pricebook:write"],
  input: z.object({ key: PluginKey }),
  output: z.object({ plugin: PluginView }),
});

export const registerReportType = defineRoute({
  method: "post",
  path: "/v1/plugins/report-types",
  summary: "Register a report type",
  description:
    "A cut of one of the report builder's datasets (`base`, a key from `GET /v1/report-datasets`): the columns it offers to group by, the numbers it offers, and filters it always carries. It appears in the report builder and on dashboards as a dataset of its own, keyed `app_` and the key. Whoever runs it needs exactly what its base, columns and filters need, scope included, and registering it needs the same of the application, with `report:build`. A key another application uses is refused.",
  module: "M28",
  idempotent: true,
  permissions: ["report:build"],
  input: z.object({
    key: PluginKey,
    label: z.string().min(1).max(80),
    description: z.string().max(500).optional(),
    base: z.string(),
    dimensions: z.array(z.string()).max(20).optional(),
    measures: z.array(z.string()).min(1).max(20),
    filters: z.array(z.object({
      dimension: z.string(),
      op: z.string(),
      value: z.union([z.string(), z.array(z.string())]),
    })).max(10).optional(),
  }),
  output: Registered,
});

export const retireReportType = defineRoute({
  method: "delete",
  path: "/v1/plugins/report-types/{key}",
  summary: "Remove a report type this application registered",
  description: "No longer offered from this call, and a saved report on it no longer runs.",
  module: "M28",
  permissions: ["report:build"],
  input: z.object({ key: PluginKey }),
  output: z.object({ plugin: PluginView }),
});

export const getJobStages = defineRoute({
  method: "get",
  path: "/v1/jobs/{id}/stages",
  summary: "Where a job is in its job type's workflow",
  description:
    "The stages of the workflow a connected application registered for the job's type, which one the job is in, and each stage's gates with whether they are met. A checklist gate reads as not known (`met: null`) to a caller who may not read visits. Empty when the job's type has no workflow in force.",
  module: "M28",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    workflow: z.object({ id: Uuid, name: z.string(), appName: z.string(), version: z.number().int() }).nullable(),
    stages: z.array(z.object({
      key: z.string(),
      name: z.string(),
      statuses: z.array(z.string()),
      current: z.boolean(),
      gates: z.array(z.object({
        kind: z.enum(["checklist", "field"]),
        label: z.string(),
        met: z.boolean().nullable(),
      })),
    })),
  }),
});

export const listReportDatasets = defineRoute({
  method: "get",
  path: "/v1/report-datasets",
  summary: "The datasets the report builder offers the caller",
  description:
    "Each dataset with the columns and numbers the caller may use, by key and label: the product's, the company's own fields and kinds of record, and the report types connected applications registered. What a report type's `base`, `dimensions`, `measures` and filters name.",
  module: "M21",
  permissions: ["report:read"],
  input: z.object({}),
  output: z.object({
    datasets: z.array(z.object({
      key: z.string(),
      label: z.string(),
      description: z.string(),
      dimensions: z.array(z.object({ key: z.string(), label: z.string() })),
      measures: z.array(z.object({ key: z.string(), label: z.string() })),
    })),
  }),
});

export const pluginRoutes = {
  listReportDatasets,
  listPlugins,
  registerJobWorkflow,
  retireJobWorkflow,
  registerPricingRule,
  retirePricingRule,
  registerReportType,
  retireReportType,
  getJobStages,
} as const;
