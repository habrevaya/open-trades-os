import { and, asc, desc, eq, inArray, isNull, lte, or, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { packById } from "@opentradesos/trade-packs";
import { time } from "@opentradesos/core";
import {
  guardedRead, guardedWrite, timezoneOf, audit,
  ConflictError, NotFoundError, type ServiceContext,
} from "./context";
import { attach } from "./files";
import { cancelFor, raise } from "./obligations";

/**
 * DOCUMENTS, REGULATORY SUBMISSIONS AND THE FIGURES THAT MOVE
 *
 * Three tables, two of which no line of code had ever touched.
 * `regulatory_submission` and `regulatory_constant` were in the first
 * compliance migration with comments describing a working feature, and the
 * only thing in this file's area that anything wrote was `retention_policy`,
 * seeded by `trade-pack.ts` and read by nothing. `document:write` was in the
 * permission catalogue, on every office role, and asserted nowhere, which
 * means an owner who withheld it withheld nothing.
 *
 *
 * THE ONE THING THIS MODULE MUST NOT DO
 *
 * It must never tell a contractor they are compliant, and the reason is not
 * caution, it is that the sentence is unsupportable by anything in this
 * database.
 *
 * "You are compliant" is a claim about a SET: that the documents, filings and
 * figures a business is required to hold are all present and all current. The
 * software holds the numerator, which is the rows somebody put here. It does
 * not hold the denominator and cannot: which documents a given business must
 * hold depends on the trade, the jurisdiction, the licence classes it works
 * under, the contracts it has signed, what its insurer requires, and what all
 * of those said this year rather than last. Nothing in this product knows any
 * of that, and nothing in a trade pack claims to either: the pack schema says
 * a submission seed "describes what the software must produce and to whom,
 * never what the business is legally required to do".
 *
 * A green tick assembled from an unknown denominator is not an optimistic
 * summary, it is an assertion about law made by a system with no access to
 * the facts the assertion depends on. And it is the single most dangerous
 * artefact this module could produce, for the same reason `inspections.ts`
 * gives about filing a half finished inspection as a pass: that screenshot
 * goes to a general contractor, to an insurer, into a bid package, and
 * everyone downstream believes it.
 *
 * So every read here returns facts about rows, each of which the code can
 * defend:
 *
 *   this document expired on this date, that many days ago
 *   this document expires on this date and the operator said it needs N days
 *   this submission was acknowledged on this date with this reference
 *   this submission was rejected, and here is what the authority said
 *   this figure's published window ended on this date and no later one exists
 *
 * There is no rollup, no score, no boolean, and `summary` below returns
 * counts rather than a verdict. The counts are statements about the register:
 * "four documents on file have expired" is true of the rows. "You have no
 * expired documents" would be true of the rows too, and it is deliberately
 * not phrased as "you are covered", because a register with nothing in it
 * produces the same zero.
 *
 * `recording_policy` in the comms schema is the precedent and the posture is
 * copied from it: that table "holds a claim the operator made, not a
 * statement of law. The software's job is to hold them to it consistently and
 * to refuse to record when their own declaration does not cover the call.
 * Whether the declaration is correct is a question for them and their
 * counsel." Everywhere this module looks like it is making a compliance
 * judgement, it is holding the operator to something they declared:
 * `required_for_work` is their flag on their document, `notice_days` is their
 * estimate of their own renewal lead time, and a submission's due date is a
 * date they supplied rather than one computed from a statute.
 *
 *
 * WHAT IS DELIBERATELY NOT A NEW MECHANISM HERE
 *
 * A renewal deadline is an `obligation`, raised through `obligations.raise`
 * and cancelled through `obligations.cancelFor`. That table exists so that
 * "what is about to breach" is one question across SLAs, acknowledgements and
 * now expiries, and a second queue on a compliance screen is how a licence
 * lapses in a product that knew the date.
 *
 * The bytes are a `stored_file` pointed at by an `attachment`, through
 * `files.attach`, which keeps the reference count honest. This file writes no
 * storage key of its own.
 *
 * The submission PROGRAMME is the trade pack's `submissions` list and is not
 * copied into a table. `inspections.ts` makes the argument at length: two
 * representations of one programme is the defect this codebase has already
 * produced twice. A declared kind takes its authority, jurisdiction and route
 * from the pack, and this file refuses an input that would state them a
 * second time.
 *
 * A PERSON'S OWN CREDENTIAL IS NOT HERE EITHER. `person_certification` and
 * `certification_type` are M24's register of what an individual holds, and
 * the renewal lead time belongs on the certification type rather than on a
 * scan of a card. A technician's licence recorded in both places is two
 * expiry dates for one credential, and the first time they disagree nothing
 * can say which is right. What this register holds is a document the COMPANY
 * holds: its contractor licence, its liability cover, a permit on a job, a
 * product's safety data sheet.
 *
 * Fleet and instrument expiries are NOT here. `core/src/assets`'s
 * `complianceOutlook` and the `asset_compliance` table are M22's, keyed by
 * asset id and by the four obligations an asset kind declares, with profiles
 * that know a van is grounded and an uncalibrated analyser casts doubt
 * backwards. None of that is true of a contractor's licence, and a second
 * implementation of the asset outlook here would be the duplication this
 * module spends the rest of its comments avoiding.
 */

/* ------------------------------------------------------- expiry standing */

/**
 * The four words, which are the same four `core/src/assets` uses for an
 * asset's obligations, because one vocabulary across both screens is worth
 * more than a slightly better fitting word on one of them.
 *
 * `current` rather than `clear`: an asset obligation that is nowhere near
 * expiry genuinely is clear, because the asset kind declares which
 * obligations it needs and core can say when they are all present. This
 * register has no such list, so the strongest word available about one
 * document is that the document itself is in date.
 */
export type ExpiryStanding = "expired" | "act_now" | "upcoming" | "current" | "no_expiry";

export interface ExpiryView {
  standing: ExpiryStanding;
  /** Negative once it has passed. Null when the document does not expire. */
  daysUntilExpiry: number | null;
  /** The day the operator's own notice period says the renewal must start. */
  actBy: string | null;
}

const DAY = 86_400_000;

const shiftDays = (date: string, by: number): string =>
  new Date(Date.parse(`${date}T00:00:00Z`) + by * DAY).toISOString().slice(0, 10);

const daysBetween = (from: string, to: string): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY);

/**
 * Worked out from the date against the clock, never read from a column.
 *
 * `obligation` makes this argument about breaches and it applies here
 * unchanged: if expiry were a stored state, then a sweep that is not deployed,
 * or died three weeks ago, leaves every document reading `active` and the
 * screen says everything is in date. A monitoring surface whose failure mode
 * is a clean bill of health is worse than no surface at all, because somebody
 * stops checking the folder.
 */
