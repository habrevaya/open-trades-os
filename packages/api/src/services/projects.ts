import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { schema, type Database } from "@opentradesos/db";
import { assertCan } from "@opentradesos/core";
import {
  audit, guardedRead, guardedWrite, scopeOf, ConflictError, NotFoundError,
  type ServiceContext,
} from "./context";
import { JOB_COSTING_SQL, GROSS_MARGIN_SQL, SETTLEMENT_SQL } from "./report-catalogue";
import { CAVEATS } from "./profitability";
import * as billing from "./billing";
import { nextNumber } from "./jobs";

/**
 * M12. PROJECTS AND MULTI-PHASE WORK.
 *
 * A job in this product is one visit's worth of work. A bathroom refit, a
 * system changeout and a commercial fit out are not: they run for weeks, they
 * have phases that cannot start until another phase finishes, they are billed
 * in draws as the work progresses, and somebody is watching the spend against
 * a budget the whole time.
 *
 * WHY A PROJECT IS NOT A PARENT JOB is argued at length in
 * `schema/projects.ts`, both ways, with the decision and the two existing
 * features that would silently produce wrong numbers if it went the other
 * way. The short version: `job.parent_job_id` means "this job is warranty
 * rework on that one", `services/reviews.ts` counts rows by it and calls the
 * result the callback rate, and phases of a project modelled as children
 * would make every project read as rework and suppress the review ask on the
 * parent for the life of the job.
 *
 * WHAT THIS FILE DOES NOT DO, AND THE FOUR THINGS IT LEANS ON INSTEAD.
 *
 *   IT DOES NO MONEY ARITHMETIC. Budget against actual reads through
 *   `JOB_COSTING_SQL` and `GROSS_MARGIN_SQL` in `services/report-catalogue.ts`,
 *   which is the same object `services/profitability.ts` and every
 *   profitability report are built from. A project margin and a per job
 *   margin that disagree by six dollars is a meeting nobody recovers from,
 *   and the only way to be sure they agree is for there to be one copy.
 *
 *   IT CREATES NO INVOICES OF ITS OWN. A draw becomes an invoice through
 *   `services/billing.ts`, which knows about numbering, the price book, rate
 *   cards, tax and the ledger posting. See `raiseDraw` for how that is made
 *   idempotent across the transaction boundary billing insists on.
 *
 *   IT MATERIALISES WORK THE WAY THE OTHER TWO MATERIALISERS DO.
 *   `services/recurring.ts` and `services/routes.ts` both turn a definition
 *   into jobs and both are idempotent by reading what already exists for a
 *   stable identity and skipping it, reporting a count rather than failing.
 *   `materialise` below is the third and follows the same rule rather than
 *   inventing one: see its comment for the one place the identity differs and
 *   why.
 *
 *   IT INVENTS NO PERMISSIONS. There is no `project:*` in
 *   `packages/core/src/access/permissions.ts` and a string that is not in the
 *   catalogue cannot be granted to anybody, which is the argument
 *   `services/crews.ts` makes. Reads use `job:read` and structural writes use
 *   `job:write`, because a project is a container for work. The BILLING
 *   SCHEDULE uses `invoice:write`, because planning and raising a draw is
 *   deciding what a customer is charged and when, and the `dispatcher` preset
 *   that holds `job:write` very deliberately holds nothing that touches
 *   money.
 */

/* ------------------------------------------------------------- the project */

export interface ProjectInput {
  customerId: string;
  propertyId: string;
  name: string;
  description?: string | null | undefined;
  businessUnitId?: string | null | undefined;
  startsOn?: string | null | undefined;
  targetCompletionOn?: string | null | undefined;
  contractValue?: string | null | undefined;
  budgetCost?: string | null | undefined;
}

export async function create(ctx: ServiceContext, input: ProjectInput) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const name = input.name.trim();
    if (name === "") throw new ConflictError("A project needs a name.");

    const [customer] = await tx.select({ id: schema.customer.id }).from(schema.customer)
      .where(eq(schema.customer.id, input.customerId)).limit(1);
    if (!customer) throw new NotFoundError("Customer");
    const [property] = await tx.select({ id: schema.property.id }).from(schema.property)
      .where(eq(schema.property.id, input.propertyId)).limit(1);
    if (!property) throw new NotFoundError("Property");

    if (input.startsOn && input.targetCompletionOn
      && input.targetCompletionOn < input.startsOn) {
      throw new ConflictError("That project is due to finish before it starts.");
    }

    const [row] = await tx.insert(schema.project).values({
      organizationId: ctx.actor.organizationId,
      customerId: input.customerId,
      propertyId: input.propertyId,
      businessUnitId: input.businessUnitId ?? null,
      name,
      description: input.description ?? null,
      startsOn: input.startsOn ?? null,
      targetCompletionOn: input.targetCompletionOn ?? null,
      contractValue: input.contractValue ?? null,
      budgetCost: input.budgetCost ?? null,
      status: "planning",
    }).returning();

    await audit(tx, ctx, "project.created", "project", row!.id, null, row!);
    return row!;
  });
}

export interface ProjectUpdate {
  id: string;
  name?: string | undefined;
  description?: string | null | undefined;
  status?: typeof schema.projectStatus.enumValues[number] | undefined;
  startsOn?: string | null | undefined;
  targetCompletionOn?: string | null | undefined;
  contractValue?: string | null | undefined;
  budgetCost?: string | null | undefined;
}

/**
 * Change the project, and refuse the two changes that break something behind
 * it.
 *
 * A CONTRACT VALUE CANNOT BE CUT BELOW WHAT HAS BEEN BILLED. The draws that
 * have been raised are invoices the customer has, and lowering the contract
 * under them would leave a project that has billed more than it is worth,
 * which every number downstream reads as an overbill.
 *
 * NOR BELOW WHAT THE PHASES ADD UP TO, for the same reason `addPhase` refuses
 * the phase that would break it: a schedule of values that totals more than
 * the contract is the thing a customer rejects the application for payment
 * over.
 *
 * A PROJECT IS NOT COMPLETE WHILE A PHASE IS NOT. "Completed" on a project is
 * read by whoever is deciding to invoice the retention and to stop paying
 * attention, and a project marked complete with a phase still open is the
 * version of that where somebody stops looking.
 */
