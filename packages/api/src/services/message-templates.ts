import { and, asc, eq, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { comms } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, audit, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { render } from "../lib/render";

/**
 * THE WORDS A CUSTOMER ACTUALLY READS
 *
 * `message_template` has been in the schema since the first migration with a
 * comment explaining that it is versioned the way the price book is, and no
 * code has ever written a row. Meanwhile the wording of every message this
 * product sends is a string literal in a service: the arrival notice is built
 * by a function in `dispatch.ts` that no operator can reach, and a workflow
 * step carries its body inside the automation that sends it.
 *
 * WHY THAT IS A REAL PROBLEM AND NOT A PREFERENCE. A company's texts are its
 * voice to a customer standing in their driveway, and the wording is the part
 * they will want to change first: the arrival notice that says "your
 * technician" when they call them an engineer, the reminder that is a
 * sentence too long for a lock screen. Today changing any of it is a pull
 * request. A product whose customer-facing copy requires a developer is one
 * where the copy never changes.
 *
 * It is also how the same sentence ends up written four times. The arrival
 * notice exists in `dispatch.ts`; a workflow that texts on the way carries
 * its own copy; a future reminder will carry a third. They drift, and nothing
 * anywhere compares them.
 *
 * WHAT THIS IS NOT. It is not a second renderer. `workflow-steps.render` has
 * resolved `{{ customer.name }}` against a scope since the workflow engine
 * was built, and it is imported here rather than reimplemented, because two
 * renderers disagreeing about an edge case means a template that previews
 * correctly and sends wrong.
 *
 * AND EDITING A TEMPLATE DOES NOT REWRITE HISTORY. A message keeps its own
 * rendered body, which the schema comment already says and `message.body`
 * already does. What was sent last year is a fact about that message; this is
 * only what future sends are built from.
 */

/** The placeholder syntax, which is the engine's, not a second one. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;

const CODE = /^[a-z][a-z0-9_.]{0,63}$/;

export interface TemplateInput {
  code: string;
  name: string;
  channel: comms.Channel;
  purpose?: comms.Purpose | undefined;
  subject?: string | null | undefined;
  body: string;
  /** Declared, so the editor can offer them and a send can be checked. */
  variables?: string[] | undefined;
  active?: boolean | undefined;
}

/** Every placeholder the body actually uses, in the order it first uses them. */
export function placeholdersIn(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(PLACEHOLDER)) {
    const name = match[1]!;
    if (!found.includes(name)) found.push(name);
  }
  return found;
}

/**
 * THE DECLARED VARIABLES AND THE BODY HAVE TO AGREE, and this is the only
 * thing making them agree.
 *
 * `variables` exists so a settings screen can offer the operator a list to
 * insert from and so a caller can be told what a template needs before it
 * sends. Both of those are worthless if the list is maintained by hand beside
 * a body that changes independently, which is the same two-lists problem this
 * codebase keeps finding.
 *
 * A placeholder the list does not declare is the dangerous direction:
 * `workflow-steps.render` resolves an unknown path to an empty string, so a
 * typo like `{{ custmer.name }}` does not fail, it sends "Hi ," to a
 * customer and nothing anywhere reports it. Refusing at definition time is
 * the only moment anybody is looking.
 *
 * A declared variable the body does not use is harmless and allowed: an
 * operator mid-edit has one, and refusing it would make the editor fight
 * them.
 */
