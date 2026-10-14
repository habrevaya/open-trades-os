import { z } from "zod";
import { defineRoute } from "../lib/define";
import { ExternalRef, PageRequest, Uuid } from "./common";

/**
 * NOTES ON A CUSTOMER (M03)
 *
 * What somebody in the office learned and the next person needs to know:
 * dated, signed, and added to rather than rewritten. Its author may change a
 * note for a few minutes after writing it; after that a correction is a new
 * note naming the one it corrects (`correctsNoteId`). Nothing deletes one.
 *
 * Read and written through the customer, under the caller's scope, so a
 * technician or a branch manager is told a customer they may not see is not
 * there. A technician (and a crew lead) reads only the notes marked for the
 * field, which are the ones on their visit.
 */

export const CustomerNote = z.object({
  id: Uuid,
  customerId: Uuid,
  body: z.string(),
  /** The day it is about: when it was written, or the day a file said for one brought in. */
  notedAt: z.string().datetime(),
  /** Who wrote it here. Null for one carried over from the old notes box or brought in from a file. */
  author: z.object({ userId: Uuid, name: z.string().nullable() }).nullable(),
  origin: z.enum(["typed", "carried", "imported"]),
  pinned: z.boolean(),
  pinnedAt: z.string().datetime().nullable(),
  /** Shown to the technician on the visit. */
  forField: z.boolean(),
  /** The note this one corrects, when it is a correction. */
  correctsNoteId: Uuid.nullable(),
  editedAt: z.string().datetime().nullable(),
  /** Until when the person asking may still change it, or null when they may not. */
  editableUntil: z.string().datetime().nullable(),
  externalRef: ExternalRef.nullable(),
});

export const listCustomerNotes = defineRoute({
  method: "get",
  path: "/v1/customers/{id}/notes",
  summary: "A customer's notes",
  description:
    "Every pinned note in `pinned`, then the rest newest first in `data`, a page at a time; pinned notes come back on every page. A technician or a crew lead gets only the notes marked for the field, and `fieldOnly` says so. A customer outside the caller's scope is a 404.",
  module: "M03",
  permissions: ["customer:read"],
  input: z.object({ id: Uuid }).merge(PageRequest),
  output: z.object({
    pinned: z.array(CustomerNote),
    data: z.array(CustomerNote),
    nextCursor: z.string().nullable(),
    hasMore: z.boolean(),
    fieldOnly: z.boolean(),
  }),
});

export const addCustomerNote = defineRoute({
  method: "post",
  path: "/v1/customers/{id}/notes",
  summary: "Write a note on a customer",
  description:
    "Signed by whoever writes it and dated now. `forField` shows it to the technician on the customer's visits; `pinned` keeps it at the top; `correctsNoteId` names the note it corrects. `notedAt` dates it earlier, under the history rules every back dated record follows: a week back for anybody, earlier only with `data:import`, never ahead. With `externalRef` it is a note from another system: marked imported, with no author here, refused a second time for the same reference, and nobody may change it afterwards. A retry with the same idempotency key returns the first answer.",
  module: "M03",
  permissions: ["customer:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    body: z.string().min(1).max(4000),
    forField: z.boolean().optional(),
    pinned: z.boolean().optional(),
    correctsNoteId: Uuid.optional(),
    notedAt: z.string().datetime().optional(),
    externalRef: ExternalRef.optional(),
  }),
  output: CustomerNote,
});

export const editCustomerNote = defineRoute({
  method: "patch",
  path: "/v1/customer-notes/{id}",
  summary: "Fix a note while it is fresh",
  description:
    "Only its author, and only for 15 minutes after writing it: the words, and whether it is for the field. After that, or for anybody else, it is refused with a sentence saying to add a new note that corrects it. A note carried over or brought in from a file is never changed.",
  module: "M03",
  permissions: ["customer:write"],
  input: z.object({
    id: Uuid,
    body: z.string().min(1).max(4000).optional(),
    forField: z.boolean().optional(),
  }),
  output: CustomerNote,
});

export const pinCustomerNote = defineRoute({
  method: "post",
  path: "/v1/customer-notes/{id}/pin",
  summary: "Keep a note at the top, or stop",
  description:
    "Anybody who may write notes may pin one, whoever wrote it, because pinning changes where it sits and not what it says. Sending the same answer twice changes nothing.",
  module: "M03",
  permissions: ["customer:write"],
  idempotent: true,
  input: z.object({ id: Uuid, pinned: z.boolean() }),
  output: CustomerNote,
});

export const customerNoteRoutes = {
  listCustomerNotes, addCustomerNote, editCustomerNote, pinCustomerNote,
} as const;