export function standingOf(
  expiresOn: string | null,
  noticeDays: number,
  today: string,
): ExpiryView {
  if (!expiresOn) return { standing: "no_expiry", daysUntilExpiry: null, actBy: null };

  const daysUntilExpiry = daysBetween(today, expiresOn);
  const actBy = shiftDays(expiresOn, -noticeDays);

  const standing: ExpiryStanding =
    daysUntilExpiry < 0
      ? "expired"
      : today >= actBy
        ? "act_now"
        : "upcoming";

  return { standing, daysUntilExpiry, actBy };
}

/* ------------------------------------------------------ document register */

export interface DocumentView {
  id: string;
  kind: string;
  name: string;
  reference: string | null;
  issuerName: string | null;
  jurisdiction: string | null;
  subjectType: string | null;
  subjectId: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  noticeDays: number;
  requiredForWork: boolean;
  state: typeof schema.complianceDocumentState.enumValues[number];
  supersedesId: string | null;
  notes: string | null;
  standing: ExpiryStanding;
  daysUntilExpiry: number | null;
  actBy: string | null;
  /**
   * Core's own sentence would be better and there is no core function for
   * this shape, so it is assembled here, once, rather than at three call
   * sites that would word it differently.
   */
  statement: string;
}

const describe = (row: typeof schema.complianceDocument.$inferSelect, today: string): DocumentView => {
  const expiry = standingOf(row.expiresOn, row.noticeDays, today);
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    reference: row.reference,
    issuerName: row.issuerName,
    jurisdiction: row.jurisdiction,
    subjectType: row.subjectType,
    subjectId: row.subjectId,
    issuedOn: row.issuedOn,
    expiresOn: row.expiresOn,
    noticeDays: row.noticeDays,
    requiredForWork: row.requiredForWork,
    state: row.state,
    supersedesId: row.supersedesId,
    notes: row.notes,
    standing: expiry.standing,
    daysUntilExpiry: expiry.daysUntilExpiry,
    actBy: expiry.actBy,
    statement: sentence(row, expiry),
  };
};

/**
 * What somebody would say about this document, and nothing more than that.
 *
 * Every branch names the document, a date and a consequence the operator
 * themselves declared. None of them says whether the business may trade, may
 * bid, or is covered, because this function has no way to know and a sentence
 * that implies it would be read as though it did.
 */
function sentence(
  row: typeof schema.complianceDocument.$inferSelect,
  expiry: ExpiryView,
): string {
  const what = `${row.name}${row.reference ? ` (${row.reference})` : ""}`;

  if (row.state === "withdrawn") {
    return `${what} was withdrawn${row.withdrawnReason ? `: ${row.withdrawnReason}` : "."}`;
  }
  if (row.state === "superseded") {
    return `${what} was replaced by a later document. It is kept because what was held on a past date is a question somebody asks later.`;
  }
  if (expiry.standing === "no_expiry") {
    return `${what} is on file with no expiry date recorded.`;
  }

  const blocked = row.requiredForWork
    ? " The operator marked it as required for work, so work marked as needing it should not be assigned while it is lapsed."
    : "";

  if (expiry.standing === "expired") {
    return `${what} expired on ${row.expiresOn}, ${-(expiry.daysUntilExpiry ?? 0)} days ago.${blocked}`;
  }
  if (expiry.standing === "act_now") {
    return `${what} expires on ${row.expiresOn}, in ${expiry.daysUntilExpiry} days, and the operator allowed ${row.noticeDays} days to renew it. The renewal should already have started on ${expiry.actBy}.`;
  }
  return `${what} expires on ${row.expiresOn}, in ${expiry.daysUntilExpiry} days. Start the renewal by ${expiry.actBy}.`;
}

export interface RegisterInput {
  kind: string;
  name: string;
  reference?: string | null | undefined;
  issuerName?: string | null | undefined;
  jurisdiction?: string | null | undefined;
  subjectType?: string | null | undefined;
  subjectId?: string | null | undefined;
  issuedOn?: string | null | undefined;
  expiresOn?: string | null | undefined;
  noticeDays?: number | undefined;
  requiredForWork?: boolean | undefined;
  notes?: string | null | undefined;
  /**
   * The bytes, already in `stored_file` through `files.put`. Optional,
   * because the date is the part that does the work: a licence number and an
   * expiry with no scan is still a renewal somebody gets reminded about, and
   * refusing the row until a photograph arrives means the row never gets
   * created.
   */
  storageKey?: string | null | undefined;
}

/**
 * Put a document on file, and put its renewal in the queue the office works.
 *
 * Guarded by `document:write` rather than `compliance:write`, and the split is
 * the one the catalogue already describes: `document:write` is "Manage company
 * documents" and `compliance:write` is "Manage licences, insurance and
 * compliance records". The register is the filing cabinet, so it is the first;
 * the submissions and the figures below are the second. An office manager who
 * files a certificate of insurance is not thereby entitled to mark a statutory
 * filing as accepted by an authority.
 */
export async function register(ctx: ServiceContext, input: RegisterInput): Promise<DocumentView> {
  return guardedWrite(ctx, "document:write", async (tx) => {
    const row = await insertDocument(tx, ctx, input, null);
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    return describe(row, time.dateIn(new Date(), zone));
  });
}

/**
 * The renewal arrived.
 *
 * A NEW ROW, with the old one marked superseded, rather than an edit. Editing
 * the expiry in place answers "when does it run out" and destroys "what were
 * you holding in March", which is the question an authority, an insurer or a
 * general contractor in a dispute actually asks. `inspections.ts` makes the
 * same argument about revising a programme in place.
 *
 * The old document's obligation is cancelled rather than satisfied. It is the
 * distinction `obligations.ts` draws and it matters to a scorecard: cancelled
 * means the deadline stopped being owed because the thing it was attached to
 * was replaced, and the new row carries the deadline that is owed now.
 */
export async function renew(
  ctx: ServiceContext,
  input: RegisterInput & { id: string },
): Promise<DocumentView> {
  return guardedWrite(ctx, "document:write", async (tx) => {
    const previous = await loadDocument(tx, ctx.actor.organizationId, input.id);
    if (previous.state !== "active") {
      throw new ConflictError(
        `That document is ${previous.state}, so it is not the one in force and renewing it would `
        + "put two live documents in the register for one thing.",
      );
    }

    const row = await insertDocument(tx, ctx, {
      /** Carried forward so a renewal only has to state what changed. */
      kind: input.kind || previous.kind,
      name: input.name || previous.name,
      reference: input.reference !== undefined ? input.reference : previous.reference,
      issuerName: input.issuerName !== undefined ? input.issuerName : previous.issuerName,
      jurisdiction: input.jurisdiction !== undefined ? input.jurisdiction : previous.jurisdiction,
      subjectType: previous.subjectType,
      subjectId: previous.subjectId,
      issuedOn: input.issuedOn ?? null,
      expiresOn: input.expiresOn ?? null,
      noticeDays: input.noticeDays ?? previous.noticeDays,
      requiredForWork: input.requiredForWork ?? previous.requiredForWork,
      notes: input.notes !== undefined ? input.notes : null,
      ...(input.storageKey ? { storageKey: input.storageKey } : {}),
    }, previous.id);

    await tx.update(schema.complianceDocument)
      .set({ state: "superseded", updatedAt: new Date() })
      .where(eq(schema.complianceDocument.id, previous.id));

    await cancelFor(tx, ctx.actor.organizationId, "compliance_document", previous.id);

    await audit(tx, ctx, "compliance_document.renewed", "compliance_document", row.id,
      { expiresOn: previous.expiresOn }, { expiresOn: row.expiresOn, supersedes: previous.id });

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    return describe(row, time.dateIn(new Date(), zone));
  });
}

