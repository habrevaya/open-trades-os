import { randomBytes } from "node:crypto";
import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan, connectors } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { FALLBACKS, type LeadFieldMap } from "../marketing/lead-webhook";
import { secretStore } from "../secrets/store";

/**
 * SETTING UP A LEAD SOURCE, WHICH NOTHING COULD DO
 *
 * The signed webhook endpoint has existed for a while. So has `receiveLead`,
 * and so has the `lead_source_connector` table with a `webhook_token` column
 * and a unique index on it. What did not exist was any way to CREATE one: no
 * service inserted a row, so there was no URL to give a sender, no signing
 * secret to give them, and no field map to store. The endpoint was reachable
 * and unreachable at the same time.
 *
 * That is the gap this file closes, and it is the difference between "a
 * partner can POST JSON at us" and "an office manager can set up Angi before
 * lunch".
 *
 * THREE THINGS MAKE IT USABLE RATHER THAN MERELY POSSIBLE.
 *
 * A URL AND A SECRET, HANDED OVER ONCE. Both are generated here. The secret
 * is returned exactly once, from `create` and `rotateSecret`, and no read
 * path returns it, for the same reason the webhook signing secret and the
 * Stripe key are not readable: a secret a list endpoint will hand over on
 * request leaks through every screen, log and support transcript that ever
 * shows a connector.
 *
 * A FIELD MAP CHECKED AGAINST WHAT THIS PRODUCT ACTUALLY HAS. See `TARGETS`.
 *
 * A DRY RUN. `testMapping` takes a sample body and shows what it would become
 * without writing anything. Every sender's JSON is a different shape, and the
 * alternative to trying one is an operator publishing a webhook URL and
 * finding out from a dispatcher that four leads arrived with no phone number.
 */

/**
 * EVERY FIELD A SENDER CAN BE MAPPED ONTO, AND WHAT IT BECOMES HERE.
 *
 * This is the "connecting to the right objects" part, and it is data rather
 * than prose because the alternative is the failure this codebase keeps
 * finding: a map stored as jsonb, whose keys are checked by nothing, sitting
 * beside a TypeScript interface that is checked at compile time and therefore
 * not at all by the time a settings call arrives.
 *
 * A key outside this list is REFUSED rather than stored and ignored. Stored
 * and ignored is the expensive version: the operator maps the sender's
 * `phone_number` onto `contact_phone`, sees it saved, and every lead arrives
 * with nobody to ring, because the real key is `contactPhone` and nothing
 * ever told them.
 *
 * `becomes` is not decoration either. It is what the settings screen shows
 * beside each row, because an operator mapping a field needs to know whether
 * they are filling in a name on a job or the name of a customer who will
 * exist afterwards.
 */
export const TARGETS = [
  {
    key: "externalId",
    label: "Their reference",
    becomes: "lead_offer.external_id, which is what makes a resend the same lead rather than a second one",
    required: true,
  },
  {
    key: "contactName",
    label: "Name",
    becomes: "lead_offer.contact_name, and the customer's name when the lead is accepted",
    required: true,
  },
  {
    key: "contactPhone",
    label: "Phone",
    becomes: "lead_offer.contact_phone, and the customer's phone when accepted",
    required: false,
  },
  {
    key: "contactEmail",
    label: "Email",
    becomes: "lead_offer.contact_email, and the customer's email when accepted",
    required: false,
  },
  {
    key: "addressLine1",
    label: "Address",
    becomes: "lead_offer.address_line1, and the property when accepted",
    required: false,
  },
  { key: "city", label: "City", becomes: "lead_offer.city, and the property", required: false },
  { key: "state", label: "State", becomes: "lead_offer.state, and the property", required: false },
  {
    key: "postalCode",
    label: "Postcode",
    becomes: "lead_offer.postal_code, and the property",
    required: false,
  },
  {
    key: "serviceRequested",
    label: "What they want doing",
    becomes: "lead_offer.service_requested, and the job summary when accepted",
    required: false,
  },
  {
    key: "notes",
    label: "Notes",
    becomes: "lead_offer.notes, and the job description when accepted",
    required: false,
  },
  {
    key: "estimatedValue",
    label: "What it is worth",
    becomes: "lead_offer.estimated_value, which the auto accept rules read",
    required: false,
  },
  {
    key: "expiresAt",
    label: "Offer expires",
    becomes: "lead_offer.expires_at, which orders the open offers list",
    required: false,
  },
] as const satisfies readonly {
  key: keyof LeadFieldMap; label: string; becomes: string; required: boolean;
}[];

