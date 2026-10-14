import { randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull, isNotNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { SYSTEM_USER_ID, files as fileRules, marketing as mk, tracking, type Actor } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, inTenant, NotFoundError, ConflictError, OrganizationSuspendedError,
  DemoReadOnlyError, type RequestMeta, type ServiceContext,
} from "./context";
import * as marketingService from "./marketing";
import * as consent from "./consent";
import * as email from "./email";
import { sendTransactional } from "./comms-send";
import { LIMITS, throttle } from "./website-tracking";
import { attach, decode, put } from "./files";
import { render } from "../lib/render";

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
      publicKey: row.publicKey,
    }));
  });
}

export interface FormSettings {
  thankYou?: string | undefined;
  confirmationText?: string | undefined;
  confirmationEmailSubject?: string | undefined;
  confirmationEmailBody?: string | undefined;
}

export interface FormInput {
  slug: string;
  title: string;
  source?: string | undefined;
  fields: mk.FormField[];
  minimumFillSeconds?: number | undefined;
  settings?: FormSettings | undefined;
  /** The pages, when the form is split. Absent or one is a form on one page. */
  pages?: mk.FormPage[] | undefined;
}

/** The kind a file sent with a lead form is kept under, apart from what a signed in customer adds. */
export const FORM_FILE_KIND = "form_file";

/** Twelve url safe characters: unguessable enough that the forms are not a list anybody can walk. */
const newPublicKey = () => randomBytes(9).toString("base64url");

/** Only the settings a person typed, trimmed, so a blank box is no setting at all. */
function cleanSettings(input: FormSettings | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    if (typeof value === "string" && value.trim() !== "") out[key] = value.trim();
  }
  if ((out["confirmationEmailSubject"] === undefined) !== (out["confirmationEmailBody"] === undefined)) {
    throw new ConflictError("A confirmation email needs both a subject and the words. Fill in both or neither.");
  }
  return out;
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
    /** One page is no split at all, and is stored as none so the hosted page draws no heading for it. */
    const pages = (input.pages ?? []).map((p) => ({ title: p.title.trim() }));
    const definition: mk.FormDefinition = {
      key: input.slug,
      title: input.title,
      fields: pages.length > 1 ? input.fields : input.fields.map(({ page: _page, ...field }) => field),
      ...(input.minimumFillSeconds === undefined
        ? {}
        : { minimumFillSeconds: input.minimumFillSeconds }),
      ...(pages.length > 1 ? { pages } : {}),
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

    /** Absent means unchanged on an edit: an API caller replacing the fields has not said to drop the confirmation. */
    const settings = input.settings === undefined ? undefined : cleanSettings(input.settings);

    /**
     * The confirmation's placeholders against these fields, including a
     * confirmation kept from before when only the fields changed: removing the
     * question `{{ name }}` names would otherwise leave "Thanks , we will ring"
     * going out to every lead.
     */
    const [kept] = settings ? [] : await tx.select({ settings: schema.webForm.settings }).from(schema.webForm)
      .where(and(eq(schema.webForm.slug, input.slug), isNull(schema.webForm.deletedAt))).limit(1);
    const said = (settings ?? (kept?.settings ?? {})) as FormSettings;
    const placeholders = mk.confirmationProblems(definition, [
      said.thankYou, said.confirmationText, said.confirmationEmailSubject, said.confirmationEmailBody,
    ]);
    if (placeholders.length > 0) {
      throw new ConflictError(`The words after a submission cannot be saved: ${placeholders.join(" ")}`);
    }
    const [row] = await tx.insert(schema.webForm).values({
      organizationId: ctx.actor.organizationId,
      slug: input.slug,
      title: input.title,
      source,
      definition: definition as unknown as Record<string, unknown>,
      publicKey: newPublicKey(),
      settings: settings ?? {},
    }).onConflictDoUpdate({
      target: [schema.webForm.organizationId, schema.webForm.slug],
      /** The unique index covers live rows only, so a deleted slug is reusable. */
      targetWhere: isNull(schema.webForm.deletedAt),
      set: {
        title: input.title,
        source,
        definition: definition as unknown as Record<string, unknown>,
        /**
         * The public key is kept on a save, never replaced: it is in links on
         * flyers and on the company's own website, and an edit to a field must
         * not break every one of them. Minted here only for a form saved
         * before hosted pages existed.
         */
        publicKey: sql`coalesce(${schema.webForm.publicKey}, ${newPublicKey()})`,
        ...(settings ? { settings } : {}),
        updatedAt: new Date(),
      },
    }).returning();

    await audit(tx, ctx, "web_form.saved", "web_form", row!.id, null, { slug: input.slug });
    return { id: row!.id, slug: row!.slug, title: row!.title, source: row!.source, publicKey: row!.publicKey! };
  });
}

