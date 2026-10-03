import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import postgres from "postgres";
import { PermissionError, type Actor } from "@opentradesos/core";
import * as projects from "../src/services/projects";
import { ConflictError, NotFoundError, type ServiceContext } from "../src/services/context";
import { seedOrg, resetOrg, testDb, fixtureId } from "./helpers";

/**
 * M12. PROJECTS AND MULTI-PHASE WORK.
 *
 * THE THREE PROPERTIES THIS FILE IS ABOUT.
 *
 * A PHASE CANNOT START OVER WORK THAT IS NOT SIGNED OFF. Closing the walls
 * before the rough in has passed inspection is the most expensive mistake on
 * a multi phase job, and the only moment anybody can be told is the moment
 * somebody marks the next phase started.
 *
 * A BILLING SCHEDULE CANNOT ADD UP TO MORE THAN WHAT IT IS A SCHEDULE OF.
 * Per phase, because that is what a certifier rejects, and across the
 * project, because that is what a customer rejects.
 *
 * RAISING A DRAW TWICE DOES NOT BILL TWICE. The invoice is created through
 * the billing service under a key derived from the draw, so a retry attaches
 * the invoice that already exists rather than sending a second application
 * for payment. That is the failure that costs a relationship rather than an
 * afternoon.
 */
const url = process.env.DATABASE_URL;
if (!url && process.env.CI) {
  throw new Error("DATABASE_URL is not set. These tests must run in CI, not skip.");
}
const run = url ? describe : describe.skip;

const ORG = fixtureId("m12:org");
const USER = fixtureId("m12:user");

let raw: postgres.Sql;
const db = () => testDb(url!);

const as = (role: Actor["roles"][number], extra: Partial<Actor> = {}): ServiceContext => ({
  actor: {
    userId: USER, organizationId: ORG, roles: [role] as Actor["roles"], ...extra,
  }, db: db(),
});
const owner = () => as("owner");

/**
 * THE ROLES THAT TELL THE PERMISSIONS APART.
 *
 * `dispatcher` holds `job:write` and holds NOTHING that touches money.
 * `accountant` holds `invoice:write` and does NOT hold `job:write`.
 * `office_manager` holds `job.cost:read` and does NOT hold
 * `report.financial:read`.
 *
 * Each pair is checked in both directions below. A test run as a role that
 * holds neither permission of a pair refuses either way and cannot say which
 * guard a surface carries.
 */
const dispatcher = () => as("dispatcher");
const accountant = () => as("accountant");
const officeManager = () => as("office_manager");

let customerId = "";
let propertyId = "";

async function fixtures(): Promise<void> {
  const [customer] = await raw<{ id: string }[]>`
    insert into public.customer (organization_id, type, name)
    values (${ORG}, 'commercial', 'Hillcrest Partners') returning id`;
  customerId = customer!.id;
  const [property] = await raw<{ id: string }[]>`
    insert into public.property (organization_id, address_line1, city, state, postal_code)
    values (${ORG}, '14 Hillcrest', 'Austin', 'TX', '78701') returning id`;
  propertyId = property!.id;
  await raw`insert into public.customer_property (organization_id, customer_id, property_id)
            values (${ORG}, ${customerId}, ${propertyId})`;
}

/** A plain job in this company, not attached to anything. */
async function job(summary = "Loose work"): Promise<string> {
  const [n] = await raw<{ next: number }[]>`
    select coalesce(max(number), 0) + 1 as next from public.job where organization_id = ${ORG}`;
  const [row] = await raw<{ id: string }[]>`
    insert into public.job (organization_id, number, customer_id, property_id, status, summary)
    values (${ORG}, ${n!.next}, ${customerId}, ${propertyId}, 'in_progress', ${summary})
    returning id`;
  return row!.id;
}

