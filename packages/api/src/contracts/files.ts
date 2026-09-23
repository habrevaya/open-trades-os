import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * FILES AND THE FIELD UPLOAD QUEUE
 *
 * Bytes are base64 on the wire rather than multipart, and that is a real
 * trade: it costs a third in size. What it buys is one request shape for
 * every client, including the MCP server, where a tool call is JSON and a
 * multipart body has nowhere to live. A technician's phone, a partner
 * integration and an agent all send a photograph the same way.
 *
 * The declared content type is carried and is NOT believed. The server
 * decides what a file is from its first bytes; the claim is used only to
 * make a refusal say something useful.
 */
export const Base64Bytes = z.string().min(4).max(28 * 1024 * 1024);

export const StoredFile = z.object({
  /** Content addressed: the SHA-256 of the bytes decides it. */
  storageKey: z.string(),
  /** Sniffed from the bytes, never taken from the request. */
  contentType: z.string(),
  sizeBytes: z.number().int(),
  /** True when these exact bytes were already held and nothing was written. */
  alreadyHeld: z.boolean(),
});

export const Attachment = z.object({
  id: Uuid,
  kind: z.string(),
  storageKey: z.string(),
  fileName: z.string().nullable(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  /** before / after / during, for photo comparison in a proposal or a dispute. */
  phase: z.string().nullable(),
  createdAt: z.string().datetime(),
});

export const listAttachments = defineRoute({
  method: "get",
  path: "/v1/attachments",
  summary: "What is attached to one record",
  module: "M23",
  permissions: ["document:read"],
  input: z.object({
    entityType: z.string().min(1).max(50),
    entityId: Uuid,
  }),
  output: z.object({ attachments: z.array(Attachment) }),
});

export const PendingUpload = z.object({
  id: Uuid,
  /** Generated on the device, so an operation could name the file before it existed. */
  clientId: z.string(),
  subjectType: z.string(),
  subjectId: Uuid.nullable(),
  contentType: z.string(),
  byteSize: z.number().int().nullable(),
  contentHash: z.string().nullable(),
  attempts: z.number().int(),
  lastError: z.string().nullable(),
  capturedAt: z.string().datetime().nullable(),
});

export const listPendingUploads = defineRoute({
  method: "get",
  path: "/v1/field/uploads",
  summary: "What the server is still waiting for from this device",
  description:
    "The question a phone asks when it comes back on a signal, and the one nothing could answer: an upload queue with no way to ask what is owed is a camera roll. Excludes what has run out of attempts, because handing a phone work it has failed five times spends a battery for nothing.",
  module: "M11",
  permissions: ["field:sync"],
  input: z.object({ deviceId: Uuid }),
  output: z.object({ uploads: z.array(PendingUpload) }),
});

export const storeUpload = defineRoute({
  method: "post",
  path: "/v1/field/uploads/{clientId}",
  summary: "Send the bytes for a queued upload",
  description:
    "The declared hash is checked against the bytes rather than trusted. A phone whose hash disagrees has sent a corrupted file, and accepting it stores a photograph of nothing under a name that says otherwise. Storing also attaches it to the record it was taken for, in the same transaction: an upload that reached storage and not the job is a photograph nobody will find.",
  module: "M11",
  permissions: ["field:sync"],
  idempotent: true,
  input: z.object({
    clientId: z.string().min(1).max(200),
    /** Base64. See the note at the top of this file on why not multipart. */
    bytes: Base64Bytes,
    caption: z.string().max(500).optional(),
  }),
  output: z.object({
    stored: z.boolean(),
    /** Null when the bytes were refused. */
    storageKey: z.string().nullable(),
    /**
     * Null when they were kept. A corrupted file comes back as an outcome
     * rather than an error, because corruption on the way out of a van is
     * ordinary weather for this endpoint, and because the attempt count has
     * to survive the answer: an exception would roll back the bookkeeping
     * and let a phone resend the same broken file forever.
     */
    reason: z.string().nullable(),
    /** True when this arrived before and the response was lost. */
    alreadyStored: z.boolean(),
    attempts: z.number().int(),
    willRetry: z.boolean(),
  }),
});

export const failUpload = defineRoute({
  method: "post",
  path: "/v1/field/uploads/{clientId}/failed",
  summary: "Report that the device could not send it",
  description:
    "Counted, and abandoned after the cap rather than left to circle forever. An abandoned upload is still a row somebody can read the error off, which is the difference between a photograph that failed and one nobody knew about.",
  module: "M11",
  permissions: ["field:sync"],
  idempotent: true,
  input: z.object({
    clientId: z.string().min(1).max(200),
    error: z.string().min(1).max(500),
  }),
  output: z.object({
    status: z.enum(["queued", "uploading", "stored", "failed", "abandoned"]),
    attempts: z.number().int(),
    willRetry: z.boolean(),
  }),
});

export const getUploadStatus = defineRoute({
  method: "get",
  path: "/v1/field/uploads/outstanding",
  summary: "How many files a record is still waiting for",
  description:
    "What lets a screen say 'two photos, one still uploading' rather than showing two and implying that is all there were. Abandoned is reported separately from pending, because still coming and never coming are different things to tell somebody.",
  module: "M11",
  permissions: ["document:read"],
  input: z.object({
    subjectType: z.string().min(1).max(50),
    subjectId: Uuid,
  }),
  output: z.object({
    stored: z.number().int(),
    pending: z.number().int(),
    abandoned: z.number().int(),
  }),
});

export const fileRoutes = {
  listAttachments, listPendingUploads, storeUpload, failUpload, getUploadStatus,
} as const;
