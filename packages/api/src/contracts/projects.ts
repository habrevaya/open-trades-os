import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid, MoneyString, RateString } from "./common";

/**
 * M12. WORK THAT IS LONGER THAN A VISIT.
 *
 * A job in this product is one visit's worth of work. A bathroom refit, a
 * system changeout and a commercial fit out run for weeks, have phases that
 * wait on each other, are billed in draws as the work progresses, and have a
 * budget somebody is watching the whole time.
 *
 * A PROJECT IS NOT A PARENT JOB. `job.parent_job_id` means "this job is
 * warranty rework on that one", and `services/reviews.ts` counts rows by it
 * and calls the result the callback rate. Phases modelled as child jobs would
 * make every project read as rework and would suppress the review ask on the
 * parent for the life of the project. The argument is written out in full,
 * both ways, in `packages/db/src/schema/projects.ts`.
 *
 * THE PERMISSIONS ARE SPLIT ALONG THE LINE THE PRESETS ALREADY DRAW. The
 * structure of a project is work, so it is `job:read` and `job:write`, which
 * a dispatcher holds. The billing schedule is money, so it is
 * `invoice:write`, which a dispatcher very deliberately does not. Budget
 * against actual needs both money permissions, the same pair
 * `getJobProfitability` requires, because it discloses revenue as well as
 * cost.
 */

const ProjectStatus = z.enum(["planning", "active", "on_hold", "completed", "cancelled"]);
const PhaseStatus = z.enum(["not_started", "in_progress", "blocked", "complete"]);

const ProjectSummary = z.object({
  id: Uuid,
  name: z.string(),
  status: ProjectStatus,
  customerId: Uuid,
  propertyId: Uuid,
  startsOn: z.string().date().nullable(),
  targetCompletionOn: z.string().date().nullable(),
  completedAt: z.string().datetime().nullable(),
  /** What the customer is paying. The budget is behind the money permissions. */
  contractValue: MoneyString.nullable(),
  phases: z.number().int(),
  jobs: z.number().int(),
});

export const listProjects = defineRoute({
  method: "get",
  path: "/v1/projects",
  summary: "Projects, with how much work and how many phases are on each",
  module: "M12",
  permissions: ["job:read"],
  input: z.object({ status: z.array(ProjectStatus).optional() }),
  output: z.object({ projects: z.array(ProjectSummary) }),
});

export const getProject = defineRoute({
  method: "get",
  path: "/v1/projects/{id}",
  summary: "One project, with its phases, its jobs and its billing schedule",
  description:
    "Carries the contract value and not the budget cost. What the customer is paying is a price, which job:read already sees on every job; what we expect it to cost is margin, and job.cost:read is the permission that exists to keep that off a technician's phone.",
  module: "M12",
  permissions: ["job:read"],
  input: z.object({ id: Uuid }),
  output: ProjectSummary.extend({
    description: z.string().nullable(),
    businessUnitId: Uuid.nullable(),
    phaseList: z.array(z.object({
      id: Uuid,
      sequence: z.number().int(),
      name: z.string(),
      description: z.string().nullable(),
      status: PhaseStatus,
      dependsOnPhaseId: Uuid.nullable(),
      billingValue: MoneyString.nullable(),
      startsOn: z.string().date().nullable(),
      endsOn: z.string().date().nullable(),
      completedAt: z.string().datetime().nullable(),
      jobIds: z.array(Uuid),
    })),
    draws: z.array(z.object({
      id: Uuid,
      sequence: z.number().int(),
      label: z.string(),
      projectPhaseId: Uuid.nullable(),
      percent: RateString.nullable(),
      amount: MoneyString,
      /** Null means planned and not yet billed. */
      invoiceId: Uuid.nullable(),
      raisedAt: z.string().datetime().nullable(),
    })),
    /** Null, never zero, when no contract value has been agreed. */
    unscheduledValue: MoneyString.nullable(),
  }),
});

