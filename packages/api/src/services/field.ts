import { and, eq, inArray, sql, desc, isNull, max } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { field } from "@opentradesos/core";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, NotFoundError, ConflictError,
} from "./context";
import { audit } from "./customers";
import { freezeRate } from "./labor";
import type {
  syncOperations, registerDevice, listConflicts, resolveConflict,
} from "../contracts/field";

/**
 * APPLYING WHAT CAME BACK FROM THE FIELD
 *
 * The reasoning about ordering, clock drift and conflict is in
 * packages/core/src/field and is tested without a database. This file is the
 * part that touches rows, and it is deliberately thin: every decision it makes
 * is one the core module already made.
 *
 * The whole batch runs in ONE transaction. A day that half lands is worse than
 * one that does not land at all, because the technician has no way to tell
 * which half and will either redo work or not redo it, and both are wrong.
 */

export async function register(ctx: ServiceContext, input: z.infer<typeof registerDevice.input>) {
  return guardedWrite(ctx, "field:sync", async (tx) => {
    const technicianId = await technicianFor(tx, ctx);

    /**
     * Keyed on the installation id, so a reinstall that kept it picks up its
     * old sequence. A device that started again at one would collide with
     * everything it had already sent, and every collision would look like a
     * replay and be silently accepted.
     */
    const [existing] = await tx.select().from(schema.device)
      .where(and(
        eq(schema.device.organizationId, ctx.actor.organizationId),
        eq(schema.device.installationId, input.installationId),
      )).limit(1);

    if (existing) {
      await tx.update(schema.device).set({
        technicianId,
        label: input.label ?? existing.label,
        platform: input.platform ?? existing.platform,
        appVersion: input.appVersion ?? existing.appVersion,
        osVersion: input.osVersion ?? existing.osVersion,
        pushToken: input.pushToken ?? existing.pushToken,
        lastSeenAt: new Date(),
        revokedAt: null,
        updatedAt: new Date(),
      }).where(eq(schema.device.id, existing.id));

      return { deviceId: existing.id, lastSequence: existing.lastSequence };
    }

    const [created] = await tx.insert(schema.device).values({
      organizationId: ctx.actor.organizationId,
      technicianId,
      installationId: input.installationId,
      label: input.label ?? null,
      platform: input.platform ?? null,
      appVersion: input.appVersion ?? null,
      osVersion: input.osVersion ?? null,
      pushToken: input.pushToken ?? null,
      lastSeenAt: new Date(),
    }).returning();

    await audit(tx, ctx, "device.registered", "device", created!.id, null,
      { installationId: input.installationId, platform: input.platform ?? null });

    return { deviceId: created!.id, lastSequence: 0 };
  });
}

/**
 * The sync endpoint.
 *
 * Idempotent by client id, per operation rather than per request, because a
 * retry after a partial failure resends operations that already landed
 * alongside ones that did not.
 */
