import { pgTable, uuid, text, index } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";
import { organization, user } from "./tenancy";

/**
 * THE COMPANY'S OWN HOW-TO NOTES.
 *
 * How this company bleeds a boiler, which filter the Johnsons' unit takes,
 * what to check before condemning a heat exchanger. Written by whoever knows
 * it (a lead technician, the service manager) and read by the field
 * assistant, which answers a technician's "how do I" from these and from
 * nothing else: a procedure taken from a model's general knowledge is how a
 * company's way of doing a job quietly becomes somebody else's.
 *
 * Words the assistant matches a question against are kept as `tags` beside
 * the title, because a technician asks about "the Rheem" and the note is
 * called "Tankless descale".
 *
 * Taken out of use by `deleted_at` rather than removed, so an answer given
 * from a note last week can still be traced to what it said.
 */
export const knowledgeNote = pgTable("knowledge_note", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  title: text("title").notNull(),
  body: text("body").notNull(),
  tags: text("tags").array().notNull().default([]),
  createdByUserId: uuid("created_by_user_id").references(() => user.id, { onDelete: "set null" }),
  updatedByUserId: uuid("updated_by_user_id").references(() => user.id, { onDelete: "set null" }),
  ...timestamps,
}, (t) => ({
  orgIdx: index("knowledge_note_org_idx").on(t.organizationId, t.updatedAt),
}));