export const createProject = defineRoute({
  method: "post",
  path: "/v1/projects",
  summary: "Start a project",
  module: "M12",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    customerId: Uuid,
    propertyId: Uuid,
    name: z.string().min(1).max(200),
    description: z.string().max(5000).nullable().optional(),
    businessUnitId: Uuid.nullable().optional(),
    startsOn: z.string().date().nullable().optional(),
    targetCompletionOn: z.string().date().nullable().optional(),
    contractValue: MoneyString.nullable().optional(),
    budgetCost: MoneyString.nullable().optional(),
  }),
  output: z.object({ id: Uuid, name: z.string(), status: ProjectStatus }),
});

export const updateProject = defineRoute({
  method: "patch",
  path: "/v1/projects/{id}",
  summary: "Change a project, or close it",
  description:
    "The contract value cannot be cut below what has already been billed, because those draws are invoices the customer is holding, nor below what the phases add up to. A project cannot be marked complete while a phase is still open: complete is read by whoever decides to stop paying attention.",
  module: "M12",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    description: z.string().max(5000).nullable().optional(),
    status: ProjectStatus.optional(),
    startsOn: z.string().date().nullable().optional(),
    targetCompletionOn: z.string().date().nullable().optional(),
    contractValue: MoneyString.nullable().optional(),
    budgetCost: MoneyString.nullable().optional(),
  }),
  output: z.object({ id: Uuid, name: z.string(), status: ProjectStatus }),
});

export const addProjectPhase = defineRoute({
  method: "post",
  path: "/v1/projects/{projectId}/phases",
  summary: "Add a phase to a project",
  description:
    "The phases cannot add up to more than the contract value: a schedule of values that totals more than the contract is what an application for payment gets rejected over, and the moment the phase is added is the cheap moment to find out.",
  module: "M12",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    projectId: Uuid,
    name: z.string().min(1).max(200),
    description: z.string().max(5000).nullable().optional(),
    /** Defaults to one past the last phase. */
    sequence: z.number().int().min(1).max(999).optional(),
    dependsOnPhaseId: Uuid.nullable().optional(),
    billingValue: MoneyString.nullable().optional(),
    budgetCost: MoneyString.nullable().optional(),
    startsOn: z.string().date().nullable().optional(),
    endsOn: z.string().date().nullable().optional(),
  }),
  output: z.object({
    id: Uuid, sequence: z.number().int(), name: z.string(), status: PhaseStatus,
  }),
});

export const setProjectPhaseDependency = defineRoute({
  method: "post",
  path: "/v1/project-phases/{id}/dependency",
  summary: "Say which phase this one waits for",
  description:
    "One predecessor, in the same project, and never a ring. The cycle check walks the whole chain rather than looking one step back, because A waits for B and B waits for C is a project where pointing C at A blocks everything and nothing says why.",
  module: "M12",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, dependsOnPhaseId: Uuid.nullable() }),
  output: z.object({ id: Uuid, dependsOnPhaseId: Uuid.nullable() }),
});

export const setProjectPhaseStatus = defineRoute({
  method: "post",
  path: "/v1/project-phases/{id}/status",
  summary: "Move a phase along",
  description:
    "Refuses to start or complete a phase whose predecessor is not complete. Closing the walls before the rough in has passed inspection is the most expensive mistake on a multi phase job, and the moment somebody marks the phase started is the only moment anybody can be told.",
  module: "M12",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid, status: PhaseStatus }),
  output: z.object({
    id: Uuid, status: PhaseStatus, completedAt: z.string().datetime().nullable(),
  }),
});

export const materialiseProject = defineRoute({
  method: "post",
  path: "/v1/projects/{id}/materialise",
  summary: "Create the job for every phase that has none",
  description:
    "Safe to run twice. A phase that already has work is counted and skipped rather than duplicated, which is the same rule the recurring schedule and the service route materialisers follow. The jobs are created as leads rather than as scheduled, because a phase has a plan and not a date until a dispatcher gives it one.",
  module: "M12",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({
    projectId: Uuid,
    created: z.array(z.object({ jobId: Uuid, phaseId: Uuid, name: z.string() })),
    alreadyThere: z.number().int(),
  }),
});

