import { and, asc, desc, eq, gte, inArray, isNotNull, isNull } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { estimate as est } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, UnprocessableError, type ServiceContext,
} from "./context";
import { refusingDuplicate } from "./duplicates";
import { assertEstimateVisible } from "./estimates";
import { attach, decode, put } from "./files";
import { remember, replayed } from "./once";

/**
 * PROPOSAL TEMPLATES: THE COMPANY'S OWN LAYOUT, SAVED
 *
 * A company designs how its proposal reads once (a cover with a photograph,
 * about us, the options, the warranty, financing, what customers said, the
 * terms, in its own order) and saves it by name, optionally as the layout a
 * job type's estimates start with, and one as the default. The rules a layout
 * is held to are core's (`estimate/proposal-layout`); this keeps them, applies
 * them to estimates and reads them back for the page and the PDF.
 *
 * DESIGNING ONE IS A SETTING, `settings:write`, like the terms and the
 * discount limit: it is what every customer of the company reads.
 * Applying one to an estimate is writing the estimate, `estimate:write`.
 *
 * APPLIED MEANS COPIED, and only to a draft. The estimate keeps its own copy
 * of the layout, as it keeps its own copy of the terms, so a template edited
 * in March does not change what a customer was sent in February. And it is
 * applied before sending rather than after, because sending is what freezes
 * the document: a customer who approved one layout and finds another on the
 * link was shown something nobody can now reproduce.
 */

type Row = typeof schema.proposalTemplate.$inferSelect;

function view(row: Row) {
  return {
    id: row.id,
    name: row.name,
    jobTypeId: row.jobTypeId,
    isDefault: row.isDefault,
    layout: {
      cover: row.cover,
      sections: row.sections as unknown as est.Section[],
      showOptionPhotos: row.showOptionPhotos,
    } as est.Layout,
    updatedAt: row.updatedAt,
  };
}
export type TemplateView = ReturnType<typeof view>;

function decided(layout: unknown): est.Layout {
  const decision = est.checkLayout(layout);
  if (!decision.ok) {
    throw new UnprocessableError(
      decision.problems.length === 1 ? "The layout needs changing" : "The layout needs a few changes",
      decision.problems.map((message) => ({ path: "layout", message })),
    );
  }
  return decision.layout;
}

async function load(tx: Database, id: string): Promise<Row> {
  const [row] = await tx.select().from(schema.proposalTemplate)
    .where(and(eq(schema.proposalTemplate.id, id), isNull(schema.proposalTemplate.deletedAt))).limit(1);
  if (!row) throw new NotFoundError("Proposal template");
  return row;
}

/** Every saved layout, the default first, for the screen that applies one and the one that designs them. */
export async function list(ctx: ServiceContext) {
  return guardedRead(ctx, "estimate:read", async (tx) => {
    const rows = await tx.select().from(schema.proposalTemplate)
      .where(isNull(schema.proposalTemplate.deletedAt))
      .orderBy(desc(schema.proposalTemplate.isDefault), asc(schema.proposalTemplate.name));
    return rows.map(view);
  });
}

export async function get(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "estimate:read", async (tx) => view(await load(tx, input.id)));
}

export interface SaveInput {
  id?: string | undefined;
  name: string;
  jobTypeId?: string | null | undefined;
  isDefault?: boolean | undefined;
  layout: unknown;
}

/**
 * Save a layout, new or changed. A cover photograph is kept as it was unless
 * the layout names another one this company holds; a key it does not hold is
 * refused rather than drawn as a broken image on a customer's proposal.
 *
 * Making one the default takes it off whichever was the default before, in
 * the same transaction, so there is never a moment with two.
 */