export async function sync(ctx: ServiceContext, input: z.infer<typeof syncOperations.input>) {
  return guardedWrite(ctx, "field:sync", async (tx) => {
    const [device] = await tx.select().from(schema.device)
      .where(eq(schema.device.id, input.deviceId)).limit(1);
    if (!device) throw new NotFoundError("Device");
    if (device.revokedAt) throw new ConflictError("This device has been revoked.");

    const receivedAt = new Date();

    // Already seen, in one query rather than one per operation. A resend of a
    // whole day is the common case, not the exceptional one.
    const clientIds = input.operations.map((o) => o.clientId);
    const seen = await tx.select({
      clientId: schema.fieldOperation.clientId,
      status: schema.fieldOperation.status,
      conflict: schema.fieldOperation.conflict,
      rejection: schema.fieldOperation.rejection,
      occurredAt: schema.fieldOperation.occurredAt,
      clamped: schema.fieldOperation.clamped,
    }).from(schema.fieldOperation)
      .where(and(
        eq(schema.fieldOperation.organizationId, ctx.actor.organizationId),
        inArray(schema.fieldOperation.clientId, clientIds),
      ));
    const alreadyApplied = new Map(seen.map((s) => [s.clientId, s]));

    const fresh = input.operations.filter((o) => !alreadyApplied.has(o.clientId));

    /**
     * Clock resolution happens before ordering, because ordering across
     * devices uses the resolved time. A phone whose clock is an hour fast
     * would otherwise sort its whole day ahead of everyone else's.
     */
    let previous: Date | undefined = device.lastSyncedAt ?? undefined;
    const resolved = fresh
      .slice()
      .sort((a, b) => a.sequence - b.sequence)
      .map((op) => {
        const r = field.resolveOccurredAt({
          claimed: new Date(op.occurredAt),
          receivedAt,
          previousOccurredAt: previous,
        });
        previous = r.occurredAt;
        return { input: op, ...r };
      });

    const asOperations: field.FieldOperation[] = resolved.map((r) => ({
      clientId: r.input.clientId,
      deviceId: device.id,
      kind: r.input.kind,
      sequence: r.input.sequence,
      occurredAt: r.occurredAt,
      subjectId: r.input.subjectId ?? "",
      payload: r.input.payload,
    }));

    const { applicable, held } = field.applicablePrefix(asOperations, {
      [device.id]: device.lastSequence,
    });

    const heldIds = new Set(held.map((h) => h.clientId));
    const byClientId = new Map(resolved.map((r) => [r.input.clientId, r]));
    const results: Array<z.infer<typeof syncOperations.output>["results"][number]> = [];

    for (const op of applicable) {
      const meta = byClientId.get(op.clientId)!;
      const outcome = await applyOne(tx, ctx, device, op, meta, receivedAt);
      results.push(outcome);
    }

    for (const clientId of heldIds) {
      const meta = byClientId.get(clientId)!;
      await recordOperation(tx, ctx, device, meta, receivedAt, {
        status: "held", conflict: null, rejection: null,
      });
      results.push({
        clientId,
        status: "held",
        conflict: null,
        rejection: null,
        occurredAt: meta.occurredAt.toISOString(),
        clamped: meta.clamped,
      });
    }

    // Replays report what happened the first time. The device is asking what
    // became of them, not asking for them to happen again.
    for (const [clientId, prior] of alreadyApplied) {
      results.push({
        clientId,
        status: prior.status,
        conflict: prior.conflict,
        rejection: prior.rejection,
        occurredAt: prior.occurredAt.toISOString(),
        clamped: (prior.clamped ?? null) as "future" | "reordered" | null,
      });
    }

    const highest = applicable.reduce((acc, o) => Math.max(acc, o.sequence), device.lastSequence);
    await tx.update(schema.device).set({
      lastSequence: highest,
      lastSyncedAt: receivedAt,
      lastSeenAt: receivedAt,
      updatedAt: receivedAt,
    }).where(eq(schema.device.id, device.id));

    const gaps = field.findSequenceGaps(asOperations, { [device.id]: device.lastSequence });
    const [snapshot] = await tx.select({ revision: schema.deviceSnapshot.revision })
      .from(schema.deviceSnapshot)
      .where(eq(schema.deviceSnapshot.deviceId, device.id))
      .orderBy(desc(schema.deviceSnapshot.sentAt)).limit(1);

    return {
      results,
      awaiting: gaps.flatMap((g) => g.missing),
      snapshotRevision: snapshot?.revision ?? 0,
    };
  });
}

type Resolved = {
  input: z.infer<typeof syncOperations.input>["operations"][number];
  occurredAt: Date;
  claimed: Date;
  clamped: null | "future" | "reordered";
};

/**
 * One operation, against whatever the server now believes.
 *
 * Every branch here records the operation. Nothing is dropped, including the
 * ones that could not be applied: the log is the evidence for what somebody
 * was paid and what a customer was billed, and an operation that vanishes
 * because it arrived inconveniently is the failure this design exists to
 * prevent.
 */