/**
 * It is not ours any more, or it never should have been here.
 *
 * A reason is required for the same reason declining a deficiency needs one:
 * a withdrawn licence with no sentence beside it is indistinguishable from
 * somebody tidying up, and the difference is the whole value of the record
 * later.
 */
export async function withdraw(
  ctx: ServiceContext,
  input: { id: string; reason: string },
): Promise<DocumentView> {
  return guardedWrite(ctx, "document:write", async (tx) => {
    const before = await loadDocument(tx, ctx.actor.organizationId, input.id);
    const reason = input.reason.trim();
    if (reason === "") {
      throw new ConflictError(
        "Say why it was withdrawn. A withdrawn document with no reason reads as a mistake "
        + "rather than a decision, and the reason is the part somebody needs later.",
      );
    }
    if (before.state === "withdrawn") {
      throw new ConflictError("That document was already withdrawn.");
    }

    const [row] = await tx.update(schema.complianceDocument).set({
      state: "withdrawn",
      withdrawnReason: reason,
      updatedAt: new Date(),
    }).where(eq(schema.complianceDocument.id, input.id)).returning();

    await cancelFor(tx, ctx.actor.organizationId, "compliance_document", input.id);
    await audit(tx, ctx, "compliance_document.withdrawn", "compliance_document", input.id,
      { state: before.state }, { state: "withdrawn", reason });

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    return describe(row!, time.dateIn(new Date(), zone));
  });
}

/**
 * The register, worst first.
 *
 * Superseded and withdrawn rows are excluded unless asked for, IN SQL rather
 * than after the fetch. Filtering afterwards applies the limit first, so a
 * company with four hundred renewed certificates would page through replaced
 * documents and see an empty renewal list. `inspections.ts` and
 * `obligations.ts` both carry this note because both had the bug.
 */
export async function documents(
  ctx: ServiceContext,
  input: {
    subjectType?: string | undefined;
    subjectId?: string | undefined;
    kind?: string | undefined;
    includeReplaced?: boolean | undefined;
    /** Only what needs attention within this many days, plus everything already expired. */
    withinDays?: number | undefined;
    asOf?: string | undefined;
  } = {},
): Promise<DocumentView[]> {
  return guardedRead(ctx, "document:read", async (tx) => {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = input.asOf ?? time.dateIn(new Date(), zone);

    const rows = await tx.select().from(schema.complianceDocument)
      .where(and(
        eq(schema.complianceDocument.organizationId, ctx.actor.organizationId),
        ...(input.includeReplaced
          ? []
          : [eq(schema.complianceDocument.state, "active")]),
        ...(input.subjectType ? [eq(schema.complianceDocument.subjectType, input.subjectType)] : []),
        ...(input.subjectId ? [eq(schema.complianceDocument.subjectId, input.subjectId)] : []),
        ...(input.kind ? [eq(schema.complianceDocument.kind, input.kind)] : []),
      ))
      /**
       * Soonest first, with the documents that do not expire at the end.
       * `nulls last` is Postgres's own default for an ascending sort rather
       * than something being corrected here, and it is written out because a
       * reader checking which end the no expiry rows land on should not have
       * to know that.
       */
      .orderBy(sql`${schema.complianceDocument.expiresOn} asc nulls last`);

    const views = rows.map((row) => describe(row, today));
    if (input.withinDays === undefined) return views;

    const within = input.withinDays;
    return views.filter((view) =>
      view.daysUntilExpiry !== null && view.daysUntilExpiry <= within);
  });
}

/**
 * How many are in each state, and nothing that adds up to a verdict.
 *
 * Read the module comment before adding a field here. A boolean, a percentage
 * or a word like "ready" assembled from these numbers would be a claim about
 * a set this register does not know the size of.
 */
export async function summary(
  ctx: ServiceContext,
  input: { asOf?: string | undefined } = {},
): Promise<{ expired: number; actNow: number; upcoming: number; noExpiry: number; expiredAndRequiredForWork: number }> {
  const views = await documents(ctx, input.asOf === undefined ? {} : { asOf: input.asOf });
  const count = (standing: ExpiryStanding) => views.filter((v) => v.standing === standing).length;
  return {
    expired: count("expired"),
    actNow: count("act_now"),
    upcoming: count("upcoming"),
    noExpiry: count("no_expiry"),
    /**
     * The one number that is about work rather than about paper, and it is
     * still a count of the operator's own flags rather than a dispatch
     * decision. `blockedSubjects` below is what a board would call.
     */
    expiredAndRequiredForWork:
      views.filter((v) => v.standing === "expired" && v.requiredForWork).length,
  };
}

/**
 * Who is carrying a lapsed document they themselves marked as required.
 *
 * This is the answer to "which jobs cannot be dispatched without it", as
 * closely as this product is entitled to give it. It does not look at jobs,
 * and it does not say a job cannot be dispatched, because whether a particular
 * job needs a particular licence is a judgement about the work and the
 * jurisdiction that nothing here can make. What it gives a dispatch board is
 * the fact underneath that judgement: this technician, this asset or this
 * company holds a document the operator flagged as required for work, and it
 * lapsed on this date.
 *
 * Nothing in the dispatch path calls it yet. That is stated rather than
 * implied: `technician.licenses` has carried the comment "Skills and licenses
 * gate dispatch assignment in the scheduling engine" since the first
 * migration, and no code in this repository reads that column, so the gate
 * described there does not exist and this function does not create it either.
 */
export async function blockedSubjects(
  ctx: ServiceContext,
  input: { asOf?: string | undefined } = {},
): Promise<{ subjectType: string | null; subjectId: string | null; documents: DocumentView[] }[]> {
  const views = await documents(ctx, input.asOf === undefined ? {} : { asOf: input.asOf });
  const lapsed = views.filter((v) => v.requiredForWork && v.standing === "expired");

  const grouped = new Map<string, { subjectType: string | null; subjectId: string | null; documents: DocumentView[] }>();
  for (const view of lapsed) {
    const key = `${view.subjectType ?? ""}:${view.subjectId ?? ""}`;
    const bucket = grouped.get(key)
      ?? { subjectType: view.subjectType, subjectId: view.subjectId, documents: [] };
    bucket.documents.push(view);
    grouped.set(key, bucket);
  }
  return [...grouped.values()];
}