/** One file posted with a submission, base64 as every upload here is. */
export interface FormFileInput {
  field: string;
  fileName: string;
  contentType?: string | undefined;
  bytes: string;
}

export interface SubmitOutcome {
  accepted: boolean;
  submissionId: string;
  /** Written for the person filling the form in, never for a developer. */
  refusals: { field: string; reason: string; message: string }[];
  /** Set when the form asked for enough to make a customer. */
  customerId: string | null;
  /** What the page says next, when it was accepted. */
  thankYou: string | null;
}

/**
 * The lead form's own actor, with the one permission it needs named.
 *
 * A submission has no user, and the one guarded thing it does is queue a
 * confirmation email, which is `message:send` and nothing else. Named here
 * rather than inherited from a role, the way the outbox and the accounting
 * worker name theirs.
 */
function formActor(organizationId: string): Actor {
  return { userId: SYSTEM_USER_ID, organizationId, roles: [], grants: ["message:send"], agentId: "lead-form" };
}

/** The values a customer record is made from, picked out of a cleaned submission by field type. */
function contactOf(form: mk.FormDefinition, values: Record<string, mk.CleanValue>) {
  const byType = (type: mk.FieldType) => form.fields.find((f) => f.type === type && values[f.key] !== undefined);
  const phoneField = byType("phone");
  const emailField = byType("email");
  const addressField = byType("service_address");
  const nameField = form.fields.find((f) => f.key === "name" && values[f.key] !== undefined)
    ?? form.fields.find((f) => f.type === "text" && /name/i.test(`${f.key} ${f.label}`) && values[f.key] !== undefined);
  return {
    name: nameField ? String(values[nameField.key]).trim() : null,
    phone: phoneField ? String(values[phoneField.key]) : null,
    email: emailField ? String(values[emailField.key]).toLowerCase() : null,
    address: addressField ? values[addressField.key] as mk.ServiceAddress : null,
  };
}

/**
 * The customer a submission is from: an existing one matched by phone, then
 * by email, or a new one.
 *
 * Matched on the normalised phone the way an inbound call is, so the
 * homeowner who rang last week and fills in the form today is one customer
 * with both in their history, and on the email lower cased. A new customer
 * claims the calls and visits they made before anybody knew them, and their
 * lead source is derived from those touches, marked so, the same as a
 * customer the office creates without choosing one.
 */
