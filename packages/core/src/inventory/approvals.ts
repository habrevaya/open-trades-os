import { type Money, compare, format } from "../money/index.js";

/**
 * WHO HAS TO SAY YES BEFORE AN ORDER GOES TO A VENDOR
 *
 * Before this, approval was one permission: whoever held `po:approve` could
 * send any order of any size, and whoever did not could send none. That is
 * fine for a company of four and wrong for one of forty, where the office
 * manager buys filters every week and nobody wants a six thousand dollar
 * compressor order going out on the same say so.
 *
 * So a company declares STEPS: an order at or over an amount needs somebody
 * holding a named role to approve it, and the steps are taken in order. Over
 * a thousand, the office manager; over five thousand, the owner as well. A
 * six thousand dollar order needs both, the office manager first, and a
 * three hundred dollar one needs neither and goes out as it always has, on
 * the sender's own `po:approve`.
 *
 * Two rules worth their reasons:
 *
 *   ONE PERSON, ONE STEP. Somebody who holds both roles cannot approve both
 *   steps of the same order. Two steps that one person can satisfy alone are
 *   one step with extra clicks, and the company asked for two people.
 *
 *   A REJECTION ENDS IT. A rejected order is not sent and is not approved
 *   again by asking a second time: it is cancelled, and a corrected order is
 *   a new order with a clean record. Approvals that can be retried until
 *   somebody says yes record nothing.
 */

export interface ApprovalRule {
  readonly id: string;
  readonly step: number;
  /** Orders at or over this need this step. */
  readonly minimumTotal: Money;
  /** The role, in words, for a sentence. */
  readonly roleLabel: string;
  /** A preset role name, or null when the step names one of the company's own roles. */
  readonly role: string | null;
  readonly roleId: string | null;
  /**
   * Which orders the step is for, beyond their size: orders to this vendor,
   * with a line from this category, delivering to this location. Absent or
   * null is every order. All that are set have to hold.
   */
  readonly vendorId?: string | null | undefined;
  readonly categoryId?: string | null | undefined;
  readonly locationId?: string | null | undefined;
  /** The scope in words for a sentence: "orders from Ferguson". Empty for every order. */
  readonly scopeLabel?: string | undefined;
}

/** What an order is, for deciding which scoped steps apply to it. */
export interface OrderScope {
  readonly vendorId: string;
  /** The price book category of every line's item. */
  readonly categoryIds: readonly string[];
  /** Where every line is going. */
  readonly locationIds: readonly string[];
}

/**
 * Does a step apply to this order, leaving its amount aside? A step scoped
 * to a category applies when ANY line is from it, and the amount it is
 * compared with is the whole order's total, not that line's share: asking
 * for more approval than a narrower reading would is the safe mistake.
 */
export function ruleCovers(rule: ApprovalRule, order: OrderScope | undefined): boolean {
  if (!rule.vendorId && !rule.categoryId && !rule.locationId) return true;
  if (!order) return false;
  if (rule.vendorId && rule.vendorId !== order.vendorId) return false;
  if (rule.categoryId && !order.categoryIds.includes(rule.categoryId)) return false;
  if (rule.locationId && !order.locationIds.includes(rule.locationId)) return false;
  return true;
}

export interface ApprovalRecord {
  readonly step: number;
  readonly decision: "approved" | "rejected";
  readonly decidedByUserId: string | null;
  readonly roleLabel: string;
  readonly minimumTotal: Money;
}

export interface ApprovalStep {
  readonly step: number;
  readonly ruleId: string | null;
  readonly minimumTotal: Money;
  readonly roleLabel: string;
  readonly role: string | null;
  readonly roleId: string | null;
  readonly state: "approved" | "rejected" | "waiting" | "later";
  readonly decidedByUserId: string | null;
  readonly scopeLabel: string;
}

export interface ApprovalPlan {
  /**
   * `not_needed`: no step applies, and the sender's own `po:approve` is the
   * approval, as it always was. `waiting`: a step is open. `approved`: every
   * step said yes. `rejected`: one said no.
   */
  readonly state: "not_needed" | "waiting" | "approved" | "rejected";
  readonly steps: readonly ApprovalStep[];
  /** The step waiting now, when one is. */
  readonly next: ApprovalStep | null;
  /** The state in one sentence, for the order's screen. */
  readonly sentence: string;
}

/**
 * The steps this order needs, and where each stands.
 *
 * A decision already recorded for a step stands even if the rule behind it
 * has since changed: the record copies what was asked. A step a rule no
 * longer requires, and that nobody decided, is not asked of the order.
 */
