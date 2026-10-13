import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";
import { Base64Bytes } from "./files";

/**
 * A SIGNED IN CUSTOMER ADDING A PHOTOGRAPH OR A PDF TO THEIR OWN JOB
 *
 * From a sign in only, like saving a card: an account link can be forwarded.
 * The job and the visit are checked against the customer the sign in names,
 * so another customer's job, another company's and one that does not exist
 * are the same not found. The bytes are held to the rules a reply by email is
 * held to: never a program, a photograph or a PDF by its bytes, caps on one
 * file, on the count and on the total for one job, and an hourly limit per
 * customer.
 */

const Token = z.string().min(20).max(200);

export const PortalFile = z.object({
  id: Uuid,
  fileName: z.string().nullable(),
  contentType: z.string().nullable(),
  sizeBytes: z.number().int().nullable(),
  addedAt: z.string().datetime(),
  jobId: Uuid,
  jobLabel: z.string(),
  /** Somebody in the company has opened it, so it stays with the job. */
  seen: z.boolean(),
  removable: z.boolean(),
});

export const listPortalFiles = defineRoute({
  method: "get",
  path: "/v1/portal/files",
  summary: "The files a signed in customer added, and where they can add one",
  description:
    "From a sign in only. The customer's jobs that are not cancelled, with the visits still to come on them, and the files they added, newest first, each saying whether it can still be taken back.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  input: z.object({ token: Token }),
  output: z.object({
    targets: z.array(z.object({ jobId: Uuid, visitId: Uuid.nullable(), label: z.string() })),
    files: z.array(PortalFile),
    limits: z.object({ maxFileMegabytes: z.number().int(), maxFilesPerJob: z.number().int() }),
  }),
});

export const addPortalFile = defineRoute({
  method: "post",
  path: "/v1/portal/files",
  summary: "Add a photograph or a PDF to one of the customer's own jobs or visits",
  description:
    "From a sign in only. Refused for a cancelled job or visit, for a program by its name, claimed type or bytes, for anything that is not a photograph (JPEG, PNG, HEIC, WebP) or a PDF by its bytes, over 5 MB, past 10 files or 25 MB on one job, and past 20 an hour for one customer. The office sees it on the job and the technician on the visit; the customer sees it in their list, never on the job link. The same bytes on the same job or visit are one file.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({
    token: Token,
    jobId: Uuid,
    /** One visit of that job, when the file is about it. */
    visitId: Uuid.optional(),
    fileName: z.string().min(1).max(255),
    /** What the browser thinks it is. Not believed. */
    contentType: z.string().max(100).optional(),
    bytes: Base64Bytes,
  }),
  output: PortalFile,
});

export const removePortalFile = defineRoute({
  method: "post",
  path: "/v1/portal/files/{id}/remove",
  summary: "Take back a file the customer added, before the company has opened it",
  description:
    "From a sign in only. Only a file this customer added, and only until somebody in the company has opened it; after that it stays with the job. A file the office added is never the customer's to remove and is the same not found as one that does not exist. Removing one already removed changes nothing.",
  module: "M05",
  permissions: [],
  authorization: "grant",
  idempotent: true,
  input: z.object({ token: Token, id: Uuid }),
  output: z.object({ id: Uuid, removed: z.boolean() }),
});

export const portalFileRoutes = { listPortalFiles, addPortalFile, removePortalFile } as const;
