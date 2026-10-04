import { createHash } from "node:crypto";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { isSystem, people as peopleCore, safety as safetyRules } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { attach, decode, put } from "./files";
import * as once from "./once";

/**
 * M24. WHAT THE COMPANY ASKS ITS OWN PEOPLE TO SIGN
 *
 * The handbook, the drug and alcohol policy, the vehicle use agreement: the
 * office writes the words once, asks people to sign them, and each person
 * signs their own from their own record (`services/me.ts`), by typing their
 * name or drawing it. Until this, onboarding could say "handbook signed" only
 * as a line somebody in the office ticked, which is a record that somebody
 * believed it happened.
 *
 * STORED AS EVERY OTHER SIGNATURE IS. A `document_signature` row, subject
 * `staff_document`, with the signer's name, their email, the moment, the
 * address and browser it came from when the screen passes them, and the hash
 * of the exact words they were shown. A drawn signature's picture is a stored
 * file attached to that row, kind `signature`, the way a toolbox talk's is.
 *
 * THE WORDS DO NOT CHANGE. There is no edit: a policy rewritten after twelve
 * people signed it would leave twelve signatures under words they never saw.
 * A new version is a new document, and retiring the old one stops anybody new
 * being asked while leaving every signature it has where it is.
 *
 * PERMISSIONS, none new. Writing and asking is the roster's `user:write`,
 * reading who signed is `user:read`, and signing your own is `profile:own`.
 */

const hashOf = (title: string, body: string): string =>
  createHash("sha256").update(JSON.stringify({ title, body })).digest("hex");

const uploader = (ctx: ServiceContext) => (isSystem(ctx.actor) ? null : ctx.actor.userId);

export interface StaffDocumentSummary {
  id: string;
  title: string;
  retired: boolean;
  createdAt: string;
  asked: number;
  signed: number;
}

export interface SignatureRequestView {
  id: string;
  membershipId: string;
  name: string;
  askedAt: string;
  signedAt: string | null;
  signedVia: string | null;
  signerName: string | null;
}

export interface StaffDocumentView {
  id: string;
  title: string;
  body: string;
  bodyHash: string;
  retiredAt: string | null;
  createdAt: string;
  requests: SignatureRequestView[];
}

/** Colleagues' names by membership, through the directory: `user` shows only one's own row. */
async function namesByMembership(tx: Database): Promise<Map<string, string>> {
  const rows = await tx.execute<{ membership_id: string; name: string | null; email: string }>(
    sql`select membership_id, name, email from app.organization_people()`,
  );
  return new Map(rows.map((r) => [r.membership_id, r.name ?? r.email]));
}

