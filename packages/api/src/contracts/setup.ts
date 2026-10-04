import { z } from "zod";
import { setup as rules } from "@opentradesos/core";
import { defineRoute } from "../lib/define";
import { Uuid, CompanyContact } from "./common";

/**
 * M02. A COMPANY SETTING ITSELF UP, WITHOUT ANYBODY POSTING JSON
 *
 * The wizard's progress, the company's own details, its trade pack and the
 * newer versions of it, which items are taxed, and the people who work
 * there. Everything the setup screens do goes through these, so a company
 * set up by a script and one set up by hand end up the same.
 */

const StepKey = z.enum(rules.SETUP_STEP_KEYS);

const Progress = z.object({
  total: z.number().int(),
  done: z.number().int(),
  essentialTotal: z.number().int(),
  essentialDone: z.number().int(),
  /** The first outstanding step the caller may do, in the wizard's order. */
  next: StepKey.nullable(),
  complete: z.boolean(),
});

export const getSetup = defineRoute({
  method: "get",
  path: "/v1/setup",
  summary: "How far the company's setup has got",
  description:
    "Every setup step, in the wizard's order: whether somebody has marked it done and when, whether the caller may do it, and what is already in place for it in words (\"Stripe connected\", \"43 items, 12 taxable\"). Done is something a person says, not something inferred, because most steps have no answer in the data; the facts sit beside it so the two can be compared.",
  module: "M02",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({
    companyName: z.string(),
    setupCompletedAt: z.string().datetime().nullable(),
    progress: Progress,
    steps: z.array(z.object({
      key: StepKey,
      title: z.string(),
      summary: z.string(),
      essential: z.boolean(),
      hasLeadTime: z.boolean(),
      permission: z.string(),
      done: z.boolean(),
      doneAt: z.string().datetime().nullable(),
      allowed: z.boolean(),
      facts: z.array(z.string()),
    })),
  }),
});

export const markSetupStep = defineRoute({
  method: "post",
  path: "/v1/setup/steps/{key}",
  summary: "Mark a setup step done, or not done",
  description:
    "Needs settings:read and the step's own permission as well (settings:write for the company, trade, service area and tax steps' settings, booking:configure for hours, user:invite for the team, pricebook:write for the price book and tax, integration:write for payments, phone and email, and accounting), because saying a step is done is a statement about that step. Marking done what is done keeps when it was first done.",
  module: "M02",
  permissions: ["settings:read"],
  /** Setting a state: the same request twice leaves the same state. */
  idempotent: true,
  input: z.object({ key: StepKey, done: z.boolean() }),
  output: z.object({ key: StepKey, done: z.boolean(), progress: Progress }),
});

export const finishSetup = defineRoute({
  method: "post",
  path: "/v1/setup/finish",
  summary: "Leave the wizard for the app",
  description:
    "Allowed with steps outstanding, because a wizard that will not let go is one people abandon. The steps stay on the list, which stays open afterwards. Finishing twice keeps the first time.",
  module: "M02",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({}),
  output: z.object({ setupCompletedAt: z.string().datetime() }),
});

const CompanyDetails = z.object({
  name: z.string(),
  legalName: z.string().nullable(),
  timezone: z.string(),
}).merge(CompanyContact);

export const getCompanyDetails = defineRoute({
  method: "get",
  path: "/v1/company",
  summary: "What the company is called, how customers reach it, and the zone its days run in",
  module: "M02",
  permissions: ["settings:read"],
  input: z.object({}),
  output: CompanyDetails,
});

export const updateCompanyDetails = defineRoute({
  method: "patch",
  path: "/v1/company",
  summary: "Rename the company, set its legal name, or set how customers reach it",
  description:
    "The name is what customers see on every invoice, text and portal page; the legal name is what goes on a document with legal weight and is often not the name on the van. The phone, email and postal address are printed on proposals, invoices, statements, their PDFs and the portal's header. A contact field left out keeps what it had and an empty string or null clears it; the phone is stored in E.164, and an address with a street and no town, or a town and no street, is refused. The time zone is changed on its own, from Settings, because of what changing it does.",
  module: "M02",
  permissions: ["settings:write"],
  input: z.object({
    name: z.string().min(1).max(120),
    legalName: z.string().max(200).nullable().optional(),
    phone: z.string().max(40).nullable().optional(),
    email: z.string().max(254).nullable().optional(),
    addressLine1: z.string().max(120).nullable().optional(),
    addressLine2: z.string().max(120).nullable().optional(),
    city: z.string().max(120).nullable().optional(),
    state: z.string().max(120).nullable().optional(),
    postalCode: z.string().max(20).nullable().optional(),
  }),
  output: CompanyDetails,
});

/* ------------------------------------------------------------------- tax */

const TaxClass = z.enum(["labor", "material", "equipment", "service", "exempt"]);

export const listItemTax = defineRoute({
  method: "get",
  path: "/v1/item-tax",
  summary: "Which items are taxed, and under which class",
  description: "Every live price book item, with its shelf, whether it is taxable and its tax class, as of now. No rates: a rate is set on the document it is charged on.",
  module: "M02",
  permissions: ["pricebook:read"],
  input: z.object({}),
  output: z.object({
    items: z.array(z.object({
      id: Uuid,
      code: z.string(),
      name: z.string(),
      category: z.string().nullable(),
      taxable: z.boolean(),
      taxClass: z.string().nullable(),
    })),
  }),
});

