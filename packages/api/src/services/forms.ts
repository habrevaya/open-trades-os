import { and, desc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { marketing as mk } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, NotFoundError, ConflictError,
  type ServiceContext,
} from "./context";
import { audit } from "./customers";
import * as marketingService from "./marketing";

/**
 * LEAD FORMS
 *
 * `checkForm` validates a definition and `checkSubmission` validates what
 * somebody sent against it, with a refusal per field written for the
 * homeowner rather than for a developer. Both were complete, both were
 * exported, and neither had a caller, because a form definition had nowhere
 * to live.
 *
 * WHY A REFUSED SUBMISSION IS STORED
 *
 * This is the decision that separates this from every form builder a
 * contractor has used. A form that silently drops what it cannot parse is a
 * form whose owner believes it works: the leads it loses are invisible by
 * construction, and the first evidence is a customer ringing to ask why
 * nobody called back after they filled it in twice.
 *
 * So a refused submission is a row, with its refusals, and it shows up on a
 * screen. Somebody can read "eleven people could not submit because the
 * phone field rejected a leading 1" and change the form. Nobody has ever
 * been able to read that.
 *
 * THE DEFINITION IS VALIDATED TWICE. Once when it is stored, and again when
 * a submission is checked against it. Same rule the report definitions
 * follow: a form is edited by an office user and then executed against input
 * from the open internet, and trusting the column is trusting whatever was
 * in it last time somebody had access.
 */

const toDefinition = (row: typeof schema.webForm.$inferSelect): mk.FormDefinition =>
  row.definition as unknown as mk.FormDefinition;

export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const rows = await tx.select().from(schema.webForm)
      .where(and(
        eq(schema.webForm.organizationId, ctx.actor.organizationId),
        isNull(schema.webForm.deletedAt),
      ))
      .orderBy(schema.webForm.title);

    return rows.map((row) => ({
      id: row.id,
      slug: row.slug,
      title: row.title,
      source: row.source,
      fields: toDefinition(row).fields.length,
    }));
  });
}

export interface FormInput {
  slug: string;
  title: string;
  source?: string | undefined;
  fields: mk.FormField[];
  minimumFillSeconds?: number | undefined;
}

/**
 * Create or replace a form.
 *
 * The definition is checked by core before it is stored, and the refusal is
 * returned verbatim. `checkForm` catches the things that make a form
 * unusable rather than merely ugly: two fields with the same key, a choice
 * field with no options, a required field nobody can satisfy.
 */
export async function save(ctx: ServiceContext, input: FormInput) {
  return guardedWrite(ctx, "adspend:write", async (tx) => {
    const definition: mk.FormDefinition = {
      key: input.slug,
      title: input.title,
      fields: input.fields,
      ...(input.minimumFillSeconds === undefined
        ? {}
        : { minimumFillSeconds: input.minimumFillSeconds }),
    };

    const verdict = mk.checkForm(definition);
    if (!verdict.ok) {
      throw new ConflictError(
        `That form cannot be published: ${verdict.problems.join(" ")}`,
      );
    }

    const source = input.source ?? "organic_search";
    if (!(mk.LEAD_SOURCE_KEYS as readonly string[]).includes(source)) {
      throw new ConflictError(
        `"${source}" is not a lead source in the catalogue, so leads from this form would appear in no report.`,
      );
    }

    const [row] = await tx.insert(schema.webForm).values({
      organizationId: ctx.actor.organizationId,
      slug: input.slug,
      title: input.title,
      source,
      definition: definition as unknown as Record<string, unknown>,
    }).onConflictDoUpdate({
      target: [schema.webForm.organizationId, schema.webForm.slug],
      /** The unique index covers live rows only, so a deleted slug is reusable. */
      targetWhere: isNull(schema.webForm.deletedAt),
      set: {
        title: input.title,
        source,
        definition: definition as unknown as Record<string, unknown>,
        updatedAt: new Date(),
      },
    }).returning();

    await audit(tx, ctx, "web_form.saved", "web_form", row!.id, null, { slug: input.slug });
    return { id: row!.id, slug: row!.slug, title: row!.title, source: row!.source };
  });
}