const TARGET_KEYS = new Set(TARGETS.map((t) => t.key as string));

/**
 * A NAME AND SOME WAY TO REACH THEM, OR IT IS NOT A LEAD.
 *
 * The same rule `lead-webhook.ts` applies when it parses, stated here so the
 * operator meets it while they are configuring rather than after four leads
 * have been silently refused. A row in the CRM with a name and no phone
 * number reads to whoever opens it as a lead somebody failed to call.
 */
function assertReachable(map: LeadFieldMap): void {
  const hasName = Boolean(map.contactName) || Boolean(FALLBACKS.contactName?.length);
  const hasReach = Boolean(map.contactPhone) || Boolean(map.contactEmail)
    || Boolean(FALLBACKS.contactPhone?.length) || Boolean(FALLBACKS.contactEmail?.length);

  if (!hasName || !hasReach) {
    throw new ConflictError(
      "Map a name, and a phone number or an email. A lead with nobody to ring is refused when "
      + "it arrives, and the sender is told nothing useful about why.",
    );
  }
}

/**
 * Check a stored map against the fields this product really has.
 *
 * Exported because the settings screen wants the same answer before it saves,
 * and because a second copy of this rule living in a form is how the form and
 * the service come to disagree.
 */
export function checkFieldMap(raw: Record<string, unknown>): Record<string, string> {
  const unknown = Object.keys(raw).filter((key) => !TARGET_KEYS.has(key));
  if (unknown.length > 0) {
    throw new ConflictError(
      `${unknown.map((u) => `"${u}"`).join(", ")} ${unknown.length === 1 ? "is not a field" : "are not fields"} `
      + "this product can put a lead into, so anything mapped there would be saved and never "
      + `shown. The fields are: ${TARGETS.map((t) => t.key).join(", ")}.`,
    );
  }

  const map: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined || value === "") continue;
    if (typeof value !== "string") {
      throw new ConflictError(
        `The mapping for "${key}" has to be the path to a field in the sender's JSON, written `
        + `as text like "contact.phone".`,
      );
    }
    map[key] = value.trim();
  }

  assertReachable(map as LeadFieldMap);
  return map;
}

/* ------------------------------------------------------------- the secret */

const SECRET_PREFIX = "lhsec_";
const newSecret = () => `${SECRET_PREFIX}${randomBytes(32).toString("base64url")}`;
const newToken = () => randomBytes(24).toString("base64url");

/**
 * Where the signing secret lives.
 *
 * In the deployment's secret store under a name this returns, never in a
 * database row, which is the same posture as every other credential here. The
 * webhook route reads it through `credentialRef`, so the operator puts the
 * value we hand them under this name and the two meet without the secret ever
 * being a column.
 */
const refFor = (connectorId: string) => `OTOS_LEAD_WEBHOOK_${connectorId.replace(/-/g, "_").toUpperCase()}`;