async function customerFor(
  tx: Database, organizationId: string,
  contact: ReturnType<typeof contactOf>, visitorId: string | null,
): Promise<{ id: string; created: boolean } | null> {
  const caller = mk.callerKey(contact.phone);
  if (!caller && !contact.email) return null;

  let found: { id: string } | undefined;
  if (caller) {
    const rows = await tx.select({ id: schema.customer.id, phone: schema.customer.phone })
      .from(schema.customer)
      .where(and(
        isNull(schema.customer.deletedAt), isNotNull(schema.customer.phone),
        sql`regexp_replace(${schema.customer.phone}, '[^0-9]', '', 'g') like ${`%${caller.slice(-10)}`}`,
      ))
      .orderBy(asc(schema.customer.createdAt));
    found = rows.find((row) => mk.callerKey(row.phone) === caller);
  }
  if (!found && contact.email) {
    [found] = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(and(isNull(schema.customer.deletedAt), sql`lower(${schema.customer.email}) = ${contact.email}`))
      .orderBy(asc(schema.customer.createdAt)).limit(1);
  }

  let created = false;
  if (!found) {
    const [row] = await tx.insert(schema.customer).values({
      organizationId,
      name: contact.name || contact.email || caller || "Website enquiry",
      phone: caller,
      email: contact.email,
    }).returning({ id: schema.customer.id });
    found = row!;
    created = true;
    if (contact.address) {
      const [property] = await tx.insert(schema.property).values({
        organizationId,
        addressLine1: contact.address.line1,
        addressLine2: contact.address.line2 ?? null,
        city: contact.address.city,
        state: contact.address.state,
        postalCode: contact.address.postalCode,
      }).returning({ id: schema.property.id });
      await tx.insert(schema.customerProperty).values({
        organizationId, customerId: found.id, propertyId: property!.id, role: "owner", isPrimary: true,
      });
    }
  }

  if (visitorId) await marketingService.identify(tx, organizationId, { visitorId, customerId: found.id });
  await marketingService.identifyCaller(tx, organizationId, { phone: caller, customerId: found.id });
  if (created) await marketingService.deriveCustomerSource(tx, organizationId, found.id);
  return { id: found.id, created };
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
 *
 * AN ACCEPTED SUBMISSION IS A LEAD THE OFFICE SEES, in one transaction:
 *
 *   1. The customer, matched by phone or email or created (`customerFor`).
 *   2. Consent, only for a consent box the form declared what for, only when
 *      it was ticked, and with the box's own words as the proof. A form that
 *      never asked records nothing, because consent is a thing a person was
 *      asked for and agreed to, not a thing inferred from filling in a form.
 *   3. A task in the office queue, so the lead is a thing somebody rings
 *      rather than a row somebody might read.
 *   4. A confirmation text or email when the form has one, through the same
 *      consent checked senders as everything else: transactional, because it
 *      answers what they just asked for, and never from a tracking number.
 *
 * Throttled per address and per form before anything is written, because
 * this is the one page in the product that a script can post to all day.
 *
 * FILES COME IN THE SAME POST, and are held to the rules a customer's own
 * upload and a reply by email are (`files.planFormUpload`, then
 * `files.checkFormUpload`): counted against this address's hourly ceiling
 * before a byte is read, refused as a program by name and claimed type before
 * they are decoded, then by their bytes, and held to a count and a total for
 * the submission. A refused file is a refusal on its field like any other, so
 * the person is told which file and why, and the row keeps its name. Bytes are
 * kept only for an accepted submission, on the customer the lead is: a
 * refused or spam submission keeps none.
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
    files?: FormFileInput[] | undefined;
  },
  meta?: RequestMeta,
): Promise<SubmitOutcome> {
  const [org] = await db.select({
    id: schema.organization.id, suspendedAt: schema.organization.suspendedAt,
    demoUserId: schema.organization.demoUserId,
  }).from(schema.organization)
    .where(eq(schema.organization.slug, input.organizationSlug)).limit(1);
  if (!org) throw new NotFoundError("Company");
  // Refused before anything is stored, for the reason booking is: a lead
  // captured for a company nobody can sign in to is a lead nobody calls.
  if (org.suspendedAt) throw new OrganizationSuspendedError();
  // Nor is one stored for the demo company, which every visitor can read.
  if (org.demoUserId) throw new DemoReadOnlyError();

  const address = meta?.ip?.slice(0, 64) || "unknown";
  await throttle(db, `form:ip:${org.id}:${address}`, LIMITS.formPerAddress);
  await throttle(db, `form:f:${org.id}:${input.formSlug}`, LIMITS.formPerForm);
  /**
   * Every file counted against the address's hourly ceiling before a byte of
   * it is looked at, so a refused file counts too and a script learns nothing
   * by sending programs until one passes.
   */
  const posted = (input.files ?? []).slice(0, fileRules.FORM_UPLOADS.maxFiles + 1);
  for (let i = 0; i < posted.length; i++) {
    await throttle(db, `form-file:ip:${org.id}:${address}`, fileRules.FORM_UPLOADS.perAddressPerHour, 3600);
  }

  const ctx: ServiceContext = { actor: formActor(org.id), db };
  const outcome = await inTenant(ctx, async (tx) => {
    const [form] = await tx.select().from(schema.webForm)
      .where(and(
        eq(schema.webForm.organizationId, org.id),
        eq(schema.webForm.slug, input.formSlug),
        isNull(schema.webForm.deletedAt),
      )).limit(1);
    if (!form) throw new NotFoundError("Form");

    /**
     * A retry of the same submission (a phone that lost signal on the post)
     * answers with the first one's outcome rather than a second lead. Keyed
     * on the form as well as the header, because a key a stranger chose must
     * not fetch somebody else's submission.
     */
    const replayKey = meta?.idempotencyKey ? `form:${form.id}:${meta.idempotencyKey}` : null;
    if (replayKey) {
      const [seen] = await tx.select({ entityId: schema.integrationEvent.entityId }).from(schema.integrationEvent)
        .where(and(eq(schema.integrationEvent.idempotencyKey, replayKey), eq(schema.integrationEvent.entityType, "form_submission")))
        .limit(1);
      if (seen?.entityId) {
        const [row] = await tx.select().from(schema.formSubmission).where(eq(schema.formSubmission.id, seen.entityId)).limit(1);
        if (row) {
          return {
            outcome: {
              accepted: row.state === "accepted", submissionId: row.id, refusals: row.refusals,
              customerId: row.customerId,
              thankYou: row.state === "accepted"
                ? thankYouOf(form, toDefinition(form), (row.clean ?? {}) as Record<string, mk.CleanValue>)
                : null,
            },
            email: null,
          };
        }
      }
    }

    const definition = toDefinition(form);

    /**
     * A file field's value is the names of the files that came for it, put
     * here from what was posted, never what the page typed in the slot: a
     * page cannot claim a file it did not send.
     */
    const fileFields = new Set(definition.fields.filter((f) => f.type === "file").map((f) => f.key));
    const values: Record<string, unknown> = { ...input.values };
    for (const key of fileFields) delete values[key];
    const fileRefusals: { field: string; reason: string; message: string }[] = [];
    const planned: FormFileInput[] = [];
    posted.forEach((file, i) => {
      if (!fileFields.has(file.field)) {
        fileRefusals.push({
          field: file.field, reason: "unknown_field",
          message: `This form has no place for files called "${file.field}". It may have been changed since the page was opened: reload and try again.`,
        });
        return;
      }
      values[file.field] = [...((values[file.field] as string[] | undefined) ?? []), file.fileName];
      const plan = i >= fileRules.FORM_UPLOADS.maxFiles
        ? { ok: false as const, reason: `${fileRules.displayName(file.fileName)} was not sent: you can send up to ${fileRules.FORM_UPLOADS.maxFiles} files with this form.` }
        : fileRules.planFormUpload({ fileName: file.fileName, contentType: file.contentType, encodedLength: file.bytes.length });
      if (plan.ok) planned.push(file);
      else fileRefusals.push({ field: file.field, reason: "bad_file", message: plan.reason });
    });

    let decision = mk.checkSubmission(definition, {
      values,
      ...(input.startedAt ? { startedAt: input.startedAt } : {}),
    });

    /**
     * The bytes are decoded only now, and only for a submission that is not
     * spam: what a script sent is never read past its name.
     */
    const kept: { field: string; fileName: string; contentType: string | undefined; bytes: Uint8Array }[] = [];
    if (!(!decision.ok && decision.reason === "spam")) {
      let bytesSoFar = 0;
      for (const file of planned) {
        let bytes: Uint8Array;
        try {
          bytes = decode(file.bytes);
        } catch {
          fileRefusals.push({
            field: file.field, reason: "bad_file",
            message: `${fileRules.displayName(file.fileName)} did not arrive whole. Pick it again and send the form again.`,
          });
          continue;
        }
        const verdict = fileRules.checkFormUpload(
          { fileName: file.fileName, contentType: file.contentType, bytes },
          { filesAlreadyAdded: kept.length, bytesAlreadyAdded: bytesSoFar },
        );
        if (!verdict.ok) {
          fileRefusals.push({ field: file.field, reason: "bad_file", message: verdict.reason });
          continue;
        }
        bytesSoFar += bytes.length;
        kept.push({ field: file.field, fileName: file.fileName, contentType: file.contentType, bytes });
      }
      if (fileRefusals.length > 0) {
        decision = {
          ok: false, reason: "invalid",
          refusals: [
            ...fileRefusals.map((r) => ({ ...r, reason: r.reason as mk.FieldRefusalReason })),
            ...(decision.ok ? [] : decision.refusals),
          ],
        };
      }
    }

    /**
     * The touch is recorded whatever the decision, and before the outcome is
     * known. Somebody who arrived from an ad and then could not submit is
     * still a click that channel was paid for, and dropping the touch on a
     * refusal would make a form with a broken field look like a channel that
     * stopped producing. The landing query is reduced to its attribution
     * first, so nothing else that was in somebody's address bar is kept.
     */
    /**
     * Any opaque id the page kept, as the booking path accepts: the snippet's,
     * the booking page's, or an integrator's own. Never something shaped like
     * an address, which would be a person rather than a thread.
     */
    const visitorId = typeof input.visitorId === "string" && /^[A-Za-z0-9_.:-]{1,200}$/.test(input.visitorId)
      ? input.visitorId : null;
    const touch = await marketingService.recordTouch(tx, org.id, {
      at: new Date(),
      visitorId,
      query: tracking.attributionQuery(input.landingQuery ?? null) || null,
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
       * leading 1. A file field holds the names of the files sent, never
       * their bytes.
       */
      raw: values,
      clean: decision.ok ? (decision.values as unknown as Record<string, unknown>) : null,
      refusals,
      touchId: touch.id,
    }).returning({ id: schema.formSubmission.id });

    if (replayKey) {
      await tx.insert(schema.integrationEvent).values({
        organizationId: org.id, direction: "inbound", provider: "lead_form", eventType: "form.submitted",
        idempotencyKey: replayKey, status: "succeeded", entityType: "form_submission", entityId: row!.id,
      });
    }

    if (!decision.ok) {
      return {
        outcome: { accepted: false, submissionId: row!.id, refusals, customerId: null, thankYou: null },
        email: null,
      };
    }

    const contact = contactOf(definition, decision.values);
    const customer = await customerFor(tx, org.id, contact, visitorId);
    if (customer) {
      await tx.update(schema.formSubmission).set({ customerId: customer.id, updatedAt: new Date() })
        .where(eq(schema.formSubmission.id, row!.id));
      await tx.update(schema.marketingTouch).set({ customerId: customer.id, updatedAt: new Date() })
        .where(and(eq(schema.marketingTouch.id, touch.id), isNull(schema.marketingTouch.customerId)));
      await marketingService.claimReferral(tx, org.id, customer.id);
    }

    /**
     * The files, on the customer the lead is. Kept under their own kind, apart
     * from what a customer adds from their own sign in: whoever filled in the
     * form gave this customer's phone or email, which is not the same as being
     * signed in as them, so the office sees where each came from. Never shown
     * to the customer and never on a job link. The same bytes sent twice are
     * one file.
     */
    const target = customer ? { type: "customer", id: customer.id } : { type: "form_submission", id: row!.id };
    const attached: string[] = [];
    for (const file of kept) {
      const { file: stored } = await put(tx, org.id, {
        bytes: file.bytes, claimedType: file.contentType, maxBytes: fileRules.FORM_UPLOADS.maxFileBytes,
      });
      const [same] = await tx.select({ id: schema.attachment.id }).from(schema.attachment)
        .where(and(
          eq(schema.attachment.entityType, target.type), eq(schema.attachment.entityId, target.id),
          eq(schema.attachment.storageKey, stored.storageKey), isNull(schema.attachment.deletedAt),
        )).limit(1);
      if (same) continue;
      const extension = stored.storageKey.split(".").pop() ?? "bin";
      const { id } = await attach(tx, org.id, {
        entityType: target.type,
        entityId: target.id,
        storageKey: stored.storageKey,
        kind: FORM_FILE_KIND,
        fileName: fileRules.downloadName(file.fileName, extension),
        contentType: stored.contentType,
        sizeBytes: stored.sizeBytes,
        uploadedByUserId: null,
      });
      attached.push(id);
      await audit(tx, ctx, "attachment.form_added", "attachment", id, null, {
        entityType: target.type, entityId: target.id, formId: form.id, submissionId: row!.id,
        storageKey: stored.storageKey, contentType: stored.contentType, sizeBytes: stored.sizeBytes,
      });
    }

    for (const field of definition.fields) {
      if (field.type !== "consent" || !field.consentFor || decision.values[field.key] !== true) continue;
      const address = field.consentFor.channel === "sms" ? mk.callerKey(contact.phone) : contact.email;
      if (!address) continue;
      await consent.recordWithin(tx, { organizationId: org.id, capturedByUserId: null }, {
        address,
        channel: field.consentFor.channel,
        purpose: field.consentFor.purpose,
        method: "web_form",
        customerId: customer?.id ?? null,
        proofText: mk.consentWording(field),
        proofReference: `form:${form.slug}:${row!.id}`,
        ipAddress: meta?.ip ?? null,
      }, "granted");
    }

    const who = contact.name || contact.phone || contact.email || "somebody";
    await tx.insert(schema.task).values({
      organizationId: org.id,
      title: `Ring back ${who}: ${form.title}`,
      body: definition.fields
        .filter((f) => decision.values[f.key] !== undefined && f.type !== "consent" && f.type !== "hidden")
        .map((f) => `${f.label}: ${formatValue(decision.values[f.key]!)}`)
        .concat(attached.length > 0
          ? [customer ? "The files they sent are on their customer page." : "The files they sent are kept with the submission."]
          : [])
        .join("\n"),
      priority: "high",
      entityType: customer ? "customer" : "form_submission",
      entityId: customer?.id ?? row!.id,
      queue: "office",
      dueAt: new Date(Date.now() + 2 * 3_600_000),
    });

    /**
     * The confirmation in their own words where it names an answer, filled
     * by the one renderer, with each answer made safe for a message first
     * (`confirmationScope`): it goes to whatever number or address was typed.
     */
    const settings = (form.settings ?? {}) as FormSettings;
    const scope = mk.confirmationScope(definition, decision.values, "message");
    const caller = mk.callerKey(contact.phone);
    if (settings.confirmationText && caller) {
      await sendTransactional(tx, {
        organizationId: org.id, address: caller, body: render(settings.confirmationText, scope), customerId: customer?.id ?? null,
      });
    }

    return {
      outcome: {
        accepted: true, submissionId: row!.id, refusals: [], customerId: customer?.id ?? null,
        thankYou: thankYouOf(form, definition, decision.values),
      },
      email: settings.confirmationEmailSubject && settings.confirmationEmailBody && contact.email
        ? {
          to: contact.email,
          subject: render(settings.confirmationEmailSubject, scope),
          text: render(settings.confirmationEmailBody, scope),
          customerId: customer?.id ?? null,
        }
        : null,
    };
  });

  /**
   * The confirmation email after the submission has committed, so a refused
   * email (no provider connected, a suppressed address) can never roll back
   * the lead it was confirming. A refusal is an answer and is left at that.
   */
  if (outcome.email) {
    await email.queue(ctx, {
      to: outcome.email.to, subject: outcome.email.subject, text: outcome.email.text,
      ...(outcome.email.customerId ? { customerId: outcome.email.customerId } : {}),
    }).catch((error: unknown) => {
      if (!(error instanceof ConflictError)) throw error;
    });
  }
  return outcome.outcome;
}