export function approvalPlan(input: {
  rules: readonly ApprovalRule[];
  total: Money;
  approvals: readonly ApprovalRecord[];
  /** The order's vendor, categories and locations, for scoped steps. Without it only unscoped steps apply. */
  order?: OrderScope | undefined;
}): ApprovalPlan {
  const applying = [...input.rules]
    .filter((rule) => compare(input.total, rule.minimumTotal) >= 0 && ruleCovers(rule, input.order))
    .sort((a, b) => a.step - b.step);
  const decided = new Map(input.approvals.map((a) => [a.step, a]));

  const byStep = new Map<number, ApprovalStep>();
  for (const rule of applying) {
    const record = decided.get(rule.step);
    byStep.set(rule.step, {
      step: rule.step,
      ruleId: rule.id,
      minimumTotal: record?.minimumTotal ?? rule.minimumTotal,
      roleLabel: record?.roleLabel ?? rule.roleLabel,
      role: rule.role,
      roleId: rule.roleId,
      state: record ? record.decision : "later",
      decidedByUserId: record?.decidedByUserId ?? null,
      scopeLabel: rule.scopeLabel ?? "",
    });
  }
  for (const record of input.approvals) {
    if (byStep.has(record.step)) continue;
    byStep.set(record.step, {
      step: record.step, ruleId: null, minimumTotal: record.minimumTotal, roleLabel: record.roleLabel,
      role: null, roleId: null, state: record.decision, decidedByUserId: record.decidedByUserId, scopeLabel: "",
    });
  }

  const ordered = [...byStep.values()].sort((a, b) => a.step - b.step);
  const firstOpen = ordered.find((s) => s.state === "later");
  const steps = ordered.map((s) => (s === firstOpen ? { ...s, state: "waiting" as const } : s));
  const next = steps.find((s) => s.state === "waiting") ?? null;
  const rejected = steps.find((s) => s.state === "rejected");

  if (steps.length === 0) {
    return {
      state: "not_needed", steps, next: null,
      sentence: "No approval step applies to an order of this size, so whoever may approve orders can send it.",
    };
  }
  if (rejected) {
    return {
      state: "rejected", steps, next: null,
      sentence: `Rejected at step ${rejected.step} (${rejected.roleLabel}). Cancel it, and raise a corrected order if one is still wanted.`,
    };
  }
  if (next) {
    const done = steps.filter((s) => s.state === "approved").length;
    return {
      state: "waiting", steps, next,
      sentence: `Waiting for ${article(next.roleLabel)} ${next.roleLabel.toLowerCase()} to approve it, step ${done + 1} of ${steps.length}, `
        + `because it is ${format(input.total)} and anything at or over ${format(next.minimumTotal)}`
        + `${next.scopeLabel ? ` on ${next.scopeLabel}` : ""} needs one.`,
    };
  }
  return {
    state: "approved", steps, next: null,
    sentence: `Approved at every step (${steps.map((s) => s.roleLabel).join(", then ")}). It can be sent to the vendor.`,
  };
}

const article = (word: string) => (/^[aeiou]/i.test(word) ? "an" : "a");

export type ApprovalDecisionCheck =
  | { ok: true; step: ApprovalStep }
  | { ok: false; reason: "nothing_waiting" | "rejected" | "wrong_role" | "already_decided_a_step"; message: string };

/**
 * May this person decide the step that is waiting?
 *
 * `holds` answers whether they hold the step's role, which the service reads
 * from their membership: a custom role replaces the preset, so somebody on a
 * custom role does not hold the preset it was copied from.
 */
export function checkDecision(input: {
  plan: ApprovalPlan;
  userId: string;
  holds: (step: ApprovalStep) => boolean;
}): ApprovalDecisionCheck {
  const { plan } = input;
  if (plan.state === "rejected") {
    return { ok: false, reason: "rejected", message: plan.sentence };
  }
  if (!plan.next) {
    return {
      ok: false, reason: "nothing_waiting",
      message: plan.state === "not_needed"
        ? "This order needs no approval step. Whoever may approve orders can send it."
        : "Every step of this order is already approved.",
    };
  }
  if (!input.holds(plan.next)) {
    return {
      ok: false, reason: "wrong_role",
      message: `Step ${plan.next.step} needs ${article(plan.next.roleLabel)} ${plan.next.roleLabel.toLowerCase()} to decide it.`,
    };
  }
  if (plan.steps.some((s) => s.decidedByUserId === input.userId && s.state !== "waiting")) {
    return {
      ok: false, reason: "already_decided_a_step",
      message: "You have already decided a step of this order. Each step needs a different person, or the company's two steps are one.",
    };
  }
  return { ok: true, step: plan.next };
}

/**
 * WHICH APPROVALS AN EDIT UNDOES.
 *
 * Each decision copied the total it approved. An edit that takes the order
 * above that total asks that step again: somebody said yes to four thousand
 * dollars, not to the six it became. An edit that keeps it at or under every
 * approved total leaves the decisions standing, because nobody approved a
 * ceiling the order has not passed. Returns the steps to ask again.
 */
export function approvalsUndoneBy(
  newTotal: Money, decisions: readonly { step: number; decision: "approved" | "rejected"; orderTotal: Money }[],
): number[] {
  return decisions
    .filter((d) => d.decision === "approved" && compare(newTotal, d.orderTotal) > 0)
    .map((d) => d.step);
}
