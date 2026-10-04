import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * PROPOSAL TEMPLATES
 *
 * The company's own proposal layout, saved by name: a cover with a
 * photograph, and sections (about us, the options, the warranty, financing,
 * reviews, the terms, sections of its own) in the order it sells in. One can
 * be the default and one can belong to each job type; a new estimate starts
 * with its job type's, or the default. Applying one to an estimate copies it,
 * like the terms, and only onto a draft, because sending froze the document.
 *
 * The layout is a closed vocabulary checked by core before it is stored, so
 * a section the page or the PDF cannot draw is refused at the save, every
 * problem at once.
 */

const SectionKind = z.enum(["options", "about", "warranty", "financing", "reviews", "terms", "custom"]);

export const ProposalSection = z.object({
  kind: SectionKind,
  title: z.string().max(80).optional(),
  /** The words under it. The options and the terms draw the estimate's own and ignore this. */
  body: z.string().max(4000).nullable().optional(),
  /** On a reviews section: the lowest rating shown, 1 to 5, and how many, 1 to 6. */
  minRating: z.number().int().min(1).max(5).optional(),
  count: z.number().int().min(1).max(6).optional(),
});

export const ProposalLayout = z.object({
  cover: z.object({
    headline: z.string().max(120),
    intro: z.string().max(600).nullable().optional(),
    /** A key from `POST /v1/proposal-templates/{id}/cover`. */
    photoKey: z.string().max(300).nullable().optional(),
  }).nullable().optional(),
  sections: z.array(ProposalSection).min(1).max(12),
  showOptionPhotos: z.boolean().optional(),
});

const TemplateView = z.object({
  id: Uuid,
  name: z.string(),
  jobTypeId: Uuid.nullable(),
  isDefault: z.boolean(),
  layout: z.object({
    cover: z.object({ headline: z.string(), intro: z.string().nullable(), photoKey: z.string().nullable() }).nullable(),
    sections: z.array(z.object({
      kind: SectionKind, title: z.string(), body: z.string().nullable(),
      minRating: z.number().int().optional(), count: z.number().int().optional(),
    })),
    showOptionPhotos: z.boolean(),
  }),
  updatedAt: z.date(),
});

const SaveFields = {
  name: z.string().min(1).max(80),
  /** The job type whose new estimates start with this layout. One layout per job type. */
  jobTypeId: Uuid.nullable().optional(),
  /** The layout every other new estimate starts with. Setting it takes it off the previous default. */
  isDefault: z.boolean().optional(),
  layout: ProposalLayout,
};

export const listProposalTemplates = defineRoute({
  method: "get",
  path: "/v1/proposal-templates",
  summary: "The company's saved proposal layouts",
  module: "M07",
  permissions: ["estimate:read"],
  input: z.object({}),
  output: z.object({ templates: z.array(TemplateView) }),
});

export const getProposalTemplate = defineRoute({
  method: "get",
  path: "/v1/proposal-templates/{id}",
  summary: "One saved proposal layout",
  module: "M07",
  permissions: ["estimate:read"],
  input: z.object({ id: Uuid }),
  output: TemplateView,
});

export const createProposalTemplate = defineRoute({
  method: "post",
  path: "/v1/proposal-templates",
  summary: "Save a proposal layout",
  description:
    "Refused with every problem at once when a section is one the proposal cannot draw, appears twice, needs words and has none, or the options are missing, because without them there is nothing to approve.",
  module: "M07",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object(SaveFields),
  output: TemplateView,
});

export const updateProposalTemplate = defineRoute({
  method: "patch",
  path: "/v1/proposal-templates/{id}",
  summary: "Change a proposal layout",
  description: "Estimates it was already applied to keep the copy they have. New estimates and estimates it is applied to from now on read the change.",
  module: "M07",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid, ...SaveFields }),
  output: TemplateView,
});

export const deleteProposalTemplate = defineRoute({
  method: "delete",
  path: "/v1/proposal-templates/{id}",
  summary: "Retire a proposal layout",
  module: "M07",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const uploadProposalCover = defineRoute({
  method: "post",
  path: "/v1/proposal-templates/{id}/cover",
  summary: "Put a photograph on a layout's cover",
  description:
    "A JPEG or a PNG, base64, up to eight megabytes, decided from the bytes rather than from what the upload claims. The PDF prints a JPEG or a plain PNG; one with transparency is shown on the page and named in the file.",
  module: "M07",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid, fileName: z.string().min(1).max(200), bytes: z.string().min(1).max(12_000_000) }),
  output: TemplateView,
});

export const applyProposalTemplate = defineRoute({
  method: "post",
  path: "/v1/estimates/{id}/proposal-template",
  summary: "Lay out a draft estimate's proposal with a saved layout, or the plain one",
  description:
    "Copies the layout onto the estimate. `templateId` null puts it back to the fixed layout, the options then the terms. Refused once the estimate has been sent, because sending froze what the customer reads.",
  module: "M07",
  permissions: ["estimate:write"],
  idempotent: true,
  input: z.object({ id: Uuid, templateId: Uuid.nullable() }),
  output: z.object({ estimateId: Uuid, templateId: Uuid.nullable(), templateName: z.string().nullable() }),
});

export const addEstimateOptionPhoto = defineRoute({
  method: "post",
  path: "/v1/estimate-options/{id}/photos",
  summary: "Put a photograph on one option of a draft estimate",
  description: "Shown under the option on the proposal when its layout shows option photographs. The same bytes on the same option are one photograph.",
  module: "M07",
  permissions: ["estimate:write"],
  idempotent: true,
  input: z.object({ id: Uuid, fileName: z.string().min(1).max(200), bytes: z.string().min(1).max(12_000_000) }),
  output: z.object({ id: Uuid, optionId: Uuid, estimateId: Uuid }),
});

export const removeEstimateOptionPhoto = defineRoute({
  method: "delete",
  path: "/v1/estimate-option-photos/{id}",
  summary: "Take a photograph off an option of a draft estimate",
  module: "M07",
  permissions: ["estimate:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({ id: Uuid, removed: z.literal(true) }),
});

export const proposalTemplateRoutes = {
  listProposalTemplates, getProposalTemplate, createProposalTemplate, updateProposalTemplate,
  deleteProposalTemplate, uploadProposalCover, applyProposalTemplate, addEstimateOptionPhoto,
  removeEstimateOptionPhoto,
} as const;
