import * as m from "../money/index.js";

/**
 * M12. THE ARITHMETIC OF A PROJECT, WITH NO DATABASE IN IT.
 *
 * Four things a fit out is run on, each of which is wrong in a way nobody
 * notices until a certifier, a customer or a lawyer reads the document it
 * produced:
 *
 *   THE SCHEDULE. Which phases decide the finish date, and what dragging one
 *   does to the ones that wait for it.
 *
 *   A CHANGE ORDER. What agreeing one does to the contract, the budget and the
 *   phase it lands on, and the changes that cannot be agreed as written.
 *
 *   AN APPLICATION FOR PAYMENT. The schedule of values, work this period and
 *   to date, stored materials, retainage held and released, and the one
 *   number at the bottom the customer pays.
 *
 *   THE INVOICE THAT APPLICATION BECOMES, which has to add up to that number
 *   to the cent.
 *
 * Everything here takes decimal strings and gives decimal strings back, and
 * every sum goes through `money`. A retainage figure that is a cent off on
 * the eleventh application of a two year job is a cent the certifier finds,
 * and an application they have found one wrong number on is an application
 * they read line by line from then on.
 */

/* ------------------------------------------------------------------- dates */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

/** Days since 1970 for a calendar date. A calendar date has no zone, so UTC is only the arithmetic. */
function dayNumber(date: string): number {
  if (!DATE.test(date)) throw new TypeError(`Not a date: ${JSON.stringify(date)}`);
  return Math.round(Date.parse(`${date}T00:00:00Z`) / DAY);
}

function fromDayNumber(day: number): string {
  return new Date(day * DAY).toISOString().slice(0, 10);
}

/** A date moved by a number of days, either way. */
export function shiftDate(date: string, days: number): string {
  return fromDayNumber(dayNumber(date) + days);
}

/** `to` less `from`, in days. */
export function daysBetween(from: string, to: string): number {
  return dayNumber(to) - dayNumber(from);
}

/**
 * How many days a phase occupies, counting both ends. A phase that starts
 * and ends on the Tuesday is one day of work, not none, and a schedule that
 * says otherwise makes every one day phase invisible to the critical path.
 */
export function durationDays(startsOn: string, endsOn: string): number {
  return daysBetween(startsOn, endsOn) + 1;
}

/* ---------------------------------------------------------------- schedule */

export type PhaseStatus = "not_started" | "in_progress" | "blocked" | "complete";

export interface PlannedPhase {
  id: string;
  name: string;
  sequence: number;
  /** The one phase this waits for. See `schema/projects.ts` for why there is only one. */
  dependsOnPhaseId: string | null;
  startsOn: string | null;
  endsOn: string | null;
  status: PhaseStatus;
}

export interface PhaseStanding {
  id: string;
  /** Both dates set, and the end not before the start. */
  scheduled: boolean;
  durationDays: number | null;
  /**
   * TOTAL FLOAT: how many days this phase can slip before the finish date
   * moves. Null for a phase with no dates, which is not zero: zero says it
   * is critical and an unscheduled phase is not known to be anything.
   */
  floatDays: number | null;
  /**
   * On the critical path: a day lost here is a day on the finish. A finished
   * phase is never critical, because it cannot slip any more, and lighting
   * it up would draw the eye to the one part of the plan nobody can change.
   */
  critical: boolean;
  /**
   * Starts on or before the day the phase it waits for ends. A plan drawn
   * that way cannot happen as drawn, and it is said rather than silently
   * corrected, because the correction is somebody's decision.
   */
  overlapsPredecessor: boolean;
}

export interface ScheduleAnalysis {
  start: string | null;
  finish: string | null;
  /** In the order the phases were given. */
  phases: PhaseStanding[];
  /** The critical phases, earliest first. */
  criticalPath: string[];
  /** Phases left out because they have no dates. */
  unscheduled: string[];
  /** One sentence for the top of the schedule. */
  statement: string;
}

const isScheduled = (p: PlannedPhase): p is PlannedPhase & { startsOn: string; endsOn: string } =>
  p.startsOn !== null && p.endsOn !== null && DATE.test(p.startsOn) && DATE.test(p.endsOn)
  && p.endsOn >= p.startsOn;

