import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString } from "./common";

/**
 * CONNECTORS
 *
 * The catalogue is published because the honest answer to "does this work
 * with Google Ads" is a state, not a yes or a no, and a product that only
 * publishes the yeses is one nobody can plan against.
 *
 * `state` and `connected` are two fields on purpose. The first says whether
 * an adapter exists at all; the second says whether this company set it up.
 * Collapsing them into one checkbox could only lie about one of them, and
 * the lie has a direction: a spend report missing a channel's cost shows
 * leads with no spend, which reads as a free channel.
 */
export const ConnectorState = z.enum(["built", "declared"]);

export const Connector = z.object({
  key: z.string(),
  label: z.string(),
  capability: z.string(),
  auth: z.string(),
  flows: z.array(z.string()),
  /** Whether an adapter exists. Not whether this company uses it. */
  state: ConnectorState,
  purpose: z.string(),
  /** What the operator has to go and get. A connector with no setup note is a support ticket with a button on it. */
  setup: z.string(),
  /** What it cannot tell you. Present on every entry, because none of them is neutral. */
  limitation: z.string(),
  connected: z.boolean(),
  connectionStatus: z.string().nullable(),
  lastError: z.string().nullable(),
});

export const listConnectors = defineRoute({
  method: "get",
  path: "/v1/connectors",
  summary: "Every connector, and whether this company has it on",
  module: "M25",
  permissions: ["integration:read"],
  input: z.object({ capability: z.string().max(50).optional() }),
  output: z.object({ connectors: z.array(Connector) }),
});

export const connectConnector = defineRoute({
  method: "post",
  path: "/v1/connectors/{provider}",
  summary: "Turn a connector on",
  description:
    "Refuses anything the catalogue calls declared. Letting an operator connect a provider with no adapter produces a settings screen saying it is on, a report with none of its data in it, and an owner concluding the channel is free.",
  module: "M25",
  permissions: ["integration:write"],
  idempotent: true,
  input: z.object({
    provider: z.string().min(1).max(50),
    accountLabel: z.string().max(200).optional(),
    /** A reference into the secret store, never a secret. */
    credentialRef: z.string().max(200).optional(),
    settings: z.record(z.unknown()).default({}),
  }),
  output: z.object({ id: Uuid, provider: z.string(), status: z.string() }),
});

export const disconnectConnector = defineRoute({
  method: "delete",
  path: "/v1/connectors/{provider}",
  summary: "Turn a connector off",
  module: "M25",
  permissions: ["integration:write"],
  input: z.object({ provider: z.string().min(1).max(50) }),
  output: z.object({ provider: z.string(), status: z.string() }),
});

export const importSpendFile = defineRoute({
  method: "post",
  path: "/v1/marketing/spend/file",
  summary: "Load an ad platform's daily export",
  description:
    "Takes the file as text and the channel it is for, because the file does not say: a Google Ads export names Google nowhere in it, and guessing from campaign names puts a whole budget under the wrong channel the first time somebody writes 'google' in a Meta campaign name. Unreadable lines are skipped with their line numbers and the rest imports.",
  module: "M19",
  permissions: ["adspend:write"],
  idempotent: true,
  input: z.object({
    /** Which adapter parses it. `spend_csv` today. */
    provider: z.string().min(1).max(50).default("spend_csv"),
    /** The lead source key every row in this file belongs to. */
    source: z.string().min(1).max(50),
    text: z.string().min(1).max(8 * 1024 * 1024),
  }),
  output: z.object({
    accepted: z.number().int(),
    /** Rows the service rejected: a bad source key, a negative amount. */
    refused: z.array(z.object({ row: z.number().int(), reason: z.string() })),
    /**
     * Lines the parser could not read. Reported separately from refusals
     * because they are a different problem with a different fix, and
     * merging them sends somebody to the wrong one.
     */
    skipped: z.array(z.object({ line: z.number().int(), reason: z.string() })),
  }),
});

export const LeadOffer = z.object({
  id: Uuid,
  connector: z.string(),
  serviceRequested: z.string().nullable(),
  addressLine1: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  postalCode: z.string().nullable(),
  estimatedValue: MoneyString.nullable(),
  expiresAt: z.string().datetime().nullable(),
  /** Computed against the clock, never read from the status. */
  expired: z.boolean(),
  secondsLeft: z.number().int().nullable(),
});

export const listLeadOffers = defineRoute({
  method: "get",
  path: "/v1/lead-offers",
  summary: "Marketplace offers on the table, soonest to expire first",
  description:
    "An offer is not a job. It costs money to accept, it expires in minutes, and a contractor at capacity has to be able to decline without that being a cancelled job on their own board.",
  module: "M25",
  permissions: ["job:read"],
  input: z.object({}),
  output: z.object({ offers: z.array(LeadOffer) }),
});

export const connectorRoutes = {
  listConnectors, connectConnector, disconnectConnector,
  importSpendFile, listLeadOffers,
} as const;
