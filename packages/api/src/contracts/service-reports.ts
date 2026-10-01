import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * M11: THE DOCUMENT THAT LEAVES WITH THE CUSTOMER
 *
 * Three permissions were granted to roles and checked by nothing, and they
 * name the three halves of this module that were missing while the fourth
 * worked: `services/field.ts` captures a report from a technician's phone,
 * records every field as its own row and submits it, and nothing could read
 * one back, declare a template, or publish.
 *
 * `published_at` is the column that decides whether the customer sees the
 * document. It was read to derive a status and set by nothing, so every
 * report ever captured was stuck at submitted and no customer ever received
 * one.
 */

const ReadingKind = z.enum([
  "numeric", "text", "boolean", "select", "photo", "signature", "chemical", "measurement",
]);

const Status = z.enum(["draft", "submitted", "published", "skipped"]);

export const TemplateField = z.object({
  key: z.string().min(1).max(80),
  label: z.string().min(1).max(200),
  kind: ReadingKind,
  unit: z.string().max(40).optional(),
  options: z.array(z.string().max(120)).optional(),
  /**
   * Defaults to false on a declaration and true on a capture, which is not an
   * inconsistency: a reading is useful to the office by default, and the safe
   * default for "should a customer read this" is no.
   */
  customerVisible: z.boolean().optional(),
  trend: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  required: z.boolean().optional(),
});

export const Template = z.object({
  id: Uuid,
  name: z.string(),
  jobTypeId: Uuid.nullable(),
  tradePackId: z.string().nullable(),
  version: z.number(),
  active: z.boolean(),
  fields: z.array(TemplateField),
});

export const listServiceReportTemplates = defineRoute({
  method: "get",
  path: "/v1/service-report-templates",
  summary: "What this company asks a technician to record",
  module: "M11",
  permissions: ["servicereport:read"],
  input: z.object({ includeRetired: z.boolean().optional() }),
  output: z.object({ templates: z.array(Template) }),
});

export const defineServiceReportTemplate = defineRoute({
  method: "post",
  path: "/v1/service-report-templates",
  summary: "Declare a report of your own",
  description:
    "Templates existed only as a side effect of installing a trade pack, so a company could not add a field or declare a report of its own. At most one active template per job type: two means the report a technician is handed depends on which row came back first, so the same work captures different readings on different days and a trend chart is made of two measurements.",
  module: "M11",
  permissions: ["servicereport:write"],
  idempotent: true,
  input: z.object({
    name: z.string().min(1).max(200),
    jobTypeId: Uuid.nullable().optional(),
    fields: z.array(TemplateField),
  }),
  output: Template,
});

export const updateServiceReportTemplate = defineRoute({
  method: "patch",
  path: "/v1/service-report-templates/{id}",
  summary: "Change a template, or retire it",
  description:
    "Changing the fields bumps the version, because a report stores which version it answered. Editing fields without a bump makes every past report claim it answered the current questions, and a reading that was never asked for reads as missing rather than as not applicable. A rename does not bump, because it changes nothing about what was asked.",
  module: "M11",
  permissions: ["servicereport:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    jobTypeId: Uuid.nullable().optional(),
    fields: z.array(TemplateField).optional(),
    active: z.boolean().optional(),
  }),
  output: Template,
});

export const ReportField = z.object({
  key: z.string(),
  label: z.string(),
  kind: z.string(),
  unit: z.string().nullable(),
  value: z.union([z.string(), z.number(), z.boolean()]).nullable(),
  equipmentId: Uuid.nullable(),
  customerVisible: z.boolean(),
  outOfRange: z.boolean(),
  recordedAt: z.string(),
  /** The regulated half, present only on a chemical application. */
  chemical: z.object({
    productName: z.string().nullable(),
    epaRegistrationNumber: z.string().nullable(),
    quantityApplied: z.string().nullable(),
    applicationUnit: z.string().nullable(),
    applicatorLicense: z.string().nullable(),
    targetPest: z.string().nullable(),
  }).nullable(),
});