export async function update(ctx: ServiceContext, input: ProjectUpdate) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const before = await loadProject(tx, ctx.actor.organizationId, input.id);

    if (input.contractValue !== undefined && input.contractValue !== null) {
      const next = Number(input.contractValue);
      const { planned, raised } = await drawTotals(tx, before.id);
      if (next < raised) {
        throw new ConflictError(
          `This project has already billed ${raised.toFixed(2)}, so the contract cannot be set `
          + `to ${next.toFixed(2)}. Those draws are invoices the customer is holding.`,
        );
      }
      const phases = await phaseTotal(tx, before.id);
      if (next < phases) {
        throw new ConflictError(
          `The phases on this project add up to ${phases.toFixed(2)}, so the contract cannot be `
          + `set to ${next.toFixed(2)}. A schedule of values that totals more than the contract `
          + "is what an application for payment gets rejected over.",
        );
      }
      if (next < planned) {
        throw new ConflictError(
          `The billing schedule on this project adds up to ${planned.toFixed(2)}, so the contract `
          + `cannot be set to ${next.toFixed(2)}.`,
        );
      }
    }

    if (input.status === "completed") {
      const open = await tx.select({ id: schema.projectPhase.id })
        .from(schema.projectPhase)
        .where(and(
          eq(schema.projectPhase.projectId, before.id),
          inArray(schema.projectPhase.status, ["not_started", "in_progress", "blocked"]),
        ));
      if (open.length > 0) {
        throw new ConflictError(
          `${open.length} ${open.length === 1 ? "phase is" : "phases are"} still open on this `
          + "project, so it is not complete. Marking it complete is how somebody stops looking "
          + "at work that is still running.",
        );
      }
    }

    const [row] = await tx.update(schema.project).set({
      ...(input.name !== undefined ? { name: input.name.trim() } : {}),
      ...(input.description !== undefined ? { description: input.description } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.startsOn !== undefined ? { startsOn: input.startsOn } : {}),
      ...(input.targetCompletionOn !== undefined
        ? { targetCompletionOn: input.targetCompletionOn } : {}),
      ...(input.contractValue !== undefined ? { contractValue: input.contractValue } : {}),
      ...(input.budgetCost !== undefined ? { budgetCost: input.budgetCost } : {}),
      /**
       * Stamped when it is marked complete and never cleared by a later edit
       * that is not about status, which is why this is not an unconditional
       * assignment.
       */
      ...(input.status === "completed" ? { completedAt: new Date() } : {}),
      updatedAt: new Date(),
    }).where(eq(schema.project.id, before.id)).returning();

    await audit(tx, ctx, "project.updated", "project", before.id, before, row!);
    return row!;
  });
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  customerId: string;
  propertyId: string;
  startsOn: string | null;
  targetCompletionOn: string | null;
  completedAt: Date | null;
  contractValue: string | null;
  phases: number;
  jobs: number;
}

export async function list(
  ctx: ServiceContext,
  input: { status?: typeof schema.projectStatus.enumValues[number][] | undefined } = {},
): Promise<ProjectSummary[]> {
  return guardedRead(ctx, "job:read", async (tx) => {
    const rows = await tx.select().from(schema.project)
      .where(and(
        eq(schema.project.organizationId, ctx.actor.organizationId),
        input.status && input.status.length > 0
          ? inArray(schema.project.status, input.status) : undefined,
      ))
      .orderBy(asc(schema.project.name));

    if (rows.length === 0) return [];
    const ids = rows.map((r) => r.id);

    const phases = await tx.select({ projectId: schema.projectPhase.projectId })
      .from(schema.projectPhase)
      .where(inArray(schema.projectPhase.projectId, ids));
    const jobs = await tx.select({ projectId: schema.projectJob.projectId })
      .from(schema.projectJob)
      .where(inArray(schema.projectJob.projectId, ids));

    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      status: row.status,
      customerId: row.customerId,
      propertyId: row.propertyId,
      startsOn: row.startsOn,
      targetCompletionOn: row.targetCompletionOn,
      completedAt: row.completedAt,
      /**
       * The contract value and NOT the budget cost. What the customer is
       * paying is a price, which `job:read` already sees on every job; what
       * we expect it to cost is margin, and `job.cost:read` is the permission
       * that exists to keep that off a technician's phone. The budget lives
       * on `profitability` below, behind both money permissions.
       */
      contractValue: row.contractValue,
      phases: phases.filter((p) => p.projectId === row.id).length,
      jobs: jobs.filter((j) => j.projectId === row.id).length,
    }));
  });
}

export interface ProjectDetail extends ProjectSummary {
  description: string | null;
  businessUnitId: string | null;
  phaseList: {
    id: string; sequence: number; name: string; description: string | null;
    status: string; dependsOnPhaseId: string | null;
    billingValue: string | null; startsOn: string | null; endsOn: string | null;
    completedAt: Date | null;
    jobIds: string[];
  }[];
  draws: {
    id: string; sequence: number; label: string; projectPhaseId: string | null;
    percent: string | null; amount: string; invoiceId: string | null; raisedAt: Date | null;
  }[];
  /** What is left on the contract after everything planned and raised. */
  unscheduledValue: string | null;
}

export async function get(ctx: ServiceContext, input: { id: string }): Promise<ProjectDetail> {
  return guardedRead(ctx, "job:read", async (tx) => {
    const row = await loadProject(tx, ctx.actor.organizationId, input.id);

    const phases = await tx.select().from(schema.projectPhase)
      .where(eq(schema.projectPhase.projectId, row.id))
      .orderBy(asc(schema.projectPhase.sequence));

    const links = await tx.select().from(schema.projectJob)
      .where(eq(schema.projectJob.projectId, row.id));

    const draws = await tx.select().from(schema.projectDraw)
      .where(eq(schema.projectDraw.projectId, row.id))
      .orderBy(asc(schema.projectDraw.sequence));

    const scheduled = draws.reduce((sum, d) => sum + Number(d.amount), 0);

    return {
      id: row.id,
      name: row.name,
      status: row.status,
      customerId: row.customerId,
      propertyId: row.propertyId,
      description: row.description,
      businessUnitId: row.businessUnitId,
      startsOn: row.startsOn,
      targetCompletionOn: row.targetCompletionOn,
      completedAt: row.completedAt,
      contractValue: row.contractValue,
      phases: phases.length,
      jobs: links.length,
      phaseList: phases.map((phase) => ({
        id: phase.id,
        sequence: phase.sequence,
        name: phase.name,
        description: phase.description,
        status: phase.status,
        dependsOnPhaseId: phase.dependsOnPhaseId,
        billingValue: phase.billingValue,
        startsOn: phase.startsOn,
        endsOn: phase.endsOn,
        completedAt: phase.completedAt,
        jobIds: links.filter((l) => l.projectPhaseId === phase.id).map((l) => l.jobId),
      })),
      draws: draws.map((draw) => ({
        id: draw.id,
        sequence: draw.sequence,
        label: draw.label,
        projectPhaseId: draw.projectPhaseId,
        percent: draw.percent,
        amount: draw.amount,
        invoiceId: draw.invoiceId,
        raisedAt: draw.raisedAt,
      })),
      /**
       * Null rather than a number when there is no contract value, because
       * "nothing left to schedule" and "nobody has agreed a price" are
       * opposite facts and zero says the first.
       */
      unscheduledValue: row.contractValue === null
        ? null
        : (Number(row.contractValue) - scheduled).toFixed(2),
    };
  });
}