async function documentWithin(tx: Database, ctx: ServiceContext, id: string) {
  const [row] = await tx.select().from(schema.staffDocument)
    .where(and(
      eq(schema.staffDocument.id, id),
      eq(schema.staffDocument.organizationId, ctx.actor.organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Document");
  return row;
}

async function viewWithin(tx: Database, ctx: ServiceContext, id: string): Promise<StaffDocumentView> {
  const row = await documentWithin(tx, ctx, id);
  const requests = await tx.select({
    request: schema.staffDocumentRequest,
    signerName: schema.documentSignature.signerName,
  }).from(schema.staffDocumentRequest)
    .leftJoin(schema.documentSignature, eq(schema.documentSignature.id, schema.staffDocumentRequest.signatureId))
    .where(eq(schema.staffDocumentRequest.documentId, id))
    .orderBy(asc(schema.staffDocumentRequest.createdAt));
  const names = await namesByMembership(tx);
  return {
    id: row.id,
    title: row.title,
    body: row.body,
    bodyHash: row.bodyHash,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    requests: requests.map(({ request, signerName }) => ({
      id: request.id,
      membershipId: request.membershipId,
      name: names.get(request.membershipId) ?? "Somebody who has left",
      askedAt: request.createdAt.toISOString(),
      signedAt: request.signedAt?.toISOString() ?? null,
      signedVia: request.signedVia,
      signerName: signerName ?? null,
    })),
  };
}

export function list(ctx: ServiceContext): Promise<StaffDocumentSummary[]> {
  return guardedRead(ctx, "user:read", async (tx) => {
    const rows = await tx.select({
      doc: schema.staffDocument,
      asked: sql<number>`(select count(*)::int from public.staff_document_request r where r.document_id = ${schema.staffDocument.id})`,
      signed: sql<number>`(select count(*)::int from public.staff_document_request r where r.document_id = ${schema.staffDocument.id} and r.signed_at is not null)`,
    }).from(schema.staffDocument)
      .where(eq(schema.staffDocument.organizationId, ctx.actor.organizationId))
      .orderBy(desc(schema.staffDocument.createdAt));
    return rows.map(({ doc, asked, signed }) => ({
      id: doc.id, title: doc.title, retired: doc.retiredAt !== null, createdAt: doc.createdAt.toISOString(),
      asked, signed,
    }));
  });
}

export function get(ctx: ServiceContext, input: { id: string }): Promise<StaffDocumentView> {
  return guardedRead(ctx, "user:read", (tx) => viewWithin(tx, ctx, input.id));
}

/** Write a document for people to sign. The words are fixed from here on. */
export function create(ctx: ServiceContext, input: { title: string; body: string }): Promise<StaffDocumentView> {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const seen = await once.replayed<StaffDocumentView>(tx, ctx, "staff_document");
    if (seen) return seen;
    const title = input.title.trim();
    const body = input.body.trim();
    if (title === "") throw new ConflictError("Give the document a title people will recognise, like Employee handbook.");
    if (body.length < 20) {
      throw new ConflictError("Put the words people are signing in the document. A signature under a title alone says nothing.");
    }
    const [row] = await tx.insert(schema.staffDocument).values({
      organizationId: ctx.actor.organizationId,
      title,
      body,
      bodyHash: hashOf(title, body),
      createdByUserId: uploader(ctx),
    }).returning({ id: schema.staffDocument.id });
    await audit(tx, ctx, "staff_document.created", "staff_document", row!.id, null, { title });
    const view = await viewWithin(tx, ctx, row!.id);
    await once.remember(tx, ctx, "staff_document", row!.id, view);
    return view;
  });
}

/**
 * Stop asking anybody new to sign it. Whoever was already asked can still
 * sign what they were given, and every signature stays.
 */
export function retire(ctx: ServiceContext, input: { id: string }): Promise<StaffDocumentView> {
  return guardedWrite(ctx, "user:write", async (tx) => {
    const row = await documentWithin(tx, ctx, input.id);
    if (!row.retiredAt) {
      await tx.update(schema.staffDocument).set({ retiredAt: new Date(), updatedAt: new Date() })
        .where(eq(schema.staffDocument.id, row.id));
      await audit(tx, ctx, "staff_document.retired", "staff_document", row.id, null, { title: row.title });
    }
    return viewWithin(tx, ctx, row.id);
  });
}

/**
 * Ask people to sign, inside a transaction somebody else opened (starting
 * onboarding asks for the documents on the checklist). Asking somebody who
 * was already asked asks once: the index holds one request per person per
 * document, and the insert leaves an existing one alone.
 */
export async function askWithin(
  tx: Database, ctx: ServiceContext, documentId: string, membershipIds: string[],
): Promise<number> {
  const doc = await documentWithin(tx, ctx, documentId);
  if (doc.retiredAt) {
    throw new ConflictError(`${doc.title} has been retired, so nobody new is asked to sign it. Ask for its newer version.`);
  }
  const ids = [...new Set(membershipIds)];
  if (ids.length === 0) return 0;
  const members = await tx.select({ id: schema.membership.id }).from(schema.membership)
    .where(and(
      inArray(schema.membership.id, ids),
      eq(schema.membership.organizationId, ctx.actor.organizationId),
      eq(schema.membership.active, true),
    ));
  if (members.length !== ids.length) throw new NotFoundError("One of those people");
  const added = await tx.insert(schema.staffDocumentRequest).values(ids.map((membershipId) => ({
    organizationId: ctx.actor.organizationId,
    documentId,
    membershipId,
    requestedByUserId: uploader(ctx),
  }))).onConflictDoNothing().returning({ id: schema.staffDocumentRequest.id });
  if (added.length > 0) {
    await audit(tx, ctx, "staff_document.asked", "staff_document", documentId, null, { people: ids, added: added.length });
  }
  return added.length;
}

/** Ask people to sign a document. Asking again asks once. */
export function ask(ctx: ServiceContext, input: { id: string; membershipIds: string[] }): Promise<StaffDocumentView> {
  return guardedWrite(ctx, "user:write", async (tx) => {
    if (input.membershipIds.length === 0) throw new ConflictError("Choose who to ask.");
    await askWithin(tx, ctx, input.id, input.membershipIds);
    return viewWithin(tx, ctx, input.id);
  });
}

/* ---------------------------------------------------------- one's own */

export interface OwnDocument {
  requestId: string;
  documentId: string;
  title: string;
  body: string;
  askedAt: string;
  signedAt: string | null;
  signedVia: string | null;
  signerName: string | null;
}

/** The documents this person was asked to sign, signed or not, newest first. */
export async function ownWithin(tx: Database, membershipId: string): Promise<OwnDocument[]> {
  const rows = await tx.select({
    request: schema.staffDocumentRequest,
    title: schema.staffDocument.title,
    body: schema.staffDocument.body,
    signerName: schema.documentSignature.signerName,
  }).from(schema.staffDocumentRequest)
    .innerJoin(schema.staffDocument, eq(schema.staffDocument.id, schema.staffDocumentRequest.documentId))
    .leftJoin(schema.documentSignature, eq(schema.documentSignature.id, schema.staffDocumentRequest.signatureId))
    .where(eq(schema.staffDocumentRequest.membershipId, membershipId))
    .orderBy(desc(schema.staffDocumentRequest.createdAt));
  return rows.map(({ request, title, body, signerName }) => ({
    requestId: request.id,
    documentId: request.documentId,
    title,
    body,
    askedAt: request.createdAt.toISOString(),
    signedAt: request.signedAt?.toISOString() ?? null,
    signedVia: request.signedVia,
    signerName: signerName ?? null,
  }));
}

export interface SignInput {
  requestId: string;
  /** Their full name, typed. Or: */
  typedName?: string | null | undefined;
  /** Their signature drawn on the screen, as a PNG data URL. */
  drawing?: string | null | undefined;
  /** Where it came from, when the screen can say. Kept on the signature as evidence. */
  ipAddress?: string | null | undefined;
  userAgent?: string | null | undefined;
}

/**
 * Sign one's own document, in a transaction the caller opened with the
 * signer resolved from the session (`me.sign`), never from the request.
 *
 * Signing twice is the first signature: a retry after a lost response finds
 * it signed and answers with it. Signing ticks every onboarding line of
 * theirs that this document is, so the office's checklist moves on its own.
 */
export async function signWithin(tx: Database, ctx: ServiceContext, self: {
  membershipId: string; name: string; email: string;
}, input: SignInput): Promise<OwnDocument> {
  const [request] = await tx.select().from(schema.staffDocumentRequest)
    .where(and(
      eq(schema.staffDocumentRequest.id, input.requestId),
      eq(schema.staffDocumentRequest.membershipId, self.membershipId),
    )).for("update").limit(1);
  /** Somebody else's request reads as not found: theirs is not there to sign. */
  if (!request) throw new NotFoundError("Document to sign");
  const ownView = async () => (await ownWithin(tx, self.membershipId)).find((d) => d.requestId === request.id)!;
  if (request.signedAt) return ownView();

  const drawing = input.drawing?.trim() || null;
  const verdict = peopleCore.checkSignature({ typedName: input.typedName, drawn: drawing !== null, ownName: self.name });
  if (!verdict.ok) throw new ConflictError(verdict.reason);

  const [doc] = await tx.select().from(schema.staffDocument)
    .where(eq(schema.staffDocument.id, request.documentId)).limit(1);
  if (!doc) throw new NotFoundError("Document to sign");

  const now = new Date();
  const [signature] = await tx.insert(schema.documentSignature).values({
    organizationId: ctx.actor.organizationId,
    subject: "staff_document",
    subjectId: request.id,
    signerName: verdict.signerName,
    signerEmail: self.email,
    documentHash: doc.bodyHash,
    signedAt: now,
    ipAddress: input.ipAddress?.slice(0, 64) ?? null,
    userAgent: input.userAgent?.slice(0, 500) ?? null,
  }).returning({ id: schema.documentSignature.id });

  if (drawing) {
    const bytes = decode(drawing);
    if (bytes.length > safetyRules.MAX_SIGNATURE_BYTES) {
      throw new ConflictError("That signature is far larger than a drawn one. Draw it again.");
    }
    const { file } = await put(tx, ctx.actor.organizationId, {
      bytes, claimedType: "image/png", uploadedByUserId: uploader(ctx),
    });
    if (!file.contentType.startsWith("image/")) throw new ConflictError("A signature has to be a picture.");
    await attach(tx, ctx.actor.organizationId, {
      entityType: "document_signature", entityId: signature!.id, storageKey: file.storageKey,
      kind: "signature", fileName: "signature.png", contentType: file.contentType, sizeBytes: file.sizeBytes,
      uploadedByUserId: uploader(ctx),
    });
  }

  await tx.update(schema.staffDocumentRequest).set({
    signedAt: now, signedVia: verdict.method, signatureId: signature!.id, updatedAt: now,
  }).where(eq(schema.staffDocumentRequest.id, request.id));

  /** The onboarding lines this document is, ticked by the signature itself. */
  await tx.update(schema.onboardingItem).set({
    doneAt: now, doneByUserId: uploader(ctx), note: `Signed ${verdict.method === "typed" ? "by typing their name" : "by drawing"}`,
    updatedAt: now,
  }).where(and(
    eq(schema.onboardingItem.membershipId, self.membershipId),
    eq(schema.onboardingItem.staffDocumentId, doc.id),
    isNull(schema.onboardingItem.doneAt),
  ));

  await audit(tx, ctx, "staff_document.signed", "staff_document", doc.id, null, {
    requestId: request.id, via: verdict.method, signerName: verdict.signerName, documentHash: doc.bodyHash,
  });
  return ownView();
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listStaffDocuments: async (ctx: ServiceContext) => ({ documents: await list(ctx) }),
  getStaffDocument: (ctx: ServiceContext, input: { id: string }) => get(ctx, input),
  createStaffDocument: (ctx: ServiceContext, input: { title: string; body: string }) => create(ctx, input),
  retireStaffDocument: (ctx: ServiceContext, input: { id: string }) => retire(ctx, input),
  askToSignStaffDocument: (ctx: ServiceContext, input: { id: string; membershipIds: string[] }) => ask(ctx, input),
} as const;