function shape(row: typeof schema.leadSourceConnector.$inferSelect) {
  return {
    id: row.id,
    source: row.source,
    displayName: row.displayName,
    active: row.active,
    /** The half of the URL this product knows. The host is the deployment's own. */
    webhookPath: row.webhookToken ? `/api/webhooks/leads/${row.webhookToken}` : null,
    /** Where the signing secret is expected to be found. Never the secret. */
    secretRef: refFor(row.id),
    /**
     * The variable to put the secret in, when this deployment keeps secrets
     * in its environment: this company's own prefix and then `secretRef`.
     */
    secretEnvironmentVariable: secretStore().kind === "environment"
      ? connectors.environmentVariableFor(row.organizationId, refFor(row.id))
      : null,
    fieldMap: row.fieldMap ?? {},
    autoAcceptEnabled: row.autoAcceptEnabled,
    autoAcceptRules: row.autoAcceptRules,
    commissionRate: row.commissionRate,
    leadFee: row.leadFee,
  };
}

export interface ConnectorInput {
  /** "angi", "thumbtack", "our_website". Free text: the senders are not a closed set. */
  source: string;
  displayName: string;
  fieldMap?: Record<string, unknown> | undefined;
  commissionRate?: string | null | undefined;
  leadFee?: string | null | undefined;
}

/**
 * Set one up, and hand over the two things a sender needs.
 *
 * The secret comes back ONCE. Losing it means rotating, which is the same
 * action somebody would take if it leaked, so there is no read path for it
 * and nothing is lost by having none.
 */
export async function create(ctx: ServiceContext, input: ConnectorInput) {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const source = input.source.trim().toLowerCase();
    const displayName = input.displayName.trim();

    if (!/^[a-z][a-z0-9_]{0,63}$/.test(source)) {
      throw new ConflictError(
        `"${input.source}" is not a usable source name. Lowercase letters, digits and `
        + "underscores: it is the string that appears on every lead's attribution and in the "
        + "spend report, so it has to survive being a column header.",
      );
    }
    if (displayName === "") {
      throw new ConflictError(
        "Give it a name somebody will recognise on the offers screen. The source is what the "
        + "reports group by; this is what a dispatcher reads at seven in the morning.",
      );
    }

    const fieldMap = checkFieldMap(input.fieldMap ?? {});
    const secret = newSecret();

    const [row] = await tx.insert(schema.leadSourceConnector).values({
      organizationId: ctx.actor.organizationId,
      source,
      displayName,
      webhookToken: newToken(),
      fieldMap,
      commissionRate: input.commissionRate ?? null,
      leadFee: input.leadFee ?? null,
      active: true,
    }).returning();

    /**
     * The connection carries the credential reference, because that is where
     * the webhook route looks for it. A connector with no connection answers
     * 409 rather than accepting unsigned leads, which is correct and is also
     * a setup that silently does not work, so it is made here rather than
     * left as a second step somebody has to know about.
     */
    const [connection] = await tx.insert(schema.integrationConnection).values({
      organizationId: ctx.actor.organizationId,
      capability: "lead_source",
      provider: `lead_webhook:${source}`,
      status: "connected",
      accountLabel: displayName,
      credentialRef: refFor(row!.id),
    }).returning({ id: schema.integrationConnection.id });

    const [linked] = await tx.update(schema.leadSourceConnector)
      .set({ connectionId: connection!.id, updatedAt: new Date() })
      .where(eq(schema.leadSourceConnector.id, row!.id))
      .returning();

    /**
     * The secret is NOT in the audit entry. `audit:read` is a much longer
     * list of people than the one person who set this up.
     */
    await audit(tx, ctx, "lead_connector.created", "lead_source_connector", row!.id, null, {
      source, displayName,
    });

    return {
      ...shape(linked!),
      /**
       * Shown once. Put it in the deployment's secret store under `secretRef`
       * and give the same value to whoever is sending the leads.
       */
      secret,
      /** A worked example, because an integrator gets the order wrong about half the time. */
      signing: "HMAC-SHA256 over `${timestamp}.${url}.${body}`, hex, in x-otos-signature, with the same timestamp in x-otos-timestamp",
    };
  });
}

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const rows = await tx.select().from(schema.leadSourceConnector)
      .where(and(
        eq(schema.leadSourceConnector.organizationId, ctx.actor.organizationId),
        isNull(schema.leadSourceConnector.deletedAt),
      ))
      .orderBy(asc(schema.leadSourceConnector.createdAt));
    return rows.map(shape);
  });
}