/**
 * THE CRITICAL PATH, BY THE BACKWARD PASS, AGAINST THE DATES AS PLANNED.
 *
 * A textbook critical path computes the earliest dates from durations and
 * then the latest. This one is handed dates somebody already chose, so it
 * only needs the second half: the latest each phase may finish without
 * moving the finish date, given everything that waits for it. The gap
 * between that and when it is planned to finish is its float, and a phase
 * with none is critical.
 *
 * Measured against the PLANNED dates rather than recomputed ones, because
 * those are the dates the customer has been told and the crews have been
 * booked on. A schedule that quietly reflowed everything to its earliest
 * possible start would show a critical path for a plan nobody is working to.
 *
 * Each phase waits for at most one other, so what waits on a phase is a tree
 * hanging off it and the backward pass is a walk down each tree. A ring is
 * refused when a dependency is set; the walk still guards against one, so a
 * row edited by hand in the database cannot hang a page.
 */
export function analyseSchedule(phases: readonly PlannedPhase[]): ScheduleAnalysis {
  const planned = phases.filter(isScheduled);
  const byId = new Map(planned.map((p) => [p.id, p]));
  const successors = new Map<string, (PlannedPhase & { startsOn: string; endsOn: string })[]>();
  for (const phase of planned) {
    if (phase.dependsOnPhaseId && byId.has(phase.dependsOnPhaseId)) {
      const list = successors.get(phase.dependsOnPhaseId) ?? [];
      list.push(phase);
      successors.set(phase.dependsOnPhaseId, list);
    }
  }

  const start = planned.length > 0
    ? planned.reduce((min, p) => (p.startsOn < min ? p.startsOn : min), planned[0]!.startsOn)
    : null;
  const finish = planned.length > 0
    ? planned.reduce((max, p) => (p.endsOn > max ? p.endsOn : max), planned[0]!.endsOn)
    : null;

  /** The latest day each phase may end without moving the finish. */
  const latestFinish = new Map<string, number>();
  const walking = new Set<string>();
  const latest = (phase: PlannedPhase & { startsOn: string; endsOn: string }): number => {
    const known = latestFinish.get(phase.id);
    if (known !== undefined) return known;
    if (walking.has(phase.id)) return dayNumber(finish!);
    walking.add(phase.id);
    let value = dayNumber(finish!);
    for (const next of successors.get(phase.id) ?? []) {
      /** The latest it may finish is the day before the latest its follower may start. */
      const followerLatestStart = latest(next) - durationDays(next.startsOn, next.endsOn) + 1;
      value = Math.min(value, followerLatestStart - 1);
    }
    walking.delete(phase.id);
    latestFinish.set(phase.id, value);
    return value;
  };

  const standings: PhaseStanding[] = phases.map((phase) => {
    if (!isScheduled(phase)) {
      return {
        id: phase.id, scheduled: false, durationDays: null, floatDays: null,
        critical: false, overlapsPredecessor: false,
      };
    }
    const float = latest(phase) - dayNumber(phase.endsOn);
    const predecessor = phase.dependsOnPhaseId ? byId.get(phase.dependsOnPhaseId) : undefined;
    return {
      id: phase.id,
      scheduled: true,
      durationDays: durationDays(phase.startsOn, phase.endsOn),
      floatDays: float,
      /**
       * Zero or less. Less than zero is a phase already late against what
       * waits for it, which is more critical than critical rather than less.
       */
      critical: float <= 0 && phase.status !== "complete",
      overlapsPredecessor: predecessor !== undefined && phase.startsOn <= predecessor.endsOn,
    };
  });

  const criticalPath = planned
    .filter((p) => standings.find((s) => s.id === p.id)?.critical)
    .sort((a, b) => a.startsOn.localeCompare(b.startsOn) || a.sequence - b.sequence)
    .map((p) => p.id);
  const unscheduled = phases.filter((p) => !isScheduled(p)).map((p) => p.id);

  return {
    start,
    finish,
    phases: standings,
    criticalPath,
    unscheduled,
    statement: scheduleStatement(finish, criticalPath.length, planned.length, unscheduled.length),
  };
}

function scheduleStatement(
  finish: string | null, critical: number, scheduled: number, unscheduled: number,
): string {
  if (finish === null) {
    return unscheduled === 0
      ? "There are no phases to schedule yet."
      : "No phase has a start and an end yet, so there is no finish date to protect.";
  }
  const parts = [`Planned to finish on ${finish}.`];
  parts.push(critical === 0
    ? "Every open phase has room to slip without moving that date."
    : `${critical} of ${scheduled} ${scheduled === 1 ? "phase is" : "phases are"} on the critical path: a day lost on ${critical === 1 ? "it" : "any of them"} is a day on the finish.`);
  if (unscheduled > 0) {
    parts.push(`${unscheduled} ${unscheduled === 1 ? "phase has" : "phases have"} no dates and ${unscheduled === 1 ? "is" : "are"} left out.`);
  }
  return parts.join(" ");
}