/* -------------------------------------------------------------- the phases */

export interface PhaseInput {
  projectId: string;
  name: string;
  description?: string | null | undefined;
  sequence?: number | undefined;
  dependsOnPhaseId?: string | null | undefined;
  billingValue?: string | null | undefined;
  budgetCost?: string | null | undefined;
  startsOn?: string | null | undefined;
  endsOn?: string | null | undefined;
}

/**
 * Add a phase.
 *
 * THE SCHEDULE OF VALUES CANNOT EXCEED THE CONTRACT. A fit out billed in
 * stages is applied for against a schedule of values, and a schedule that
 * adds up to more than the contract is rejected by whoever is certifying it.
 * Refusing the phase that breaks it is the only moment anybody is in a
 * position to fix it cheaply.
 *
 * A PHASE WAITS FOR AT MOST ONE OTHER PHASE, in the same project, and never
 * for itself or for anything downstream of itself. The cycle check walks the
 * chain rather than looking one step back: A waits for B, B waits for C, and
 * making C wait for A is a project where nothing can ever start and nothing
 * says so.
 */
export async function addPhase(ctx: ServiceContext, input: PhaseInput) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const project = await loadProject(tx, ctx.actor.organizationId, input.projectId);
    const name = input.name.trim();
    if (name === "") throw new ConflictError("A phase needs a name.");

    if (input.billingValue !== undefined && input.billingValue !== null
      && project.contractValue !== null) {
      const total = await phaseTotal(tx, project.id) + Number(input.billingValue);
      if (total > Number(project.contractValue)) {
        throw new ConflictError(
          `The phases on this project would add up to ${total.toFixed(2)} against a contract of `
          + `${Number(project.contractValue).toFixed(2)}. A schedule of values that totals more `
          + "than the contract is what an application for payment gets rejected over.",
        );
      }
    }

    if (input.dependsOnPhaseId) {
      const [predecessor] = await tx.select({ id: schema.projectPhase.id })
        .from(schema.projectPhase)
        .where(and(
          eq(schema.projectPhase.id, input.dependsOnPhaseId),
          eq(schema.projectPhase.projectId, project.id),
        )).limit(1);
      if (!predecessor) {
        throw new ConflictError(
          "A phase can only wait for another phase of the same project.",
        );
      }
    }

    const sequence = input.sequence ?? await nextSequence(tx, project.id);
    const [clash] = await tx.select({ id: schema.projectPhase.id })
      .from(schema.projectPhase)
      .where(and(
        eq(schema.projectPhase.projectId, project.id),
        eq(schema.projectPhase.sequence, sequence),
      )).limit(1);
    if (clash) {
      throw new ConflictError(
        `This project already has a phase ${sequence}. Two phases in one position means the `
        + "order of the work depends on which row came back first.",
      );
    }

    const [row] = await tx.insert(schema.projectPhase).values({
      organizationId: ctx.actor.organizationId,
      projectId: project.id,
      sequence,
      name,
      description: input.description ?? null,
      dependsOnPhaseId: input.dependsOnPhaseId ?? null,
      billingValue: input.billingValue ?? null,
      budgetCost: input.budgetCost ?? null,
      startsOn: input.startsOn ?? null,
      endsOn: input.endsOn ?? null,
      status: "not_started",
    }).returning();

    await audit(tx, ctx, "project_phase.added", "project_phase", row!.id, null, row!);
    return row!;
  });
}

/**
 * Point a phase at the one it waits for, after both exist.
 *
 * Separate from `addPhase` because a chain is usually laid out forwards: the
 * phases are entered first and then somebody says which waits for which, and
 * a dependency that can only be set at creation time would mean entering them
 * backwards.
 */
export async function setPhaseDependency(
  ctx: ServiceContext, input: { id: string; dependsOnPhaseId: string | null },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const before = await loadPhase(tx, ctx.actor.organizationId, input.id);

    if (input.dependsOnPhaseId !== null) {
      if (input.dependsOnPhaseId === before.id) {
        throw new ConflictError("A phase cannot wait for itself.");
      }
      const [predecessor] = await tx.select({
        id: schema.projectPhase.id,
      }).from(schema.projectPhase)
        .where(and(
          eq(schema.projectPhase.id, input.dependsOnPhaseId),
          eq(schema.projectPhase.projectId, before.projectId),
        )).limit(1);
      if (!predecessor) {
        throw new ConflictError("A phase can only wait for another phase of the same project.");
      }
      await assertNoCycle(tx, before.projectId, before.id, input.dependsOnPhaseId);
    }

    const [row] = await tx.update(schema.projectPhase).set({
      dependsOnPhaseId: input.dependsOnPhaseId,
      updatedAt: new Date(),
    }).where(eq(schema.projectPhase.id, before.id)).returning();

    await audit(tx, ctx, "project_phase.dependency_set", "project_phase", before.id, before, row!);
    return row!;
  });
}

/**
 * Walking the chain, not looking one step back.
 *
 * A waits for B and B waits for C. Pointing C at A makes a ring in which
 * every phase is blocked by another phase that is blocked by it, and nothing
 * in the product would ever say why nothing can start. One step of checking
 * catches the two phase version and nothing else.
 */