export async function update(
  ctx: ServiceContext,
  input: {
    id: string;
    displayName?: string | undefined;
    fieldMap?: Record<string, unknown> | undefined;
    active?: boolean | undefined;
    commissionRate?: string | null | undefined;
    leadFee?: string | null | undefined;
  },
) {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);

    const [after] = await tx.update(schema.leadSourceConnector).set({
      ...(input.displayName !== undefined ? { displayName: input.displayName.trim() } : {}),
      ...(input.fieldMap !== undefined ? { fieldMap: checkFieldMap(input.fieldMap) } : {}),
      ...(input.active !== undefined ? { active: input.active } : {}),
      ...(input.commissionRate !== undefined ? { commissionRate: input.commissionRate } : {}),
      ...(input.leadFee !== undefined ? { leadFee: input.leadFee } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.leadSourceConnector.id, input.id)).returning();

    await audit(tx, ctx, "lead_connector.updated", "lead_source_connector", input.id, before, after!);
    return shape(after!);
  });
}

/**
 * A new secret and a new URL, together.
 *
 * Both, deliberately. Rotating the secret alone leaves the old URL live with
 * a secret somebody may still hold; rotating the token alone leaves a secret
 * that may have leaked still valid on the new one. An operator rotating is
 * responding to a worry and should not have to reason about which half of the
 * pair they fixed.
 */
export async function rotateSecret(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);
    const secret = newSecret();

    const [after] = await tx.update(schema.leadSourceConnector)
      .set({ webhookToken: newToken(), updatedAt: new Date() })
      .where(eq(schema.leadSourceConnector.id, input.id))
      .returning();

    await audit(tx, ctx, "lead_connector.rotated", "lead_source_connector", input.id, before, after!);
    return { ...shape(after!), secret };
  });
}

export async function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "integration:write", async (tx) => {
    const before = await load(tx, ctx.actor.organizationId, input.id);

    /**
     * The token is cleared as well as the row being deleted, so a sender
     * still POSTing at the old URL gets a 404 rather than reaching a soft
     * deleted row. The unique index on the token also stops a future
     * connector colliding with a tombstone.
     */
    const [after] = await tx.update(schema.leadSourceConnector)
      .set({ deletedAt: new Date(), active: false, webhookToken: null, updatedAt: new Date() })
      .where(eq(schema.leadSourceConnector.id, input.id))
      .returning();

    await audit(tx, ctx, "lead_connector.removed", "lead_source_connector", input.id, before, after!);
    return { id: input.id, removed: true as const };
  });
}

async function load(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.leadSourceConnector)
    .where(and(
      eq(schema.leadSourceConnector.id, id),
      eq(schema.leadSourceConnector.organizationId, organizationId),
      isNull(schema.leadSourceConnector.deletedAt),
    )).limit(1);
  if (!row) throw new NotFoundError("Lead connector");
  return row;
}

/* ---------------------------------------------------------------- dry run */

/**
 * WHAT THIS SENDER'S JSON WOULD BECOME, WITHOUT WRITING ANYTHING.
 *
 * The single thing that turns this from a developer integration into
 * something an office manager can finish. Every sender's body is a different
 * shape and the mapping is guesswork until somebody tries one; the
 * alternative is publishing a URL and learning from a dispatcher three days
 * later that every lead arrived with no phone number.
 *
 * It reports what is MISSING as loudly as what matched, because a mapping
 * that quietly produces nulls looks exactly like a mapping that works.
 */
