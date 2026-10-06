import { createHash } from "node:crypto";
import { field } from "@opentradesos/core";
import {
  OfflineError, SignedOutError, estimateFromPayload,
  type FieldSnapshot, type FieldVisit, type StoreUploadResult, type SyncResponse, type Transport,
  type UploadTransport,
} from "../src/index";

/**
 * A server in miniature, for testing the phone against something that
 * behaves like the real one.
 *
 * The rules that matter are core's own, imported rather than imitated: the
 * same gap holding, the same conflict verdicts and the same state changes the
 * real sync applies. The bytes are checked against the declared hash the way
 * the real upload route checks them. What it leaves out is the database.
 */
export class FakeServer {
  lastSequence = 0;
  readonly applied = new Map<string, { status: SyncResponse["results"][number]["status"]; conflict: string | null }>();
  readonly visits = new Map<string, FieldVisit>();
  /** upload id to the hash the record declared, for files still owed. */
  readonly owed = new Map<string, string>();
  readonly stored = new Map<string, string>();
  openSince: string | null = null;
  revision = 1;

  /** Flip to simulate a basement. */
  offline = false;
  signedOut = false;
  calls = { sync: 0, owed: 0, store: 0, snapshot: 0 };

  addVisit(id: string, over: Partial<FieldVisit> = {}): FieldVisit {
    const visit: FieldVisit = {
      id, jobId: `job-${id}`, jobNumber: 100, sequence: 1, status: "dispatched",
      summary: "Condenser not cooling", description: null, customerComplaint: null,
      technicianNotes: null, arrivedAt: null,
      windowStart: "2026-10-02T14:00:00Z", windowEnd: "2026-10-02T16:00:00Z",
      routeOrder: null, estimatedDurationMinutes: 60,
      customer: { id: `c-${id}`, name: `Customer ${id}`, phone: null },
      property: {
        id: `p-${id}`, addressLine1: "88 Ridge Rd", city: "Austin", state: "TX", postalCode: "78704",
        gateCode: null, accessNotes: null, hazardNotes: null, hasDog: false,
      },
      checklist: [],
      amountDue: null,
      report: { id: null, submitted: false, fields: [] },
      parts: [],
      ...over,
    };
    this.visits.set(id, visit);
    return visit;
  }

  private gate(): void {
    if (this.offline) throw new OfflineError("Network request failed");
    if (this.signedOut) throw new SignedOutError();
  }

  transport(): Transport {
    return {
      send: async (input) => {
        this.calls.sync += 1;
        this.gate();
        // Held is not settled: a held operation sent again is judged again.
        const fresh = input.operations.filter((o) => {
          const prior = this.applied.get(o.clientId);
          return !prior || prior.status === "held";
        });
        const asOps: field.FieldOperation[] = fresh.map((o) => ({
          clientId: o.clientId, deviceId: input.deviceId, kind: o.kind, sequence: o.sequence,
          occurredAt: new Date(o.occurredAt), subjectId: o.subjectId ?? "", payload: o.payload,
        }));
        const skipped = { [input.deviceId]: input.skipped ?? [] };
        const last = { [input.deviceId]: this.lastSequence };
        const { applicable, held } = field.applicablePrefix(asOps, last, skipped);
        const awaiting = field.findSequenceGaps(asOps, last, skipped).flatMap((g) => g.missing);
        const results: SyncResponse["results"] = [];

        for (const op of applicable) {
          const visit = op.subjectId ? this.visits.get(op.subjectId) : undefined;
          const verdict = field.evaluate({
            kind: op.kind, currentState: visit?.status, allowedFrom: field.allowedFrom(op.kind),
            occurredAt: op.occurredAt,
          });
          const status = !verdict.apply ? "rejected" : verdict.conflict ? "conflicted" : "applied";
          if (verdict.apply) this.effect(op, visit);
          this.applied.set(op.clientId, { status, conflict: verdict.conflict });
          results.push({
            clientId: op.clientId, status, conflict: verdict.conflict,
            rejection: verdict.apply ? null : verdict.conflict,
            occurredAt: op.occurredAt.toISOString(), clamped: null,
          });
          this.lastSequence = Math.max(this.lastSequence, op.sequence);
        }
        for (const op of held) {
          this.applied.set(op.clientId, { status: "held", conflict: null });
          results.push({
            clientId: op.clientId, status: "held", conflict: null, rejection: null,
            occurredAt: op.occurredAt.toISOString(), clamped: null,
          });
        }
        for (const o of input.operations) {
          const prior = this.applied.get(o.clientId);
          if (prior && !results.some((r) => r.clientId === o.clientId)) {
            results.push({
              clientId: o.clientId, status: prior.status, conflict: prior.conflict, rejection: null,
              occurredAt: o.occurredAt, clamped: null,
            });
          }
        }
        return { results, awaiting, snapshotRevision: this.revision };
      },
    };
  }