async function assertNoCycle(
  tx: Database, projectId: string, phaseId: string, predecessorId: string,
): Promise<void> {
  const phases = await tx.select({
    id: schema.projectPhase.id,
    dependsOnPhaseId: schema.projectPhase.dependsOnPhaseId,
    name: schema.projectPhase.name,
  }).from(schema.projectPhase)
    .where(eq(schema.projectPhase.projectId, projectId));

  const by = new Map(phases.map((p) => [p.id, p]));
  const seen = new Set<string>([phaseId]);
  let at: string | null = predecessorId;
  while (at !== null) {
    if (seen.has(at)) {
      throw new ConflictError(
        "That would make a ring of phases, each waiting for one that is waiting for it. "
        + "Nothing in the chain could ever start and nothing would say why.",
      );
    }
    seen.add(at);
    at = by.get(at)?.dependsOnPhaseId ?? null;
  }
}

/**
 * Move a phase along, and refuse to start one whose predecessor is not done.
 *
 * THIS IS THE REFUSAL THE DEPENDENCY EXISTS FOR. Closing the walls before the
 * rough in has passed inspection is the single most expensive mistake on a
 * multi phase job, and the only moment anybody can be told is the moment
 * somebody marks the phase started.
 *
 * `blocked` is settable by hand and is also what the refusal describes. It is
 * a state about this project rather than about the plan: the inspector did
 * not come, the material did not arrive.
 */
export async function setPhaseStatus(
  ctx: ServiceContext,
  input: { id: string; status: typeof schema.projectPhaseStatus.enumValues[number] },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const before = await loadPhase(tx, ctx.actor.organizationId, input.id);

    if ((input.status === "in_progress" || input.status === "complete")
      && before.dependsOnPhaseId !== null) {
      const [predecessor] = await tx.select({
        id: schema.projectPhase.id,
        name: schema.projectPhase.name,
        sequence: schema.projectPhase.sequence,
        status: schema.projectPhase.status,
      }).from(schema.projectPhase)
        .where(eq(schema.projectPhase.id, before.dependsOnPhaseId)).limit(1);

      if (predecessor && predecessor.status !== "complete") {
        throw new ConflictError(
          `${before.name} waits for ${predecessor.name}, which is ${predecessor.status}. `
          + "Starting the next phase over work that is not signed off is the expensive version "
          + "of this mistake, and this is the only moment anybody can be told.",
        );
      }
    }

    const [row] = await tx.update(schema.projectPhase).set({
      status: input.status,
      /**
       * Stamped on completion and CLEARED when a phase is reopened, because a
       * completion date left behind on a phase that has gone back to
       * in_progress is a date that says the work finished and it did not.
       */
      completedAt: input.status === "complete" ? new Date() : null,
      updatedAt: new Date(),
    }).where(eq(schema.projectPhase.id, before.id)).returning();

    await audit(tx, ctx, "project_phase.status_set", "project_phase", before.id, before, row!);
    return row!;
  });
}

async function nextSequence(tx: Database, projectId: string): Promise<number> {
  const rows = await tx.select({ sequence: schema.projectPhase.sequence })
    .from(schema.projectPhase)
    .where(eq(schema.projectPhase.projectId, projectId));
  return rows.reduce((max, r) => Math.max(max, r.sequence), 0) + 1;
}

async function phaseTotal(tx: Database, projectId: string): Promise<number> {
  const rows = await tx.select({ billingValue: schema.projectPhase.billingValue })
    .from(schema.projectPhase)
    .where(eq(schema.projectPhase.projectId, projectId));
  return rows.reduce((sum, r) => sum + Number(r.billingValue ?? 0), 0);
}

/* ------------------------------------------------------- turning it into work */

export interface MaterialiseResult {
  projectId: string;
  created: { jobId: string; phaseId: string; name: string }[];
  /** Phases that already had work. Not an error: this is safe to run twice. */
  alreadyThere: number;
}

/**
 * Create the job for every phase that has none.
 *
 * THE THIRD MATERIALISER IN THIS CODEBASE, and it follows the rule the other
 * two set rather than inventing one. `services/recurring.ts` and
 * `services/routes.ts` both compute what should exist, read what does exist
 * against a stable identity, skip what is already there and report a count.
 * Both say the same thing about why: a worker or a human running it twice in
 * a minute must not put two technicians on one pool.
 *
 * WHERE THE IDENTITY DIFFERS, AND WHY. Those two key on the schedule and the
 * DATE, because a series has an occurrence per date and the second occurrence
 * is not a duplicate of the first. A phase is not a series: it is one thing,
 * it happens once, and the work for it is the work for it. So the identity is
 * the phase, and `project_job` carries a unique index on `job_id` that makes
 * a job in two phases impossible rather than merely unlikely, for the same
 * reason the job number's unique index exists beside its advisory lock.
 *
 * The provenance columns are written as well, with the phase id, so a job
 * created this way says where it came from in the same place every imported
 * and generated job in this product says it.
 */
export async function materialise(
  ctx: ServiceContext, input: { id: string },
): Promise<MaterialiseResult> {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const project = await loadProject(tx, ctx.actor.organizationId, input.id);
    if (project.status === "cancelled") {
      throw new ConflictError(
        "That project is cancelled, so nothing should be created from it.",
      );
    }

    const phases = await tx.select().from(schema.projectPhase)
      .where(eq(schema.projectPhase.projectId, project.id))
      .orderBy(asc(schema.projectPhase.sequence));

    const existing = await tx.select({ phaseId: schema.projectJob.projectPhaseId })
      .from(schema.projectJob)
      .where(eq(schema.projectJob.projectId, project.id));
    const done = new Set(existing.map((e) => e.phaseId).filter((id): id is string => id !== null));

    const created: { jobId: string; phaseId: string; name: string }[] = [];
    let alreadyThere = 0;

    for (const phase of phases) {
      if (done.has(phase.id)) { alreadyThere += 1; continue; }

      const number = await nextNumber(tx, ctx.actor.organizationId, "job");
      const [job] = await tx.insert(schema.job).values({
        organizationId: ctx.actor.organizationId,
        number,
        customerId: project.customerId,
        propertyId: project.propertyId,
        businessUnitId: project.businessUnitId,
        /**
         * `lead` rather than `scheduled`, which is what a job with no visit
         * on it is everywhere else in this product: `services/jobs.ts`
         * creates a job as scheduled only when a visit comes with it. A phase
         * has a plan and not a date until a dispatcher gives it one, and a
         * job showing as scheduled with nothing on the board is how work goes
         * missing.
         */
        status: "lead",
        summary: `${project.name}: ${phase.name}`,
        description: phase.description,
        sourceSystem: "project_phase",
        sourceId: phase.id,
      }).returning({ id: schema.job.id });

      await tx.insert(schema.projectJob).values({
        organizationId: ctx.actor.organizationId,
        projectId: project.id,
        projectPhaseId: phase.id,
        jobId: job!.id,
      });

      created.push({ jobId: job!.id, phaseId: phase.id, name: phase.name });
      done.add(phase.id);
    }

    if (created.length > 0) {
      await audit(tx, ctx, "project.materialised", "project", project.id, null, {
        created: created.length, alreadyThere,
      });
    }

    return { projectId: project.id, created, alreadyThere };
  });
}