export const Report = z.object({
  id: Uuid,
  visitId: Uuid,
  jobId: Uuid,
  customerId: Uuid,
  propertyId: Uuid,
  templateId: Uuid.nullable(),
  templateVersion: z.number().nullable(),
  status: Status,
  summary: z.string().nullable(),
  technicianNotes: z.string().nullable(),
  observations: z.string().nullable(),
  skipped: z.boolean(),
  skipReason: z.string().nullable(),
  submittedAt: z.string().nullable(),
  publishedAt: z.string().nullable(),
  fields: z.array(ReportField),
});

export const listServiceReports = defineRoute({
  method: "get",
  path: "/v1/service-reports",
  summary: "What was actually done, and where a reading was out of range",
  module: "M11",
  permissions: ["servicereport:read"],
  input: z.object({
    jobId: Uuid.optional(),
    visitId: Uuid.optional(),
    customerId: Uuid.optional(),
    propertyId: Uuid.optional(),
    status: Status.optional(),
    outOfRangeOnly: z.boolean().optional(),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  output: z.object({
    reports: z.array(z.object({
      id: Uuid,
      visitId: Uuid,
      jobId: Uuid,
      customerId: Uuid,
      propertyId: Uuid,
      status: Status,
      summary: z.string().nullable(),
      fieldCount: z.number(),
      outOfRangeCount: z.number(),
      submittedAt: z.string().nullable(),
      publishedAt: z.string().nullable(),
    })),
  }),
});

export const getServiceReport = defineRoute({
  method: "get",
  path: "/v1/service-reports/{id}",
  summary: "One report, with everything recorded on it",
  description:
    "customerFacing drops the fields marked not customer visible AND the technician's own notes. Those notes are where somebody writes what the customer did not want to hear, and a portal that showed them would be a different product.",
  module: "M11",
  permissions: ["servicereport:read"],
  input: z.object({ id: Uuid, customerFacing: z.boolean().optional() }),
  output: Report,
});

export const annotateServiceReport = defineRoute({
  method: "patch",
  path: "/v1/service-reports/{id}",
  summary: "The office's own words on it",
  description:
    "Summary and observations only. The technician's notes are not editable here: they are what the person who was in the building wrote, and an office that can rewrite them has destroyed the one record of what was actually said. A published report is refused: the customer has it, and changing it with no second version means two people reading different things.",
  module: "M11",
  permissions: ["servicereport:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    summary: z.string().max(4000).nullable().optional(),
    observations: z.string().max(4000).nullable().optional(),
  }),
  output: Report,
});

export const publishServiceReport = defineRoute({
  method: "post",
  path: "/v1/service-reports/{id}/publish",
  summary: "Send it to the customer",
  description:
    "The write this module was missing. Publishing is a decision somebody takes, separately from capture: a report is written on a phone in a basement and may carry readings out of range and a three word summary, and collapsing publish into submit would mean every typo is a document the customer has already read. A draft is refused because it is still syncing; a skipped report is refused because there is no document.",
  module: "M11",
  permissions: ["servicereport:publish"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Report,
});

export const unpublishServiceReport = defineRoute({
  method: "post",
  path: "/v1/service-reports/{id}/unpublish",
  summary: "Take it back, with a reason",
  description:
    "The reason goes on the report's observations rather than only into the audit log, so it travels with the document. Somebody asks about a withdrawn report a year later.",
  module: "M11",
  permissions: ["servicereport:publish"],
  idempotent: true,
  input: z.object({ id: Uuid, reason: z.string().min(1).max(1000) }),
  output: Report,
});

export const serviceReportRoutes = {
  listServiceReportTemplates,
  defineServiceReportTemplate,
  updateServiceReportTemplate,
  listServiceReports,
  getServiceReport,
  annotateServiceReport,
  publishServiceReport,
  unpublishServiceReport,
} as const;