  private effect(op: field.FieldOperation, visit: FieldVisit | undefined): void {
    /**
     * Selling on site, as the server keeps it: the estimate on the visit's
     * day with the phone's ids, the customer's decision, the invoice raised.
     * Enough for the phone's view to be checked against what comes back.
     */
    const onVisit = typeof op.payload["visitId"] === "string" ? this.visits.get(op.payload["visitId"]) : undefined;
    if (op.kind === "estimate.create" && onVisit) {
      onVisit.estimates = [...(onVisit.estimates ?? []), {
        ...estimateFromPayload(op.subjectId, op.payload, onVisit.member), number: 2001, jobId: onVisit.jobId,
      }];
      this.revision += 1;
    }
    if (op.kind === "estimate.approve" && onVisit) {
      const estimate = onVisit.estimates?.find((e) => e.id === op.subjectId);
      if (estimate) {
        estimate.status = "approved";
        estimate.selectedOptionId = String(op.payload["optionId"]);
        estimate.signerName = String(op.payload["signerName"] ?? "");
      }
      this.revision += 1;
    }
    if (op.kind === "invoice.raise" && onVisit) {
      const total = String(op.payload["shownTotal"]);
      onVisit.invoices = [...(onVisit.invoices ?? []), { id: op.subjectId, number: 3001, status: "open", total, balance: total }];
      onVisit.amountDue = total;
      this.revision += 1;
    }
    if (op.kind === "timeclock.punch_in") this.openSince = op.occurredAt.toISOString();
    if (op.kind === "timeclock.punch_out") this.openSince = null;
    if (op.kind === "attachment.attach" || op.kind === "signature.capture") {
      this.owed.set(String(op.payload["uploadId"]), String(op.payload["contentHash"]));
    }
    if (!visit) return;
    const next = field.stateAfter(op.kind, visit.status as field.VisitState);
    if (next) visit.status = next;
    if (op.kind === "visit.arrive") visit.arrivedAt = op.occurredAt.toISOString();
    if (op.kind === "visit.note") {
      visit.technicianNotes = [visit.technicianNotes, String(op.payload["text"])].filter(Boolean).join("\n");
    }
    this.revision += 1;
  }

  uploads(): UploadTransport {
    return {
      owed: async () => {
        this.calls.owed += 1;
        this.gate();
        return [...this.owed.keys()];
      },
      store: async (uploadId, base64): Promise<StoreUploadResult> => {
        this.calls.store += 1;
        this.gate();
        const declared = this.owed.get(uploadId);
        if (declared === undefined) {
          return this.stored.has(uploadId)
            ? { stored: true, storageKey: this.stored.get(uploadId)!, reason: null, alreadyStored: true, attempts: 1, willRetry: false }
            : { stored: false, storageKey: null, reason: "Upload not found", alreadyStored: false, attempts: 0, willRetry: false };
        }
        const actual = createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
        if (actual !== declared) {
          return { stored: false, storageKey: null, reason: "The bytes do not match the hash.", alreadyStored: false, attempts: 1, willRetry: true };
        }
        this.owed.delete(uploadId);
        this.stored.set(uploadId, `org/${actual}.jpg`);
        return { stored: true, storageKey: `org/${actual}.jpg`, reason: null, alreadyStored: false, attempts: 1, willRetry: false };
      },
      fail: async (uploadId) => {
        this.gate();
        this.owed.delete(uploadId);
      },
    };
  }

  snapshot = async (input: { sinceRevision?: number | undefined }): Promise<FieldSnapshot> => {
    this.calls.snapshot += 1;
    this.gate();
    if (input.sinceRevision === this.revision) {
      return { revision: this.revision, unchanged: true, visits: [], priceBook: [], openTimeEntry: null };
    }
    return {
      revision: this.revision,
      unchanged: false,
      visits: [...this.visits.values()].map((v) => structuredClone(v)),
      priceBook: [],
      openTimeEntry: this.openSince ? { id: "t1", kind: "on_site", startedAt: this.openSince } : null,
    };
  };
}

export const sha256Base64 = (base64: string) =>
  createHash("sha256").update(Buffer.from(base64, "base64")).digest("hex");