async function insertDocument(
  tx: Database,
  ctx: ServiceContext,
  input: RegisterInput,
  supersedesId: string | null,
): Promise<typeof schema.complianceDocument.$inferSelect> {
  const name = input.name.trim();
  if (name === "") throw new ConflictError("A document needs a name.");
  if (input.kind.trim() === "") throw new ConflictError("A document needs a kind.");

  const noticeDays = input.noticeDays ?? 30;
  if (noticeDays < 0) {
    throw new ConflictError("Notice days cannot be negative. A renewal cannot start after the document expires.");
  }

  const issuedOn = input.issuedOn ?? null;
  const expiresOn = input.expiresOn ?? null;

  /**
   * A document that expired before it was issued is a typed date, every time,
   * and the cost of accepting it is specific: the row lands in the register
   * reading `expired`, somebody renews a licence that is perfectly valid, and
   * the real expiry never gets recorded.
   */
  if (issuedOn && expiresOn && expiresOn <= issuedOn) {
    throw new ConflictError(
      `That document expires on ${expiresOn} and was issued on ${issuedOn}, so it would arrive in the `
      + "register already expired. One of the two dates is a typing mistake.",
    );
  }

  /**
   * The bytes are checked to EXIST before the row claims them.
   *
   * `attachment.storage_key` is a plain string with no foreign key behind it,
   * which is what lets one photograph belong to a job and an invoice at once,
   * and it is also what lets a caller attach a key that was never stored. A
   * compliance register whose certificate link opens nothing is worse than one
   * with no link, because the first one gets relied on.
   */
  let stored: { contentType: string; sizeBytes: number } | null = null;
  if (input.storageKey) {
    const [file] = await tx.select({
      contentType: schema.storedFile.contentType,
      sizeBytes: schema.storedFile.sizeBytes,
    }).from(schema.storedFile)
      .where(and(
        eq(schema.storedFile.organizationId, ctx.actor.organizationId),
        eq(schema.storedFile.storageKey, input.storageKey),
      )).limit(1);
    if (!file) {
      throw new ConflictError(
        "There is no stored file under that key, so the document would point at nothing. "
        + "Upload the bytes first.",
      );
    }
    stored = file;
  }

  const [row] = await tx.insert(schema.complianceDocument).values({
    organizationId: ctx.actor.organizationId,
    kind: input.kind.trim(),
    name,
    reference: input.reference?.trim() || null,
    issuerName: input.issuerName?.trim() || null,
    jurisdiction: input.jurisdiction?.trim() || null,
    subjectType: input.subjectType?.trim() || null,
    subjectId: input.subjectId ?? null,
    issuedOn,
    expiresOn,
    noticeDays,
    requiredForWork: input.requiredForWork ?? false,
    state: "active",
    supersedesId,
    withdrawnReason: null,
    notes: input.notes?.trim() || null,
  }).returning();

  if (input.storageKey && stored) {
    await attach(tx, ctx.actor.organizationId, {
      entityType: "compliance_document",
      entityId: row!.id,
      storageKey: input.storageKey,
      kind: "document",
      fileName: name,
      contentType: stored.contentType,
      sizeBytes: stored.sizeBytes,
      uploadedByUserId: ctx.actor.userId,
    });
  }

  /**
   * The deadline, in the queue everything else uses.
   *
   * `dueAt` is the END of the act by day in the company's zone, not the
   * expiry: the thing that is owed is starting the renewal, and a queue that
   * only lights up on the expiry date is a queue that tells a contractor
   * about a ten week licence renewal on the morning it runs out.
   * `escalateAt` is the expiry itself, which is the day the consequence the
   * operator declared actually arrives.
   *
   * A document with no expiry raises nothing. A safety data sheet reissued
   * when the formulation changes has no date to be late for, and inventing
   * one would put a false deadline in a real queue every year.
   */
  if (expiresOn) {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const actBy = shiftDays(expiresOn, -noticeDays);
    await raise(tx, ctx.actor.organizationId, {
      kind: "compliance.document_expiry",
      entityType: "compliance_document",
      entityId: row!.id,
      dueAt: time.startOfDayIn(time.nextDay(actBy), zone),
      consequence: `${name} expires on ${expiresOn}. The operator allowed ${noticeDays} days to renew it.`,
      escalateAt: time.startOfDayIn(expiresOn, zone),
    });
  }

  if (!supersedesId) {
    await audit(tx, ctx, "compliance_document.registered", "compliance_document", row!.id, null, {
      kind: row!.kind, name: row!.name, expiresOn: row!.expiresOn,
    });
  }

  return row!;
}

async function loadDocument(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.complianceDocument)
    .where(and(
      eq(schema.complianceDocument.id, id),
      eq(schema.complianceDocument.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Document");
  return row;
}

/* --------------------------------------------------- regulatory submissions */

/** The states that mean nobody is waiting on this one any more. */
const SETTLED = ["acknowledged", "waived"] as const;

export type SubmissionState = typeof schema.submissionState.enumValues[number];

export interface SubmissionView {
  id: string;
  kind: string;
  authorityName: string;
  jurisdiction: string | null;
  periodStart: string | null;
  periodEnd: string | null;
  state: SubmissionState;
  dueOn: string | null;
  route: string | null;
  submittedAt: Date | null;
  acknowledgementReference: string | null;
  acknowledgedAt: Date | null;
  rejectedAt: Date | null;
  rejectionReason: string | null;
  supersedesId: string | null;
  /** Computed against the clock. Never read from `state`. See `obligations.ts`. */
  overdue: boolean;
  daysUntilDue: number | null;
  statement: string;
}

const viewSubmission = (
  row: typeof schema.regulatorySubmission.$inferSelect,
  today: string,
  zone: string,
): SubmissionView => {
  const settled = (SETTLED as readonly string[]).includes(row.state);
  const daysUntilDue = row.dueOn ? daysBetween(today, row.dueOn) : null;
  return {
    id: row.id,
    kind: row.kind,
    authorityName: row.authorityName,
    jurisdiction: row.jurisdiction,
    periodStart: row.periodStart,
    periodEnd: row.periodEnd,
    state: row.state,
    dueOn: row.dueOn,
    route: row.route,
    submittedAt: row.submittedAt,
    acknowledgementReference: row.acknowledgementReference,
    acknowledgedAt: row.acknowledgedAt,
    rejectedAt: row.rejectedAt,
    rejectionReason: row.rejectionReason,
    supersedesId: row.supersedesId,
    overdue: !settled && daysUntilDue !== null && daysUntilDue < 0,
    daysUntilDue,
    statement: submissionSentence(row, daysUntilDue, zone),
  };
};

/**
 * What happened to this filing, said plainly.
 *
 * The acknowledged branch is the sentence this whole table exists to be able
 * to produce, and it names the reference rather than asserting anything about
 * the filing being correct. An authority acknowledging receipt is a fact about
 * receipt. It is not a finding that the contents were right, and three years
 * of these is a record of what was filed and when, which is a different and
 * more defensible thing than a record of having been compliant.
 */
function submissionSentence(
  row: typeof schema.regulatorySubmission.$inferSelect,
  daysUntilDue: number | null,
  zone: string,
): string {
  switch (row.state) {
    case "acknowledged":
      return `${row.authorityName} acknowledged this on `
        + `${row.acknowledgedAt ? time.dateIn(row.acknowledgedAt, zone) : "an unrecorded date"} `
        + `under reference ${row.acknowledgementReference ?? "none recorded"}.`;
    case "rejected":
      return `${row.authorityName} rejected this: ${row.rejectionReason ?? "no reason recorded"}. `
        + "It needs resubmitting, which creates a new filing that supersedes this one.";
    case "resubmitted":
      return "This was superseded by a later filing after a rejection.";
    case "submitted":
      return `Filed with ${row.authorityName} and not yet acknowledged. Nothing here says it was accepted.`;
    case "waived":
      return `Recorded as not owed: ${row.rejectionReason ?? "no reason recorded"}.`;
    case "prepared":
      return `Prepared and not yet filed${row.dueOn ? `, due ${row.dueOn}` : ""}.`;
    case "due":
      if (daysUntilDue === null) return "Open, with no due date recorded.";
      return daysUntilDue < 0
        ? `Due on ${row.dueOn}, ${-daysUntilDue} days ago, and not yet filed.`
        : `Due on ${row.dueOn}, in ${daysUntilDue} days.`;
  }
}

/**
 * What the organization's trade pack says it has to produce, and for whom.
 *
 * The programme, read from the pack at the moment it is asked for rather than
 * copied into a table at setup. A copy would be a second representation of one
 * programme, which is the defect `inspections.ts` names twice, and the copy
 * would be the stale one: a pack release that corrects an authority's name
 * would correct it for new companies only.
 */
export async function declared(ctx: ServiceContext) {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const [org] = await tx.select({ primaryTrade: schema.organization.primaryTrade })
      .from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    if (!org) throw new NotFoundError("Organization");

    const pack = org.primaryTrade ? packById(org.primaryTrade) : undefined;
    return (pack?.submissions ?? []).map((submission) => ({
      kind: submission.kind,
      label: submission.label,
      authorityName: submission.authorityName,
      jurisdiction: submission.jurisdiction,
      cadence: submission.cadence,
      route: submission.route ?? null,
      notes: submission.notes ?? null,
    }));
  });
}

