import { reports, deliverySchedules, type ServiceContext } from "@opentradesos/api/services";
import { can, reporting } from "@opentradesos/core";
import type { StepOption } from "@/app/(app)/automations/Canvas";

/**
 * The company's own records a step's fields pick from, attached to the step.
 *
 * Only the report step has any, and only for somebody who may read reports:
 * an author without `report:read` sees the step offered and refused on its
 * permissions, the way every step they cannot publish is, rather than a list
 * of reports they could not otherwise see.
 */
export async function withStepChoices(ctx: ServiceContext, steps: StepOption[]): Promise<StepOption[]> {
  if (!steps.some((step) => step.kind === "email_report") || !can(ctx.actor, "report:read")) return steps;
  const choices = {
    reports: [
      ...reports.builtIn(ctx).map((r) => ({ value: `builtIn:${r.slug}`, label: r.name })),
      ...(await reports.list(ctx)).map((r) => ({ value: `saved:${r.id}`, label: `${r.name} (saved)` })),
    ],
    people: (await deliverySchedules.recipientChoices(ctx)).map((p) => ({ userId: p.userId, name: p.name })),
    periods: reporting.PERIODS.map((p) => ({ key: p.key, label: p.label })),
  };
  return steps.map((step) => (step.kind === "email_report" ? { ...step, choices } : step));
}