/**
 * Put work that already exists into a project.
 *
 * The common real case, and the reason this is not only `materialise`: a
 * project usually starts as one job somebody booked, and the phases are drawn
 * around it afterwards. The unique index on `project_job.job_id` is what makes
 * this safe to call twice and what refuses a job that is already somewhere
 * else, which would otherwise be counted twice in the actual cost.
 */
export async function attachJob(
  ctx: ServiceContext,
  input: { projectId: string; jobId: string; phaseId?: string | null | undefined },
) {
  return guardedWrite(ctx, "job:write", async (tx) => {
    const project = await loadProject(tx, ctx.actor.organizationId, input.projectId);

    const [job] = await tx.select({ id: schema.job.id, number: schema.job.number })
      .from(schema.job)
      .where(and(eq(schema.job.id, input.jobId), isNull(schema.job.deletedAt))).limit(1);
    if (!job) throw new NotFoundError("Job");

    if (input.phaseId) {
      const [phase] = await tx.select({ id: schema.projectPhase.id })
        .from(schema.projectPhase)
        .where(and(
          eq(schema.projectPhase.id, input.phaseId),
          eq(schema.projectPhase.projectId, project.id),
        )).limit(1);
      if (!phase) throw new ConflictError("That phase is not part of this project.");
    }

    const [already] = await tx.select({
      id: schema.projectJob.id, projectId: schema.projectJob.projectId,
    }).from(schema.projectJob)
      .where(eq(schema.projectJob.jobId, job.id)).limit(1);
    if (already) {
      if (already.projectId !== project.id) {
        throw new ConflictError(
          `Job ${job.number} already belongs to another project. A job in two projects is `
          + "counted twice in both, and the overrun it produces is in the one that is wrong.",
        );
      }
      const [row] = await tx.update(schema.projectJob).set({
        projectPhaseId: input.phaseId ?? null,
        updatedAt: new Date(),
      }).where(eq(schema.projectJob.id, already.id)).returning();
      return row!;
    }

    const [row] = await tx.insert(schema.projectJob).values({
      organizationId: ctx.actor.organizationId,
      projectId: project.id,
      projectPhaseId: input.phaseId ?? null,
      jobId: job.id,
    }).returning();

    await audit(tx, ctx, "project.job_attached", "project", project.id, null, row!);
    return row!;
  });
}

/* ------------------------------------------------------- progress billing */

export interface DrawInput {
  projectId: string;
  phaseId?: string | null | undefined;
  label: string;
  /** "0.3" for thirty per cent. Exactly one of this and `amount`. */
  percent?: string | null | undefined;
  amount?: string | null | undefined;
  sequence?: number | undefined;
}

/**
 * Plan a draw.
 *
 * A PERCENTAGE OF SOMETHING THAT HAS A VALUE. A draw entered as a percentage
 * against a phase with no billing value, or against a project with no
 * contract value, has no number behind it, and the one thing a billing
 * schedule has to be is a list of amounts.
 *
 * THE AMOUNT IS COMPUTED AND FROZEN HERE rather than re-derived when the draw
 * is raised. A phase whose billing value is revised in month four would
 * otherwise change the amount of a draw that was raised in month two, which
 * by then is an invoice the customer has paid.
 *
 * THE SCHEDULE CANNOT EXCEED WHAT IT IS A SCHEDULE OF, per phase and across
 * the project. Both checks exist because they fail differently: a phase over
 * billed against a correct contract total is a certifier's rejection, and a
 * project over billed is a customer's.
 */
export async function planDraw(ctx: ServiceContext, input: DrawInput) {
  return guardedWrite(ctx, "invoice:write", async (tx) => {
    const project = await loadProject(tx, ctx.actor.organizationId, input.projectId);
    const label = input.label.trim();
    if (label === "") throw new ConflictError("A draw needs a label. It goes on the invoice.");

    const hasPercent = input.percent !== undefined && input.percent !== null;
    const hasAmount = input.amount !== undefined && input.amount !== null;
    if (hasPercent === hasAmount) {
      throw new ConflictError(
        "A draw is a percentage of a phase or a flat amount, and exactly one of the two. "
        + "Both means two numbers that can disagree, and neither means a line with no price.",
      );
    }

    let phaseValue: string | null = null;
    if (input.phaseId) {
      const [phase] = await tx.select({
        id: schema.projectPhase.id,
        name: schema.projectPhase.name,
        billingValue: schema.projectPhase.billingValue,
      }).from(schema.projectPhase)
        .where(and(
          eq(schema.projectPhase.id, input.phaseId),
          eq(schema.projectPhase.projectId, project.id),
        )).limit(1);
      if (!phase) throw new ConflictError("That phase is not part of this project.");
      phaseValue = phase.billingValue;
    }

    let amount: number;
    let percent: string | null = null;
    if (hasPercent) {
      const basis = input.phaseId ? phaseValue : project.contractValue;
      if (basis === null) {
        throw new ConflictError(
          input.phaseId
            ? "That phase carries no part of the contract, so a percentage of it is not a number."
            : "This project has no contract value, so a percentage of it is not a number.",
        );
      }
      const fraction = Number(input.percent);
      if (!(fraction > 0) || fraction > 1) {
        throw new ConflictError("A draw percentage is above zero and at most 1, where 1 is all of it.");
      }
      percent = input.percent!;
      amount = Number(basis) * fraction;
    } else {
      amount = Number(input.amount);
      if (!(amount > 0)) throw new ConflictError("A draw is for an amount above zero.");
    }

    if (input.phaseId && phaseValue !== null) {
      const already = await drawTotalForPhase(tx, input.phaseId);
      if (already + amount > Number(phaseValue) + 1e-9) {
        throw new ConflictError(
          `That would bill ${(already + amount).toFixed(2)} against a phase worth `
          + `${Number(phaseValue).toFixed(2)}. A phase cannot be billed for more than it carries.`,
        );
      }
    }
    if (project.contractValue !== null) {
      const { planned, raised } = await drawTotals(tx, project.id);
      if (planned + raised + amount > Number(project.contractValue) + 1e-9) {
        throw new ConflictError(
          `That would bill ${(planned + raised + amount).toFixed(2)} against a contract of `
          + `${Number(project.contractValue).toFixed(2)}.`,
        );
      }
    }

    const sequence = input.sequence ?? await nextDrawSequence(tx, project.id);
    const [clash] = await tx.select({ id: schema.projectDraw.id }).from(schema.projectDraw)
      .where(and(
        eq(schema.projectDraw.projectId, project.id),
        eq(schema.projectDraw.sequence, sequence),
      )).limit(1);
    if (clash) throw new ConflictError(`This project already has a draw ${sequence}.`);

    const [row] = await tx.insert(schema.projectDraw).values({
      organizationId: ctx.actor.organizationId,
      projectId: project.id,
      projectPhaseId: input.phaseId ?? null,
      sequence,
      label,
      percent,
      amount: amount.toFixed(4),
    }).returning();

    await audit(tx, ctx, "project_draw.planned", "project_draw", row!.id, null, row!);
    return row!;
  });
}