export async function save(ctx: ServiceContext, input: SaveInput) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const again = input.id ? null : await replayed<TemplateView>(tx, ctx, "proposal_template");
    if (again) return again;
    const name = input.name.trim();
    if (name === "") throw new ConflictError("A layout needs a name, like Installs or Service calls.");
    if (name.length > 80) throw new ConflictError("A layout's name is at most eighty characters.");
    const layout = decided(input.layout);
    const before = input.id ? await load(tx, input.id) : null;

    if (layout.cover?.photoKey) {
      const [held] = await tx.select({ id: schema.storedFile.id }).from(schema.storedFile)
        .where(and(eq(schema.storedFile.storageKey, layout.cover.photoKey), isNull(schema.storedFile.deletedAt))).limit(1);
      if (!held) throw new ConflictError("The cover's photograph is not one this company has uploaded. Upload it again.");
    }
    if (input.jobTypeId) {
      const [type] = await tx.select({ id: schema.jobType.id }).from(schema.jobType)
        .where(eq(schema.jobType.id, input.jobTypeId)).limit(1);
      if (!type) throw new NotFoundError("Job type");
    }

    const isDefault = input.isDefault ?? before?.isDefault ?? false;
    if (isDefault) {
      await tx.update(schema.proposalTemplate).set({ isDefault: false, updatedAt: new Date() })
        .where(and(eq(schema.proposalTemplate.isDefault, true), isNull(schema.proposalTemplate.deletedAt)));
    }
    const values = {
      name,
      jobTypeId: input.jobTypeId === undefined ? (before?.jobTypeId ?? null) : input.jobTypeId,
      isDefault,
      cover: layout.cover,
      sections: layout.sections as unknown as Record<string, unknown>[],
      showOptionPhotos: layout.showOptionPhotos,
    };
    const write = () => before
      ? tx.update(schema.proposalTemplate).set({ ...values, updatedAt: new Date() })
        .where(eq(schema.proposalTemplate.id, before.id)).returning()
      : tx.insert(schema.proposalTemplate).values({
        organizationId: ctx.actor.organizationId, ...values, createdByUserId: ctx.actor.userId,
      }).returning();
    const [row] = await refusingDuplicate(
      "proposal_template_name_idx",
      `There is already a layout called "${name}". Open that one, or give this one a name that says how it differs.`,
      () => refusingDuplicate(
        "proposal_template_job_type_idx",
        "That job type already starts with another layout. Take it off that one first, so which layout a new estimate gets is never a guess.",
        () => refusingDuplicate(
          "proposal_template_default_idx",
          "Another layout became the default at the same moment. Try again.",
          write,
        ),
      ),
    );
    await audit(tx, ctx, before ? "proposal_template.updated" : "proposal_template.created",
      "proposal_template", row!.id, before, row!);
    const answer = view(row!);
    if (!before) await remember(tx, ctx, "proposal_template", row!.id, answer);
    return answer;
  });
}

/** Retire a layout. Estimates it was applied to keep their copy; new ones stop starting with it. */
export async function remove(ctx: ServiceContext, input: { id: string }) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const before = await load(tx, input.id);
    await tx.update(schema.proposalTemplate).set({ deletedAt: new Date(), isDefault: false, updatedAt: new Date() })
      .where(eq(schema.proposalTemplate.id, before.id));
    await audit(tx, ctx, "proposal_template.removed", "proposal_template", before.id, before, null);
    return { id: before.id, removed: true as const };
  });
}

const IMAGE_LIMIT = 8 * 1024 * 1024;

/**
 * A photograph for a template's cover, kept in the company's own file store
 * and attached to the template so it is counted as used. Returns the key the
 * layout's cover names; the layout is saved separately, so a photograph can
 * be uploaded before somebody presses save.
 */