/** A consumed part, at cost. What `JOB_COSTING_SQL.materialCost` sums. */
async function materialLine(jobId: string, quantity: string, unitCost: string | null) {
  await raw`
    insert into public.job_line (organization_id, job_id, kind, name, quantity, unit_price, unit_cost)
    values (${ORG}, ${jobId}, 'part', 'Pipe', ${quantity}, '0', ${unitCost})`;
}

/** A closed punch at a frozen loaded rate. What `JOB_COSTING_SQL.labourCost` sums. */
async function punch(jobId: string, technicianId: string, minutes: number, rate: string) {
  await raw`
    insert into public.timeclock_entry
      (organization_id, technician_id, job_id, kind, started_at, ended_at, minutes, applied_loaded_rate)
    values (${ORG}, ${technicianId}, ${jobId}, 'on_site',
            '2026-05-01T14:00:00Z'::timestamptz, '2026-05-01T18:00:00Z'::timestamptz,
            ${minutes}, ${rate})`;
}

async function technician(key: string, name: string): Promise<string> {
  const userId = fixtureId(`m12:tech:${key}`);
  await raw`insert into public."user" (id, email) values (${userId}, ${`m12-${key}@test.local`})
            on conflict (id) do nothing`;
  const [m] = await raw<{ id: string }[]>`
    insert into public.membership (organization_id, user_id, role)
    values (${ORG}, ${userId}, 'technician') returning id`;
  const [t] = await raw<{ id: string }[]>`
    insert into public.technician (organization_id, membership_id, display_name)
    values (${ORG}, ${m!.id}, ${name}) returning id`;
  return t!.id;
}

beforeAll(async () => {
  if (!url) return;
  raw = postgres(url, { max: 1, onnotice: () => {} });
});

afterAll(async () => { if (raw) await raw.end(); });

beforeEach(async () => {
  if (!url) return;
  await resetOrg(raw, ORG);
  await seedOrg(raw, { organizationId: ORG, userId: USER, name: "Fitout Co", slug: "fitout-co" });
  await fixtures();
});

/** A project with a contract value, which most of the money rules need. */
async function project(contractValue: string | null = "100000", budgetCost: string | null = null) {
  return projects.create(owner(), {
    customerId, propertyId, name: "Hillcrest fit out",
    contractValue, budgetCost,
  });
}

/* ================================================================ the project */

run("starting a project", () => {
  it("refuses a project due to finish before it starts", async () => {
    await expect(projects.create(owner(), {
      customerId, propertyId, name: "Backwards",
      startsOn: "2026-06-01", targetCompletionOn: "2026-05-01",
    })).rejects.toThrow(/finish before it starts/);
  });

  it("refuses a property that is not this company's", async () => {
    await expect(projects.create(owner(), {
      customerId, propertyId: fixtureId("m12:nowhere"), name: "Nowhere",
    })).rejects.toThrow(NotFoundError);
  });

  it("starts in planning and shows no phases and no work", async () => {
    const made = await project();
    const detail = await projects.get(owner(), { id: made.id });
    expect(detail.status).toBe("planning");
    expect(detail.phaseList).toEqual([]);
    expect(detail.jobs).toBe(0);
    expect(detail.unscheduledValue).toBe("100000.00");
  });

  it("says nothing rather than zero about what is left when there is no contract", async () => {
    /**
     * "Nothing left to schedule" and "nobody has agreed a price" are opposite
     * facts, and zero says the first.
     */
    const made = await project(null);
    const detail = await projects.get(owner(), { id: made.id });
    expect(detail.unscheduledValue).toBeNull();
  });
});