export interface PhaseMove {
  id: string;
  startsOn: string;
  endsOn: string;
}

export type MoveDecision =
  | { ok: true; shiftDays: number; moves: PhaseMove[] }
  | { ok: false; reason: string };

/**
 * DRAG A PHASE, AND EVERYTHING THAT WAITS FOR IT COMES WITH IT.
 *
 * Every phase downstream moves by the same number of days and keeps its
 * length, which is what a person dragging a bar means: the drywall still
 * takes four days, it just starts when the rough in now finishes. Moving
 * only the dragged phase would leave its followers starting before it
 * ends, which is a plan that cannot happen and a crew turning up to a site
 * that is not ready for them.
 *
 * Refused rather than adjusted, in three cases, each with the sentence:
 *
 *   It would start on or before the day the phase it waits for ends. The
 *   earliest day it can start is named, so the next drag lands.
 *
 *   It is complete. Its dates are what happened, and dragging history is
 *   how a schedule stops being evidence.
 *
 *   Something downstream of it is complete. Moving a finished phase is the
 *   same rewrite, reached sideways.
 *
 * A downstream phase with no dates is left where it is, which is nowhere:
 * there is nothing to move. Its own followers that do have dates still move,
 * because they still wait for this one, through it.
 */
export function movePhase(
  phases: readonly PlannedPhase[], phaseId: string, newStartsOn: string,
): MoveDecision {
  if (!DATE.test(newStartsOn)) return { ok: false, reason: "That is not a date." };
  const phase = phases.find((p) => p.id === phaseId);
  if (!phase) return { ok: false, reason: "That phase is not part of this project." };
  if (!isScheduled(phase)) {
    return {
      ok: false,
      reason: `${phase.name} has no dates to move. Give it a start and an end first.`,
    };
  }
  if (phase.status === "complete") {
    return {
      ok: false,
      reason: `${phase.name} is complete, so its dates are what happened. Reopen it first if the plan really changed.`,
    };
  }

  const predecessor = phase.dependsOnPhaseId
    ? phases.find((p) => p.id === phase.dependsOnPhaseId)
    : undefined;
  if (predecessor && isScheduled(predecessor) && newStartsOn <= predecessor.endsOn) {
    return {
      ok: false,
      reason: `${phase.name} waits for ${predecessor.name}, which finishes on ${predecessor.endsOn}. `
        + `The earliest it can start is ${shiftDate(predecessor.endsOn, 1)}.`,
    };
  }

  const shift = daysBetween(phase.startsOn, newStartsOn);
  if (shift === 0) return { ok: true, shiftDays: 0, moves: [] };

  const children = new Map<string, PlannedPhase[]>();
  for (const p of phases) {
    if (!p.dependsOnPhaseId) continue;
    const list = children.get(p.dependsOnPhaseId) ?? [];
    list.push(p);
    children.set(p.dependsOnPhaseId, list);
  }

  const downstream: PlannedPhase[] = [];
  const seen = new Set<string>([phase.id]);
  const queue = [...(children.get(phase.id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    downstream.push(next);
    queue.push(...(children.get(next.id) ?? []));
  }

  const finished = downstream.find((p) => p.status === "complete");
  if (finished) {
    return {
      ok: false,
      reason: `${finished.name} waits for ${phase.name} and is already complete, so moving ${phase.name} would rewrite when it happened.`,
    };
  }

  const moves: PhaseMove[] = [phase, ...downstream].filter(isScheduled).map((p) => ({
    id: p.id,
    startsOn: shiftDate(p.startsOn!, shift),
    endsOn: shiftDate(p.endsOn!, shift),
  }));
  return { ok: true, shiftDays: shift, moves };
}

/* ------------------------------------------------------------ change orders */

export interface ChangeOrderLine {
  /** Signed: a credit for work taken out is a negative quantity. */
  quantity: string;
  unitPrice: string;
  /** What it costs us. Null when nobody knows, which is not zero. */
  unitCost: string | null;
}

export interface ChangeOrderTotals {
  /** Each line, rounded to the cent. */
  lineTotals: string[];
  /** What the change adds to the contract. Negative for a credit. */
  amount: string;
  /** What it adds to our cost, over the lines whose cost is known. */
  cost: string;
  /** False when a line has no cost, so `cost` is a floor rather than a figure. */
  costKnown: boolean;
}

/**
 * WHAT A CHANGE ORDER ADDS UP TO.
 *
 * Rounded per line, which is the opposite of what an invoice does and on
 * purpose. A change order is a contract document a customer signs, and a
 * signed page whose printed lines do not add up to its printed total is a
 * page somebody argues about. Rounding each line to the cent and summing the
 * rounded lines is the only way the arithmetic on the paper is the
 * arithmetic that was agreed.
 */
export function changeOrderTotals(lines: readonly ChangeOrderLine[]): ChangeOrderTotals {
  const totals = lines.map((line) => m.round(m.multiply(m.money(line.unitPrice), line.quantity), 2));
  const costs = lines.map((line) =>
    line.unitCost === null ? null : m.round(m.multiply(m.money(line.unitCost), line.quantity), 2));
  return {
    lineTotals: totals.map(m.toString),
    amount: m.toString(m.sum(totals)),
    cost: m.toString(m.sum(costs.filter((c): c is m.Money => c !== null))),
    costKnown: costs.every((c) => c !== null),
  };
}

export interface ContractPosition {
  /** Null when no contract value has been agreed. */
  contractValue: string | null;
  /** Null when nobody set a budget. */
  budgetCost: string | null;
  /** Everything invoiced on the project so far: raised draws and invoiced applications. */
  billedToDate: string;
  /** What the phases' billing values add up to. */
  scheduledValue: string;
  /** The phase the change lands on, if it names one. */
  phase?: {
    name: string;
    billingValue: string | null;
    budgetCost: string | null;
    /** Drawn against this phase, or certified against it on an application. */
    billedAgainst: string;
  } | null | undefined;
}

export type FoldDecision =
  | {
      ok: true;
      contractValue: string;
      /** Unchanged when there was no budget to change, or the change has no known cost. */
      budgetCost: string | null;
      /** Null when the change names no phase. */
      phaseBillingValue: string | null;
      phaseBudgetCost: string | null;
    }
  | { ok: false; reason: string };

/**
 * WHAT AGREEING A CHANGE ORDER DOES TO THE PROJECT, OR WHY IT CANNOT.
 *
 * The amount goes onto the contract, and onto the phase it names so the
 * schedule of values still adds up to the contract. The cost goes onto the
 * budget the same way. A change that names no phase becomes a line of its
 * own on the schedule of values, which is how a certifier expects to see
 * one.
 *
 * REFUSED, with the sentence, when:
 *
 *   The project has no agreed contract. A change to a price nobody agreed
 *   has nothing to change, and treating the missing contract as zero would
 *   make the first change order the whole contract.
 *
 *   A credit would take the contract below what has been billed, or below
 *   what the phases add up to. The first leaves the customer holding
 *   invoices for more than the job is worth; the second is a schedule of
 *   values that adds up to more than the contract.
 *
 *   A credit would take a phase below what has been billed against it, or
 *   below nothing.
 *
 *   A credit names no phase. A schedule of values line worth less than
 *   nothing cannot be billed against, so a credit has to say which part of
 *   the work it comes out of.
 *
 * A BUDGET NOBODY SET STAYS UNSET. Adding a change's cost to a missing
 * budget would invent one equal to the change, and every variance read off
 * it afterwards would be a variance against a number nobody chose.
 */
export function foldChangeOrder(
  position: ContractPosition, change: { amount: string; cost: string | null },
): FoldDecision {
  if (position.contractValue === null) {
    return {
      ok: false,
      reason: "This project has no agreed contract value, so a change to it has nothing to change. "
        + "Set the contract value first.",
    };
  }
  const amount = m.money(change.amount);
  const contract = m.add(m.money(position.contractValue), amount);
  const billed = m.money(position.billedToDate);
  const phase = position.phase ?? null;

  if (m.isNegative(amount) && phase === null) {
    return {
      ok: false,
      reason: "A change that takes money off the contract has to say which phase it comes out of. "
        + "A schedule of values line worth less than nothing cannot be billed against.",
    };
  }
  if (m.compare(contract, billed) < 0) {
    return {
      ok: false,
      reason: `This project has already billed ${m.format(billed)}, so a change taking the contract to `
        + `${m.format(contract)} cannot be agreed. Those are invoices the customer is holding.`,
    };
  }
  if (phase === null && m.compare(contract, m.money(position.scheduledValue)) < 0) {
    return {
      ok: false,
      reason: `The phases add up to ${m.format(m.money(position.scheduledValue))}, more than the `
        + `${m.format(contract)} this change would leave on the contract.`,
    };
  }

  let phaseBillingValue: string | null = null;
  let phaseBudgetCost: string | null = null;
  if (phase !== null) {
    const next = m.add(m.money(phase.billingValue ?? "0"), amount);
    if (m.isNegative(next)) {
      return {
        ok: false,
        reason: `${phase.name} carries ${m.format(m.money(phase.billingValue ?? "0"))}, so a credit of `
          + `${m.format(m.abs(amount))} cannot come out of it.`,
      };
    }
    if (m.compare(next, m.money(phase.billedAgainst)) < 0) {
      return {
        ok: false,
        reason: `${m.format(m.money(phase.billedAgainst))} has already been billed against ${phase.name}, `
          + `so this change cannot take it down to ${m.format(next)}.`,
      };
    }
    phaseBillingValue = m.toString(next);
    phaseBudgetCost = phase.budgetCost === null || change.cost === null
      ? phase.budgetCost
      : m.toString(m.add(m.money(phase.budgetCost), m.money(change.cost)));
  }

  return {
    ok: true,
    contractValue: m.toString(contract),
    budgetCost: position.budgetCost === null || change.cost === null
      ? position.budgetCost
      : m.toString(m.add(m.money(position.budgetCost), m.money(change.cost))),
    phaseBillingValue,
    phaseBudgetCost,
  };
}

/**
 * The contract as first agreed: what it is now, less every change order
 * agreed since. Derived rather than stored, so it cannot disagree with the
 * change order log it is read beside.
 */
export function originalContractSum(contractValue: string, approvedChanges: readonly string[]): string {
  return m.toString(m.subtract(m.money(contractValue), m.sum(approvedChanges.map((a) => m.money(a)))));
}

/* --------------------------------------------- the application for payment */

export interface ApplicationLineInput {
  key: string;
  description: string;
  /** What this line of the schedule of values is worth. */
  scheduledValue: string;
  /** Work completed on earlier applications. */
  previousWork: string;
  /** Materials stored and not yet installed, as the previous application said. */
  previousStored: string;
  /** Work completed this period. */
  workThisPeriod: string;
  /** Materials presently stored and not yet in the work, as of this application. */
  storedNow: string;
}

export interface ApplicationInput {
  lines: readonly ApplicationLineInput[];
  /** The contract sum to date, change orders included. */
  contractSum: string;
  /** The net of every change order agreed so far. */
  netChangeOrders: string;
  /** Retainage held on completed work, as a fraction: "0.1" for ten per cent. */
  retainageRate: string;
  /** Retainage held on stored materials, as a fraction. */
  storedRetainageRate: string;
  /** Retainage released on earlier applications. */
  retainageReleasedBefore: string;
  /** Retainage released on this one. */
  retainageReleasedNow: string;
  /** What the previous application certified as earned less retainage, or nothing. */
  previousCertificates: string;
}

export interface ApplicationLine extends ApplicationLineInput {
  /** Completed and stored to date: earlier work, this period's, and what is stored now. */
  completedAndStored: string;
  /** Of the scheduled value, to two places: "45.25" for forty five and a quarter per cent. */
  percentComplete: string;
  balanceToFinish: string;
  /** This application's movement on the line: completed and stored now, less on the last one. */
  thisPeriod: string;
}

export interface ApplicationTotals {
  originalContractSum: string;
  netChangeOrders: string;
  contractSumToDate: string;
  totalCompletedAndStored: string;
  retainageOnWork: string;
  retainageOnStored: string;
  /** Released to date, this application included. */
  retainageReleased: string;
  /** Held now: on work and stored, less what has been released. */
  totalRetainage: string;
  totalEarnedLessRetainage: string;
  previousCertificates: string;
  currentPaymentDue: string;
  /** What is left on the contract, retainage included. */
  balanceToFinish: string;
}

export type ApplicationDecision =
  | { ok: true; lines: ApplicationLine[]; totals: ApplicationTotals }
  | { ok: false; problems: string[] };

/**
 * ONE APPLICATION FOR PAYMENT, IN THE SHAPE A CERTIFIER READS.
 *
 * The continuation sheet's columns per line (scheduled value, work from
 * earlier applications, work this period, materials presently stored,
 * completed and stored to date, per cent, balance to finish) and the summary
 * sheet's nine lines (original contract, net change orders, contract to date,
 * completed and stored, retainage, earned less retainage, previous
 * certificates, payment due now, balance to finish).
 *
 * RETAINAGE IS COMPUTED ON THE TOTALS, rounded once to the cent, at its own
 * rate for work and for stored materials, because those are the two figures
 * the summary prints and the two a certifier checks. A per line retainage
 * rounded and summed differs from it by cents on a long schedule, and which
 * of the two is right is then an argument.
 *
 * RELEASING RETAINAGE IS A NUMBER, NOT A RATE CHANGE ALONE. Lowering the
 * rate (ten per cent to five at the halfway point) releases the difference
 * and so does an explicit release at the end; both land on the same line.
 * Releasing more than is held is refused.
 *
 * REFUSED, as a list of every problem rather than the first, because a
 * twelve line schedule with three wrong lines should not take three tries:
 *
 *   A schedule of values that does not add up to the contract to date. The
 *   summary sheet's third line and the continuation sheet's total are the
 *   same number, and an application where they differ is rejected unread.
 *
 *   Work or stored materials below nothing.
 *
 *   A line billed past its scheduled value. Overbilling a line is either a
 *   change order nobody wrote or a mistake, and both are cheaper to find
 *   here than after the customer has paid it.
 *
 *   A line whose completed and stored figure is lower than the last
 *   application's. Work certified once does not un-happen; a reduction is a
 *   credit note against the invoice that billed it.
 *
 *   A payment due below nothing. Same reason.
 */
export function computeApplication(input: ApplicationInput): ApplicationDecision {
  const problems: string[] = [];
  const contractSum = m.money(input.contractSum);

  const lines: ApplicationLine[] = input.lines.map((line) => {
    const scheduled = m.money(line.scheduledValue);
    const previousWork = m.money(line.previousWork);
    const previousStored = m.money(line.previousStored);
    const work = m.money(line.workThisPeriod);
    const stored = m.money(line.storedNow);
    const completed = m.add(m.add(previousWork, work), stored);
    const before = m.add(previousWork, previousStored);

    if (m.isNegative(work)) problems.push(`${line.description}: work this period cannot be less than nothing.`);
    if (m.isNegative(stored)) problems.push(`${line.description}: stored materials cannot be less than nothing.`);
    if (m.compare(completed, scheduled) > 0) {
      problems.push(
        `${line.description} would be billed to ${m.format(completed)} against a scheduled value of `
        + `${m.format(scheduled)}. More than the line is worth is a change order nobody wrote.`,
      );
    }
    if (m.compare(completed, before) < 0) {
      problems.push(
        `${line.description} was certified at ${m.format(before)} on the last application and would go down `
        + `to ${m.format(completed)}. Work certified once is a credit note to take back, not a smaller number.`,
      );
    }

    return {
      ...line,
      completedAndStored: m.toString(completed),
      percentComplete: percentOf(completed, scheduled),
      balanceToFinish: m.toString(m.subtract(scheduled, completed)),
      thisPeriod: m.toString(m.subtract(completed, before)),
    };
  });

  const scheduledTotal = m.sum(input.lines.map((l) => m.money(l.scheduledValue)));
  if (!m.equals(scheduledTotal, contractSum)) {
    const gap = m.subtract(contractSum, scheduledTotal);
    problems.push(
      `The schedule of values adds up to ${m.format(scheduledTotal)} and the contract to date is `
      + `${m.format(contractSum)}, ${m.format(m.abs(gap))} ${m.isNegative(gap) ? "over" : "short"}. `
      + "Give every part of the contract a phase with a billing value before applying for payment.",
    );
  }

  const workToDate = m.sum(input.lines.map((l) => m.add(m.money(l.previousWork), m.money(l.workThisPeriod))));
  const storedToDate = m.sum(input.lines.map((l) => m.money(l.storedNow)));
  const completedToDate = m.add(workToDate, storedToDate);

  const onWork = m.round(m.multiply(workToDate, input.retainageRate), 2);
  const onStored = m.round(m.multiply(storedToDate, input.storedRetainageRate), 2);
  const held = m.add(onWork, onStored);
  const released = m.add(m.money(input.retainageReleasedBefore), m.money(input.retainageReleasedNow));
  if (m.isNegative(m.money(input.retainageReleasedNow))) {
    problems.push("Retainage released cannot be less than nothing.");
  }
  if (m.compare(released, held) > 0) {
    problems.push(
      `This would release ${m.format(released)} of retainage in all, and ${m.format(held)} is held. `
      + "Retainage that was never held cannot be released.",
    );
  }
  const totalRetainage = m.max(m.subtract(held, released), m.zero());
  const earned = m.subtract(completedToDate, totalRetainage);
  const previous = m.money(input.previousCertificates);
  const due = m.subtract(earned, previous);
  if (m.isNegative(due)) {
    problems.push(
      `This application would certify ${m.format(earned)} against ${m.format(previous)} already certified. `
      + "A reduction is a credit note against the invoice that billed it, not a negative application.",
    );
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    lines,
    totals: {
      originalContractSum: m.toString(m.subtract(contractSum, m.money(input.netChangeOrders))),
      netChangeOrders: m.toString(m.money(input.netChangeOrders)),
      contractSumToDate: m.toString(contractSum),
      totalCompletedAndStored: m.toString(completedToDate),
      retainageOnWork: m.toString(onWork),
      retainageOnStored: m.toString(onStored),
      retainageReleased: m.toString(released),
      totalRetainage: m.toString(totalRetainage),
      totalEarnedLessRetainage: m.toString(earned),
      previousCertificates: m.toString(previous),
      currentPaymentDue: m.toString(due),
      balanceToFinish: m.toString(m.subtract(contractSum, earned)),
    },
  };
}

/**
 * A part of a whole as a percentage to two places, from the bigints, so
 * "33.33" is what a third reads as on every machine. Nothing of nothing is
 * nought rather than a division by zero.
 */
function percentOf(part: m.Money, whole: m.Money): string {
  if (whole.amount === 0n) return "0.00";
  const basisPoints = (part.amount * 10_000n * 2n + whole.amount) / (whole.amount * 2n);
  const negative = basisPoints < 0n;
  const abs = negative ? -basisPoints : basisPoints;
  return `${negative ? "-" : ""}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}

export interface PaymentLine {
  /** The schedule of values line it bills, or null for retainage released. */
  key: string | null;
  name: string;
  description: string;
  amount: string;
}

export type PaymentLinesDecision =
  | { ok: true; lines: PaymentLine[]; total: string }
  | { ok: false; reason: string };

/**
 * THE INVOICE AN APPLICATION BECOMES, ADDING UP TO ITS PAYMENT DUE.
 *
 * One invoice line per schedule of values line that moved this period, at
 * what moved less its share of the retainage held this period, and a line of
 * its own for retainage released. Each line says the gross and the
 * retainage in its description, and the application document carries every
 * figure behind it.
 *
 * WHY THE LINES ARE NET RATHER THAN GROSS WITH A DEDUCTION. An invoice in
 * this product has no negative lines: an amount off is a discount, and a
 * discount posts to the discounts account. Retainage is not a discount. It
 * is money earned and not yet payable, and dressing it as a discount would
 * put every retained dollar of a two year job in the discounts account and
 * take it out again at the end. So revenue is booked as it is billed: the
 * net now, the retainage when it is released and invoiced. The application
 * still shows everything held.
 *
 * The held share is allocated by each line's movement with core's
 * allocation, so the lines sum to the payment due to the cent. The total is
 * checked against the application's own figure anyway, because two pieces
 * of arithmetic that should agree are cheaper to compare than to trust.
 */
export function paymentLines(
  application: { lines: readonly ApplicationLine[]; totals: ApplicationTotals },
  previousRetainage: string,
): PaymentLinesDecision {
  const moved = application.lines
    .map((line) => ({ line, amount: m.money(line.thisPeriod) }))
    .filter((x) => m.isPositive(x.amount));
  const heldNow = m.subtract(m.money(application.totals.totalRetainage), m.money(previousRetainage));

  const out: PaymentLine[] = [];
  if (!m.isNegative(heldNow)) {
    const shares = moved.length > 0 && m.isPositive(heldNow)
      ? m.allocate(heldNow, moved.map((x) => m.toString(x.amount)), 2)
      : moved.map(() => m.zero());
    moved.forEach((x, i) => {
      const share = shares[i] ?? m.zero();
      const net = m.subtract(x.amount, share);
      if (!m.isPositive(net)) return;
      out.push({
        key: x.line.key,
        name: x.line.description,
        description: m.isPositive(share)
          ? `This period ${m.format(x.amount)}, less ${m.format(share)} retainage held`
          : `This period ${m.format(x.amount)}`,
        amount: m.toString(net),
      });
    });
  } else {
    for (const x of moved) {
      out.push({
        key: x.line.key, name: x.line.description,
        description: `This period ${m.format(x.amount)}`, amount: m.toString(x.amount),
      });
    }
    out.push({
      key: null,
      name: "Retainage released",
      description: `Retainage held on earlier applications, released on this one`,
      amount: m.toString(m.negate(heldNow)),
    });
  }

  const total = m.sum(out.map((l) => m.money(l.amount)));
  if (!m.isPositive(total)) {
    return { ok: false, reason: "Nothing is due on this application, so there is nothing to invoice." };
  }
  if (!m.equals(total, m.money(application.totals.currentPaymentDue))) {
    return {
      ok: false,
      reason: `The invoice lines add up to ${m.format(total)} and the application says `
        + `${m.format(m.money(application.totals.currentPaymentDue))} is due. Nothing was invoiced.`,
    };
  }
  return { ok: true, lines: out, total: m.toString(total) };
}

/* ---------------------------------------------------- notices and waivers */

export type LienRecordKind = "notice" | "waiver";
export type WaiverCondition = "conditional" | "unconditional";
export type WaiverScope = "progress" | "final";

export interface LienRecordLike {
  id: string;
  kind: LienRecordKind;
  direction: "sent" | "received";
  condition: WaiverCondition | null;
  scope: WaiverScope | null;
  partyName: string;
  onDate: string;
  amount: string | null;
  /** The payment it is against: a raised draw's or an application's invoice. */
  invoiceId: string | null;
}

export interface PaymentForWaivers {
  invoiceId: string;
  label: string;
  amount: string;
  billedOn: string | null;
  /** Nothing left owing on the invoice. */
  paid: boolean;
}

export interface WaiverChecklistRow extends PaymentForWaivers {
  conditional: LienRecordLike[];
  unconditional: LienRecordLike[];
  /** Plain statements of what is and is not on file. Never a statement of law. */
  notes: string[];
}

/**
 * THE CHECKLIST PER PAYMENT, AND WHAT IT DELIBERATELY DOES NOT SAY.
 *
 * For every payment the project has billed, the waivers on file against it,
 * conditional and unconditional, and plain notes about what is and is not
 * on file. That is the whole of it.
 *
 * NO STATE'S RULES ARE IN HERE, and that is the design rather than a gap.
 * Which notices are required, by when, in what form, whether a waiver must
 * follow a statutory form and when a conditional one becomes effective all
 * differ by state, change, and carry consequences a contractor needs a
 * lawyer for. A checklist that said "your preliminary notice is late" would
 * be this product giving legal advice, and the first time it was wrong it
 * would be wrong about somebody's right to be paid. So the notes say what
 * the records say: nothing on file, only a conditional one, an amount that
 * differs from the payment. Deciding what that means is the person's job.
 */
export function waiverChecklist(
  payments: readonly PaymentForWaivers[], records: readonly LienRecordLike[],
): WaiverChecklistRow[] {
  return payments.map((payment) => {
    const against = records.filter((r) => r.kind === "waiver" && r.invoiceId === payment.invoiceId);
    const conditional = against.filter((r) => r.condition === "conditional");
    const unconditional = against.filter((r) => r.condition === "unconditional");
    const notes: string[] = [];
    if (against.length === 0) {
      notes.push("No waiver is on file against this payment.");
    } else {
      if (payment.paid && unconditional.length === 0) {
        notes.push("Paid, and only a conditional waiver is on file.");
      }
      for (const record of against) {
        if (record.amount !== null && !m.equals(m.money(record.amount), m.money(payment.amount))) {
          notes.push(
            `The ${record.condition === null ? "" : `${record.condition} `}waiver from ${record.partyName} is for `
            + `${m.format(m.money(record.amount))}, and this payment is ${m.format(m.money(payment.amount))}.`,
          );
        }
      }
    }
    return { ...payment, conditional, unconditional, notes };
  });
}