export async function uploadCoverPhoto(
  ctx: ServiceContext, input: { id: string; fileName: string; bytes: string | Uint8Array },
) {
  return guardedWrite(ctx, "settings:write", async (tx) => {
    const row = await load(tx, input.id);
    const bytes = typeof input.bytes === "string" ? decode(input.bytes) : input.bytes;
    const { file } = await put(tx, ctx.actor.organizationId, {
      bytes, maxBytes: IMAGE_LIMIT, uploadedByUserId: ctx.actor.userId,
    });
    if (!file.contentType.startsWith("image/")) throw new ConflictError("A cover is a photograph: a JPEG or a PNG.");
    /** The same bytes sent again (a retry, a second press) are one attachment, not two. */
    const [already] = await tx.select({ id: schema.attachment.id }).from(schema.attachment).where(and(
      eq(schema.attachment.entityType, "proposal_template"), eq(schema.attachment.entityId, row.id),
      eq(schema.attachment.storageKey, file.storageKey), isNull(schema.attachment.deletedAt),
    )).limit(1);
    if (!already) {
      await attach(tx, ctx.actor.organizationId, {
        entityType: "proposal_template", entityId: row.id, storageKey: file.storageKey, kind: "cover",
        fileName: input.fileName, contentType: file.contentType, sizeBytes: file.sizeBytes,
        uploadedByUserId: ctx.actor.userId,
      });
    }
    const cover = { headline: row.cover?.headline || row.name, intro: row.cover?.intro ?? null, photoKey: file.storageKey };
    const [after] = await tx.update(schema.proposalTemplate).set({ cover, updatedAt: new Date() })
      .where(eq(schema.proposalTemplate.id, row.id)).returning();
    await audit(tx, ctx, "proposal_template.cover_uploaded", "proposal_template", row.id, row, after!);
    return view(after!);
  });
}

/* ------------------------------------------------------- on an estimate */

/** The layout an estimate carries: the template's, copied, with where it came from. */
function snapshot(row: Row): Record<string, unknown> {
  return {
    templateId: row.id,
    templateName: row.name,
    cover: row.cover,
    sections: row.sections,
    showOptionPhotos: row.showOptionPhotos,
  };
}

/**
 * The layout a NEW estimate starts with: its job type's, or the company's
 * default, or none (the fixed layout). Called inside the estimate's own
 * create, so an estimate never exists for a moment without the layout it was
 * going to have.
 */
export async function layoutForNew(
  tx: Database, jobId: string | null,
): Promise<{ proposalTemplateId: string | null; proposalLayout: Record<string, unknown> | null }> {
  let row: Row | undefined;
  if (jobId) {
    const [job] = await tx.select({ jobTypeId: schema.job.jobTypeId }).from(schema.job)
      .where(eq(schema.job.id, jobId)).limit(1);
    if (job?.jobTypeId) {
      [row] = await tx.select().from(schema.proposalTemplate)
        .where(and(eq(schema.proposalTemplate.jobTypeId, job.jobTypeId), isNull(schema.proposalTemplate.deletedAt))).limit(1);
    }
  }
  if (!row) {
    [row] = await tx.select().from(schema.proposalTemplate)
      .where(and(eq(schema.proposalTemplate.isDefault, true), isNull(schema.proposalTemplate.deletedAt))).limit(1);
  }
  return row ? { proposalTemplateId: row.id, proposalLayout: snapshot(row) } : { proposalTemplateId: null, proposalLayout: null };
}

async function draftEstimate(tx: Database, ctx: ServiceContext, estimateId: string) {
  await assertEstimateVisible(tx, ctx, estimateId);
  const [row] = await tx.select({ id: schema.estimate.id, status: schema.estimate.status })
    .from(schema.estimate).where(eq(schema.estimate.id, estimateId)).limit(1);
  if (!row) throw new NotFoundError("Estimate");
  if (row.status !== "draft") {
    throw new ConflictError(
      "This estimate has been sent, and sending froze what the customer reads. Change the layout on a draft, "
      + "or write a new estimate and send that.",
    );
  }
  return row;
}

/**
 * Apply a layout to a draft estimate, or take it off (null) for the fixed
 * one. The estimate gets a copy; editing the template later changes nothing
 * here unless it is applied again.
 */