async function applyOne(
  tx: Database,
  ctx: ServiceContext,
  device: typeof schema.device.$inferSelect,
  op: field.FieldOperation,
  meta: Resolved,
  receivedAt: Date,
) {
  const subjectState = await currentState(tx, op);
  const lastEditAt = await lastEditFor(tx, ctx, op);

  const verdict = field.evaluate({
    kind: op.kind,
    currentState: subjectState ?? undefined,
    allowedFrom: field.allowedFrom(op.kind),
    lastEditAt: lastEditAt ?? undefined,
    occurredAt: op.occurredAt,
  });

  const verdictStatus = !verdict.apply
    ? (verdict.conflict ? "rejected" as const : "superseded" as const)
    : verdict.conflict
      ? "conflicted" as const
      : "applied" as const;

  const row = await recordOperation(tx, ctx, device, meta, receivedAt, {
    status: verdictStatus,
    conflict: verdict.conflict,
    rejection: verdict.apply ? null : verdict.conflict,
  });

  /**
   * THE HANDLER'S OWN ANSWER, which nothing used to look at.
   *
   * `effect` returned void, so a handler that could not do its work simply
   * returned and the operation was reported to the phone as APPLIED. A
   * technician filled in a service report, watched it sync, and lost every
   * field: the report row had never been created, so `set_field` looked it
   * up, found nothing, and gave up quietly.
   *
   * The verdict above decides whether an operation MAY be applied, against
   * the state machine. This decides whether it COULD be, against the data
   * that is actually there. Both can refuse and they refuse for different
   * reasons, so the log records which.
   */
  const failure = verdict.apply
    ? await effect(tx, ctx, op, subjectState, row.id)
    : null;

  const status = failure ? "rejected" as const : verdictStatus;
  const rejection = failure ?? (verdict.apply ? null : verdict.conflict);

  if (failure) {
    await tx.update(schema.fieldOperation)
      .set({ status, rejection, updatedAt: new Date() })
      .where(eq(schema.fieldOperation.id, row.id));
  }

  return {
    clientId: op.clientId,
    status,
    conflict: verdict.conflict,
    rejection,
    occurredAt: op.occurredAt.toISOString(),
    clamped: meta.clamped,
  };
}

/**
 * Operation kinds that deliberately change nothing beyond the log itself.
 *
 * Exported so a test can assert that everything NOT in this list has a real
 * effect. The gap this closes was real: three kinds fell through to a default
 * branch with a comment claiming another path applied them, no such path
 * existed, and the server marked them applied anyway. The phone deletes an
 * applied operation from its queue, so a chemical application recorded in a
 * crawl space was accepted, acknowledged, and gone.
 *
 * A name belongs here only when the log IS the record. Nothing currently
 * qualifies, which is the correct state for this list to be in.
 */
export const LOG_ONLY_OPERATIONS: readonly field.OperationKind[] = [] as const;

/**
 * What the operation actually does to the rest of the schema.
 *
 * Kept in one place so that adding an operation kind means adding one case
 * here rather than finding the four places a similar one is handled.
 */
/**
 * What the operation does to the rest of the schema, and whether it could.
 *
 * Returns a rejection reason, or null when the operation landed. It used to
 * return void, and every handler that could not do its work simply
 * `return`ed: the sync then reported the operation as APPLIED, because
 * nothing was looking at the result. A technician filling in a service report
 * on their phone watched it sync successfully and lose every field.
 */
/**
 * The service report this operation is about, created if it is not there yet.
 *
 * NOTHING IN THIS CODEBASE EVER CREATED ONE. `service_report` was the target
 * of exactly one write, an update setting `submitted_at`, and no insert
 * anywhere outside a test. So a technician filled in a report on their phone,
 * the sync accepted every operation and reported success, `submit` updated
 * zero rows, and `set_field` looked the report up, found nothing, and
 * returned: every reading, every refrigerant weight and every chemical
 * application went on the floor one operation at a time, silently, with the
 * phone showing a tick.
 *
 * The id comes from the phone, like every other id in this protocol, because
 * a device that is offline has to be able to reference a report before it can
 * tell anybody about it. What the server needs and does not have is the rest:
 * the job, the customer and the property. Those come off the visit, which the
 * operation names in its payload.
 *
 * Returns a rejection reason, or null once the report exists.
 */
