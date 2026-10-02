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

/**
 * Whether a named secret holds anything, and never what.
 *
 * `environmentVariable` is where the operator puts it when the deployment
 * keeps secrets in its environment: the company's own prefix, then the name.
 * `last4` is only kept by the database store.
 */
export const SecretStatus = z.object({
  name: z.string(),
  set: z.boolean(),
  last4: z.string().nullable(),
  updatedAt: z.string().nullable(),
  environmentVariable: z.string().nullable(),
});

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
  /** Where the provider sends webhooks for this connection, after this deployment's public address. */
  webhookPath: z.string().nullable(),
  /** The name of the secret holding the credential, never the value. */
  credentialRef: z.string().nullable(),
  /** Something to do that nothing else here says, such as a secret value left in the database by an earlier version. */
  notice: z.string().nullable(),
  /** Every secret the connection names and whether anything is stored under it. Never a value. */
  secrets: z.array(SecretStatus),
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
    /**
     * Change only what is sent and keep the rest of an existing connection.
     * Without it the settings are replaced whole.
     */
    keepExisting: z.boolean().default(false),
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

/* ------------------------------------------------------------- secrets */

/** A secret's name, as `credentialRef` and every `...Ref` setting hold it. */
const SecretName = z.string().min(1).max(100).regex(/^[A-Za-z_][A-Za-z0-9_]*$/);

export const listSecrets = defineRoute({
  method: "get",
  path: "/v1/secrets",
  summary: "Which secrets this company has set, never what they are",
  description:
    "Every secret this company's connections name, and every one it has stored, with whether it is set and, "
    + "with the database store, its last four characters. There is no route that returns a value.",
  module: "M25",
  permissions: ["integration:read"],
  input: z.object({}),
  output: z.object({
    /** `environment`: the operator sets each one on the server. `database`: pasted here, encrypted. */
    store: z.enum(["environment", "database"]),
    secrets: z.array(SecretStatus),
  }),
});

export const putSecret = defineRoute({
  method: "put",
  path: "/v1/secrets/{name}",
  summary: "Paste a secret, or replace one",
  description:
    "Write only: the value is encrypted and stored, and the answer says it is set and its last four "
    + "characters. Audited by name, never by value. Refused with the variable to set when the deployment "
    + "keeps secrets in its environment. Not offered to AI agents, because a value passed to one passes "
    + "through its model provider.",
  module: "M25",
  permissions: ["integration:write"],
  agentTool: false,
  input: z.object({
    name: SecretName,
    value: z.string().min(1).max(16 * 1024),
  }),
  output: SecretStatus,
});

export const deleteSecret = defineRoute({
  method: "delete",
  path: "/v1/secrets/{name}",
  summary: "Clear a secret",
  module: "M25",
  permissions: ["integration:write"],
  input: z.object({ name: SecretName }),
  output: z.object({ name: z.string(), removed: z.literal(true) }),
});

export const connectorRoutes = {
  listConnectors, connectConnector, disconnectConnector,
  listSecrets, putSecret, deleteSecret,
  importSpendFile, listLeadOffers,
} as const;