export interface SubmitOutcome {
  accepted: boolean;
  submissionId: string;
  /** Written for the person filling the form in, never for a developer. */
  refusals: { field: string; reason: string; message: string }[];
  /** Set when the form asked for enough to make a customer. */
  customerId: string | null;
}

/**
 * Somebody filled the form in.
 *
 * Takes a Database rather than a ServiceContext, like every other public
 * intake path here: the caller is a homeowner with no account.
 *
 * A REFUSAL IS RETURNED, NOT THROWN, and the row is written either way. The
 * thrown version would be a 4xx the browser shows as a generic failure, and
 * nothing would be stored, which puts this straight back to being a form
 * whose losses are invisible.
 */
export async function submit(
  db: Database,
  input: {
    organizationSlug: string;
    formSlug: string;
    values: Record<string, unknown>;
    startedAt?: Date | undefined;
    visitorId?: string | null;
    landingQuery?: string | null;
    referrer?: string | null;
  },
): Promise<SubmitOutcome> {
  return db.transaction(async (raw) => {
    const tx = raw as unknown as Database;

    const [org] = await tx.select({ id: schema.organization.id })
      .from(schema.organization)
      .where(eq(schema.organization.slug, input.organizationSlug)).limit(1);
    if (!org) throw new NotFoundError("Company");

    const [form] = await tx.select().from(schema.webForm)
      .where(and(
        eq(schema.webForm.organizationId, org.id),
        eq(schema.webForm.slug, input.formSlug),
        isNull(schema.webForm.deletedAt),
      )).limit(1);
    if (!form) throw new NotFoundError("Form");

    const definition = toDefinition(form);
    const decision = mk.checkSubmission(definition, {
      values: input.values,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    });

    /**
     * The touch is recorded whatever the decision, and before the outcome is
     * known. Somebody who arrived from an ad and then could not submit is
     * still a click that channel was paid for, and dropping the touch on a
     * refusal would make a form with a broken field look like a channel that
     * stopped producing.
     */
    const touch = await marketingService.recordTouch(tx, org.id, {
      at: new Date(),
      visitorId: input.visitorId ?? null,
      query: input.landingQuery ?? null,
      referrer: input.referrer ?? null,
    });

    const state = decision.ok
      ? "accepted"
      : decision.reason === "spam" ? "spam" : "rejected";

    const refusals = decision.ok
      ? []
      : decision.reason === "spam"
        ? [{ field: "", reason: "spam", message: decision.detail }]
        : decision.refusals.map((r) => ({ field: r.field, reason: r.reason, message: r.message }));

    const [row] = await tx.insert(schema.formSubmission).values({
      organizationId: org.id,
      formId: form.id,
      state,
      /**
       * Exactly what arrived, whatever it was. A rejected submission whose
       * raw values were discarded cannot be read back, and reading it back
       * is the only way anybody finds out the phone field is rejecting a
       * leading 1.
       */
      raw: input.values as Record<string, unknown>,
      clean: decision.ok ? (decision.values as unknown as Record<string, unknown>) : null,
      refusals,
      touchId: touch.id,
    }).returning({ id: schema.formSubmission.id });

    return {
      accepted: decision.ok,
      submissionId: row!.id,
      refusals,
      customerId: null,
    };
  });
}

/**
 * What arrived, including what was refused.
 *
 * The refused ones are the point. A screen showing only accepted
 * submissions is the same form builder every contractor already has.
 */