async function ensureReport(
  tx: Database, org: string, op: field.FieldOperation,
): Promise<string | null> {
  const reportId = op.subjectId!;

  const [existing] = await tx.select({ id: schema.serviceReport.id })
    .from(schema.serviceReport).where(eq(schema.serviceReport.id, reportId)).limit(1);
  if (existing) return null;

  const visitId = op.payload["visitId"] as string | undefined;
  if (!visitId) {
    /**
     * Refused rather than skipped. A report with no visit cannot be attached
     * to a job, a customer or a property, so there is nowhere for it to be
     * read back from, and accepting it would be the same silent loss under a
     * new name.
     */
    return "That service report is not attached to a visit, so there is nowhere to file it.";
  }

  const [visit] = await tx.select({
    id: schema.visit.id,
    jobId: schema.visit.jobId,
    customerId: schema.job.customerId,
    propertyId: schema.job.propertyId,
  }).from(schema.visit)
    .innerJoin(schema.job, eq(schema.job.id, schema.visit.jobId))
    .where(and(eq(schema.visit.id, visitId), eq(schema.visit.organizationId, org)))
    .limit(1);
  if (!visit) return "That visit is not here.";

  await tx.insert(schema.serviceReport).values({
    id: reportId,
    organizationId: org,
    visitId: visit.id,
    jobId: visit.jobId,
    customerId: visit.customerId,
    propertyId: visit.propertyId,
  /**
   * For the race this function cannot see, and NOT for an ordinary replay:
   * the existence check at the top already returns before reaching here on
   * the second arrival, which is why deleting this line breaks no test.
   *
   * It stays for two syncs landing at once, which two devices on one job
   * genuinely produce: both read no report, both insert, and without this one
   * transaction fails on the primary key and takes an entire batch of a
   * technician's day down with it.
   */
  }).onConflictDoNothing();

  return null;
}