export async function applyToEstimate(ctx: ServiceContext, input: { estimateId: string; templateId: string | null }) {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    await draftEstimate(tx, ctx, input.estimateId);
    const template = input.templateId ? await load(tx, input.templateId) : null;
    const [before] = await tx.select({ proposalTemplateId: schema.estimate.proposalTemplateId, proposalLayout: schema.estimate.proposalLayout })
      .from(schema.estimate).where(eq(schema.estimate.id, input.estimateId)).limit(1);
    await tx.update(schema.estimate).set({
      proposalTemplateId: template?.id ?? null,
      proposalLayout: template ? snapshot(template) : null,
      updatedAt: new Date(),
    }).where(eq(schema.estimate.id, input.estimateId));
    await audit(tx, ctx, "estimate.proposal_template_applied", "estimate", input.estimateId, before ?? null,
      { proposalTemplateId: template?.id ?? null });
    return { estimateId: input.estimateId, templateId: template?.id ?? null, templateName: template?.name ?? null };
  });
}

/**
 * A photograph on one option of a draft estimate: the condenser being
 * replaced, the system on offer. Shown under the option on the proposal when
 * its layout says so.
 */
export async function addOptionPhoto(
  ctx: ServiceContext, input: { optionId: string; fileName: string; bytes: string | Uint8Array },
) {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    const [option] = await tx.select({ id: schema.estimateOption.id, estimateId: schema.estimateOption.estimateId })
      .from(schema.estimateOption).where(eq(schema.estimateOption.id, input.optionId)).limit(1);
    if (!option) throw new NotFoundError("Option");
    await draftEstimate(tx, ctx, option.estimateId);
    const bytes = typeof input.bytes === "string" ? decode(input.bytes) : input.bytes;
    const { file } = await put(tx, ctx.actor.organizationId, { bytes, maxBytes: IMAGE_LIMIT, uploadedByUserId: ctx.actor.userId });
    if (!file.contentType.startsWith("image/")) throw new ConflictError("An option's picture is a photograph: a JPEG or a PNG.");
    const [already] = await tx.select({ id: schema.attachment.id }).from(schema.attachment).where(and(
      eq(schema.attachment.entityType, "estimate_option"), eq(schema.attachment.entityId, option.id),
      eq(schema.attachment.storageKey, file.storageKey), isNull(schema.attachment.deletedAt),
    )).limit(1);
    const id = already?.id ?? (await attach(tx, ctx.actor.organizationId, {
      entityType: "estimate_option", entityId: option.id, storageKey: file.storageKey, kind: "photo",
      fileName: input.fileName, contentType: file.contentType, sizeBytes: file.sizeBytes, uploadedByUserId: ctx.actor.userId,
    })).id;
    if (!already) await audit(tx, ctx, "estimate.option_photo_added", "estimate", option.estimateId, null, { optionId: option.id, attachmentId: id });
    return { id, optionId: option.id, estimateId: option.estimateId };
  });
}

/** Take a photograph off an option of a draft estimate. The bytes stay for whatever else uses them. */
export async function removeOptionPhoto(ctx: ServiceContext, input: { attachmentId: string }) {
  return guardedWrite(ctx, "estimate:write", async (tx) => {
    const [photo] = await tx.select().from(schema.attachment).where(and(
      eq(schema.attachment.id, input.attachmentId), eq(schema.attachment.entityType, "estimate_option"),
      isNull(schema.attachment.deletedAt),
    )).limit(1);
    if (!photo) throw new NotFoundError("Photograph");
    const [option] = await tx.select({ estimateId: schema.estimateOption.estimateId }).from(schema.estimateOption)
      .where(eq(schema.estimateOption.id, photo.entityId)).limit(1);
    if (!option) throw new NotFoundError("Option");
    await draftEstimate(tx, ctx, option.estimateId);
    await tx.update(schema.attachment).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(schema.attachment.id, photo.id));
    await audit(tx, ctx, "estimate.option_photo_removed", "estimate", option.estimateId, photo, null);
    return { id: photo.id, removed: true as const };
  });
}

