import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * SETTING UP A LEAD SOURCE
 *
 * The signed webhook endpoint, `receiveLead`, and a `lead_source_connector`
 * table with a unique index on its token have all existed for a while.
 * Nothing created a row. There was no way to get a URL, no way to get a
 * signing secret, and nowhere to put the field map the parser has always
 * accepted, so the endpoint was reachable and unusable at the same time.
 *
 * These routes are the screen that was missing. The shape to aim at is a
 * contractor finishing Angi before lunch: create it, copy two values into
 * whoever is sending, paste one of their leads in to see what it becomes, and
 * turn it on.
 */

export const LeadFieldTarget = z.object({
  key: z.string(),
  label: z.string(),
  /** Which record this ends up on. Shown beside the row being mapped. */
  becomes: z.string(),
  required: z.boolean(),
});

export const LeadConnector = z.object({
  id: Uuid,
  source: z.string(),
  displayName: z.string(),
  active: z.boolean(),
  /** Append to this deployment's own public address to get the URL to hand over. */
  webhookPath: z.string().nullable(),
  /** The name the signing secret is expected under in the secret store. Never the secret. */
  secretRef: z.string(),
  /** With the environment store, the variable to set: this company's prefix, then `secretRef`. Null otherwise. */
  secretEnvironmentVariable: z.string().nullable(),
  fieldMap: z.record(z.string()),
  autoAcceptEnabled: z.boolean(),
  autoAcceptRules: z.record(z.unknown()),
  commissionRate: MoneyString.nullable(),
  leadFee: MoneyString.nullable(),
});

const FieldMap = z.record(z.string().max(200));

export const listLeadFieldTargets = defineRoute({
  method: "get",
  path: "/v1/lead-connectors/fields",
  summary: "Every field a sender can be mapped onto, and what it becomes",
  description:
    "The list the mapping screen is built from. Each entry says which record the value ends up on, because an operator mapping a field needs to know whether they are filling in something on the offer or the name of a customer who will exist afterwards.",
  module: "M19",
  permissions: ["integration:read"],
  input: z.object({}),
  output: z.object({ targets: z.array(LeadFieldTarget) }),
});

export const createLeadConnector = defineRoute({
  method: "post",
  path: "/v1/lead-connectors",
  summary: "Set up a lead source and get its URL and signing secret",
  description:
    "Returns the signing secret exactly once. No read path gives it back, for the same reason no read path gives back a payment processor key: a secret a list endpoint will hand over leaks through every screen, log and support transcript that ever shows a connector. Losing it means rotating, which is the same thing you would do if it leaked.",
  module: "M19",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({
    /** Lowercase, and the string every report groups this channel by. */
    source: z.string().min(1).max(64),
    displayName: z.string().min(1).max(200),
    fieldMap: FieldMap.optional(),
    commissionRate: MoneyString.nullable().optional(),
    leadFee: MoneyString.nullable().optional(),
  }),
  output: LeadConnector.extend({
    /** Shown once. Put it in your secret store under `secretRef` and give it to the sender. */
    secret: z.string(),
    /** A worked example, because integrators get the concatenation order wrong about half the time. */
    signing: z.string(),
  }),
});

export const listLeadConnectors = defineRoute({
  method: "get",
  path: "/v1/lead-connectors",
  summary: "Every lead source this company has set up",
  module: "M19",
  permissions: ["integration:read"],
  input: z.object({}),
  output: z.object({ connectors: z.array(LeadConnector) }),
});

export const updateLeadConnector = defineRoute({
  method: "patch",
  path: "/v1/lead-connectors/{id}",
  summary: "Change the mapping, the name, or whether it is on",
  description:
    "A field map key that is not a field this product can store is refused rather than saved. Saved and ignored is the expensive version: the operator maps the sender's phone number onto a name nothing reads, sees it save, and every lead arrives with nobody to ring.",
  module: "M19",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    displayName: z.string().min(1).max(200).optional(),
    fieldMap: FieldMap.optional(),
    active: z.boolean().optional(),
    commissionRate: MoneyString.nullable().optional(),
    leadFee: MoneyString.nullable().optional(),
  }),
  output: LeadConnector,
});

export const testLeadMapping = defineRoute({
  method: "post",
  path: "/v1/lead-connectors/test",
  summary: "Paste one of their leads in and see what it becomes",
  description:
    "Writes nothing. Every sender's JSON is a different shape and the mapping is guesswork until somebody tries one; the alternative is publishing a URL and learning from a dispatcher three days later that every lead arrived with no phone number. Says what is missing as loudly as what matched, because a mapping that quietly produces nulls looks exactly like one that works.",
  module: "M19",
  permissions: ["integration:read"],
  idempotent: true,
  input: z.object({
    /** An existing connector's mapping, or pass `fieldMap` to try one before saving it. */
    id: Uuid.optional(),
    fieldMap: FieldMap.optional(),
    /** One real body from the sender, exactly as they would POST it. */
    sample: z.record(z.unknown()),
  }),
  output: z.object({
    wouldBeAccepted: z.boolean(),
    /** Written for the person configuring it, not for a developer. */
    reason: z.string().nullable(),
    fields: z.array(LeadFieldTarget.extend({
      /** The path in their JSON this was taken from, or null if nothing is mapped. */
      mappedFrom: z.string().nullable(),
      value: z.string().nullable(),
    })),
    /** Top level keys in the sample nothing is mapped to. */
    unmapped: z.array(z.string()),
  }),
});

export const rotateLeadConnectorSecret = defineRoute({
  method: "post",
  path: "/v1/lead-connectors/{id}/rotate",
  summary: "New URL and new secret, together",
  description:
    "Both, deliberately. Rotating the secret alone leaves the old URL live with a secret somebody may still hold; rotating the URL alone leaves a leaked secret valid on the new one. Somebody rotating is responding to a worry and should not have to reason about which half they fixed.",
  module: "M19",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: LeadConnector.extend({ secret: z.string() }),
});

export const deleteLeadConnector = defineRoute({
  method: "delete",
  path: "/v1/lead-connectors/{id}",
  summary: "Stop accepting leads from this source",
  description:
    "The token is cleared as well, so a sender still posting at the old URL gets a not found rather than reaching a removed row.",
  module: "M19",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const leadConnectorRoutes = {
  listLeadFieldTargets, createLeadConnector, listLeadConnectors,
  updateLeadConnector, testLeadMapping, rotateLeadConnectorSecret, deleteLeadConnector,
} as const;