async function effect(
  tx: Database,
  ctx: ServiceContext,
  op: field.FieldOperation,
  currentState: string | null,
  operationId: string,
): Promise<string | null> {
  const org = ctx.actor.organizationId;
  const nextState = field.stateAfter(op.kind, (currentState ?? undefined) as field.VisitState | undefined);

  switch (op.kind) {
    case "visit.en_route":
    case "visit.arrive":
    case "visit.start":
    case "visit.pause":
    case "visit.complete": {
      if (!op.subjectId) return "That operation names nothing to apply it to.";
      const stamp =
        op.kind === "visit.en_route" ? { enRouteAt: op.occurredAt }
        : op.kind === "visit.arrive" ? { arrivedAt: op.occurredAt }
        : op.kind === "visit.complete" ? { completedAt: op.occurredAt }
        : {};

      await tx.update(schema.visit).set({
        ...stamp,
        ...(nextState ? { status: nextState } : {}),
        updatedAt: new Date(),
      }).where(eq(schema.visit.id, op.subjectId));

      await customerTimeline(tx, org, op, nextState);
      return null;
    }

    case "visit.note": {
      if (!op.subjectId) return "That operation names nothing to apply it to.";
      const note = String(op.payload["text"] ?? "");
      if (!note) return "That note is empty.";
      await tx.update(schema.visit).set({
        technicianNotes: sql`coalesce(${schema.visit.technicianNotes} || E'\\n', '') || ${note}`,
        updatedAt: new Date(),
      }).where(eq(schema.visit.id, op.subjectId));
      return null;
    }

    case "timeclock.punch_in": {
      await tx.insert(schema.timeclockEntry).values({
        organizationId: org,
        technicianId: op.payload["technicianId"] as string,
        /**
         * `on_site` rather than `job`, which is what the enum used to say.
         * A punch with no kind is somebody at a property working, which is
         * the only default here that cannot quietly reclassify paid time.
         */
        kind: (op.payload["kind"] as "on_site") ?? "on_site",
        jobId: (op.payload["jobId"] as string) ?? null,
        visitId: op.subjectId || null,
        startedAt: op.occurredAt,
        /**
         * Captured at the punch, never inferred later. Reconstructing which
         * classification applied to which hours six weeks afterwards is the
         * exercise this field exists to avoid, and it has real money on it.
         */
        classification: (op.payload["classification"] as string) ?? null,
        workClassCode: (op.payload["workClassCode"] as string) ?? null,
        costCode: (op.payload["costCode"] as string) ?? null,
        startLatitude: (op.payload["latitude"] as string) ?? null,
        startLongitude: (op.payload["longitude"] as string) ?? null,
      });
      return null;
    }

    case "timeclock.punch_out": {
      const technicianId = op.payload["technicianId"] as string;
      const [open] = await tx.select().from(schema.timeclockEntry)
        .where(and(
          eq(schema.timeclockEntry.organizationId, org),
          eq(schema.timeclockEntry.technicianId, technicianId),
          isNull(schema.timeclockEntry.endedAt),
        ))
        .orderBy(desc(schema.timeclockEntry.startedAt)).limit(1);

      // No open punch is not an error worth refusing. Somebody's phone lost
      // the punch in, and a punch out on its own is still evidence that they
      // stopped; it surfaces as an open entry a supervisor fixes. Null rather
      // than a rejection for exactly that reason: it is not the technician's
      // mistake and telling their phone it failed helps nobody.
      if (!open) return null;

      const minutes = Math.max(
        0,
        Math.round((op.occurredAt.getTime() - open.startedAt.getTime()) / 60_000),
      );

      await tx.update(schema.timeclockEntry).set({
        endedAt: op.occurredAt,
        minutes,
        endLatitude: (op.payload["latitude"] as string) ?? null,
        endLongitude: (op.payload["longitude"] as string) ?? null,
        updatedAt: new Date(),
      }).where(eq(schema.timeclockEntry.id, open.id));

      /**
       * WHAT THOSE HOURS COST, decided now and never again.
       *
       * The three applied rate columns sit under a comment reading "Frozen at
       * close. The scale can change; this entry's cost must not", and nothing
       * wrote them. Every entry cost null, so labour contributed nothing to
       * job costing and a contractor reading a margin was reading a number
       * with its largest expense missing.
       *
       * Here rather than at report time because a rate looked up later
       * changes retroactively when somebody edits a wage scale, and last
       * quarter's costing moving after the quarter closed is how a number
       * stops being something anybody can stand behind.
       */
      await freezeRate(tx, org, open.id);
      return null;
    }

    case "visit.checklist_item": {
      if (!op.subjectId) return "That operation names nothing to apply it to.";
      const itemId = String(op.payload["itemId"] ?? "");
      const done = op.payload["done"] !== false;
      const [visit] = await tx.select({ checklist: schema.visit.checklist })
        .from(schema.visit).where(eq(schema.visit.id, op.subjectId)).limit(1);
      if (!visit) return "That visit is not here.";

      await tx.update(schema.visit).set({
        checklist: visit.checklist.map((item) =>
          item.id === itemId
            ? { ...item, doneAt: done ? op.occurredAt.toISOString() : null }
            : item),
        updatedAt: new Date(),
      }).where(eq(schema.visit.id, op.subjectId));
      return null;
    }

    case "attachment.attach":
    case "signature.capture": {
      /**
       * The record is written before the bytes arrive. A report that mentions
       * three photos should say so the moment it syncs, with the images
       * following behind, rather than appearing to have none until the last
       * upload finishes over a cellular connection in a van.
       */
      await tx.insert(schema.fieldUpload).values({
        organizationId: org,
        deviceId: op.deviceId,
        operationId,
        clientId: String(op.payload["uploadId"] ?? op.clientId),
        subjectType: op.kind === "signature.capture" ? "signature" : "visit",
        subjectId: op.subjectId || null,
        contentType: String(op.payload["contentType"] ?? "image/jpeg"),
        byteSize: (op.payload["byteSize"] as number) ?? null,
        contentHash: (op.payload["contentHash"] as string) ?? null,
        caption: (op.payload["caption"] as string) ?? null,
        capturedAt: op.occurredAt,
        latitude: (op.payload["latitude"] as string) ?? null,
        longitude: (op.payload["longitude"] as string) ?? null,
      }).onConflictDoNothing();
      return null;
    }

    case "service_report.submit": {
      if (!op.subjectId) return "That operation names no service report.";
      const missing = await ensureReport(tx, org, op);
      if (missing) return missing;

      await tx.update(schema.serviceReport).set({
        submittedAt: op.occurredAt,
        updatedAt: new Date(),
      }).where(eq(schema.serviceReport.id, op.subjectId));
      return null;
    }

    case "service_report.set_field": {
      /**
       * One row per captured field, not a blob on the report.
       *
       * These get trended, range checked and exported to regulators. A
       * refrigerant weight and a chemical application are the same shape here
       * and both have real consequences attached, which is why the regulated
       * columns are first class rather than living in a JSON bag.
       */
      if (!op.subjectId) return "That operation names no service report.";
      const key = String(op.payload["field"] ?? "");
      if (!key) return "That reading names no field.";

      const missing = await ensureReport(tx, org, op);
      if (missing) return missing;

      const [report] = await tx.select({
        propertyId: schema.serviceReport.propertyId,
      }).from(schema.serviceReport).where(eq(schema.serviceReport.id, op.subjectId)).limit(1);
      if (!report) return "That service report could not be created.";

      const value = op.payload["value"];

      await tx.insert(schema.serviceReportField).values({
        organizationId: org,
        reportId: op.subjectId,
        propertyId: report.propertyId,
        equipmentId: (op.payload["equipmentId"] as string) ?? null,
        key,
        label: (op.payload["label"] as string) ?? key,
        // Defaults to numeric, which is what a reading is. A chemical
        // application and a signature are their own kinds because the columns
        // they fill are different and regulators ask about them by name.
        kind: (op.payload["kind"] as "numeric") ?? "numeric",
        valueNumeric: typeof value === "number" ? String(value) : null,
        valueText: typeof value === "string" ? value : null,
        valueBoolean: typeof value === "boolean" ? value : null,
        unit: (op.payload["unit"] as string) ?? null,
        // The regulated set. Captured at the moment or reconstructed never.
        productName: (op.payload["productName"] as string) ?? null,
        epaRegistrationNumber: (op.payload["epaRegistrationNumber"] as string) ?? null,
        quantityApplied: (op.payload["quantityApplied"] as string) ?? null,
        applicationUnit: (op.payload["applicationUnit"] as string) ?? null,
        applicatorLicense: (op.payload["applicatorLicense"] as string) ?? null,
        targetPest: (op.payload["targetPest"] as string) ?? null,
        recordedAt: op.occurredAt,
      });
      return null;
    }

    case "visit.add_line": {
      /**
       * A part or an hour consumed on the job.
       *
       * Recorded as a JOB line, not an invoice line. The two are different:
       * warranty work has job lines and no invoice lines, a flat rate job has
       * one invoice line and a dozen job lines beneath it, and a callback has
       * lines that must never reach an invoice and must absolutely reach the
       * margin on the original job.
       */
      if (!op.subjectId) return "That operation names nothing to apply it to.";
      const [visit] = await tx.select({
        jobId: schema.visit.jobId,
      }).from(schema.visit).where(eq(schema.visit.id, op.subjectId)).limit(1);
      if (!visit) return "That visit is not here.";

      const technicianId = await technicianForDevice(tx, op.deviceId);

      await tx.insert(schema.jobLine).values({
        organizationId: org,
        jobId: visit.jobId,
        visitId: op.subjectId,
        kind: (op.payload["kind"] as "part") ?? "part",
        source: "field",
        priceBookItemVersionId: (op.payload["priceBookItemVersionId"] as string) ?? null,
        name: String(op.payload["name"] ?? "Unnamed line"),
        description: (op.payload["description"] as string) ?? null,
        quantity: String(op.payload["quantity"] ?? "1"),
        unitPrice: String(op.payload["unitPrice"] ?? "0"),
        unitCost: (op.payload["unitCost"] as string) ?? null,
        taxable: op.payload["taxable"] !== false,
        technicianId,
        nonBillableReason: (op.payload["nonBillableReason"] as string) ?? null,
        occurredAt: op.occurredAt,
      });
      return null;
    }

    case "equipment.record": {
      /**
       * The equipment at the property, found or updated on site.
       *
       * Matched on serial number where there is one, because that is the only
       * identifier that survives a customer moving out and the next owner
       * calling. Matching on anything softer produces a second record for the
       * same furnace and splits ten years of history down the middle.
       */
      const propertyId = op.payload["propertyId"] as string | undefined;
      if (!propertyId) return "That equipment record names no property.";

      const serial = (op.payload["serialNumber"] as string) ?? null;

      if (serial) {
        const [existing] = await tx.select({ id: schema.equipment.id })
          .from(schema.equipment)
          .where(and(
            eq(schema.equipment.organizationId, org),
            eq(schema.equipment.propertyId, propertyId),
            eq(schema.equipment.serialNumber, serial),
          )).limit(1);

        if (existing) {
          await tx.update(schema.equipment).set({
            manufacturer: (op.payload["manufacturer"] as string) ?? undefined,
            model: (op.payload["model"] as string) ?? undefined,
            location: (op.payload["location"] as string) ?? undefined,
            updatedAt: new Date(),
          }).where(eq(schema.equipment.id, existing.id));
          return null;
        }
      }

      await tx.insert(schema.equipment).values({
        organizationId: org,
        propertyId,
        category: String(op.payload["category"] ?? "other"),
        manufacturer: (op.payload["manufacturer"] as string) ?? null,
        model: (op.payload["model"] as string) ?? null,
        serialNumber: serial,
        location: (op.payload["location"] as string) ?? null,
        attributes: (op.payload["attributes"] as Record<string, unknown>) ?? {},
      });
      return null;
    }

    default:
      /**
       * Nothing here. An operation kind reaching this branch is accepted,
       * marked applied, and does nothing, which is worse than rejecting it:
       * the phone deletes it from the queue on the strength of that word.
       *
       * A test asserts this branch is unreachable for every kind in the
       * catalogue, so adding one without an effect fails rather than
       * silently discarding a technician's work.
       */
      return null;
  }
}