/**
 * The sentence the page shows, with any answers it names. The page goes only
 * to the person who sent the form, and draws it as words, so an answer there
 * is cut to a line rather than to a few words.
 */
function thankYouOf(
  form: typeof schema.webForm.$inferSelect, definition: mk.FormDefinition, values: Record<string, mk.CleanValue>,
): string {
  const written = ((form.settings ?? {}) as FormSettings).thankYou;
  if (!written) return "Thank you. We have your details and will be in touch shortly.";
  return render(written, mk.confirmationScope(definition, values, "page"));
}

function formatValue(value: mk.CleanValue): string {
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") {
    return [value.line1, value.line2, value.city, value.state, value.postalCode].filter(Boolean).join(", ");
  }
  return String(value);
}

/**
 * The form a public key names, for the hosted page.
 *
 * Everything the page needs to draw the form and nothing more: no
 * submissions, no source, no settings beyond the sentence it shows after.
 */
export async function hosted(db: Database, input: { key: string }) {
  const [row] = await db.select({
    form: schema.webForm, orgName: schema.organization.name, orgSlug: schema.organization.slug,
    suspendedAt: schema.organization.suspendedAt,
  }).from(schema.webForm)
    .innerJoin(schema.organization, eq(schema.organization.id, schema.webForm.organizationId))
    .where(and(eq(schema.webForm.publicKey, input.key), isNull(schema.webForm.deletedAt)))
    .limit(1);
  if (!row || row.suspendedAt) throw new NotFoundError("Form");
  const definition = toDefinition(row.form);
  return {
    organizationName: row.orgName,
    organizationSlug: row.orgSlug,
    formSlug: row.form.slug,
    title: row.form.title,
    fields: definition.fields,
    thankYou: ((row.form.settings ?? {}) as FormSettings).thankYou ?? null,
    pages: definition.pages ?? [],
    uploads: {
      maxFiles: fileRules.FORM_UPLOADS.maxFiles,
      maxFileMegabytes: Math.round(fileRules.FORM_UPLOADS.maxFileBytes / (1024 * 1024)),
      maxTotalMegabytes: Math.round(fileRules.FORM_UPLOADS.maxTotalBytes / (1024 * 1024)),
      types: [...fileRules.FORM_UPLOADS.types],
    },
  };
}

