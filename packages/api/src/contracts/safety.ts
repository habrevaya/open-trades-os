import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * TOOLBOX TALKS AND INCIDENT REPORTS
 *
 * The safety half of M23. Three permissions and three audiences: `safety:read`
 * is the register (who was hurt, which talks were held), `safety:write` runs
 * talks and follows reports up, and `safety:report` is reporting something
 * that went wrong, held by almost everybody and showing a reporter their own
 * reports and nobody else's. A technician signs a talk with `field:sync`, for
 * themselves only: the line on the sheet is found from who is signed in, never
 * from an id in the request.
 *
 * Nothing here says whether an incident must be reported to an authority.
 * That depends on facts this database does not hold, and the module's rule
 * that it never tells a contractor they are compliant applies here too.
 */

const Photo = z.object({
  fileName: z.string().min(1).max(200),
  contentType: z.string().max(100).optional(),
  /** Base64, with or without a data URL prefix. The type is decided from the bytes. */
  bytes: z.string().min(1),
});

const Stored = z.object({
  id: Uuid, kind: z.string(), storageKey: z.string(), fileName: z.string().nullable(),
  contentType: z.string().nullable(), createdAt: z.string(),
});

const Attendee = z.object({
  id: Uuid,
  technicianId: Uuid.nullable(),
  name: z.string(),
  signedAt: z.string().nullable(),
  /** `field` signed on their own phone, `office` recorded from the paper sheet. */
  signedVia: z.string().nullable(),
  hasSignature: z.boolean(),
});

const Meeting = z.object({
  id: Uuid,
  topic: z.string(),
  notes: z.string().nullable(),
  heldAt: z.string(),
  location: z.string().nullable(),
  jobId: Uuid.nullable(),
  ledBy: z.string().nullable(),
  closedAt: z.string().nullable(),
  attendees: z.array(Attendee),
  signed: z.number().int(),
});

const AttendeeInput = z.object({
  /** One of the company's own people, who can then sign from their phone. */
  technicianId: Uuid.optional(),
  /** Somebody without an account: a supplier's rep, a subcontractor. Taken from the technician when omitted. */
  name: z.string().max(200).optional(),
});

export const listSafetyMeetings = defineRoute({
  method: "get",
  path: "/v1/safety/meetings",
  summary: "Toolbox talks, newest first",
  description: "Each with who was on the list and who has signed.",
  module: "M23",
  permissions: ["safety:read"],
  input: z.object({ limit: z.number().int().min(1).max(500).optional() }),
  output: z.object({ meetings: z.array(Meeting) }),
});

export const createSafetyMeeting = defineRoute({
  method: "post",
  path: "/v1/safety/meetings",
  summary: "Record a toolbox talk",
  description:
    "A topic, when, where, who led it and who was there. Each of the company's own people on the list can then sign it from their phone; anybody else is marked signed from the paper sheet.",
  module: "M23",
  permissions: ["safety:write"],
  idempotent: true,
  input: z.object({
    topic: z.string().min(1).max(300),
    notes: z.string().max(10000).optional(),
    heldAt: z.string().datetime({ offset: true }),
    location: z.string().max(300).optional(),
    jobId: Uuid.optional(),
    ledBy: z.string().max(200).optional(),
    attendees: z.array(AttendeeInput).max(200).optional(),
  }),
  output: z.object({ id: Uuid }),
});

export const getSafetyMeeting = defineRoute({
  method: "get",
  path: "/v1/safety/meetings/{id}",
  summary: "One toolbox talk, its sign in sheet and its photographs",
  module: "M23",
  permissions: ["safety:read"],
  input: z.object({ id: Uuid }),
  output: Meeting.extend({ photos: z.array(Stored) }),
});

export const addSafetyMeetingAttendees = defineRoute({
  method: "post",
  path: "/v1/safety/meetings/{id}/attendees",
  summary: "Add people to a talk's sign in sheet",
  description: "Refused once the sheet is closed, and for somebody already on it.",
  module: "M23",
  permissions: ["safety:write"],
  idempotent: true,
  input: z.object({ id: Uuid, attendees: z.array(AttendeeInput).min(1).max(200) }),
  output: z.object({ added: z.number().int() }),
});