run("changing a project", () => {
  it("refuses a contract value below what the phases add up to", async () => {
    const made = await project();
    await projects.addPhase(owner(), { projectId: made.id, name: "Rough in", billingValue: "60000" });
    await expect(projects.update(owner(), { id: made.id, contractValue: "50000" }))
      .rejects.toThrow(/phases on this project add up to \$60,000.00/);
  });

  it("refuses a contract value below what has already been billed", async () => {
    const made = await project();
    const phase = await projects.addPhase(owner(), {
      projectId: made.id, name: "Rough in", billingValue: "60000",
    });
    await projects.setPhaseStatus(owner(), { id: phase.id, status: "in_progress" });
    const draw = await projects.planDraw(owner(), {
      projectId: made.id, phaseId: phase.id, label: "Rough in 50%", percent: "0.5",
    });
    await projects.raiseDraw(owner(), { id: draw.id });

    await expect(projects.update(owner(), { id: made.id, contractValue: "20000" }))
      .rejects.toThrow(/already billed \$30,000.00/);
  });

  it("refuses to complete a project with a phase still open", async () => {
    const made = await project();
    await projects.addPhase(owner(), { projectId: made.id, name: "Rough in" });
    await expect(projects.update(owner(), { id: made.id, status: "completed" }))
      .rejects.toThrow(/still open on this project/);
  });

  it("completes it once every phase is complete, and stamps the date", async () => {
    const made = await project();
    const phase = await projects.addPhase(owner(), { projectId: made.id, name: "Rough in" });
    await projects.setPhaseStatus(owner(), { id: phase.id, status: "complete" });
    await projects.update(owner(), { id: made.id, status: "completed" });

    const [row] = await raw<{ status: string; completed_at: Date | null }[]>`
      select status, completed_at from public.project where id = ${made.id}`;
    /** Both columns, read back separately: a status with no date is half the fact. */
    expect(row!.status).toBe("completed");
    expect(row!.completed_at).not.toBeNull();
  });
});

/* ================================================================= the phases */

run("the phases and what waits for what", () => {
  it("refuses phases that add up to more than the contract", async () => {
    const made = await project();
    await projects.addPhase(owner(), { projectId: made.id, name: "Rough in", billingValue: "60000" });
    await expect(projects.addPhase(owner(), {
      projectId: made.id, name: "Finish", billingValue: "60000",
    })).rejects.toThrow(/would add up to 120000.00 against a contract of 100000.00/);
  });

  it("numbers them in order and refuses two in one position", async () => {
    const made = await project();
    const first = await projects.addPhase(owner(), { projectId: made.id, name: "Strip out" });
    const second = await projects.addPhase(owner(), { projectId: made.id, name: "Rough in" });
    expect([first.sequence, second.sequence]).toEqual([1, 2]);

    await expect(projects.addPhase(owner(), {
      projectId: made.id, name: "Clash", sequence: 2,
    })).rejects.toThrow(/already has a phase 2/);
  });

  it("refuses a predecessor belonging to a different project", async () => {
    const a = await project();
    const b = await project();
    const theirs = await projects.addPhase(owner(), { projectId: b.id, name: "Theirs" });
    await expect(projects.addPhase(owner(), {
      projectId: a.id, name: "Ours", dependsOnPhaseId: theirs.id,
    })).rejects.toThrow(/only wait for another phase of the same project/);
  });

  it("refuses a phase that waits for itself", async () => {
    const made = await project();
    const phase = await projects.addPhase(owner(), { projectId: made.id, name: "Rough in" });
    await expect(projects.setPhaseDependency(owner(), {
      id: phase.id, dependsOnPhaseId: phase.id,
    })).rejects.toThrow(/cannot wait for itself/);
  });

  it("refuses a ring of three phases, which one step of checking would miss", async () => {
    /**
     * A waits for B, B waits for C. Pointing C at A makes a ring in which
     * every phase is blocked by one that is blocked by it, and nothing in the
     * product would say why nothing can start. A check that only compared the
     * new predecessor against the phase itself passes this.
     */
    const made = await project();
    const a = await projects.addPhase(owner(), { projectId: made.id, name: "A" });
    const b = await projects.addPhase(owner(), { projectId: made.id, name: "B" });
    const c = await projects.addPhase(owner(), { projectId: made.id, name: "C" });
    await projects.setPhaseDependency(owner(), { id: a.id, dependsOnPhaseId: b.id });
    await projects.setPhaseDependency(owner(), { id: b.id, dependsOnPhaseId: c.id });

    await expect(projects.setPhaseDependency(owner(), { id: c.id, dependsOnPhaseId: a.id }))
      .rejects.toThrow(/ring of phases/);
  });

  it("refuses to start a phase whose predecessor is not complete", async () => {
    const made = await project();
    const rough = await projects.addPhase(owner(), { projectId: made.id, name: "Rough in" });
    const close = await projects.addPhase(owner(), {
      projectId: made.id, name: "Close up", dependsOnPhaseId: rough.id,
    });

    await expect(projects.setPhaseStatus(owner(), { id: close.id, status: "in_progress" }))
      .rejects.toThrow(/waits for Rough in, which is not_started/);

    await projects.setPhaseStatus(owner(), { id: rough.id, status: "complete" });
    const started = await projects.setPhaseStatus(owner(), { id: close.id, status: "in_progress" });
    expect(started.status).toBe("in_progress");
  });

  it("clears the completion date when a phase is reopened", async () => {
    /**
     * A completion date left behind on a phase that has gone back to
     * in_progress is a date saying the work finished, and it did not.
     */
    const made = await project();
    const phase = await projects.addPhase(owner(), { projectId: made.id, name: "Rough in" });
    const done = await projects.setPhaseStatus(owner(), { id: phase.id, status: "complete" });
    expect(done.completedAt).not.toBeNull();

    const reopened = await projects.setPhaseStatus(owner(), { id: phase.id, status: "in_progress" });
    expect(reopened.completedAt).toBeNull();
  });
});