/** One form as the builder edits it. */
export async function definitionOf(ctx: ServiceContext, slug: string) {
  return guardedRead(ctx, "adspend:read", async (tx) => {
    const [row] = await tx.select().from(schema.webForm)
      .where(and(eq(schema.webForm.slug, slug), isNull(schema.webForm.deletedAt))).limit(1);
    if (!row) throw new NotFoundError("Form");
    const definition = toDefinition(row);
    return {
      id: row.id, slug: row.slug, title: row.title, source: row.source, publicKey: row.publicKey,
      fields: definition.fields, minimumFillSeconds: definition.minimumFillSeconds ?? null,
      settings: (row.settings ?? {}) as FormSettings,
      pages: definition.pages ?? [],
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
    settings?: FormSettings | undefined; pages?: mk.FormPage[] | undefined;
  }): Promise<{ id: string; slug: string; title: string; source: string; publicKey: string }> =>
    save(ctx, { ...input, fields: input.fields as mk.FormField[] }),

  getForm: (ctx: ServiceContext, input: { slug: string }) => definitionOf(ctx, input.slug),

  getHostedForm: (db: Database, input: { key: string }) => hosted(db, input),

  submitForm: (db: Database, input: {
    organizationSlug: string; formSlug: string;
    values: Record<string, unknown>;
    startedAt?: string | undefined; visitorId?: string | undefined;
    landingQuery?: string | undefined; referrer?: string | undefined;
    files?: FormFileInput[] | undefined;
  }, meta?: RequestMeta): Promise<SubmitOutcome> => submit(db, {
    organizationSlug: input.organizationSlug,
    formSlug: input.formSlug,
    values: input.values,
    ...(input.startedAt ? { startedAt: new Date(input.startedAt) } : {}),
    visitorId: input.visitorId ?? null,
    landingQuery: input.landingQuery ?? null,
    referrer: input.referrer ?? null,
    files: input.files,
  }, meta),

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
