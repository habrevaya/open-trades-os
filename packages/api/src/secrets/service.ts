import { and, eq, isNull } from "drizzle-orm";
import { schema } from "@opentradesos/db";
import { assertCan, connectors } from "@opentradesos/core";
import { audit, ConflictError, guardedRead, guardedWrite, NotFoundError, type ServiceContext } from "../services/context";
import { secretNamesOf } from "../services/lead-intake";
import { assertSecretName, secretStore, type SecretStatus } from "./store";
import type { DatabaseSecretStore } from "./database";

/**
 * A COMPANY'S SECRETS, WRITE ONLY
 *
 * Paste a value once; it is encrypted and stored, and what comes back is
 * whether something is set and its last four characters. There is no read.
 * A secret somebody can read back through an API is a secret anybody with
 * that permission, or their stolen session, can carry away; one that can
 * only be replaced is one whose worst case is being replaced.
 *
 * `integration:write` to change one, the permission that already decides
 * which provider a company's money and messages go through. Every change is
 * audited by name, and the audit entry records THAT it changed and nothing
 * about the value, not even the last four: `audit:read` is a much longer list
 * of people than `integration:write`.
 *
 * Only with the database store. With the environment store the operator sets
 * the variable, and the refusal says which one.
 */

function databaseStore(organizationId: string, name: string): DatabaseSecretStore {
  const store = secretStore();
  if (store.kind === "database") return store as DatabaseSecretStore;
  throw new ConflictError(
    "This deployment keeps secrets in its environment, so they are set on the server rather than here. "
    + `Set ${connectors.environmentVariableFor(organizationId, name)} and restart.`,
  );
}

/** Every name this company's connections point at, plus every name it has stored. */
async function namesInUse(ctx: ServiceContext): Promise<string[]> {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const rows = await tx.select({
      provider: schema.integrationConnection.provider,
      credentialRef: schema.integrationConnection.credentialRef,
      settings: schema.integrationConnection.settings,
    }).from(schema.integrationConnection).where(and(
      eq(schema.integrationConnection.organizationId, ctx.actor.organizationId),
      isNull(schema.integrationConnection.deletedAt),
    ));
    return [...new Set(rows.flatMap((row) =>
      secretNamesOf(row.provider, row.credentialRef, row.settings as Record<string, unknown> | null)))];
  });
}

export async function list(ctx: ServiceContext): Promise<{ store: "environment" | "database"; secrets: SecretStatus[] }> {
  const store = secretStore();
  const referenced = (await namesInUse(ctx)).filter((name) => connectors.checkSecretName(name).ok);
  const org = ctx.actor.organizationId;
  if (store.kind !== "database") {
    return { store: "environment", secrets: await store.status(ctx.db, org, referenced.sort()) };
  }
  const stored = await (store as DatabaseSecretStore).list(ctx.db, org);
  const storedNames = new Set(stored.map((s) => s.name));
  const missing = await store.status(ctx.db, org, referenced.filter((name) => !storedNames.has(name)));
  return {
    store: "database",
    secrets: [...stored, ...missing].sort((a, b) => a.name.localeCompare(b.name)),
  };
}

export async function put(ctx: ServiceContext, input: { name: string; value: string }): Promise<SecretStatus> {
  // The permission before anything about the input, so a caller without it
  // learns nothing, not even whether the name was well formed.
  assertCan(ctx.actor, "integration:write");
  assertSecretName(input.name);
  const value = input.value.trim();
  if (value === "") throw new ConflictError("Paste the secret. An empty value is not stored; clear it instead.");
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const store = databaseStore(ctx.actor.organizationId, input.name);
    const [before] = await store.status(tx, ctx.actor.organizationId, [input.name]);
    await store.write(tx, ctx.actor.organizationId, input.name, value);
    const [after] = await store.status(tx, ctx.actor.organizationId, [input.name]);
    const [row] = await tx.select({ id: schema.integrationSecret.id }).from(schema.integrationSecret)
      .where(and(
        eq(schema.integrationSecret.organizationId, ctx.actor.organizationId),
        eq(schema.integrationSecret.name, input.name),
      )).limit(1);
    // That it changed, and the name. Never the value, and not its last four.
    await audit(tx, ctx, before!.set ? "secret.replaced" : "secret.set", "integration_secret", row!.id,
      { name: input.name, set: before!.set }, { name: input.name, set: true });
    return after!;
  });
}

export async function remove(ctx: ServiceContext, input: { name: string }): Promise<{ name: string; removed: true }> {
  assertCan(ctx.actor, "integration:write");
  assertSecretName(input.name);
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const store = databaseStore(ctx.actor.organizationId, input.name);
    const [row] = await tx.select({ id: schema.integrationSecret.id }).from(schema.integrationSecret)
      .where(and(
        eq(schema.integrationSecret.organizationId, ctx.actor.organizationId),
        eq(schema.integrationSecret.name, input.name),
      )).limit(1);
    if (!row) throw new NotFoundError(`Secret "${input.name}"`);
    await store.remove(tx, ctx.actor.organizationId, input.name);
    await audit(tx, ctx, "secret.cleared", "integration_secret", row.id,
      { name: input.name, set: true }, { name: input.name, set: false });
    return { name: input.name, removed: true as const };
  });
}

export const handlers = {
  listSecrets: (ctx: ServiceContext, _input: Record<string, never>) => list(ctx),
  putSecret: (ctx: ServiceContext, input: { name: string; value: string }) => put(ctx, input),
  deleteSecret: (ctx: ServiceContext, input: { name: string }) => remove(ctx, input),
};