/** The customer-visible timeline, written as things happen rather than assembled on read. */
async function customerTimeline(
  tx: Database, org: string, op: field.FieldOperation, nextState: string | null,
) {
  if (!op.subjectId) return;
  const kind =
    op.kind === "visit.en_route" ? "on_the_way" as const
    : op.kind === "visit.arrive" ? "arrived" as const
    : op.kind === "visit.start" ? "in_progress" as const
    : op.kind === "visit.complete" ? "completed" as const
    : null;
  if (!kind) return;

  const [visit] = await tx.select({ jobId: schema.visit.jobId })
    .from(schema.visit).where(eq(schema.visit.id, op.subjectId)).limit(1);
  if (!visit) return;

  const [job] = await tx.select({ customerId: schema.job.customerId, number: schema.job.number })
    .from(schema.job).where(eq(schema.job.id, visit.jobId)).limit(1);
  if (!job) return;

  const headline =
    kind === "on_the_way" ? "Your technician is on the way"
    : kind === "arrived" ? "Your technician has arrived"
    : kind === "in_progress" ? "Work has started"
    : "The work is complete";

  await tx.insert(schema.portalEvent).values({
    organizationId: org,
    customerId: job.customerId,
    jobId: visit.jobId,
    kind,
    headline,
    occurredAt: op.occurredAt,
    // A completion that landed after a cancellation is an office problem, not
    // something to announce to the customer as if it were routine.
    isCustomerVisible: nextState !== "completed_after_cancellation",
  });
}