export const setItemTax = defineRoute({
  method: "post",
  path: "/v1/item-tax",
  summary: "Set whether items are taxed, many at once",
  description:
    "A new version of each item that changes, exactly as a price change is, so an invoice that charged tax on an item last month still says it did. Items already as asked are left alone. An exempt item cannot be taxable.",
  module: "M02",
  permissions: ["pricebook:write"],
  idempotent: true,
  dryRun: true,
  input: z.object({
    itemIds: z.array(Uuid).min(1).max(1000),
    taxable: z.boolean(),
    taxClass: TaxClass.nullable(),
  }),
  output: z.object({ changed: z.number().int() }),
});

/* ----------------------------------------------------------- trade packs */

export const listTradePacks = defineRoute({
  method: "get",
  path: "/v1/trade-packs",
  summary: "The trade packs this product ships, and the version the company is on",
  module: "M02",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({
    primaryTrade: z.string().nullable(),
    packs: z.array(z.object({
      id: z.string(),
      name: z.string(),
      summary: z.string(),
      version: z.number().int(),
      applied: z.number().int().nullable(),
      upgradable: z.boolean(),
      priceBookItems: z.number().int(),
      jobTypes: z.number().int(),
    })),
  }),
});

export const applyTradePack = defineRoute({
  method: "post",
  path: "/v1/trade-packs/{id}/apply",
  summary: "Apply a trade pack",
  description:
    "Seeds the pack's price book, job types, categories, service report template, inspection programmes, retention rules and portal layout, in one transaction. Additive: an item or job type whose code the company already has is skipped and counted, never overwritten, and the rest of the pack is seeded once, so applying a pack again changes nothing.",
  module: "M02",
  permissions: ["settings:write"],
  /** Applying a pack a second time skips everything the first one made. */
  idempotent: true,
  input: z.object({ id: z.string().max(60) }),
  output: z.object({
    packId: z.string(),
    version: z.number().int(),
    created: z.object({ priceBookItems: z.number().int(), jobTypes: z.number().int(), categories: z.number().int() }),
    skipped: z.object({ priceBookItems: z.number().int(), jobTypes: z.number().int() }),
  }),
});

const FieldChange = z.object({
  field: z.string(),
  /** Null for a cost the caller may not read. */
  from: z.union([z.string(), z.number(), z.boolean(), z.null()]),
  to: z.union([z.string(), z.number(), z.boolean(), z.null()]),
});

const SetupKind = z.enum(["service_report", "inspection_program", "retention_rule", "portal_layout"]);

/**
 * The rest of what a pack sets up, planned under the same rule as the price
 * book. `changed` names the parts that differ: `fields` (a template's
 * readings), `checkpoints`, `retainMonths`, `blocks` and so on.
 */
const SetupPlan = z.object({
  add: z.array(z.object({ kind: SetupKind, key: z.string(), name: z.string() })),
  update: z.array(z.object({ kind: SetupKind, key: z.string(), id: Uuid, name: z.string(), changed: z.array(z.string()) })),
  kept: z.array(z.object({
    kind: SetupKind, key: z.string(), id: Uuid.nullable(), name: z.string(),
    /** `edited` changed here, `yours` made here under the same name, `removed` taken out here, `purging` a shorter period on a rule allowed to purge. */
    reason: z.enum(["edited", "yours", "removed", "purging"]),
    changed: z.array(z.string()),
  })),
  unchanged: z.number().int(),
  dropped: z.array(z.object({ kind: SetupKind, key: z.string(), id: Uuid, name: z.string() })),
});

export const previewTradePackUpgrade = defineRoute({
  method: "get",
  path: "/v1/trade-packs/{id}/upgrade",
  summary: "What a newer version of a trade pack would change",
  description:
    "Nothing is written. Items the company does not have are added; items still exactly as the older version seeded them take the new values; items somebody here changed, or made under the same code, are kept and listed with what the new version would have changed; items the new version dropped are kept and listed. Job types the company is missing are added. The service report template, inspection programmes, retention rules and portal layout are planned the same way under `setup`: what is new is set up, what is still as the older version set it up is updated, and what the company changed, removed or made under the same name is kept, as is a retention rule allowed to purge whose period the new version shortens. Costs are shown only to a caller who may read them.",
  module: "M02",
  permissions: ["settings:read"],
  input: z.object({ id: z.string().max(60) }),
  output: z.object({
    packId: z.string(),
    fromVersion: z.number().int().nullable(),
    toVersion: z.number().int(),
    upToDate: z.boolean(),
    add: z.array(z.object({
      code: z.string(), name: z.string(), category: z.string(), price: z.string(), cost: z.string().nullable(),
    }).passthrough()),
    update: z.array(z.object({ itemId: Uuid, code: z.string(), name: z.string(), changes: z.array(FieldChange) })),
    kept: z.array(z.object({
      itemId: Uuid, code: z.string(), name: z.string(), reason: z.enum(["edited", "yours"]), changes: z.array(FieldChange),
    })),
    unchanged: z.number().int(),
    dropped: z.array(z.object({ itemId: Uuid, code: z.string(), name: z.string() })),
    jobTypes: z.object({ add: z.array(z.object({ code: z.string(), name: z.string() })), present: z.number().int() }),
    setup: SetupPlan,
  }),
});

