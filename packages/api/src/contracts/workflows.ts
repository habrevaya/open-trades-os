import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * AUTOMATIONS, ON THE API: SEE IT AND STOP IT
 *
 * `services/workflows.ts` was reachable only from `/automations`, so an operator
 * away from a browser, an integration, and an agent asked "why did this customer
 * get that text" all had nothing to read, and nothing could turn an automation
 * off.
 *
 * The screen's own header says what this module is for: what exists, what it did,
 * and make it stop. Those are the routes here, and the stop is the important one.
 * An automation sending the wrong thing to customers with no way to stop it is the
 * failure that ends a trial, and it is worse than the automation not existing.
 *
 * WRITING A DEFINITION IS DELIBERATELY NOT HERE, and the reason is not timidity.
 * A definition carries a condition group, which is a recursive shape, and the
 * OpenAPI generator cannot describe a recursive schema: publishing one would mean
 * publishing a document that does not say what the request is. Worse, publishing a
 * builder's input invites a caller to construct a definition the engine then
 * refuses at publish time, and the authority check on a publish is against what
 * the AUTHOR holds, which is a question about a session rather than about a
 * payload. The builder stays where the permission check can see who is asking.
 */

export const WorkflowStepRef = z.object({ kind: z.string() });

export const WorkflowSummaryView = z.object({
  id: Uuid,
  name: z.string(),
  description: z.string().nullable(),
  enabled: z.boolean(),
  triggerKind: z.string(),
  triggerEvents: z.array(z.string()),
  schedule: z.string().nullable(),
  /** The schedule in words, when there is one. */
  scheduleText: z.string().nullable(),
  dwell: z.object({ shape: z.string(), afterDays: z.number().int() }).nullable(),
  dwellText: z.string().nullable(),
  nextRunAt: z.string().nullable(),
  lastRunAt: z.string().nullable(),
  /** Why it is not firing, when it is not. A schedule that cannot be parsed. */
  scheduleError: z.string().nullable(),
  version: z.number().int().nullable(),
  steps: z.array(WorkflowStepRef),
  /** How the last few runs went, newest first. */
  recent: z.array(z.object({ status: z.string(), at: z.string().nullable() })),
});

export const WorkflowRunView = z.object({
  id: Uuid,
  status: z.string(),
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  /** When a run waiting on a delay comes back. A wait survives a deploy. */
  resumeAt: z.string().nullable(),
  eventName: z.string().nullable(),
  steps: z.array(z.object({
    index: z.number().int(),
    kind: z.string(),
    status: z.string(),
    error: z.string().nullable(),
    output: z.record(z.unknown()).nullable(),
  })),
});

export const listWorkflows = defineRoute({
  method: "get",
  path: "/v1/workflows",
  summary: "What is automated, and whether it is firing",
  description:
    "Each one with its trigger, its schedule in words as well as in cron, and how its last few runs went. `scheduleError` is why an automation is not firing when it is not, which is the state that otherwise looks identical to a quiet week.",
  module: "M29",
  permissions: ["workflow:read"],
  input: z.object({}),
  output: z.object({ workflows: z.array(WorkflowSummaryView) }),
});

export const getWorkflowRuns = defineRoute({
  method: "get",
  path: "/v1/workflows/{id}/runs",
  summary: "What one automation actually did, step by step",
  description:
    "The step rows are the point. \"Why did this customer get that text in March\" is the question this answers, and a run row on its own says only that something happened.",
  module: "M29",
  permissions: ["workflow:read"],
  input: z.object({ id: Uuid, runs: z.number().int().min(1).max(50).optional() }),
  output: z.object({ runs: z.array(WorkflowRunView) }),
});

export const setWorkflowEnabled = defineRoute({
  method: "post",
  path: "/v1/workflows/{id}/enabled",
  summary: "Turn an automation on or off",
  description:
    "The most important control in the module. Switching one off does not touch runs already in flight: a run that has sent a text has sent it, and pretending otherwise would be a lie about what happened. New triggers stop immediately.",
  module: "M29",
  permissions: ["workflow:write"],
  idempotent: true,
  input: z.object({ id: Uuid, enabled: z.boolean() }),
  output: z.object({ id: Uuid, enabled: z.boolean() }),
});