export const markSafetyMeetingSigned = defineRoute({
  method: "post",
  path: "/v1/safety/meetings/{id}/attendees/{attendeeId}/signed",
  summary: "Mark somebody signed from the paper sheet",
  description:
    "Recorded as signed in the office, never as a signature the person gave themselves. Photograph the paper sheet onto the talk as the evidence. Marking somebody already signed changes nothing.",
  module: "M23",
  permissions: ["safety:write"],
  idempotent: true,
  input: z.object({ id: Uuid, attendeeId: Uuid }),
  output: z.object({ signedAt: z.string() }),
});

export const closeSafetyMeeting = defineRoute({
  method: "post",
  path: "/v1/safety/meetings/{id}/close",
  summary: "Close a talk's sign in sheet",
  description: "After this nobody signs and nobody is added. Closing a closed sheet changes nothing.",
  module: "M23",
  permissions: ["safety:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ closedAt: z.string() }),
});

export const addSafetyMeetingPhoto = defineRoute({
  method: "post",
  path: "/v1/safety/meetings/{id}/photos",
  summary: "Add a photograph to a talk, such as the paper sign in sheet",
  description: "The same bytes twice are one photograph.",
  module: "M23",
  permissions: ["safety:write"],
  idempotent: true,
  input: Photo.extend({ id: Uuid }),
  output: z.object({ id: Uuid }),
});

export const listMySafetyMeetings = defineRoute({
  method: "get",
  path: "/v1/safety/my-meetings",
  summary: "The talks I am on, waiting for my signature first",
  description:
    "The signed in technician's own lines and nothing about anybody else's. `cannotSign` says why one cannot be signed yet: not held yet, sheet closed.",
  module: "M23",
  permissions: ["field:sync"],
  input: z.object({}),
  output: z.object({
    meetings: z.array(z.object({
      meetingId: Uuid,
      topic: z.string(),
      notes: z.string().nullable(),
      heldAt: z.string(),
      location: z.string().nullable(),
      ledBy: z.string().nullable(),
      signedAt: z.string().nullable(),
      cannotSign: z.string().nullable(),
    })),
  }),
});

export const signSafetyMeeting = defineRoute({
  method: "post",
  path: "/v1/safety/meetings/{id}/sign",
  summary: "Sign a toolbox talk, from the field",
  description:
    "The signed in technician signs their own line with a drawn signature, sent as a PNG. Refused before the talk was held, after the sheet was closed, and for somebody not on the list. A retry after it worked answers with the time it was signed.",
  module: "M23",
  permissions: ["field:sync"],
  idempotent: true,
  input: z.object({ id: Uuid, signature: z.string().min(1) }),
  output: z.object({ signedAt: z.string() }),
});

const IncidentKind = z.enum(["injury", "near_miss", "property_damage", "vehicle", "environmental", "other"]);
const PersonRole = z.enum(["injured", "involved", "witness"]);

export const reportIncident = defineRoute({
  method: "post",
  path: "/v1/safety/incidents",
  summary: "Report an incident or a near miss",
  description:
    "What happened in the reporter's own words, when, where, who was there and how, and photographs. An injury report has to say who was hurt. The office is told by a task in its queue, raised in the same transaction.",
  module: "M23",
  permissions: ["safety:report"],
  idempotent: true,
  input: z.object({
    kind: IncidentKind,
    occurredAt: z.string().datetime({ offset: true }),
    location: z.string().max(300).optional(),
    propertyId: Uuid.optional(),
    jobId: Uuid.optional(),
    description: z.string().min(1).max(10000),
    immediateAction: z.string().max(5000).optional(),
    people: z.array(z.object({
      technicianId: Uuid.optional(),
      name: z.string().max(200).optional(),
      role: PersonRole,
      injury: z.string().max(2000).optional(),
    })).max(50).optional(),
    photos: z.array(Photo).max(10).optional(),
  }),
  output: z.object({ id: Uuid }),
});

export const listIncidents = defineRoute({
  method: "get",
  path: "/v1/safety/incidents",
  summary: "Incident reports, newest first",
  description: "The register for whoever holds `safety:read`; a reporter without it sees their own reports and only those.",
  module: "M23",
  permissions: ["safety:report"],
  input: z.object({
    status: z.enum(["open", "closed"]).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  output: z.object({
    incidents: z.array(z.object({
      id: Uuid,
      kind: IncidentKind,
      occurredAt: z.string(),
      location: z.string().nullable(),
      description: z.string(),
      status: z.enum(["open", "closed"]),
      people: z.array(z.object({ name: z.string(), role: PersonRole })),
    })),
  }),
});

export const getIncident = defineRoute({
  method: "get",
  path: "/v1/safety/incidents/{id}",
  summary: "One incident report, its people, photographs and follow ups",
  description: "Another person's report is the same not found as one that does not exist, for a reporter without `safety:read`.",
  module: "M23",
  permissions: ["safety:report"],
  input: z.object({ id: Uuid }),
  output: z.object({
    id: Uuid,
    kind: IncidentKind,
    occurredAt: z.string(),
    location: z.string().nullable(),
    propertyId: Uuid.nullable(),
    jobId: Uuid.nullable(),
    description: z.string(),
    immediateAction: z.string().nullable(),
    status: z.enum(["open", "closed"]),
    reportedByUserId: Uuid.nullable(),
    closedAt: z.string().nullable(),
    closingNote: z.string().nullable(),
    createdAt: z.string(),
    people: z.array(z.object({
      id: Uuid, technicianId: Uuid.nullable(), name: z.string(), role: PersonRole, injury: z.string().nullable(),
    })),
    followUps: z.array(z.object({
      id: Uuid, title: z.string(), status: z.string(), dueAt: z.string().nullable(), assigneeUserId: Uuid.nullable(),
    })),
    photos: z.array(Stored),
  }),
});

export const addIncidentFollowUp = defineRoute({
  method: "post",
  path: "/v1/safety/incidents/{id}/follow-ups",
  summary: "Add a follow up action, as a task",
  description:
    "A task in the office queue tied to the report, so it is tracked by the same queue as everything else. The report cannot be closed while one is open.",
  module: "M23",
  permissions: ["safety:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    title: z.string().min(1).max(300),
    assigneeUserId: Uuid.optional(),
    dueAt: z.string().datetime({ offset: true }).optional(),
  }),
  output: z.object({ taskId: Uuid }),
});

export const closeIncident = defineRoute({
  method: "post",
  path: "/v1/safety/incidents/{id}/close",
  summary: "Close an incident report, saying what was learned",
  description: "Refused while a follow up, including the review task raised with the report, is still open. Closing a closed report changes nothing.",
  module: "M23",
  permissions: ["safety:write"],
  idempotent: true,
  input: z.object({ id: Uuid, closingNote: z.string().min(1).max(5000) }),
  output: z.object({ closedAt: z.string() }),
});

export const addIncidentPhoto = defineRoute({
  method: "post",
  path: "/v1/safety/incidents/{id}/photos",
  summary: "Add a photograph to an incident report",
  description: "By the person who reported it, or by whoever follows it up. The same bytes twice are one photograph.",
  module: "M23",
  permissions: ["safety:report"],
  idempotent: true,
  input: Photo.extend({ id: Uuid }),
  output: z.object({ id: Uuid }),
});

export const safetyRoutes = {
  listSafetyMeetings, createSafetyMeeting, getSafetyMeeting, addSafetyMeetingAttendees,
  markSafetyMeetingSigned, closeSafetyMeeting, addSafetyMeetingPhoto, listMySafetyMeetings,
  signSafetyMeeting, reportIncident, listIncidents, getIncident, addIncidentFollowUp, closeIncident,
  addIncidentPhoto,
} as const;