export const upgradeTradePack = defineRoute({
  method: "post",
  path: "/v1/trade-packs/{id}/upgrade",
  summary: "Upgrade to the newer version of a trade pack",
  description:
    "Applies the plan the preview shows, worked out again inside the transaction so an item edited after the preview was looked at is kept rather than overwritten. An updated item gets a new version, as a price change by hand does, so documents that quoted the old one still say the old one, and so does an updated template's readings or programme's checkpoints, so a report captured under the old questions still says which it answered. Nothing the company changed, removed or made is touched, and nothing is deleted.",
  module: "M02",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: z.string().max(60) }),
  output: z.object({
    packId: z.string(),
    fromVersion: z.number().int().nullable(),
    toVersion: z.number().int(),
    added: z.number().int(),
    updated: z.number().int(),
    kept: z.number().int(),
    unchanged: z.number().int(),
    dropped: z.number().int(),
    jobTypesAdded: z.number().int(),
    setup: z.object({ added: z.number().int(), updated: z.number().int(), kept: z.number().int(), dropped: z.number().int() }),
  }),
});

/* ------------------------------------------------------------------ team */

const RoleKey = z.enum(["owner", "admin", "office_manager", "dispatcher", "csr", "technician", "crew_lead", "accountant", "readonly"]);

export const listTeam = defineRoute({
  method: "get",
  path: "/v1/team",
  summary: "Everybody in the company, with their role and branch",
  description: "Turned off people too, so they can be turned back on. `waiting` is somebody invited who has not chosen a password yet.",
  module: "M01",
  permissions: ["user:read"],
  input: z.object({}),
  output: z.object({
    people: z.array(z.object({
      membershipId: Uuid,
      userId: Uuid,
      name: z.string().nullable(),
      email: z.string(),
      role: RoleKey,
      roleLabel: z.string(),
      customRoleId: Uuid.nullable(),
      customRoleName: z.string().nullable(),
      businessUnitId: Uuid.nullable(),
      branchName: z.string().nullable(),
      technicianId: Uuid.nullable(),
      active: z.boolean(),
      waiting: z.boolean(),
      isYou: z.boolean(),
    })),
  }),
});

const Invitation = z.object({
  membershipId: Uuid,
  /** The one-time link to choose a password. Null when the deployment has no PUBLIC_URL. Shown once. */
  link: z.string().nullable(),
  reissued: z.boolean(),
});

export const inviteMember = defineRoute({
  method: "post",
  path: "/v1/invitations",
  summary: "Invite somebody to work here",
  description:
    "Creates the person with a preset role, in a branch if one is named, with a technician record when they go out to jobs (the default for technicians and crew leads), and returns a one-time link for them to choose a password, valid for seven days. The role must be one the inviter could define themselves. An address that already has an account with another company is refused, because adding an existing account would hand this company to whoever controls it. Inviting somebody who was invited and has not signed in returns a new link and retires the old one.",
  module: "M01",
  permissions: ["user:invite"],
  idempotent: true,
  input: z.object({
    email: z.string().email().max(254),
    name: z.string().min(1).max(120),
    role: RoleKey,
    businessUnitId: Uuid.nullable().optional(),
    goesOut: z.boolean().optional(),
  }),
  output: Invitation,
});

export const resendInvite = defineRoute({
  method: "post",
  path: "/v1/invitations/{membershipId}/resend",
  summary: "A new link for somebody who has not signed in yet",
  description: "The old link stops working. Refused for somebody who has chosen a password, who signs in as normal.",
  module: "M01",
  permissions: ["user:invite"],
  idempotent: true,
  input: z.object({ membershipId: Uuid }),
  output: Invitation,
});

export const setMemberRole = defineRoute({
  method: "post",
  path: "/v1/memberships/{membershipId}/role",
  summary: "Give somebody a different preset role",
  description:
    "Checked both ways: the caller must hold everything the new role carries and everything the old one did, so an administrator cannot demote an owner. Nobody changes their own role, and the last owner stays an owner. Choosing a preset takes away a custom role, which would otherwise go on replacing it; a custom role is given with the custom roles routes.",
  module: "M01",
  permissions: ["user:write"],
  idempotent: true,
  input: z.object({ membershipId: Uuid, role: RoleKey }),
  output: z.object({ membershipId: Uuid, role: RoleKey, customRoleId: Uuid.nullable() }),
});

export const setupRoutes = {
  getSetup, markSetupStep, finishSetup,
  getCompanyDetails, updateCompanyDetails,
  listItemTax, setItemTax,
  listTradePacks, applyTradePack, previewTradePackUpgrade, upgradeTradePack,
  listTeam, inviteMember, resendInvite, setMemberRole,
} as const;