async function recordOperation(
  tx: Database,
  ctx: ServiceContext,
  device: typeof schema.device.$inferSelect,
  meta: Resolved,
  receivedAt: Date,
  outcome: { status: "accepted" | "applied" | "conflicted" | "rejected" | "superseded" | "held"; conflict: string | null; rejection: string | null },
) {
  const [row] = await tx.insert(schema.fieldOperation).values({
    organizationId: ctx.actor.organizationId,
    deviceId: device.id,
    technicianId: device.technicianId,
    clientId: meta.input.clientId,
    sequence: meta.input.sequence,
    kind: meta.input.kind,
    subjectId: meta.input.subjectId ?? null,
    payload: meta.input.payload,
    occurredAt: meta.occurredAt,
    claimedAt: meta.claimed,
    clamped: meta.clamped,
    receivedAt,
    appliedAt: outcome.status === "held" ? null : receivedAt,
    status: outcome.status,
    conflict: outcome.conflict,
    rejection: outcome.rejection,
    latitude: meta.input.latitude ?? null,
    longitude: meta.input.longitude ?? null,
    accuracyMeters: meta.input.accuracyMeters ?? null,
  }).returning({ id: schema.fieldOperation.id });

  return row!;
}

async function currentState(tx: Database, op: field.FieldOperation): Promise<string | null> {
  if (!op.subjectId) return null;

  if (op.kind === "service_report.submit" || op.kind === "service_report.set_field") {
    const [report] = await tx.select({
      submittedAt: schema.serviceReport.submittedAt,
      publishedAt: schema.serviceReport.publishedAt,
    }).from(schema.serviceReport).where(eq(schema.serviceReport.id, op.subjectId)).limit(1);
    if (!report) return null;
    // Derived, because the table models this with timestamps rather than an
    // enum: a report is what its history says it is.
    return report.publishedAt ? "published" : report.submittedAt ? "submitted" : "draft";
  }

  const [visit] = await tx.select({ status: schema.visit.status })
    .from(schema.visit).where(eq(schema.visit.id, op.subjectId)).limit(1);
  return visit?.status ?? null;
}