/* =========================================================== turning it into work */

run("materialising the work", () => {
  it("creates one job per phase and links both ends of it", async () => {
    const made = await project();
    const one = await projects.addPhase(owner(), { projectId: made.id, name: "Strip out" });
    await projects.addPhase(owner(), { projectId: made.id, name: "Rough in" });

    const result = await projects.materialise(owner(), { id: made.id });
    expect(result.created).toHaveLength(2);
    expect(result.alreadyThere).toBe(0);

    const first = result.created.find((c) => c.phaseId === one.id)!;
    /**
     * BOTH ENDS, READ BACK SEPARATELY. The job carries its provenance and
     * `project_job` carries the link, and a test that only checked one would
     * pass against a materialiser that wrote the other and not this.
     */
    const [jobRow] = await raw<{ status: string; source_system: string; source_id: string }[]>`
      select status, source_system, source_id from public.job where id = ${first.jobId}`;
    expect(jobRow!.source_system).toBe("project_phase");
    expect(jobRow!.source_id).toBe(one.id);
    /** A lead, not scheduled: a phase has a plan and not a date until a dispatcher gives it one. */
    expect(jobRow!.status).toBe("lead");

    const [link] = await raw<{ project_id: string; project_phase_id: string }[]>`
      select project_id, project_phase_id from public.project_job where job_id = ${first.jobId}`;
    expect(link!.project_id).toBe(made.id);
    expect(link!.project_phase_id).toBe(one.id);
  });

  it("is safe to run twice, which is the rule the other two materialisers follow", async () => {
    const made = await project();
    await projects.addPhase(owner(), { projectId: made.id, name: "Strip out" });
    await projects.addPhase(owner(), { projectId: made.id, name: "Rough in" });

    await projects.materialise(owner(), { id: made.id });
    const again = await projects.materialise(owner(), { id: made.id });
    expect(again.created).toEqual([]);
    expect(again.alreadyThere).toBe(2);

    const [count] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.job where organization_id = ${ORG}`;
    expect(count!.n).toBe("2");
  });

  it("creates the job for a phase added after the first run, and only that one", async () => {
    const made = await project();
    await projects.addPhase(owner(), { projectId: made.id, name: "Strip out" });
    await projects.materialise(owner(), { id: made.id });

    const late = await projects.addPhase(owner(), { projectId: made.id, name: "Snagging" });
    const second = await projects.materialise(owner(), { id: made.id });
    expect(second.created.map((c) => c.phaseId)).toEqual([late.id]);
    expect(second.alreadyThere).toBe(1);
  });

  it("refuses to create work from a cancelled project", async () => {
    const made = await project();
    await projects.addPhase(owner(), { projectId: made.id, name: "Strip out" });
    await projects.update(owner(), { id: made.id, status: "cancelled" });
    await expect(projects.materialise(owner(), { id: made.id }))
      .rejects.toThrow(/cancelled, so nothing should be created/);
  });
});

run("attaching work that already exists", () => {
  it("puts an existing job into a phase", async () => {
    const made = await project();
    const phase = await projects.addPhase(owner(), { projectId: made.id, name: "Rough in" });
    const existing = await job("The job that started it");

    await projects.attachJob(owner(), {
      projectId: made.id, jobId: existing, phaseId: phase.id,
    });
    const detail = await projects.get(owner(), { id: made.id });
    expect(detail.phaseList[0]!.jobIds).toEqual([existing]);
  });

  it("refuses a job that already belongs to another project", async () => {
    /**
     * A job counted in two projects is counted twice in both, and the overrun
     * it produces is in the one that is wrong.
     */
    const a = await project();
    const b = await project();
    const existing = await job();
    await projects.attachJob(owner(), { projectId: a.id, jobId: existing });
    await expect(projects.attachJob(owner(), { projectId: b.id, jobId: existing }))
      .rejects.toThrow(/already belongs to another project/);
  });

  it("moves a job between phases of the same project rather than refusing", async () => {
    const made = await project();
    const one = await projects.addPhase(owner(), { projectId: made.id, name: "Strip out" });
    const two = await projects.addPhase(owner(), { projectId: made.id, name: "Rough in" });
    const existing = await job();

    await projects.attachJob(owner(), { projectId: made.id, jobId: existing, phaseId: one.id });
    await projects.attachJob(owner(), { projectId: made.id, jobId: existing, phaseId: two.id });

    const detail = await projects.get(owner(), { id: made.id });
    expect(detail.phaseList.find((p) => p.id === one.id)!.jobIds).toEqual([]);
    expect(detail.phaseList.find((p) => p.id === two.id)!.jobIds).toEqual([existing]);
  });

  it("refuses a phase that is not part of this project", async () => {
    const a = await project();
    const b = await project();
    const theirs = await projects.addPhase(owner(), { projectId: b.id, name: "Theirs" });
    await expect(projects.attachJob(owner(), {
      projectId: a.id, jobId: await job(), phaseId: theirs.id,
    })).rejects.toThrow(/not part of this project/);
  });
});

/* =========================================================== progress billing */

run("planning the billing", () => {
  it("refuses a draw that is both a percentage and an amount, and one that is neither", async () => {
    const made = await project();
    await expect(projects.planDraw(owner(), {
      projectId: made.id, label: "Both", percent: "0.5", amount: "100",
    })).rejects.toThrow(/exactly one of the two/);
    await expect(projects.planDraw(owner(), { projectId: made.id, label: "Neither" }))
      .rejects.toThrow(/exactly one of the two/);
  });

  it("computes the amount from the percentage of the phase and freezes it", async () => {
    /**
     * Frozen on the row rather than re-derived. A phase whose billing value
     * is revised in month four would otherwise change the amount of a draw
     * raised in month two, which by then is an invoice somebody has paid.
     */
    const made = await project();
    const phase = await projects.addPhase(owner(), {
      projectId: made.id, name: "Rough in", billingValue: "40000",
    });
    const draw = await projects.planDraw(owner(), {
      projectId: made.id, phaseId: phase.id, label: "Rough in 30%", percent: "0.3",
    });
    expect(Number(draw.amount)).toBe(12000);
    expect(draw.percent).toBe("0.300000");
  });

  it("refuses a percentage of a phase that carries no part of the contract", async () => {
    const made = await project();
    const phase = await projects.addPhase(owner(), { projectId: made.id, name: "Rough in" });
    await expect(projects.planDraw(owner(), {
      projectId: made.id, phaseId: phase.id, label: "Half", percent: "0.5",
    })).rejects.toThrow(/no part of the contract/);
  });

  it("refuses billing a phase for more than it carries", async () => {
    const made = await project();
    const phase = await projects.addPhase(owner(), {
      projectId: made.id, name: "Rough in", billingValue: "40000",
    });
    await projects.planDraw(owner(), {
      projectId: made.id, phaseId: phase.id, label: "First", amount: "30000",
    });
    await expect(projects.planDraw(owner(), {
      projectId: made.id, phaseId: phase.id, label: "Second", amount: "20000",
    })).rejects.toThrow(/against a phase worth 40000.00/);
  });

  it("refuses billing the project for more than the contract", async () => {
    /**
     * A separate check from the phase one, because they fail differently: a
     * phase over billed against a correct total is a certifier's rejection
     * and a project over billed is a customer's.
     */
    const made = await project("50000");
    await projects.planDraw(owner(), { projectId: made.id, label: "Mobilisation", amount: "30000" });
    await expect(projects.planDraw(owner(), {
      projectId: made.id, label: "More", amount: "30000",
    })).rejects.toThrow(/against a contract of 50000.00/);
  });

  it("allows a draw against no phase at all, which is how a deposit is billed", async () => {
    const made = await project();
    const draw = await projects.planDraw(owner(), {
      projectId: made.id, label: "Mobilisation", amount: "5000",
    });
    expect(draw.amount).toBe("5000.0000");
  });
});

run("raising a draw", () => {
  it("creates an invoice for the amount, and never a second one", async () => {
    /**
     * THE PROPERTY THAT COSTS A RELATIONSHIP WHEN IT IS WRONG. The invoice is
     * created under an idempotency key derived from the draw, so a retry
     * attaches the invoice that already exists rather than sending the
     * customer a second application for payment.
     */
    const made = await project();
    const phase = await projects.addPhase(owner(), {
      projectId: made.id, name: "Rough in", billingValue: "40000",
    });
    await projects.setPhaseStatus(owner(), { id: phase.id, status: "in_progress" });
    const draw = await projects.planDraw(owner(), {
      projectId: made.id, phaseId: phase.id, label: "Rough in 30%", percent: "0.3",
    });

    const first = await projects.raiseDraw(owner(), { id: draw.id });
    expect(first.created).toBe(true);

    const second = await projects.raiseDraw(owner(), { id: draw.id });
    expect(second.created).toBe(false);
    expect(second.invoiceId).toBe(first.invoiceId);

    const [count] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.invoice where organization_id = ${ORG}`;
    expect(count!.n).toBe("1");

    const [invoice] = await raw<{ total: string }[]>`
      select total::text as total from public.invoice where id = ${first.invoiceId}`;
    expect(Number(invoice!.total)).toBe(12000);
  });

  it("attaches the invoice that already exists when the attach never happened", async () => {
    /**
     * THE TEST THE IDEMPOTENCY KEY IS ACTUALLY FOR, and the first version of
     * this file did not have it.
     *
     * Calling `raiseDraw` twice in a row proves nothing about the key: the
     * draw already carries its invoice by then and the function returns
     * before billing is reached. The failure the key exists for is a crash
     * BETWEEN creating the invoice and writing it onto the draw, which leaves
     * an invoice nothing points at. Clearing the column is that state.
     *
     * The run after it must find the invoice it already made rather than
     * sending the customer a second application for payment.
     */
    const made = await project();
    const draw = await projects.planDraw(owner(), {
      projectId: made.id, label: "Mobilisation", amount: "5000",
    });
    const first = await projects.raiseDraw(owner(), { id: draw.id });

    await raw`update public.project_draw
              set invoice_id = null, raised_at = null where id = ${draw.id}`;

    const retry = await projects.raiseDraw(owner(), { id: draw.id });
    expect(retry.invoiceId).toBe(first.invoiceId);

    const [count] = await raw<{ n: string }[]>`
      select count(*)::text as n from public.invoice where organization_id = ${ORG}`;
    expect(count!.n).toBe("1");
  });

  it("writes the invoice onto the draw, so the schedule knows what is billed", async () => {
    const made = await project();
    const draw = await projects.planDraw(owner(), {
      projectId: made.id, label: "Mobilisation", amount: "5000",
    });
    const raised = await projects.raiseDraw(owner(), { id: draw.id });

    const [row] = await raw<{ invoice_id: string | null; raised_at: Date | null }[]>`
      select invoice_id, raised_at from public.project_draw where id = ${draw.id}`;
    /** Both columns. A draw with an invoice and no date cannot be aged. */
    expect(row!.invoice_id).toBe(raised.invoiceId);
    expect(row!.raised_at).not.toBeNull();
  });

  it("refuses a draw against a phase nobody has started", async () => {
    /**
     * Progress billing bills progress. Money taken before any work is a
     * deposit, which belongs to the project rather than to a phase and is
     * planned with no phase on it.
     */
    const made = await project();
    const phase = await projects.addPhase(owner(), {
      projectId: made.id, name: "Rough in", billingValue: "40000",
    });
    const draw = await projects.planDraw(owner(), {
      projectId: made.id, phaseId: phase.id, label: "Rough in 30%", percent: "0.3",
    });
    await expect(projects.raiseDraw(owner(), { id: draw.id }))
      .rejects.toThrow(/has not started, so there is no progress to bill/);
  });

  it("moves the draw out of what is left to bill once it is raised", async () => {
    const made = await project();
    const a = await projects.planDraw(owner(), {
      projectId: made.id, label: "Mobilisation", amount: "5000",
    });
    await projects.planDraw(owner(), { projectId: made.id, label: "Later", amount: "7000" });
    await projects.raiseDraw(owner(), { id: a.id });

    const report = await projects.profitability(owner(), { id: made.id });
    expect(Number(report.billedToDate)).toBe(5000);
    expect(Number(report.leftToBill)).toBe(7000);
  });
});