export interface OpenSubmissionInput {
  kind: string;
  dueOn: string;
  periodStart?: string | null | undefined;
  periodEnd?: string | null | undefined;
  /** Only for a kind the pack does not declare. See the refusal below. */
  authorityName?: string | undefined;
  jurisdiction?: string | undefined;
  route?: string | undefined;
}

/**
 * Open a filing that is owed.
 *
 * THE DUE DATE IS SUPPLIED AND NEVER COMPUTED. A trade pack declares a cadence
 * ("quarterly", "annual") and deliberately no offset, so there is nothing here
 * to derive a deadline from. That is the right shape: a filing deadline is a
 * statutory fact that moves, differs by jurisdiction and shifts for weekends
 * and holidays in ways that vary by authority. Software that computed one
 * would be telling a contractor when the law says to file, which is exactly
 * the kind of statement the module comment above refuses to make. So the
 * operator states the date, and this records whose date it was.
 *
 * Idempotent on the kind and the period, which is what the schema's own
 * comment says the period is for: "The reporting period this covers, which is
 * what makes it deduplicable." Two dispatchers opening the same quarter get
 * one row, not two filings of the same quarter.
 */
export async function openSubmission(
  ctx: ServiceContext,
  input: OpenSubmissionInput,
): Promise<SubmissionView> {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const kind = input.kind.trim();
    if (kind === "") throw new ConflictError("A submission needs a kind.");

    const [org] = await tx.select({ primaryTrade: schema.organization.primaryTrade })
      .from(schema.organization)
      .where(eq(schema.organization.id, ctx.actor.organizationId)).limit(1);
    const pack = org?.primaryTrade ? packById(org.primaryTrade) : undefined;
    const fromPack = pack?.submissions.find((s) => s.kind === kind);

    /**
     * ONE PLACE FOR THE AUTHORITY'S NAME.
     *
     * When the pack declares this kind, the pack is where its authority,
     * jurisdiction and route live, and an input that states them again is
     * refused rather than merged. Merging would be the quiet version of the
     * same defect: the row says "State pesticide lead agency" because somebody
     * typed it in 2026, the pack is corrected in 2027, and the two now
     * disagree with nothing to say which is right.
     */
    if (fromPack && (input.authorityName || input.jurisdiction || input.route)) {
      throw new ConflictError(
        `The trade pack already declares the authority, jurisdiction and route for "${kind}". `
        + "Stating them here would put the same fact in two places, and a pack correction would "
        + "then only reach companies set up afterwards. Correct the pack instead.",
      );
    }

    const authorityName = fromPack?.authorityName ?? input.authorityName?.trim();
    if (!authorityName) {
      throw new ConflictError(
        `No trade pack declares "${kind}", so the authority it is filed with has to be named here. `
        + "A filing with no authority on it cannot be produced for anybody later.",
      );
    }

    const periodStart = input.periodStart ?? null;
    const periodEnd = input.periodEnd ?? null;
    if (periodStart && periodEnd && periodEnd < periodStart) {
      throw new ConflictError("The reporting period ends before it starts.");
    }

    const [existing] = await tx.select().from(schema.regulatorySubmission)
      .where(and(
        eq(schema.regulatorySubmission.organizationId, ctx.actor.organizationId),
        eq(schema.regulatorySubmission.kind, kind),
        periodStart === null
          ? isNull(schema.regulatorySubmission.periodStart)
          : eq(schema.regulatorySubmission.periodStart, periodStart),
        periodEnd === null
          ? isNull(schema.regulatorySubmission.periodEnd)
          : eq(schema.regulatorySubmission.periodEnd, periodEnd),
        /**
         * A superseded filing does not block a new one for the same period:
         * that is the whole resubmission path, and a rejected quarter that
         * could never be refiled would be the opposite of what this table is
         * for.
         */
        inArray(schema.regulatorySubmission.state,
          ["due", "prepared", "submitted", "acknowledged", "waived"]),
      )).limit(1);

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = time.dateIn(new Date(), zone);
    if (existing) return viewSubmission(existing, today, zone);

    const [row] = await tx.insert(schema.regulatorySubmission).values({
      organizationId: ctx.actor.organizationId,
      kind,
      authorityName,
      jurisdiction: fromPack?.jurisdiction ?? input.jurisdiction?.trim() ?? null,
      periodStart,
      periodEnd,
      state: "due",
      dueOn: input.dueOn,
      route: fromPack?.route ?? input.route?.trim() ?? null,
      supersedesId: null,
    }).returning();

    await raise(tx, ctx.actor.organizationId, {
      kind: "compliance.submission_due",
      entityType: "regulatory_submission",
      entityId: row!.id,
      dueAt: time.startOfDayIn(time.nextDay(input.dueOn), zone),
      consequence: `${kind} is owed to ${authorityName} by ${input.dueOn}.`,
    });

    await audit(tx, ctx, "regulatory_submission.opened", "regulatory_submission", row!.id, null, {
      kind, periodStart, periodEnd, dueOn: input.dueOn,
    });

    return viewSubmission(row!, today, zone);
  });
}