export const attachJobToProject = defineRoute({
  method: "post",
  path: "/v1/projects/{projectId}/jobs",
  summary: "Put work that already exists into a project",
  description:
    "A project usually starts as one job somebody booked and gets its phases drawn around it afterwards. A job already in another project is refused: a job counted in two projects produces an overrun in the one that is wrong.",
  module: "M12",
  permissions: ["job:write"],
  idempotent: true,
  input: z.object({
    projectId: Uuid,
    jobId: Uuid,
    phaseId: Uuid.nullable().optional(),
  }),
  output: z.object({
    id: Uuid, projectId: Uuid, projectPhaseId: Uuid.nullable(), jobId: Uuid,
  }),
});

export const planProjectDraw = defineRoute({
  method: "post",
  path: "/v1/projects/{projectId}/draws",
  summary: "Plan a stage of the billing",
  description:
    "A percentage of a phase or a flat amount, and exactly one of the two. The amount is computed here and frozen on the row, so a phase whose billing value is revised in month four does not change the amount of a draw raised in month two. The schedule cannot exceed the phase it is against or the contract it is part of.",
  module: "M12",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({
    projectId: Uuid,
    /** Null for a draw against the project itself: mobilisation, retention. */
    phaseId: Uuid.nullable().optional(),
    label: z.string().min(1).max(200),
    /** "0.3" for thirty per cent. */
    percent: RateString.nullable().optional(),
    amount: MoneyString.nullable().optional(),
    sequence: z.number().int().min(1).max(999).optional(),
  }),
  output: z.object({
    id: Uuid, sequence: z.number().int(), label: z.string(),
    amount: MoneyString, percent: RateString.nullable(),
  }),
});

export const raiseProjectDraw = defineRoute({
  method: "post",
  path: "/v1/project-draws/{id}/raise",
  summary: "Turn a planned draw into an invoice",
  description:
    "Idempotent by construction. The invoice is created through the billing service under an idempotency key derived from the draw, so a retry returns the invoice that already exists rather than sending the customer a second application for payment. A draw against a phase nobody has started is refused: money taken before any work is a deposit, and a deposit belongs to the project rather than to a phase.",
  module: "M12",
  permissions: ["invoice:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: z.object({
    drawId: Uuid,
    invoiceId: Uuid,
    amount: MoneyString,
    /** False when the invoice already existed, which is what a retry gets. */
    created: z.boolean(),
  }),
});

export const getProjectProfitability = defineRoute({
  method: "get",
  path: "/v1/projects/{id}/profitability",
  summary: "Budget against actual",
  description:
    "Summed over the project's jobs through the same SQL fragments the per job statement and every profitability report are built from, so a project margin and the sum of its jobs' margins cannot disagree. Refused rather than narrowed for a caller scoped to some of the company's jobs: a project total over a subset of its jobs is not a smaller answer, it is a wrong one that reads as an under run.",
  module: "M12",
  permissions: ["job.cost:read", "report.financial:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    projectId: Uuid,
    name: z.string(),
    jobsCounted: z.number().int(),
    contractValue: MoneyString.nullable(),
    budgetCost: MoneyString.nullable(),
    revenue: MoneyString,
    materialCost: MoneyString,
    labourCost: MoneyString,
    processingFees: MoneyString,
    grossMargin: MoneyString,
    /** Positive is under budget. Null, never zero, when nothing was budgeted. */
    costVariance: MoneyString.nullable(),
    billedToDate: MoneyString,
    leftToBill: MoneyString.nullable(),
    scheduledHours: z.string(),
    actualHours: z.string(),
    /** Why these numbers are not finished being wrong. Empty when they are. */
    provisional: z.array(z.string()),
    caveats: z.record(z.string()),
  }),
});

export const projectRoutes = {
  listProjects, getProject, createProject, updateProject,
  addProjectPhase, setProjectPhaseDependency, setProjectPhaseStatus,
  materialiseProject, attachJobToProject,
  planProjectDraw, raiseProjectDraw, getProjectProfitability,
} as const;
