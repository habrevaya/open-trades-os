import { pgTable, uuid, date, integer, index, uniqueIndex } from "drizzle-orm/pg-core";
import { pk, timestamps } from "./_shared";
import { organization } from "./tenancy";
import { job } from "./work";
import { task } from "./automation";

/**
 * WHAT A CUSTOMER SENT TO A JOB ON ONE DAY, AND THE TASK IT RAISED
 *
 * A customer sending photos or a PDF to a job from their account raises one
 * office task a day per job, however many files they send that day: the first
 * file of the day writes this row and the task, and each one after adds to the
 * count the task's title says. The unique index is what makes it one, whatever
 * two uploads arriving together do. When the task has been finished (everybody
 * opened what was sent) and another file comes the same day, a new task is
 * raised and this row points at it, so a file is never sent to a task nobody
 * is looking at.
 *
 * The day is the company's, in its own timezone.
 */
export const customerUploadDay = pgTable("customer_upload_day", {
  id: pk(),
  organizationId: uuid("organization_id").notNull().references(() => organization.id, { onDelete: "cascade" }),
  jobId: uuid("job_id").notNull().references(() => job.id, { onDelete: "cascade" }),
  onDay: date("on_day").notNull(),
  /** The office task for the files of this day, the newest when one was finished and another raised. */
  taskId: uuid("task_id").references(() => task.id, { onDelete: "set null" }),
  /** How many files the customer sent to the job that day. */
  files: integer("files").notNull().default(0),
  ...timestamps,
}, (t) => ({
  dayIdx: uniqueIndex("customer_upload_day_job_day_idx").on(t.organizationId, t.jobId, t.onDay),
  taskIdx: index("customer_upload_day_task_idx").on(t.taskId),
}));