/* ======================================================== budget against actual */

run("budget against actual", () => {
  it("counts only the jobs attached to this project", async () => {
    /**
     * The failure this prevents is a project whose cost quietly includes
     * every job in the company, which looks exactly like an overrun.
     */
    const made = await project("100000", "50000");
    const mine = await job("Project work");
    const theirs = await job("Somebody else's work");
    await materialLine(mine, "2", "1000");
    await materialLine(theirs, "2", "9999");
    await projects.attachJob(owner(), { projectId: made.id, jobId: mine });

    const report = await projects.profitability(owner(), { id: made.id });
    expect(report.jobsCounted).toBe(1);
    expect(Number(report.materialCost)).toBe(2000);
  });

  it("reads labour at the rate frozen on the punch and reports the variance", async () => {
    const made = await project("100000", "5000");
    const tech = await technician("dana", "Dana Reyes");
    const mine = await job("Project work");
    await materialLine(mine, "2", "1000");
    await punch(mine, tech, 240, "50");
    await projects.attachJob(owner(), { projectId: made.id, jobId: mine });

    const report = await projects.profitability(owner(), { id: made.id });
    /** Four hours at fifty. */
    expect(Number(report.labourCost)).toBe(200);
    expect(Number(report.actualHours)).toBe(4);
    /** Budget 5000 against 2200 of cost, and no revenue, so the margin is negative. */
    expect(Number(report.costVariance)).toBe(2800);
    expect(Number(report.grossMargin)).toBe(-2200);
  });

  it("says nothing rather than zero about variance when nobody set a budget", async () => {
    const made = await project("100000", null);
    const report = await projects.profitability(owner(), { id: made.id });
    expect(report.costVariance).toBeNull();
  });

  it("says why the numbers are not finished", async () => {
    const made = await project("100000", "5000");
    const mine = await job("Project work");
    /** A line with no cost is unknown rather than zero, and the report says so. */
    await materialLine(mine, "2", null);
    await projects.attachJob(owner(), { projectId: made.id, jobId: mine });

    const report = await projects.profitability(owner(), { id: made.id });
    expect(report.provisional.join(" ")).toContain("no cost recorded");
  });

  it("says that an empty project has measured nothing rather than spent nothing", async () => {
    const made = await project();
    const report = await projects.profitability(owner(), { id: made.id });
    expect(report.jobsCounted).toBe(0);
    expect(report.provisional.join(" ")).toContain("nothing has been measured");
  });

  it("carries the caveats, because a project margin is wrong about the same four things", async () => {
    const made = await project();
    const report = await projects.profitability(owner(), { id: made.id });
    expect(report.caveats["overhead"]).toContain("No overhead is allocated");
  });
});