export interface RaiseResult {
  drawId: string;
  invoiceId: string;
  amount: string;
  /** False when the invoice already existed, which is what a retry gets. */
  created: boolean;
}

/**
 * Turn a planned draw into an invoice.
 *
 * IDEMPOTENT ACROSS A TRANSACTION BOUNDARY, which is the interesting part of
 * this function and the reason it is written in three steps rather than one.
 *
 * `services/billing.ts` says, on its own loader, that a service must never
 * call another service's public entry point from inside a transaction. So
 * this cannot open a transaction, call `billing.create` in it and write the
 * invoice id back. It does three things instead:
 *
 *   1. In its own transaction, check the draw can be raised, and return
 *      immediately if it already carries an invoice. That is the fast path
 *      for a retry that happened after everything succeeded.
 *
 *   2. Call `billing.create` with a DETERMINISTIC IDEMPOTENCY KEY derived
 *      from the draw id. Billing writes an `integration_event` against that
 *      key and returns the existing invoice when it sees it again, so a
 *      second call for one draw returns the first invoice rather than
 *      billing the customer twice.
 *
 *   3. In a second transaction, attach the invoice to the draw.
 *
 * A crash between 2 and 3 leaves an invoice with no draw pointing at it. The
 * next call recomputes the same key, gets the same invoice back, and attaches
 * it: the pair converges rather than diverging, which is the property that
 * matters, because the failure mode being avoided is a customer receiving the
 * same application for payment twice.
 *
 * A DRAW AGAINST A PHASE NOBODY HAS STARTED IS REFUSED. Progress billing
 * bills progress. Money taken before any work is a deposit, which this
 * product already models properly in `services/deposits.ts` and which belongs
 * to the project rather than to a phase, so it is planned with no phase on it
 * and raised without hitting this check.
 */