/* ------------------------------------------------------ read for a page */

export interface ResolvedLayout {
  templateName: string | null;
  cover: { headline: string; intro: string | null; photoKey: string | null } | null;
  sections: Array<est.Section & { reviews?: Array<{ author: string | null; rating: number; body: string | null; postedAt: string }> }>;
  showOptionPhotos: boolean;
  /** Each option's photographs, by option id, in the order they were added. */
  optionPhotos: Record<string, Array<{ id: string; storageKey: string; contentType: string | null }>>;
}

/**
 * The layout an estimate is drawn in, with what its sections read from the
 * database: the reviews, the option photographs. Inside a transaction the
 * caller holds and has authorised, for the office page, the customer's link
 * and the PDF alike, so the three cannot draw it differently.
 *
 * The reviews are the company's own, the best first and then the newest,
 * with words in them: a five star rating with nothing written is a number,
 * and a section of numbers persuades nobody.
 */
export async function layoutWithin(tx: Database, estimateId: string, stored: unknown): Promise<ResolvedLayout> {
  const layout = est.layoutOrFixed(stored);
  const templateName = stored && typeof stored === "object" && typeof (stored as Record<string, unknown>)["templateName"] === "string"
    ? (stored as Record<string, string>)["templateName"]! : null;

  const sections: ResolvedLayout["sections"] = [];
  for (const section of layout.sections) {
    if (section.kind !== "reviews") { sections.push(section); continue; }
    const rows = await tx.select({
      author: schema.review.authorName, rating: schema.review.rating, body: schema.review.body, postedAt: schema.review.postedAt,
    }).from(schema.review)
      .where(and(gte(schema.review.rating, section.minRating ?? 5), isNotNull(schema.review.body)))
      .orderBy(desc(schema.review.rating), desc(schema.review.postedAt))
      .limit(section.count ?? 3);
    sections.push({
      ...section,
      reviews: rows.filter((r) => (r.body ?? "").trim() !== "")
        .map((r) => ({ author: r.author, rating: r.rating, body: r.body, postedAt: r.postedAt.toISOString() })),
    });
  }

  const optionPhotos: ResolvedLayout["optionPhotos"] = {};
  if (layout.showOptionPhotos) {
    const options = await tx.select({ id: schema.estimateOption.id }).from(schema.estimateOption)
      .where(eq(schema.estimateOption.estimateId, estimateId));
    if (options.length > 0) {
      const photos = await tx.select({
        id: schema.attachment.id, entityId: schema.attachment.entityId,
        storageKey: schema.attachment.storageKey, contentType: schema.attachment.contentType,
      }).from(schema.attachment).where(and(
        eq(schema.attachment.entityType, "estimate_option"),
        inArray(schema.attachment.entityId, options.map((o) => o.id)),
        isNull(schema.attachment.deletedAt),
      )).orderBy(asc(schema.attachment.createdAt));
      for (const photo of photos) {
        (optionPhotos[photo.entityId] ??= []).push({ id: photo.id, storageKey: photo.storageKey, contentType: photo.contentType });
      }
    }
  }
  return { templateName, cover: layout.cover, sections, showOptionPhotos: layout.showOptionPhotos, optionPhotos };
}

/**
 * The bytes of one photograph a proposal shows, when it is one: the cover
 * its estimate's layout names, or a photograph on one of its options. Any
 * other key is not found, so a link to a proposal cannot be turned into a
 * way to read the company's other files.
 */