export const listWorkflowEvents = defineRoute({
  method: "get",
  path: "/v1/workflow-events",
  summary: "What an automation can trigger on",
  description:
    "The catalogue, with the names this company's own log has already seen marked. A name the log holds stays valid even if this build no longer emits it: it is a real thing in that company's history, and refusing it would break automations that work.",
  module: "M29",
  permissions: ["workflow:read"],
  input: z.object({}),
  output: z.object({
    events: z.array(z.object({
      name: z.string(),
      /**
       * What the event means, when this build declares it. Null for a name only
       * this company's log holds, which is the honest answer: nothing in this
       * build can say what an older build meant by it.
       */
      summary: z.string().nullable(),
    })),
  }),
});

export const listWorkflowSteps = defineRoute({
  method: "get",
  path: "/v1/workflow-steps",
  summary: "What an automation can do, and what each step needs",
  description:
    "Every step this build implements, with the permissions it requires. A workflow runs as its author's authority rather than the owner's, so a version declares what its steps need and the author must hold all of it: this is the list that says what that costs before anybody writes one.",
  module: "M29",
  permissions: ["workflow:read"],
  input: z.object({}),
  output: z.object({
    steps: z.array(z.object({
      kind: z.string(),
      label: z.string(),
      description: z.string(),
      permissions: z.array(z.string()),
      /**
       * Whether the CALLER may use it, shown either way with the permissions
       * beside it. A step missing from the list with no explanation reads as a
       * product that cannot do the thing rather than an account that may not.
       */
      allowed: z.boolean(),
    })),
  }),
});

/**
 * RECOMMENDED AUTOMATIONS
 *
 * Turning one on IS on the API, unlike writing a definition, and the
 * difference is the shape of the input: a template's key and a few named
 * values, none of them recursive, rather than a condition group. What it
 * installs is an ordinary workflow, published through the same check as one
 * drawn on the canvas, with the same rule that a workflow cannot do anything
 * its installer may not.
 */
export const WorkflowTemplateView = z.object({
  key: z.string(),
  name: z.string(),
  summary: z.string(),
  /** What has to be true in the company for it to do anything. */
  needs: z.string(),
  parameters: z.array(z.object({
    key: z.string(),
    label: z.string(),
    help: z.string(),
    kind: z.enum(["number", "platform"]),
    default: z.number().int().optional(),
    min: z.number().int().optional(),
    max: z.number().int().optional(),
  })),
  /** The ordinary workflow it installed, when it is installed. */
  installed: z.object({ id: Uuid, enabled: z.boolean(), name: z.string() }).nullable(),
  /** Why it cannot be turned on yet, in words. */
  blockedBy: z.string().nullable(),
  platforms: z.array(z.object({ platform: z.string(), displayName: z.string() })),
});

export const listWorkflowTemplates = defineRoute({
  method: "get",
  path: "/v1/workflow-templates",
  summary: "Recommended automations, and which are on",
  description:
    "Following up an estimate nobody answered, and asking for a review once a job is paid. Each says what it does, what it needs from the company, and whether it is installed; an installed one is an ordinary workflow at `/v1/workflows`.",
  module: "M29",
  permissions: ["workflow:read"],
  input: z.object({}),
  output: z.object({ templates: z.array(WorkflowTemplateView) }),
});

export const installWorkflowTemplate = defineRoute({
  method: "post",
  path: "/v1/workflow-templates/{key}/install",
  summary: "Turn a recommended automation on",
  description:
    "Installs the template as an ordinary, editable workflow and switches it on. Refused when it is already installed, when a value is outside its bounds, when the installer does not hold every permission its steps need, and, for the review request, when the company has no review rules or no review site with a link to send people to.",
  module: "M29",
  permissions: ["workflow:write"],
  idempotent: true,
  input: z.object({
    key: z.string().min(1).max(60),
    values: z.record(z.union([z.string().max(200), z.number()])).optional(),
  }),
  output: z.object({
    id: Uuid, name: z.string(), enabled: z.boolean(), templateKey: z.string().nullable(),
  }),
});

export const workflowRoutes = {
  listWorkflows, getWorkflowRuns, setWorkflowEnabled, listWorkflowEvents, listWorkflowSteps,
  listWorkflowTemplates, installWorkflowTemplate,
} as const;