export async function raiseDraw(
  ctx: ServiceContext, input: { id: string },
): Promise<RaiseResult> {
  const prepared = await guardedWrite(ctx, "invoice:write", async (tx) => {
    const draw = await loadDraw(tx, ctx.actor.organizationId, input.id);
    const project = await loadProject(tx, ctx.actor.organizationId, draw.projectId);

    if (draw.invoiceId !== null) {
      return { draw, project, phaseName: null as string | null, done: true as const };
    }

    let phaseName: string | null = null;
    if (draw.projectPhaseId !== null) {
      const [phase] = await tx.select({
        name: schema.projectPhase.name, status: schema.projectPhase.status,
      }).from(schema.projectPhase)
        .where(eq(schema.projectPhase.id, draw.projectPhaseId)).limit(1);
      if (phase && phase.status === "not_started") {
        throw new ConflictError(
          `${phase.name} has not started, so there is no progress to bill. Money taken before `
          + "any work is a deposit rather than a draw, and a deposit belongs to the project.",
        );
      }
      phaseName = phase?.name ?? null;
    }

    return { draw, project, phaseName, done: false as const };
  });

  if (prepared.done) {
    return {
      drawId: prepared.draw.id,
      invoiceId: prepared.draw.invoiceId!,
      amount: prepared.draw.amount,
      created: false,
    };
  }

  const { draw, project, phaseName } = prepared;

  const invoice = await billing.create(
    /**
     * The key is the draw, so it is the same on every attempt for this draw
     * and different for every other draw. A key taken from the request header
     * would be whatever the caller sent, which on a retry from a browser that
     * lost its tab is a new one.
     */
    { ...ctx, idempotencyKey: `project-draw:${draw.id}` },
    {
      customerId: project.customerId,
      memo: `${project.name}${phaseName ? `, ${phaseName}` : ""}`,
      lines: [{
        name: draw.label,
        description: `${project.name}${phaseName ? `: ${phaseName}` : ""}`,
        quantity: "1",
        unitPrice: draw.amount,
        discountAmount: "0",
        taxable: true,
      }],
    },
  );

  const attached = await guardedWrite(ctx, "invoice:write", async (tx) => {
    const [row] = await tx.update(schema.projectDraw).set({
      invoiceId: invoice.id,
      raisedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(schema.projectDraw.id, draw.id)).returning();

    await audit(tx, ctx, "project_draw.raised", "project_draw", draw.id, draw, row!);
    return row!;
  });

  return {
    drawId: attached.id,
    invoiceId: invoice.id,
    amount: attached.amount,
    created: true,
  };
}

async function nextDrawSequence(tx: Database, projectId: string): Promise<number> {
  const rows = await tx.select({ sequence: schema.projectDraw.sequence })
    .from(schema.projectDraw)
    .where(eq(schema.projectDraw.projectId, projectId));
  return rows.reduce((max, r) => Math.max(max, r.sequence), 0) + 1;
}

async function drawTotals(
  tx: Database, projectId: string,
): Promise<{ planned: number; raised: number }> {
  const rows = await tx.select({
    amount: schema.projectDraw.amount, invoiceId: schema.projectDraw.invoiceId,
  }).from(schema.projectDraw)
    .where(eq(schema.projectDraw.projectId, projectId));
  let planned = 0;
  let raised = 0;
  for (const row of rows) {
    if (row.invoiceId === null) planned += Number(row.amount);
    else raised += Number(row.amount);
  }
  return { planned, raised };
}

async function drawTotalForPhase(tx: Database, phaseId: string): Promise<number> {
  const rows = await tx.select({ amount: schema.projectDraw.amount })
    .from(schema.projectDraw)
    .where(eq(schema.projectDraw.projectPhaseId, phaseId));
  return rows.reduce((sum, r) => sum + Number(r.amount), 0);
}

/* ---------------------------------------------------- budget against actual */

export interface ProjectProfitability {
  projectId: string;
  name: string;
  jobsCounted: number;
  contractValue: string | null;
  budgetCost: string | null;
  revenue: string;
  materialCost: string;
  labourCost: string;
  processingFees: string;
  grossMargin: string;
  /** Null, never zero, when there is nothing budgeted to be a variance against. */
  costVariance: string | null;
  billedToDate: string;
  /** What is planned and not yet billed. */
  leftToBill: string | null;
  scheduledHours: string;
  actualHours: string;
  /** Why these numbers are not finished being wrong. Empty when they are. */
  provisional: string[];
  /** Carried from `services/profitability.ts`, because the caveats are the same. */
  caveats: Record<string, string>;
}

/** A money column as a decimal string, never a float. The same helper profitability uses. */
const money = (expression: string, alias: string) =>
  sql.raw(`coalesce(sum(${expression}), 0)::numeric(14,4)::text as "${alias}"`);

const hours = (expression: string, alias: string) =>
  sql.raw(`round(coalesce(sum(${expression}), 0)::numeric, 2)::text as "${alias}"`);

/**
 * BUDGET AGAINST ACTUAL, THROUGH THE SAME FRAGMENTS EVERY OTHER MARGIN IN THE
 * PRODUCT IS BUILT FROM.
 *
 * `JOB_COSTING_SQL` and `GROSS_MARGIN_SQL` are correlated expressions over a
 * row of `job`, and they are what `services/profitability.ts` and the
 * `profitability` report dataset both use. Summing them over the jobs in a
 * project is the whole of this function, and that is deliberate: a project
 * margin that is computed independently and disagrees with the sum of its
 * jobs' margins by six dollars is a meeting nobody recovers from.
 *
 * GUARDED BY BOTH MONEY PERMISSIONS, the same pair as
 * `profitability.statement`, and the first is the one that is easy to leave
 * out. `job.cost:read` is the obvious guard; on its own it is not enough,
 * because this discloses revenue, and a surface handing out one project's
 * revenue to somebody who may not run the company's financial reports is the
 * financial report with a loop around it.
 *
 * REFUSED RATHER THAN NARROWED FOR A SCOPED CALLER. A technician granted the
 * money permissions on a custom role is scoped to their own jobs, and a
 * project roll up over the subset of its jobs that happen to be theirs is not
 * a smaller answer, it is a WRONG one: it reads as an under run. Every other
 * surface in this product narrows; this one refuses, because there is no
 * honest narrowed version of a total.
 */
export async function profitability(
  ctx: ServiceContext, input: { id: string },
): Promise<ProjectProfitability> {
  assertCan(ctx.actor, "report.financial:read");

  return guardedRead(ctx, "job.cost:read", async (tx) => {
    const scope = scopeOf(ctx, "job");
    if (scope !== "all") {
      throw new ConflictError(
        "Your access is limited to some of this company's jobs, and a project total over some "
        + "of its jobs is not a smaller answer, it is a wrong one. Nothing here can be shown "
        + "to you honestly.",
      );
    }

    const project = await loadProject(tx, ctx.actor.organizationId, input.id);

    const [totals] = await tx.execute<{
      jobs: string; revenue: string; material_cost: string; labour_cost: string;
      processing_fees: string; gross_margin: string;
      scheduled_hours: string; actual_hours: string;
      open_entries: string; uncosted_lines: string; unbilled_cost: string;
      in_progress: string;
    }>(sql`
      select
        count(*)::text as "jobs",
        ${money(JOB_COSTING_SQL.revenue, "revenue")},
        ${money(JOB_COSTING_SQL.materialCost, "material_cost")},
        ${money(JOB_COSTING_SQL.labourCost, "labour_cost")},
        ${money(JOB_COSTING_SQL.processingFees, "processing_fees")},
        ${money(GROSS_MARGIN_SQL, "gross_margin")},
        ${hours(JOB_COSTING_SQL.scheduledHours, "scheduled_hours")},
        ${hours(JOB_COSTING_SQL.actualHours, "actual_hours")},
        ${sql.raw(`coalesce(sum(${JOB_COSTING_SQL.openTimeEntries}), 0)::text as "open_entries"`)},
        ${sql.raw(`coalesce(sum(${JOB_COSTING_SQL.uncostedLines}), 0)::text as "uncosted_lines"`)},
        ${money(JOB_COSTING_SQL.unbilledCost, "unbilled_cost")},
        ${sql.raw(
          `count(*) filter (where ${SETTLEMENT_SQL} <> 'Settled')::text as "in_progress"`,
        )}
      from public.job
      join public.project_job pj on pj.job_id = job.id
      where pj.project_id = ${project.id}::uuid
        and job.deleted_at is null
    `);

    const { planned, raised } = await drawTotals(tx, project.id);

    /**
     * WHY THESE NUMBERS ARE NOT FINISHED, as sentences rather than a boolean,
     * which is the shape `services/profitability.ts` established. "Provisional"
     * on its own tells somebody not to trust the figure and not what to do
     * about it, and every one of these is fixable by somebody in the office
     * this afternoon.
     */
    const provisional: string[] = [];
    const open = Number(totals?.open_entries ?? 0);
    const uncosted = Number(totals?.uncosted_lines ?? 0);
    const inProgress = Number(totals?.in_progress ?? 0);
    if (open > 0) {
      provisional.push(
        `${open} ${open === 1 ? "punch is" : "punches are"} still running on this project, `
        + "so the labour cost is still going up.",
      );
    }
    if (uncosted > 0) {
      provisional.push(
        `${uncosted} ${uncosted === 1 ? "line has" : "lines have"} no cost recorded, `
        + "which is unknown rather than zero.",
      );
    }
    if (inProgress > 0) {
      provisional.push(
        `${inProgress} of the ${totals?.jobs ?? 0} jobs on this project are not settled, so they `
        + "carry some of their revenue and not all of their cost.",
      );
    }
    if (Number(totals?.unbilled_cost ?? 0) !== 0) {
      provisional.push(
        "Work has been consumed that is neither billed nor marked non-billable, "
        + "so revenue on this project may still be coming.",
      );
    }
    if (Number(totals?.jobs ?? 0) === 0) {
      provisional.push(
        "No job is attached to this project yet, so every actual below is zero because "
        + "nothing has been measured, not because nothing has been spent.",
      );
    }

    const actualCost = Number(totals?.material_cost ?? 0)
      + Number(totals?.labour_cost ?? 0)
      + Number(totals?.processing_fees ?? 0);

    return {
      projectId: project.id,
      name: project.name,
      jobsCounted: Number(totals?.jobs ?? 0),
      contractValue: project.contractValue,
      budgetCost: project.budgetCost,
      revenue: totals?.revenue ?? "0.0000",
      materialCost: totals?.material_cost ?? "0.0000",
      labourCost: totals?.labour_cost ?? "0.0000",
      processingFees: totals?.processing_fees ?? "0.0000",
      grossMargin: totals?.gross_margin ?? "0.0000",
      /**
       * Positive means under budget. Null rather than zero when nothing was
       * budgeted, because "we are exactly on budget" and "nobody set one" are
       * opposite statements and the second one is the common case.
       */
      costVariance: project.budgetCost === null
        ? null
        : (Number(project.budgetCost) - actualCost).toFixed(4),
      billedToDate: raised.toFixed(4),
      leftToBill: project.contractValue === null ? null : planned.toFixed(4),
      scheduledHours: totals?.scheduled_hours ?? "0.00",
      actualHours: totals?.actual_hours ?? "0.00",
      provisional,
      /**
       * The same caveats, from the same place. A project margin is a sum of
       * job margins and is wrong about exactly the same four things: no
       * overhead is allocated, the overtime premium is not in it, nothing
       * posts to COGS, and card fees are allocated rather than attributed.
       */
      caveats: { ...CAVEATS },
    };
  });
}

/* ----------------------------------------------------------------- loading */

/**
 * NO SOFT DELETE FILTER ON THESE TABLES, AND THAT IS A DECISION.
 *
 * `project`, `project_phase`, `project_draw` and `project_job` all carry a
 * `deleted_at` column because every table in this schema does, and nothing in
 * this module sets one: a project is cancelled through its status and a phase
 * is a row somebody keeps. `test/unwritten-columns.test.ts` makes the
 * argument at length and `services/crews.ts` reached the same conclusion on
 * its own tables: a filter on a column nothing writes is decoration, it makes
 * a query look guarded when it is not, and it is indistinguishable in review
 * from one that is doing work.
 *
 * The filter on `job.deleted_at` in `attachJob` and in `profitability` is a
 * different thing and is real: `services/jobs.ts` does soft delete a job.
 */
async function loadProject(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.project)
    .where(and(
      eq(schema.project.id, id),
      eq(schema.project.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Project");
  return row;
}

async function loadPhase(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.projectPhase)
    .where(and(
      eq(schema.projectPhase.id, id),
      eq(schema.projectPhase.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Phase");
  return row;
}

async function loadDraw(tx: Database, organizationId: string, id: string) {
  const [row] = await tx.select().from(schema.projectDraw)
    .where(and(
      eq(schema.projectDraw.id, id),
      eq(schema.projectDraw.organizationId, organizationId),
    )).limit(1);
  if (!row) throw new NotFoundError("Draw");
  return row;
}

/* --------------------------------------------------------------- handlers */

export const handlers = {
  listProjects: async (ctx: ServiceContext, input: {
    status?: typeof schema.projectStatus.enumValues[number][] | undefined;
  }): Promise<{ projects: ProjectSummary[] }> => ({ projects: await list(ctx, input) }),

  getProject: (ctx: ServiceContext, input: { id: string }): Promise<ProjectDetail> =>
    get(ctx, input),

  createProject: async (ctx: ServiceContext, input: ProjectInput): Promise<{
    id: string; name: string; status: string;
  }> => {
    const row = await create(ctx, input);
    return { id: row.id, name: row.name, status: row.status };
  },

  updateProject: async (ctx: ServiceContext, input: ProjectUpdate): Promise<{
    id: string; name: string; status: string;
  }> => {
    const row = await update(ctx, input);
    return { id: row.id, name: row.name, status: row.status };
  },

  addProjectPhase: async (ctx: ServiceContext, input: PhaseInput): Promise<{
    id: string; sequence: number; name: string; status: string;
  }> => {
    const row = await addPhase(ctx, input);
    return { id: row.id, sequence: row.sequence, name: row.name, status: row.status };
  },

  setProjectPhaseDependency: async (ctx: ServiceContext, input: {
    id: string; dependsOnPhaseId: string | null;
  }): Promise<{ id: string; dependsOnPhaseId: string | null }> => {
    const row = await setPhaseDependency(ctx, input);
    return { id: row.id, dependsOnPhaseId: row.dependsOnPhaseId };
  },

  setProjectPhaseStatus: async (ctx: ServiceContext, input: {
    id: string; status: typeof schema.projectPhaseStatus.enumValues[number];
  }): Promise<{ id: string; status: string; completedAt: Date | null }> => {
    const row = await setPhaseStatus(ctx, input);
    return { id: row.id, status: row.status, completedAt: row.completedAt };
  },

  materialiseProject: (ctx: ServiceContext, input: { id: string }): Promise<MaterialiseResult> =>
    materialise(ctx, input),

  attachJobToProject: async (ctx: ServiceContext, input: {
    projectId: string; jobId: string; phaseId?: string | null | undefined;
  }): Promise<{ id: string; projectId: string; projectPhaseId: string | null; jobId: string }> => {
    const row = await attachJob(ctx, input);
    return {
      id: row.id, projectId: row.projectId,
      projectPhaseId: row.projectPhaseId, jobId: row.jobId,
    };
  },

  planProjectDraw: async (ctx: ServiceContext, input: DrawInput): Promise<{
    id: string; sequence: number; label: string; amount: string; percent: string | null;
  }> => {
    const row = await planDraw(ctx, input);
    return {
      id: row.id, sequence: row.sequence, label: row.label,
      amount: row.amount, percent: row.percent,
    };
  },

  raiseProjectDraw: (ctx: ServiceContext, input: { id: string }): Promise<RaiseResult> =>
    raiseDraw(ctx, input),

  getProjectProfitability: (ctx: ServiceContext, input: { id: string }):
    Promise<ProjectProfitability> => profitability(ctx, input),
} as const;