/** The occurrence time of the newest edit already applied to this subject. */
async function lastEditFor(
  tx: Database, ctx: ServiceContext, op: field.FieldOperation,
): Promise<Date | null> {
  if (field.CONFLICT_RULES[op.kind] !== "edit" || !op.subjectId) return null;

  const [row] = await tx.select({ at: max(schema.fieldOperation.occurredAt) })
    .from(schema.fieldOperation)
    .where(and(
      eq(schema.fieldOperation.organizationId, ctx.actor.organizationId),
      eq(schema.fieldOperation.subjectId, op.subjectId),
      eq(schema.fieldOperation.kind, op.kind),
      inArray(schema.fieldOperation.status, ["applied", "conflicted"]),
      // Same field, not merely the same subject. Two people filling in two
      // different boxes on one form are not editing the same thing.
      sql`${schema.fieldOperation.payload}->>'field' is not distinct from ${
        (op.payload["field"] as string | undefined) ?? null
      }`,
    ));

  return row?.at ?? null;
}

/** The technician a device belongs to, for attributing what came off it. */
async function technicianForDevice(tx: Database, deviceId: string): Promise<string | null> {
  const [row] = await tx.select({ technicianId: schema.device.technicianId })
    .from(schema.device).where(eq(schema.device.id, deviceId)).limit(1);
  return row?.technicianId ?? null;
}

/**
 * Whether this account has a technician record at all.
 *
 * Separate from the `field:sync` permission and deliberately so. The
 * permission says the account is allowed to sync; this says there is a person
 * with a route. An owner holds the permission and usually has no route, and
 * conflating the two produced a five hundred on the technician's own screen.
 */
export async function isTechnician(ctx: ServiceContext): Promise<boolean> {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const [row] = await tx.select({ id: schema.technician.id })
      .from(schema.technician)
      .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
      .where(and(
        eq(schema.technician.organizationId, ctx.actor.organizationId),
        eq(schema.membership.userId, ctx.actor.userId),
      )).limit(1);
    return row !== undefined;
  });
}

async function technicianFor(tx: Database, ctx: ServiceContext): Promise<string> {
  const [row] = await tx.select({ id: schema.technician.id })
    .from(schema.technician)
    .innerJoin(schema.membership, eq(schema.membership.id, schema.technician.membershipId))
    .where(and(
      eq(schema.technician.organizationId, ctx.actor.organizationId),
      eq(schema.membership.userId, ctx.actor.userId),
    )).limit(1);

  if (!row) {
    throw new ConflictError(
      "This account is not a technician, so it has no field app to register.",
    );
  }
  return row.id;
}

export async function conflicts(ctx: ServiceContext, input: z.infer<typeof listConflicts.input>) {
  return guardedRead(ctx, "visit:read", async (tx) => {
    const rows = await tx.select({
      op: schema.fieldOperation,
      technicianName: schema.technician.displayName,
    })
      .from(schema.fieldOperation)
      .innerJoin(schema.technician, eq(schema.technician.id, schema.fieldOperation.technicianId))
      .where(and(
        eq(schema.fieldOperation.status, "conflicted"),
        input.includeResolved ? undefined : isNull(schema.fieldOperation.resolvedAt),
      ))
      .orderBy(desc(schema.fieldOperation.receivedAt))
      .limit(input.limit + 1);

    const hasMore = rows.length > input.limit;
    const data = (hasMore ? rows.slice(0, input.limit) : rows).map((r) => ({
      id: r.op.id,
      kind: r.op.kind,
      subjectId: r.op.subjectId,
      technicianId: r.op.technicianId,
      technicianName: r.technicianName,
      conflict: r.op.conflict ?? "",
      occurredAt: r.op.occurredAt.toISOString(),
      receivedAt: r.op.receivedAt.toISOString(),
      payload: r.op.payload,
      createdAt: r.op.createdAt.toISOString(),
      updatedAt: r.op.updatedAt.toISOString(),
    }));

    return { data, hasMore, nextCursor: null };
  });
}

export async function resolve(ctx: ServiceContext, input: z.infer<typeof resolveConflict.input>) {
  return guardedWrite(ctx, "visit:write", async (tx) => {
    // A retry is a no-op. Resolving something already resolved is the state
    // the caller was asking for.
    await tx.update(schema.fieldOperation).set({
      resolvedAt: new Date(),
      resolvedByUserId: ctx.actor.userId,
      updatedAt: new Date(),
    }).where(and(
      eq(schema.fieldOperation.id, input.id),
      isNull(schema.fieldOperation.resolvedAt),
    ));

    await audit(tx, ctx, "field.conflict.resolved", "field_operation", input.id, null,
      { note: input.note ?? null });

    return { ok: true as const };
  });
}


