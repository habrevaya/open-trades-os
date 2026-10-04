import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * A SANDBOX: A PRACTICE COPY OF THE COMPANY'S SETTINGS
 *
 * A second company, a real tenant, holding a copy of this one's job types,
 * custom fields, kinds of record, saved reports, proposal layouts and
 * automations (all switched off), none of its customers, and optional
 * anonymised sample work. Nothing in it can reach a real customer, because
 * row level security keeps two companies apart and the sandbox has no
 * integrations to send anything with. Chosen settings are copied back item
 * by item, by the real company's own services, as the person copying.
 *
 * Moving a signed in session into the sandbox and back is the web app's,
 * because an app token belongs to one company; an app connected to the real
 * company makes, reads, copies back from and throws away its sandbox here.
 */

const PlanItem = z.object({
  /** What to send back in `items`: the kind and the setting's name or key. */
  id: z.string(),
  kind: z.enum(["custom_object", "custom_field", "proposal_template", "workflow"]),
  naturalKey: z.string(),
  label: z.string(),
  /** What copying it would do to the real company: make it, change it, or nothing because it is the same. */
  action: z.enum(["create", "update", "same"]),
});

export const getSandbox = defineRoute({
  method: "get",
  path: "/v1/sandbox",
  summary: "Whether this company is a sandbox, or has one",
  module: "M28",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({
    isSandbox: z.boolean(),
    production: z.object({ id: Uuid, name: z.string() }).nullable(),
    sandbox: z.object({ id: Uuid, name: z.string(), createdAt: z.string() }).nullable(),
  }),
});

export const createSandbox = defineRoute({
  method: "post",
  path: "/v1/sandbox",
  summary: "Make a sandbox copy of this company's settings",
  description:
    "Copies the configuration and none of the customers. With `sampleData`, adds up to twenty five sample jobs drawn from the most recent real ones with every name, street, email and phone number invented: only the town is real. The person making it is its owner and its only member. Refused when the company already has one.",
  module: "M28",
  permissions: ["sandbox:manage"],
  idempotent: true,
  input: z.object({ sampleData: z.boolean().optional() }),
  output: z.object({
    sandboxOrganizationId: Uuid,
    name: z.string(),
    copied: z.object({
      jobTypes: z.number().int(), customFields: z.number().int(), kinds: z.number().int(),
      workflows: z.number().int(), reports: z.number().int(), proposalTemplates: z.number().int(),
    }),
    sampleJobs: z.number().int(),
  }),
});

export const discardSandbox = defineRoute({
  method: "delete",
  path: "/v1/sandbox",
  summary: "Throw the sandbox away",
  description: "Everybody in it is signed out of it and it cannot be opened again. A new one can then be made from today's settings.",
  module: "M28",
  permissions: ["sandbox:manage"],
  idempotent: true,
  input: z.object({}),
  output: z.object({ sandboxOrganizationId: Uuid, discarded: z.literal(true) }),
});

export const getSandboxCopyPlan = defineRoute({
  method: "get",
  path: "/v1/sandbox/settings",
  summary: "The sandbox's settings, and what copying each back would do",
  module: "M28",
  permissions: ["sandbox:manage"],
  input: z.object({}),
  output: z.object({
    available: z.array(PlanItem),
    chosen: z.array(PlanItem).nullable(),
    unknown: z.array(z.string()),
  }),
});

export const copyBackFromSandbox = defineRoute({
  method: "post",
  path: "/v1/sandbox/copy-back",
  summary: "Copy chosen settings from the sandbox into this company",
  description:
    "All of them or none. Each goes through this company's own service as the caller, so anything that service would refuse (a field that contradicts stored values, a step the caller may not publish) refuses the whole copy. A new automation arrives switched off; one with the same name gets a new version and keeps whether it was on. Send a dry run first to see every row it would write.",
  module: "M28",
  permissions: ["sandbox:manage"],
  idempotent: true,
  dryRun: true,
  input: z.object({ items: z.array(z.string().max(300)).min(1).max(200) }),
  output: z.object({ applied: z.array(PlanItem.omit({ id: true })) }),
});

export const sandboxRoutes = {
  getSandbox, createSandbox, discardSandbox, getSandboxCopyPlan, copyBackFromSandbox,
} as const;