export async function submissions(
  ctx: ServiceContext,
  input: { formId?: string | undefined; state?: string | undefined; limit?: number | undefined },
) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const filters = [eq(schema.formSubmission.organizationId, ctx.actor.organizationId)];
    if (input.formId) filters.push(eq(schema.formSubmission.formId, input.formId));
    if (input.state) {
      filters.push(eq(
        schema.formSubmission.state,
        input.state as typeof schema.formSubmissionState.enumValues[number],
      ));
    }

    const rows = await tx.select().from(schema.formSubmission)
      .where(and(...filters))
      .orderBy(desc(schema.formSubmission.createdAt))
      .limit(Math.min(input.limit ?? 50, 200));

    return rows.map((row) => ({
      id: row.id,
      formId: row.formId,
      state: row.state,
      refusals: row.refusals,
      customerId: row.customerId,
      jobId: row.jobId,
      createdAt: row.createdAt,
    }));
  });
}

/**
 * Which fields are losing people, counted.
 *
 * The number nobody has ever been able to read: not "the form gets some
 * submissions", but "eleven people in a fortnight could not get past the
 * phone number field". One of those is a fact somebody can act on in an
 * afternoon.
 */
export async function refusalCounts(ctx: ServiceContext, formId: string) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const rows = await tx.select({ refusals: schema.formSubmission.refusals })
      .from(schema.formSubmission)
      .where(and(
        eq(schema.formSubmission.organizationId, ctx.actor.organizationId),
        eq(schema.formSubmission.formId, formId),
        eq(schema.formSubmission.state, "rejected"),
      ));

    const byField = new Map<string, { field: string; reason: string; count: number }>();
    for (const row of rows) {
      for (const refusal of row.refusals) {
        const key = `${refusal.field}:${refusal.reason}`;
        const entry = byField.get(key) ?? { field: refusal.field, reason: refusal.reason, count: 0 };
        entry.count += 1;
        byField.set(key, entry);
      }
    }

    return [...byField.values()].sort((a, b) => b.count - a.count);
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listForms: async (ctx: ServiceContext): Promise<{
    forms: { id: string; slug: string; title: string; source: string; fields: number }[];
  }> => ({ forms: await list(ctx) }),

  /**
   * The field list is taken structurally and handed straight to core.
   *
   * Zod's inferred shape and core's `FormField` describe the same thing and
   * are not assignable to each other under `exactOptionalPropertyTypes`,
   * because zod writes every optional as `T | undefined` present-but-
   * undefined. The cast is safe because the contract's enum is swept
   * against core's union in vocabulary.test.ts, which is what makes the two
   * lists the same list rather than two that happen to agree today.
   */
  saveForm: (ctx: ServiceContext, input: {
    slug: string; title: string; source?: string | undefined;
    fields: readonly unknown[]; minimumFillSeconds?: number | undefined;
  }): Promise<{ id: string; slug: string; title: string; source: string }> =>
    save(ctx, { ...input, fields: input.fields as mk.FormField[] }),

  submitForm: (db: Database, input: {
    organizationSlug: string; formSlug: string;
    values: Record<string, unknown>;
    startedAt?: string | undefined; visitorId?: string | undefined;
    landingQuery?: string | undefined; referrer?: string | undefined;
  }): Promise<SubmitOutcome> => submit(db, {
    organizationSlug: input.organizationSlug,
    formSlug: input.formSlug,
    values: input.values,
    ...(input.startedAt ? { startedAt: new Date(input.startedAt) } : {}),
    visitorId: input.visitorId ?? null,
    landingQuery: input.landingQuery ?? null,
    referrer: input.referrer ?? null,
  }),

  listSubmissions: async (ctx: ServiceContext, input: {
    formId?: string | undefined; state?: string | undefined; limit: number;
  }): Promise<{
    submissions: {
      id: string; formId: string; state: string;
      refusals: { field: string; reason: string; message: string }[];
      customerId: string | null; jobId: string | null; createdAt: Date;
    }[];
  }> => ({ submissions: await submissions(ctx, input) }),

  getFormRefusals: async (ctx: ServiceContext, input: { formId: string }): Promise<{
    refusals: { field: string; reason: string; count: number }[];
  }> => ({ refusals: await refusalCounts(ctx, input.formId) }),
} as const;