function normalise(input: TemplateInput) {
  const code = input.code.trim();
  if (!CODE.test(code)) {
    throw new ConflictError(
      `"${input.code}" is not a usable template code. It has to start with a lowercase letter `
      + "and hold only lowercase letters, digits, dots and underscores, because it is the "
      + "stable name a workflow step and a service refer to it by rather than anything a "
      + "person reads.",
    );
  }

  const name = input.name.trim();
  if (name === "") {
    throw new ConflictError(
      "A template needs a name. The code is what the software refers to it by and the name is "
      + "what somebody picks it out of a list with.",
    );
  }

  const body = input.body.trim();
  if (body === "") {
    throw new ConflictError("A template with no body would send an empty message.");
  }

  const used = placeholdersIn(body);
  const declared = [...new Set((input.variables ?? used).map((v) => v.trim()).filter(Boolean))];
  const undeclared = used.filter((name_) => !declared.includes(name_));

  if (undeclared.length > 0) {
    throw new ConflictError(
      `This body uses ${undeclared.map((u) => `"${u}"`).join(", ")} and does not declare `
      + `${undeclared.length === 1 ? "it" : "them"}. An undeclared placeholder is not an error `
      + "when the message is sent: it resolves to nothing and the customer reads a sentence "
      + "with a hole in it. Declare it, or correct the spelling.",
    );
  }

  /**
   * A subject on something that has no subject line is a field nobody will
   * ever see, and the operator who typed it will believe it went out.
   */
  const wantsSubject = input.channel === "email";
  const subject = input.subject?.trim() || null;
  if (subject && !wantsSubject) {
    throw new ConflictError(
      `A ${input.channel} message has no subject line, so this subject would never be shown `
      + "to anybody. Put it in the body or change the channel.",
    );
  }
  if (!subject && wantsSubject) {
    throw new ConflictError(
      "An email template needs a subject. An email that arrives with an empty subject line is "
      + "the single strongest spam signal a sender can produce.",
    );
  }

  return {
    code,
    name,
    channel: input.channel,
    purpose: input.purpose ?? "transactional",
    subject,
    body,
    variables: declared,
    active: input.active ?? true,
  };
}

function shape(row: typeof schema.messageTemplate.$inferSelect) {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    channel: row.channel,
    purpose: row.purpose,
    subject: row.subject,
    body: row.body,
    variables: row.variables,
    active: row.active,
  };
}

export async function define(ctx: ServiceContext, input: TemplateInput) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const proposed = normalise(input);

    const [clash] = await tx.select({ id: schema.messageTemplate.id })
      .from(schema.messageTemplate)
      .where(and(
        eq(schema.messageTemplate.organizationId, ctx.actor.organizationId),
        eq(schema.messageTemplate.code, proposed.code),
        isNull(schema.messageTemplate.deletedAt),
      )).limit(1);

    if (clash) {
      throw new ConflictError(
        `"${proposed.code}" is already a template here. One code is one template: a second one `
        + "over the same name means which wording a customer gets is decided by whichever row a "
        + "query happened to read first.",
      );
    }

    const [row] = await tx.insert(schema.messageTemplate).values({
      organizationId: ctx.actor.organizationId,
      ...proposed,
    }).returning();

    await audit(tx, ctx, "message_template.defined", "message_template", row!.id, null, row!);
    return shape(row!);
  });
}

export async function update(
  ctx: ServiceContext,
  input: { id: string } & { [K in keyof TemplateInput]?: TemplateInput[K] | undefined },
) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [before] = await tx.select().from(schema.messageTemplate)
      .where(and(
        eq(schema.messageTemplate.id, input.id),
        isNull(schema.messageTemplate.deletedAt),
      )).limit(1);
    if (!before) throw new NotFoundError("Template");

    if (input.code !== undefined && input.code.trim() !== before.code) {
      throw new ConflictError(
        `A template's code cannot be changed. Workflow steps and services refer to "${before.code}" `
        + "by that string, so renaming it would leave every one of them falling back to its "
        + "built in wording with nothing saying why. Change the name instead, which is the part "
        + "people read.",
      );
    }

    /**
     * MERGED BEFORE VALIDATING, not validated against the patch alone.
     *
     * A patch that changes the body and leaves `variables` alone has to be
     * checked against the variables already stored, or every edit that adds a
     * placeholder passes because the patch declared nothing to contradict it.
     */
    const proposed = normalise({
      code: before.code,
      name: input.name ?? before.name,
      channel: input.channel ?? (before.channel as comms.Channel),
      purpose: input.purpose ?? (before.purpose as comms.Purpose),
      subject: input.subject !== undefined ? input.subject : before.subject,
      body: input.body ?? before.body,
      variables: input.variables ?? (input.body !== undefined ? undefined : before.variables),
      active: input.active ?? before.active,
    });

    const [after] = await tx.update(schema.messageTemplate)
      .set({ ...proposed, updatedAt: new Date() })
      .where(eq(schema.messageTemplate.id, input.id))
      .returning();

    await audit(tx, ctx, "message_template.updated", "message_template", input.id, before, after!);
    return shape(after!);
  });
}

export async function list(
  ctx: ServiceContext, input: { channel?: string | undefined } = {},
) {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rows = await tx.select().from(schema.messageTemplate)
      .where(and(
        eq(schema.messageTemplate.organizationId, ctx.actor.organizationId),
        isNull(schema.messageTemplate.deletedAt),
        ...(input.channel
          ? [eq(schema.messageTemplate.channel, input.channel as "sms")]
          : []),
      ))
      .orderBy(asc(schema.messageTemplate.code));
    return rows.map(shape);
  });
}