export interface AdvanceInput {
  id: string;
  to: SubmissionState;
  /** Required to acknowledge. The proof, and the reason this table is sticky. */
  reference?: string | undefined;
  /** Required to reject and to waive. */
  reason?: string | undefined;
  /** What was filed, kept because an authority may ask years later. */
  payload?: Record<string, unknown> | undefined;
  at?: Date | undefined;
}

/**
 * Move a filing along, and refuse the moves that would manufacture a record.
 *
 * `acknowledged` REQUIRES A REFERENCE, and that single rule is what makes the
 * schema's claim about retention true. The table's comment says the sticky
 * part is submitting with "an acknowledgement kept as proof"; an acknowledged
 * row with no confirmation number is not proof of anything, it is somebody
 * having clicked a button, and three years of those is a history that falls
 * apart the first time it is tested.
 *
 * `resubmitted` is not settable here. A resubmission is a NEW filing that
 * supersedes the rejected one, because the rejected one and what the authority
 * said about it are the record. `resubmit` below is that path.
 */
export async function advance(ctx: ServiceContext, input: AdvanceInput): Promise<SubmissionView> {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const before = await loadSubmission(tx, ctx.actor.organizationId, input.id);
    const at = input.at ?? new Date();

    if (input.to === "resubmitted") {
      throw new ConflictError(
        "A resubmission is a new filing that supersedes this one, not a state on it. "
        + "What the authority rejected and what it said have to survive.",
      );
    }
    if (before.state === "acknowledged") {
      throw new ConflictError(
        "That filing is already acknowledged. Changing it now would rewrite a record the "
        + "authority's own reference is attached to.",
      );
    }
    if (before.state === "resubmitted") {
      throw new ConflictError(
        "That filing was superseded by a later one. Act on the filing that replaced it.",
      );
    }

    const reference = input.reference?.trim() || null;
    const reason = input.reason?.trim() || null;

    if (input.to === "acknowledged" && !reference) {
      throw new ConflictError(
        "An acknowledgement needs the reference the authority gave: a confirmation number, a "
        + "stamped receipt, a signed acknowledgement. Without it the row records a click rather "
        + "than proof, which is the whole thing this register is for.",
      );
    }
    if ((input.to === "rejected" || input.to === "waived") && !reason) {
      throw new ConflictError(
        `A ${input.to} filing needs a reason. "Rejected" with no sentence beside it tells whoever `
        + "picks it up nothing about what to change.",
      );
    }
    if (input.to === "submitted" && before.state === "due" && !input.payload) {
      /**
       * Filing with nothing kept is the half of this that destroys the value
       * later. The schema's own comment on `payload` says it exists "because
       * an authority may ask years later", and a submitted row with an empty
       * payload is a claim that something was filed and no way to show what.
       */
      throw new ConflictError(
        "Record what was filed. A submitted filing with nothing kept cannot be produced for an "
        + "authority later, which is the only reason to keep the row at all.",
      );
    }

    const [row] = await tx.update(schema.regulatorySubmission).set({
      state: input.to,
      ...(input.payload ? { payload: input.payload } : {}),
      ...(input.to === "submitted" ? { submittedAt: at } : {}),
      ...(input.to === "acknowledged"
        ? { acknowledgedAt: at, acknowledgementReference: reference }
        : {}),
      ...(input.to === "rejected" ? { rejectedAt: at, rejectionReason: reason } : {}),
      /**
       * A waiver's sentence goes in `rejection_reason` rather than in a
       * column of its own, and that is a choice worth naming: the column
       * holds "what came back", and "we agreed this was not owed, because"
       * is the same question answered by the operator instead of by the
       * authority. A second nullable text column saying almost the same
       * thing is how a table ends up with two places to look.
       */
      ...(input.to === "waived" ? { rejectionReason: reason } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.regulatorySubmission.id, input.id)).returning();

    if ((SETTLED as readonly string[]).includes(input.to)) {
      await cancelFor(tx, ctx.actor.organizationId, "regulatory_submission", input.id);
    }

    await audit(tx, ctx, `regulatory_submission.${input.to}`, "regulatory_submission", input.id,
      { state: before.state }, { state: input.to, reference, reason });

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    return viewSubmission(row!, time.dateIn(new Date(), zone), zone);
  });
}

/**
 * File it again after a rejection.
 *
 * A new row pointing at the old one through `supersedes_id`, and the old one
 * moved to `resubmitted` rather than edited. The rejected filing and the
 * authority's words about it are the part a contractor needs years later, and
 * an in place edit is what destroys it.
 *
 * Only a REJECTED filing can be resubmitted. Resubmitting one that was
 * acknowledged would put a second filing of the same period in front of an
 * authority that already accepted the first.
 */
export async function resubmit(
  ctx: ServiceContext,
  input: { id: string; dueOn?: string | undefined },
): Promise<SubmissionView> {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const before = await loadSubmission(tx, ctx.actor.organizationId, input.id);
    if (before.state !== "rejected") {
      throw new ConflictError(
        `Only a rejected filing is resubmitted, and this one is ${before.state}. `
        + "Open a new filing for the period instead.",
      );
    }

    const [row] = await tx.insert(schema.regulatorySubmission).values({
      organizationId: ctx.actor.organizationId,
      kind: before.kind,
      authorityName: before.authorityName,
      jurisdiction: before.jurisdiction,
      periodStart: before.periodStart,
      periodEnd: before.periodEnd,
      state: "due",
      dueOn: input.dueOn ?? before.dueOn,
      route: before.route,
      supersedesId: before.id,
    }).returning();

    await tx.update(schema.regulatorySubmission)
      .set({ state: "resubmitted", updatedAt: new Date() })
      .where(eq(schema.regulatorySubmission.id, before.id));

    await cancelFor(tx, ctx.actor.organizationId, "regulatory_submission", before.id);

    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    if (row!.dueOn) {
      await raise(tx, ctx.actor.organizationId, {
        kind: "compliance.submission_due",
        entityType: "regulatory_submission",
        entityId: row!.id,
        dueAt: time.startOfDayIn(time.nextDay(row!.dueOn), zone),
        consequence: `${before.kind} was rejected by ${before.authorityName} and is owed again.`,
      });
    }

    await audit(tx, ctx, "regulatory_submission.resubmitted", "regulatory_submission", row!.id,
      { supersedes: before.id }, { state: "due", dueOn: row!.dueOn });

    return viewSubmission(row!, time.dateIn(new Date(), zone), zone);
  });
}

/**
 * The compliance calendar: what is owed, soonest first.
 *
 * Settled filings are excluded with NOT IN rather than by listing the live
 * states, for the reason `obligations.ts` gives: a state added to the enum
 * later shows up as live work rather than vanishing, because the failure of a
 * list of deadlines has to be noisy.
 */
