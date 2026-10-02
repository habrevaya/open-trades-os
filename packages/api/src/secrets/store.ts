import type { Database } from "@opentradesos/db";
import { connectors } from "@opentradesos/core";
import { ConflictError } from "../services/context";

/**
 * WHERE A COMPANY'S PROVIDER SECRETS LIVE
 *
 * `integration_connection.credentialRef`, and every `...Ref` setting, hold
 * the NAME of a secret, never its value. This file is what turns a name into
 * a value, and the one rule it exists to keep is that a company can only ever
 * name ITS OWN secrets.
 *
 * That rule was not kept before. The default store read `process.env[name]`
 * with the name exactly as the company typed it, so anybody holding
 * `integration:write` could name AUTH_SECRET, DATABASE_URL or OPERATOR_TOKEN
 * and the server would read the deployment's own secret on their behalf.
 * Paired with a provider `baseUrl` pointing at their own host, the server
 * then sent it to them as a bearer token. On a deployment serving several
 * companies that was every company's sessions; on a self host it was the
 * server's keys in the hands of whoever could connect Stripe.
 *
 * Now every store is asked for (organization, name), never a bare name, and
 * each keeps the organization in the lookup itself:
 *
 *   environment  `OTS_SECRET__<organization id>__<name>`. The company types
 *                the name; the prefix is added here, from the actor's own
 *                organization, so no name a company can type reaches a
 *                variable outside it. The default, for a self host whose
 *                operator is the company.
 *
 *   database     encrypted rows in `integration_secret`, scoped by row level
 *                security and bound to their organization inside the
 *                ciphertext. For a deployment serving several companies,
 *                where the environment is the operator's and not theirs.
 */

export type ReadSecret = (name: string) => Promise<string>;
export type WriteSecret = (name: string, value: string) => Promise<void>;

export interface SecretStatus {
  name: string;
  set: boolean;
  /** The last four characters, shown so somebody can tell which key is in. Null where the store does not keep them. */
  last4: string | null;
  updatedAt: string | null;
  /** Where to put it, for a store the operator fills in outside this product. */
  environmentVariable: string | null;
}

export interface SecretStore {
  readonly kind: "environment" | "database";
  /** Throws `SecretNotSetError` when nothing is stored under the name. */
  read(db: Database, organizationId: string, name: string): Promise<string>;
  /** Durable, where the store can be: OAuth refresh tokens rotate through here. */
  write(db: Database, organizationId: string, name: string, value: string): Promise<void>;
  /** Whether each name holds something. Never the value. */
  status(db: Database, organizationId: string, names: readonly string[]): Promise<SecretStatus[]>;
}

/**
 * Nothing is stored under the name.
 *
 * A ConflictError, so the API answers 409 with the sentence below rather than
 * a 500: the fix is a setting somebody can make, and the sentence names it.
 */
export class SecretNotSetError extends ConflictError {
  constructor(readonly secretName: string, hint: string) {
    super(`No secret named "${secretName}" is set for this company. ${hint}`);
    this.name = "SecretNotSetError";
  }
}

export function assertSecretName(name: string): void {
  const checked = connectors.checkSecretName(name);
  if (!checked.ok) throw new ConflictError(checked.reason);
}

/* ---------------------------------------------------------------- environment */

let warnedAboutRotation = false;

/**
 * The default: one environment variable per company and name.
 *
 * NO FALLBACK TO THE BARE NAME. An install that set `STRIPE_SECRET_KEY` and
 * connected Stripe under that name now gets an error naming the variable
 * this version reads, and has to rename it. Reading the old name when the
 * new one is missing would be the vulnerability again with an extra step.
 */
export const environmentSecretStore: SecretStore = {
  kind: "environment",

  async read(_db, organizationId, name) {
    assertSecretName(name);
    const variable = connectors.environmentVariableFor(organizationId, name);
    const value = process.env[variable];
    if (!value) {
      throw new SecretNotSetError(
        name,
        `This server reads it from the environment variable ${variable}. Set that and restart. `
        + `(Earlier versions read a variable called ${name} alone. That name is no longer read, `
        + `so rename it.)`,
      );
    }
    return value;
  },

  async write(_db, organizationId, name, value) {
    assertSecretName(name);
    process.env[connectors.environmentVariableFor(organizationId, name)] = value;
    if (!warnedAboutRotation) {
      warnedAboutRotation = true;
      console.warn(
        "[secrets] A provider credential rotated and was kept in this process only, because this "
        + "deployment keeps secrets in its environment. Set SECRET_STORE=database, or the connection "
        + "will need reauthorizing after the next restart.",
      );
    }
  },

  async status(_db, organizationId, names) {
    return names.map((name) => {
      // A name an earlier version accepted and this one does not is reported
      // unset, with no variable: there is none it could be put in.
      if (!connectors.checkSecretName(name).ok) {
        return { name, set: false, last4: null, updatedAt: null, environmentVariable: null };
      }
      const variable = connectors.environmentVariableFor(organizationId, name);
      return {
        name,
        set: Boolean(process.env[variable]),
        last4: null,
        updatedAt: null,
        environmentVariable: variable,
      };
    });
  },
};

/* ---------------------------------------------------------------- selection */

let override: SecretStore | null = null;

/** A deployment, or a test, points this at its own store. `null` puts the configured one back. */
export function useSecretStore(store: SecretStore | null): void {
  override = store;
}

/**
 * The store this deployment uses, from `SECRET_STORE`.
 *
 * An unknown value throws rather than falling back to the environment, so a
 * typo in a hosted deployment's configuration is an error at the first
 * secret read and not a quiet return to the store it was meant to leave.
 */
export function secretStore(): SecretStore {
  if (override) return override;
  const configured = (process.env["SECRET_STORE"] ?? "environment").trim() || "environment";
  if (configured === "environment") return environmentSecretStore;
  throw new Error(
    `SECRET_STORE is "${configured}", which this version does not have. Use "environment".`,
  );
}

/** A reader for one organization's secrets. Every default reader in the services is one of these. */
export function readerFor(db: Database, organizationId: string): ReadSecret {
  return (name) => secretStore().read(db, organizationId, name);
}

export function writerFor(db: Database, organizationId: string): WriteSecret {
  return (name, value) => secretStore().write(db, organizationId, name, value);
}
