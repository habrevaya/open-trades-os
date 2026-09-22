import { and, eq, inArray, sql, desc, isNull, max } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { field } from "@opentradesos/core";
import type { z } from "zod";
import {
  type ServiceContext, guardedRead, guardedWrite, NotFoundError, ConflictError,
} from "./context";
import { audit } from "./customers";
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

  const status = !verdict.apply
    ? (verdict.conflict ? "rejected" as const : "superseded" as const)
    : verdict.conflict
      ? "conflicted" as const
      : "applied" as const;

  const row = await recordOperation(tx, ctx, device, meta, receivedAt, {
    status,
    conflict: verdict.conflict,
    rejection: verdict.apply ? null : verdict.conflict,
  });

  if (verdict.apply) await effect(tx, ctx, op, subjectState, row.id);

  return {
    clientId: op.clientId,
    status,
    conflict: verdict.conflict,
    rejection: verdict.apply ? null : verdict.conflict,
    occurredAt: op.occurredAt.toISOString(),
    clamped: meta.clamped,
  };
}

/**
 * What the operation actually does to the rest of the schema.
 *
 * Kept in one place so that adding an operation kind means adding one case
 * here rather than finding the four places a similar one is handled.
 */
async function effect(
  tx: Database,
  ctx: ServiceContext,
  op: field.FieldOperation,
  currentState: string | null,
  operationId: string,
) {
  const org = ctx.actor.organizationId;
  const nextState = field.stateAfter(op.kind, (currentState ?? undefined) as field.VisitState | undefined);

  switch (op.kind) {
    case "visit.en_route":
    case "visit.arrive":
    case "visit.start":
    case "visit.pause":
    case "visit.complete": {
      if (!op.subjectId) return;
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
      return;
    }

    case "visit.note": {
      if (!op.subjectId) return;
      const note = String(op.payload["text"] ?? "");
      if (!note) return;
      await tx.update(schema.visit).set({
        technicianNotes: sql`coalesce(${schema.visit.technicianNotes} || E'\\n', '') || ${note}`,
        updatedAt: new Date(),
      }).where(eq(schema.visit.id, op.subjectId));
      return;
    }

    case "timeclock.punch_in": {
      await tx.insert(schema.timeclockEntry).values({
        organizationId: org,
        technicianId: op.payload["technicianId"] as string,
        kind: (op.payload["kind"] as "job") ?? "job",
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
      return;
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
      // stopped; it surfaces as an open entry a supervisor fixes.
      if (!open) return;

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
      return;
    }

    case "visit.checklist_item": {
      if (!op.subjectId) return;
      const itemId = String(op.payload["itemId"] ?? "");
      const done = op.payload["done"] !== false;
      const [visit] = await tx.select({ checklist: schema.visit.checklist })
        .from(schema.visit).where(eq(schema.visit.id, op.subjectId)).limit(1);
      if (!visit) return;

      await tx.update(schema.visit).set({
        checklist: visit.checklist.map((item) =>
          item.id === itemId
            ? { ...item, doneAt: done ? op.occurredAt.toISOString() : null }
            : item),
        updatedAt: new Date(),
      }).where(eq(schema.visit.id, op.subjectId));
      return;
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
      return;
    }

    case "service_report.submit": {
      if (!op.subjectId) return;
      await tx.update(schema.serviceReport).set({
        submittedAt: op.occurredAt,
        updatedAt: new Date(),
      }).where(eq(schema.serviceReport.id, op.subjectId));
      return;
    }

    default:
      // service_report.set_field, visit.add_line and equipment.record are recorded in
      // the log and applied by the service report and billing paths, which
      // own those tables. Writing them from here would put the same rules in
      // two places.
      return;
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