export async function calendar(
  ctx: ServiceContext,
  input: { includeSettled?: boolean | undefined; kind?: string | undefined; asOf?: string | undefined } = {},
): Promise<SubmissionView[]> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = input.asOf ?? time.dateIn(new Date(), zone);

    const rows = await tx.select().from(schema.regulatorySubmission)
      .where(and(
        eq(schema.regulatorySubmission.organizationId, ctx.actor.organizationId),
        ...(input.kind ? [eq(schema.regulatorySubmission.kind, input.kind)] : []),
        ...(input.includeSettled
          ? []
          : [sql`${schema.regulatorySubmission.state} not in ('acknowledged', 'waived', 'resubmitted')`]),
      ))
      .orderBy(sql`${schema.regulatorySubmission.dueOn} asc nulls last`,
        desc(schema.regulatorySubmission.createdAt));

    return rows.map((row) => viewSubmission(row, today, zone));
  });
}

async function loadSubmission(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.regulatorySubmission)
    .where(and(
      eq(schema.regulatorySubmission.id, id),
      eq(schema.regulatorySubmission.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Submission");
  return row;
}

/* ---------------------------------------------------- regulatory constants */

/**
 * WHAT `regulatory_constant` TURNED OUT TO BE FOR, AND WHAT IT IS NOT.
 *
 * A published figure that changes on a date: a reporting threshold, a mileage
 * rate, a permit fee, a notification limit. The schema's example is the
 * 1099-NEC threshold moving from 600 dollars to 2,000 for tax years beginning
 * after 2025, and the point it makes is that anything which hardcoded 600 is
 * now wrong and will be wrong again. The table is not about one number, it is
 * about the shape of every number of that sort: a value, a jurisdiction, a
 * window it is in force for, and a citation.
 *
 * THIS PRODUCT SHIPS NO VALUES, and that is the deliberate part.
 *
 * A figure seeded by this repository would be this repository telling a
 * contractor what a threshold is, which is the legal conclusion the module
 * comment above refuses to reach, with the extra problem that a wrong one
 * would be wrong silently in every deployment until somebody shipped a
 * release. So the operator publishes the figure they are working to, with the
 * `basis` that says where they got it, and the product's whole contribution is
 * to resolve it by date, to keep the old windows rather than overwriting them,
 * and to say when the window has run out and nobody has supplied the next one.
 *
 * THE TRADE PACKS DO NOT ALREADY HOLD THESE. I checked all eight. A pack
 * carries price book figures (commercial, an operator re-margins them), KPI
 * targets (management, not law), inspection ranges (a judgement for the trade,
 * not a jurisdiction) and `retention.retainMonths`, which IS jurisdiction
 * derived and is the one genuine overlap. That one already has its own home in
 * `retention_policy`, seeded from the pack by `trade-pack.ts`, so a retention
 * period stored here as well would be the second place for one number that
 * this codebase keeps finding. `publishConstant` refuses that key namespace by
 * name rather than leaving it to a convention nobody reads.
 *
 * AND ONE THING THE SCHEMA OFFERS THAT CANNOT WORK. `organization_id` is
 * nullable, under a comment reading "Global by default, with an organization
 * override where one is needed". A global row cannot be read by this
 * application at all: row level security is applied from the catalogue to
 * every table carrying an `organization_id`, the policy is
 * `organization_id = app.current_organization_id()`, and that is not true of
 * NULL. A row written with no organization would be invisible to every tenant
 * and the only sign would be a lookup that finds nothing. So every constant
 * this service writes names the organization, which is also what the paragraph
 * above wants: there is no published global figure because this product
 * publishes none.
 */
const RESERVED_KEY_PREFIXES: { prefix: string; owner: string }[] = [
  {
    prefix: "retention.",
    owner:
      "retention_policy, which trade-pack.ts seeds from the pack's own retention rules. "
      + "A retention period in two places is two answers to how long a record must be kept.",
  },
];

export interface ConstantView {
  key: string;
  jurisdiction: string;
  value: string;
  unit: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  basis: string | null;
}

const viewConstant = (row: typeof schema.regulatoryConstant.$inferSelect): ConstantView => ({
  key: row.key,
  jurisdiction: row.jurisdiction,
  value: row.value,
  unit: row.unit,
  effectiveFrom: row.effectiveFrom,
  effectiveTo: row.effectiveTo,
  basis: row.basis,
});

/**
 * Publish the next value of a figure.
 *
 * The predecessor is CLOSED rather than replaced: its `effective_to` becomes
 * the day before this one starts, and the row stays. That is the entire reason
 * this is a table and not a settings field. A payroll export re-run for last
 * January has to use last January's threshold, and a system that overwrote the
 * number answers that question with this year's and shows no sign of having
 * done so.
 */
export async function publishConstant(
  ctx: ServiceContext,
  input: {
    key: string; value: string; effectiveFrom: string;
    jurisdiction?: string | undefined; unit?: string | null | undefined;
    basis?: string | null | undefined;
  },
): Promise<ConstantView> {
  return guardedWrite(ctx, "compliance:write", async (tx) => {
    const key = input.key.trim();
    const jurisdiction = input.jurisdiction?.trim() || "US";
    if (key === "") throw new ConflictError("A constant needs a key.");
    if (input.value.trim() === "") {
      throw new ConflictError("A constant with no value decides nothing.");
    }

    const reserved = RESERVED_KEY_PREFIXES.find((r) => key.startsWith(r.prefix));
    if (reserved) {
      throw new ConflictError(
        `"${key}" belongs to ${reserved.owner}`,
      );
    }

    /**
     * The one in force immediately before this, which is the row to close.
     * Chosen by the LATEST `effective_from` at or before the new date rather
     * than by "the one with a null `effective_to`", because a figure can be
     * published out of order when somebody backfills last year, and a null
     * test would close the wrong row and leave a gap in the middle.
     */
    const [previous] = await tx.select().from(schema.regulatoryConstant)
      .where(and(
        eq(schema.regulatoryConstant.organizationId, ctx.actor.organizationId),
        eq(schema.regulatoryConstant.key, key),
        eq(schema.regulatoryConstant.jurisdiction, jurisdiction),
        lte(schema.regulatoryConstant.effectiveFrom, input.effectiveFrom),
      ))
      .orderBy(desc(schema.regulatoryConstant.effectiveFrom))
      .limit(1);

    if (previous && previous.effectiveFrom === input.effectiveFrom) {
      throw new ConflictError(
        `${key} already has a value from ${input.effectiveFrom} in ${jurisdiction}. `
        + "Two figures in force on the same day is a lookup with two answers.",
      );
    }

    if (previous) {
      await tx.update(schema.regulatoryConstant).set({
        effectiveTo: shiftDays(input.effectiveFrom, -1),
        updatedAt: new Date(),
      }).where(eq(schema.regulatoryConstant.id, previous.id));
    }

    const [row] = await tx.insert(schema.regulatoryConstant).values({
      organizationId: ctx.actor.organizationId,
      key,
      jurisdiction,
      value: input.value.trim(),
      unit: input.unit?.trim() || null,
      effectiveFrom: input.effectiveFrom,
      /**
       * Open ended until the next one is published. A figure given an end date
       * at the moment it is created is a figure that silently stops resolving
       * on a day nobody will remember choosing.
       */
      effectiveTo: null,
      basis: input.basis?.trim() || null,
    }).returning();

    await audit(tx, ctx, "regulatory_constant.published", "regulatory_constant", row!.id,
      previous ? { value: previous.value, effectiveFrom: previous.effectiveFrom } : null,
      { key, jurisdiction, value: row!.value, effectiveFrom: row!.effectiveFrom });

    return viewConstant(row!);
  });
}

/**
 * The figure in force on a date, or an honest refusal.
 *
 * It returns a result rather than throwing when there is no row, because "no
 * published figure covers that date" is the answer, and it is the answer the
 * caller has to be able to act on: the alternative is a caller that catches an
 * exception and falls back to a default, which is a hardcoded constant with
 * extra steps.
 */
export async function constantOn(
  ctx: ServiceContext,
  input: { key: string; on: string; jurisdiction?: string | undefined },
): Promise<
  | { found: true; constant: ConstantView }
  | { found: false; reason: string; lastKnown: ConstantView | null }
> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const jurisdiction = input.jurisdiction?.trim() || "US";

    const [row] = await tx.select().from(schema.regulatoryConstant)
      .where(and(
        eq(schema.regulatoryConstant.organizationId, ctx.actor.organizationId),
        eq(schema.regulatoryConstant.key, input.key),
        eq(schema.regulatoryConstant.jurisdiction, jurisdiction),
        lte(schema.regulatoryConstant.effectiveFrom, input.on),
        or(
          isNull(schema.regulatoryConstant.effectiveTo),
          sql`${schema.regulatoryConstant.effectiveTo} >= ${input.on}`,
        ),
      ))
      .orderBy(desc(schema.regulatoryConstant.effectiveFrom))
      .limit(1);

    if (row) return { found: true as const, constant: viewConstant(row) };

    const [last] = await tx.select().from(schema.regulatoryConstant)
      .where(and(
        eq(schema.regulatoryConstant.organizationId, ctx.actor.organizationId),
        eq(schema.regulatoryConstant.key, input.key),
        eq(schema.regulatoryConstant.jurisdiction, jurisdiction),
      ))
      .orderBy(desc(schema.regulatoryConstant.effectiveFrom))
      .limit(1);

    return {
      found: false as const,
      reason: last
        ? `The published value of ${input.key} in ${jurisdiction} ran to ${last.effectiveTo ?? "an unrecorded date"} `
          + `and nothing covers ${input.on}. Somebody has to publish the next one.`
        : `No value of ${input.key} has been published for ${jurisdiction}.`,
      lastKnown: last ? viewConstant(last) : null,
    };
  });
}