/* ============================================================== the permissions */

run("who may do what", () => {
  it("lets a dispatcher create a project, which is job:write and not money", async () => {
    await expect(projects.create(dispatcher(), {
      customerId, propertyId, name: "Dispatcher's project",
    })).resolves.toMatchObject({ status: "planning" });
  });

  it("refuses a project to an accountant, who holds invoice:write and no job:write", async () => {
    /**
     * The other half of the pair. An accountant can bill and cannot create
     * work, so this failing while the draw test below passes proves the two
     * surfaces carry different guards.
     */
    await expect(projects.create(accountant(), {
      customerId, propertyId, name: "Accountant's project",
    })).rejects.toThrow(PermissionError);
  });

  it("refuses the billing schedule to a dispatcher, who holds no invoice:write", async () => {
    const made = await project();
    await expect(projects.planDraw(dispatcher(), {
      projectId: made.id, label: "Mobilisation", amount: "5000",
    })).rejects.toThrow(PermissionError);
  });

  it("lets an accountant plan a draw", async () => {
    const made = await project();
    await expect(projects.planDraw(accountant(), {
      projectId: made.id, label: "Mobilisation", amount: "5000",
    })).resolves.toMatchObject({ label: "Mobilisation" });
  });

  it("refuses budget against actual to the office manager, who holds no report.financial:read", async () => {
    /**
     * `office_manager` holds `job.cost:read` and not `report.financial:read`.
     * Guarding this with the cost permission alone would hand the company's
     * revenue to every office manager, one project at a time.
     */
    const made = await project();
    await expect(projects.profitability(officeManager(), { id: made.id }))
      .rejects.toThrow(PermissionError);
  });

  it("lets the office manager read the project itself, so the refusal is about the money", async () => {
    const made = await project();
    await expect(projects.get(officeManager(), { id: made.id }))
      .resolves.toMatchObject({ name: "Hillcrest fit out" });
  });

  it("lets an accountant read budget against actual", async () => {
    const made = await project();
    await expect(projects.profitability(accountant(), { id: made.id }))
      .resolves.toMatchObject({ jobsCounted: 0 });
  });

  it("refuses a project total to somebody scoped to their own work", async () => {
    /**
     * A technician granted both money permissions on a custom role is still
     * scoped to their own jobs, and a project total over the subset that
     * happens to be theirs is not a smaller answer, it is a wrong one that
     * reads as an under run. Every other surface narrows; this one refuses.
     */
    const made = await project();
    const scoped = as("technician", {
      grants: ["job.cost:read", "report.financial:read", "job:read"],
    });
    await expect(projects.profitability(scoped, { id: made.id }))
      .rejects.toThrow(/not a smaller answer/);
  });
});

run("the guards refuse rather than quietly doing nothing", () => {
  it("throws a conflict rather than returning a result", async () => {
    const made = await project();
    await expect(projects.planDraw(owner(), { projectId: made.id, label: "Neither" }))
      .rejects.toThrow(ConflictError);
  });
});