export async function proposalPhotoWithin(tx: Database, estimateId: string, photoId: string) {
  const [estimate] = await tx.select({ layout: schema.estimate.proposalLayout }).from(schema.estimate)
    .where(eq(schema.estimate.id, estimateId)).limit(1);
  if (!estimate) throw new NotFoundError("Photograph");
  const layout = est.layoutOrFixed(estimate.layout);
  let key: string | null = null;
  if (photoId === "cover") key = layout.cover?.photoKey ?? null;
  else if (/^[0-9a-f-]{36}$/i.test(photoId) && layout.showOptionPhotos) {
    const [photo] = await tx.select({ storageKey: schema.attachment.storageKey, optionId: schema.attachment.entityId })
      .from(schema.attachment).where(and(
        eq(schema.attachment.id, photoId), eq(schema.attachment.entityType, "estimate_option"), isNull(schema.attachment.deletedAt),
      )).limit(1);
    if (photo) {
      const [option] = await tx.select({ id: schema.estimateOption.id }).from(schema.estimateOption)
        .where(and(eq(schema.estimateOption.id, photo.optionId), eq(schema.estimateOption.estimateId, estimateId))).limit(1);
      if (option) key = photo.storageKey;
    }
  }
  if (!key) throw new NotFoundError("Photograph");
  const [file] = await tx.select({ bytes: schema.storedFile.bytes, contentType: schema.storedFile.contentType })
    .from(schema.storedFile).where(and(eq(schema.storedFile.storageKey, key), isNull(schema.storedFile.deletedAt))).limit(1);
  if (!file) throw new NotFoundError("Photograph");
  return { bytes: file.bytes, contentType: file.contentType };
}

/** The cover photograph of a template, for the editor's preview. */
export async function templatePhoto(ctx: ServiceContext, input: { id: string }) {
  return guardedRead(ctx, "estimate:read", async (tx) => {
    const row = await load(tx, input.id);
    const key = row.cover?.photoKey;
    if (!key) throw new NotFoundError("Photograph");
    const [file] = await tx.select({ bytes: schema.storedFile.bytes, contentType: schema.storedFile.contentType })
      .from(schema.storedFile).where(and(eq(schema.storedFile.storageKey, key), isNull(schema.storedFile.deletedAt))).limit(1);
    if (!file) throw new NotFoundError("Photograph");
    return { bytes: file.bytes, contentType: file.contentType };
  });
}

/** The office's view of a proposal photograph, under the estimate's own read and scope. */
export async function proposalPhoto(ctx: ServiceContext, input: { estimateId: string; photoId: string }) {
  return guardedRead(ctx, "estimate:read", async (tx) => {
    await assertEstimateVisible(tx, ctx, input.estimateId);
    return proposalPhotoWithin(tx, input.estimateId, input.photoId);
  });
}

/* ------------------------------------------------------------ the routes */

export const handlers = {
  listProposalTemplates: async (ctx: ServiceContext) => ({ templates: await list(ctx) }),
  getProposalTemplate: (ctx: ServiceContext, input: { id: string }) => get(ctx, input),
  createProposalTemplate: (ctx: ServiceContext, input: Omit<SaveInput, "id">) => save(ctx, input),
  updateProposalTemplate: (ctx: ServiceContext, input: SaveInput & { id: string }) => save(ctx, input),
  deleteProposalTemplate: (ctx: ServiceContext, input: { id: string }) => remove(ctx, input),
  uploadProposalCover: (ctx: ServiceContext, input: { id: string; fileName: string; bytes: string }) =>
    uploadCoverPhoto(ctx, input),
  applyProposalTemplate: (ctx: ServiceContext, input: { id: string; templateId: string | null }) =>
    applyToEstimate(ctx, { estimateId: input.id, templateId: input.templateId }),
  addEstimateOptionPhoto: (ctx: ServiceContext, input: { id: string; fileName: string; bytes: string }) =>
    addOptionPhoto(ctx, { optionId: input.id, fileName: input.fileName, bytes: input.bytes }),
  removeEstimateOptionPhoto: (ctx: ServiceContext, input: { id: string }) =>
    removeOptionPhoto(ctx, { attachmentId: input.id }),
} as const;