export async function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const [before] = await tx.select().from(schema.messageTemplate)
      .where(and(
        eq(schema.messageTemplate.id, input.id),
        isNull(schema.messageTemplate.deletedAt),
      )).limit(1);
    if (!before) throw new NotFoundError("Template");

    /**
     * Soft, and the reason is the same as everywhere else it is soft here: a
     * workflow step naming this code keeps working off its built in wording
     * rather than failing, and the audit trail for every message ever sent
     * from it still names something.
     */
    const [after] = await tx.update(schema.messageTemplate)
      .set({ deletedAt: new Date(), active: false, updatedAt: new Date() })
      .where(eq(schema.messageTemplate.id, input.id))
      .returning();

    await audit(tx, ctx, "message_template.removed", "message_template", input.id, before, after!);
    return { id: input.id, removed: true as const };
  });
}

/* ---------------------------------------------------------------- sending */

export interface Rendered {
  code: string;
  channel: string;
  purpose: string;
  subject: string | null;
  body: string;
  /** Declared variables the scope had nothing for. See `renderWithin`. */
  missing: string[];
}

/**
 * Render one company's template, inside the transaction of whatever is
 * sending.
 *
 * Takes a `tx` rather than a context, like `senderFor` and `validateWithin`
 * next door, and for the same reason: a technician pressing "on my way" holds
 * `message:send` and has no business holding `settings:read`, so a lookup
 * that checked a settings permission of its own would refuse the send it was
 * called to serve.
 *
 * MISSING VARIABLES ARE REPORTED, NOT REFUSED, and that is a deliberate
 * asymmetry with `define` above. At definition time a problem is in front of
 * the person who can fix it. At send time the person is a technician in a
 * driveway, and refusing to tell a customer the van is coming because a
 * template references a field this particular job has nothing in is a worse
 * outcome than a sentence with a gap. The caller decides, and `missing` is
 * how it knows.
 */
export async function renderWithin(
  tx: Database,
  organizationId: string,
  code: string,
  scope: Record<string, unknown>,
): Promise<Rendered | null> {
  const [row] = await tx.select().from(schema.messageTemplate)
    .where(and(
      eq(schema.messageTemplate.organizationId, organizationId),
      eq(schema.messageTemplate.code, code),
      eq(schema.messageTemplate.active, true),
      isNull(schema.messageTemplate.deletedAt),
    )).limit(1);

  /**
   * NULL RATHER THAN A THROW when a company has not defined this template.
   *
   * Every caller of this has its own built in wording, and that is the point:
   * the product works out of the box and a company overrides the words it
   * cares about. Throwing would mean the first service to ask for a template
   * stops working for every company that has never opened the templates
   * screen.
   */
  if (!row) return null;

  const missing = (row.variables ?? []).filter((name) => {
    const value = name.split(".").reduce<unknown>(
      (current, part) => (current && typeof current === "object"
        ? (current as Record<string, unknown>)[part]
        : undefined),
      scope,
    );
    return value === null || value === undefined || value === "";
  });

  return {
    code: row.code,
    channel: row.channel,
    purpose: row.purpose,
    subject: row.subject ? render(row.subject, scope) : null,
    body: render(row.body, scope),
    missing,
  };
}

/** Ask for a preview from outside a send. */
export async function preview(
  ctx: ServiceContext, input: { code: string; scope?: Record<string, unknown> | undefined },
) {
  return guardedRead(ctx, "settings:read", async (tx) => {
    const rendered = await renderWithin(
      tx, ctx.actor.organizationId, input.code, input.scope ?? {},
    );
    if (!rendered) throw new NotFoundError("Template");
    return rendered;
  });
}

export const handlers = {
  defineMessageTemplate: (ctx: ServiceContext, input: TemplateInput) => define(ctx, input),

  listMessageTemplates: async (
    ctx: ServiceContext, input: { channel?: string | undefined },
  ) => ({ templates: await list(ctx, input) }),

  updateMessageTemplate: (
    ctx: ServiceContext,
    input: { id: string } & { [K in keyof TemplateInput]?: TemplateInput[K] | undefined },
  ) => update(ctx, input),

  deleteMessageTemplate: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),

  previewMessageTemplate: (
    ctx: ServiceContext, input: { code: string; scope?: Record<string, unknown> | undefined },
  ) => preview(ctx, input),
} as const;