/**
 * The figures that have run out.
 *
 * A key whose latest window closed before today is a number somebody is still
 * working to and nobody has renewed. It is the one list in this file that is
 * genuinely a warning, and it is still a statement about rows: this register
 * has no current value for this key, not "your figures are wrong".
 */
export async function staleConstants(
  ctx: ServiceContext,
  input: { asOf?: string | undefined } = {},
): Promise<{ key: string; jurisdiction: string; lastValue: string; endedOn: string }[]> {
  return guardedRead(ctx, "compliance:read", async (tx) => {
    const zone = await timezoneOf(tx, ctx.actor.organizationId);
    const today = input.asOf ?? time.dateIn(new Date(), zone);

    const rows = await tx.select().from(schema.regulatoryConstant)
      .where(eq(schema.regulatoryConstant.organizationId, ctx.actor.organizationId))
      .orderBy(asc(schema.regulatoryConstant.key), desc(schema.regulatoryConstant.effectiveFrom));

    /**
     * The latest row per key and jurisdiction, picked in JavaScript off an
     * ordered read rather than with a window function, because the set is one
     * organization's constants: tens of rows, not thousands. A DISTINCT ON
     * here would be faster and harder to read, and nothing about the size of
     * this table justifies the trade.
     */
    const latest = new Map<string, typeof schema.regulatoryConstant.$inferSelect>();
    for (const row of rows) {
      const key = `${row.key}\u0000${row.jurisdiction}`;
      if (!latest.has(key)) latest.set(key, row);
    }

    return [...latest.values()]
      .filter((row) => row.effectiveTo !== null && row.effectiveTo < today)
      .map((row) => ({
        key: row.key,
        jurisdiction: row.jurisdiction,
        lastValue: row.value,
        endedOn: row.effectiveTo!,
      }));
  });
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listComplianceDocuments: async (ctx: ServiceContext, input: {
    subjectType?: string | undefined; subjectId?: string | undefined;
    kind?: string | undefined; includeReplaced?: boolean | undefined;
    withinDays?: number | undefined;
  }) => ({ documents: await documents(ctx, input) }),

  getComplianceSummary: (ctx: ServiceContext) => summary(ctx),

  listWorkBlockingDocuments: async (ctx: ServiceContext) => ({
    subjects: await blockedSubjects(ctx),
  }),

  registerComplianceDocument: (ctx: ServiceContext, input: RegisterInput) => register(ctx, input),

  renewComplianceDocument: (ctx: ServiceContext, input: RegisterInput & { id: string }) =>
    renew(ctx, input),

  withdrawComplianceDocument: (ctx: ServiceContext, input: { id: string; reason: string }) =>
    withdraw(ctx, input),

  listDeclaredSubmissions: async (ctx: ServiceContext) => ({ submissions: await declared(ctx) }),

  listRegulatorySubmissions: async (ctx: ServiceContext, input: {
    includeSettled?: boolean | undefined; kind?: string | undefined;
  }) => ({ submissions: await calendar(ctx, input) }),

  openRegulatorySubmission: (ctx: ServiceContext, input: OpenSubmissionInput) =>
    openSubmission(ctx, input),

  advanceRegulatorySubmission: (ctx: ServiceContext, input: AdvanceInput) => advance(ctx, input),

  resubmitRegulatorySubmission: (ctx: ServiceContext, input: { id: string; dueOn?: string | undefined }) =>
    resubmit(ctx, input),

  publishRegulatoryConstant: (ctx: ServiceContext, input: {
    key: string; value: string; effectiveFrom: string;
    jurisdiction?: string | undefined; unit?: string | null | undefined;
    basis?: string | null | undefined;
  }) => publishConstant(ctx, input),

  getRegulatoryConstant: (ctx: ServiceContext, input: {
    key: string; on: string; jurisdiction?: string | undefined;
  }) => constantOn(ctx, input),

  listStaleRegulatoryConstants: async (ctx: ServiceContext) => ({
    constants: await staleConstants(ctx),
  }),
} as const;