export async function testMapping(
  ctx: ServiceContext,
  input: { id?: string | undefined; fieldMap?: Record<string, unknown> | undefined; sample: Record<string, unknown> },
) {
  return guardedRead(ctx, "integration:read", async (tx) => {
    const map: Record<string, string> = input.fieldMap !== undefined
      ? checkFieldMap(input.fieldMap)
      : input.id
        ? (await load(tx, ctx.actor.organizationId, input.id)).fieldMap ?? {}
        : {};

    const read = (path: string | undefined, fallbacks: readonly string[]): string | null => {
      for (const candidate of path ? [path, ...fallbacks] : fallbacks) {
        const value = candidate.split(".").reduce<unknown>(
          (current, part) => (current && typeof current === "object"
            ? (current as Record<string, unknown>)[part]
            : undefined),
          input.sample,
        );
        if (typeof value === "string" && value.trim() !== "") return value.trim();
        if (typeof value === "number") return String(value);
      }
      return null;
    };

    const fields = TARGETS.map((target) => {
      const configured = map[target.key];
      const value = read(
        configured,
        (FALLBACKS as Record<string, readonly string[] | undefined>)[target.key] ?? [],
      );
      return {
        key: target.key,
        label: target.label,
        becomes: target.becomes,
        mappedFrom: configured ?? null,
        value,
        required: target.required,
      };
    });

    const missingRequired = fields.filter((f) => f.required && f.value === null).map((f) => f.key);
    const name = fields.find((f) => f.key === "contactName")?.value;
    const phone = fields.find((f) => f.key === "contactPhone")?.value;
    const email = fields.find((f) => f.key === "contactEmail")?.value;

    /**
     * The verdict is the same rule the live parser applies, run here so the
     * operator meets it while they can still change the mapping.
     */
    const wouldBeAccepted = Boolean(name) && Boolean(phone || email)
      && missingRequired.length === 0;

    return {
      wouldBeAccepted,
      /** Written for the person configuring it, not for a developer. */
      reason: wouldBeAccepted
        ? null
        : !name
          ? "No name came out of this. Nothing can be put on the board without one."
          : !phone && !email
            ? "A name and no way to reach them. This lead would be refused when it arrived."
            : `Nothing mapped for: ${missingRequired.join(", ")}.`,
      fields,
      /** Keys in the sample nothing is mapped to, so an operator can see what they are ignoring. */
      unmapped: Object.keys(input.sample).filter((key) =>
        !Object.values(map).includes(key)
        && !fields.some((f) => f.mappedFrom?.split(".")[0] === key)),
    };
  });
}

export const handlers = {
  createLeadConnector: (ctx: ServiceContext, input: ConnectorInput) => create(ctx, input),

  listLeadConnectors: async (ctx: ServiceContext) => ({ connectors: await list(ctx) }),

  updateLeadConnector: (
    ctx: ServiceContext,
    input: {
      id: string; displayName?: string | undefined;
      fieldMap?: Record<string, unknown> | undefined; active?: boolean | undefined;
      commissionRate?: string | null | undefined; leadFee?: string | null | undefined;
    },
  ) => update(ctx, input),

  rotateLeadConnectorSecret: (ctx: ServiceContext, input: { id: string }) =>
    rotateSecret(ctx, input),

  deleteLeadConnector: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),

  testLeadMapping: (
    ctx: ServiceContext,
    input: { id?: string | undefined; fieldMap?: Record<string, unknown> | undefined; sample: Record<string, unknown> },
  ) => testMapping(ctx, input),

  /**
   * The list of things a lead field can be mapped onto.
   *
   * It is a constant, so there is nothing tenant scoped to leak, and the first
   * version took no context and checked nothing for exactly that reason. The
   * route declares `integration:read` all the same, and a declared permission
   * nothing asserts is the defect `permissions-enforced.test.ts` exists for one
   * level down: an owner withholding it believes they have withheld something.
   *
   * So it is checked. `assertCan` rather than `guardedRead`, because there is no
   * query to run inside a tenant and opening a transaction to read a constant
   * would be the same claim made more expensively.
   */
  listLeadFieldTargets: async (ctx: ServiceContext) => {
    assertCan(ctx.actor, "integration:read");
    return { targets: TARGETS.map((t) => ({ ...t })) };
  },
} as const;
