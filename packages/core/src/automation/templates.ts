import type { PlanNode } from "./index.js";

/**
 * RECOMMENDED AUTOMATIONS
 *
 * Two automations nearly every trades company wants and, until these, had to
 * build for themselves on a canvas: chase the estimate nobody answered, and
 * ask for a review once the job is paid. Both are the most valuable things a
 * small office forgets to do, and both were possible and unbuilt in almost
 * every company that tried the product.
 *
 * A TEMPLATE IS A STARTING DEFINITION AND NOTHING ELSE. Installing one writes
 * an ordinary workflow, published through the same check every hand built one
 * goes through, with the same permission rule and the same versions, and the
 * company edits it on the same canvas. There is no hidden logic: what runs is
 * what the canvas shows, and a company that wants a different wording, an
 * extra wait or no email at all changes the workflow, not the template.
 *
 * Here rather than in the service because the screen draws the parameters and
 * the server builds the definition, and both have to agree on what a template
 * is. The same argument as `flattenPlan`.
 */

export interface TemplateParameter {
  key: string;
  label: string;
  /** One sentence beside the box, in a trades owner's words. */
  help: string;
  kind: "number" | "platform";
  /** For a number: the default, and the inclusive bounds. */
  default?: number;
  min?: number;
  max?: number;
}

export interface TemplateDefinition {
  name: string;
  description: string;
  triggerKind: "event";
  triggerEvents: string[];
  steps: PlanNode[];
}

export interface WorkflowTemplate {
  key: string;
  name: string;
  /** What it does, as the recommended list says it. */
  summary: string;
  /** What has to be true in the company for it to do anything, said up front. */
  needs: string;
  parameters: TemplateParameter[];
}

export const TEMPLATES: readonly WorkflowTemplate[] = [
  {
    key: "estimate_follow_up",
    name: "Follow up an estimate that has not been answered",
    summary:
      "Some days after an estimate is sent, if the customer has not approved or declined it, "
      + "text them the link to it, then email it, then put a call in the office queue.",
    needs:
      "A registered texting number for the text and a connected email provider for the email. "
      + "A customer who has not agreed to texts is not texted; the email and the call still happen.",
    parameters: [{
      key: "days",
      label: "Days to wait after sending",
      help: "Three is what most offices use. Less reads as pushy; more and they have hired somebody else.",
      kind: "number", default: 3, min: 1, max: 30,
    }],
  },
  {
    key: "review_after_paid",
    name: "Ask for a review after a paid job",
    summary:
      "A while after a job's invoice is paid in full, ask the customer for a review, by text, "
      + "if your review rules allow it and they have not been asked recently.",
    needs:
      "Your review rules set under Reviews, and the place customers leave reviews declared there with its link. "
      + "The rules decide who is asked and when; this only does the asking.",
    parameters: [
      {
        key: "hours",
        label: "Hours to wait after payment",
        help: "Your review rules can hold it later still, for the evening cut off or a customer asked last month.",
        kind: "number", default: 2, min: 0, max: 168,
      },
      {
        key: "platform",
        label: "Where to send them",
        help: "One of the review sites you have declared, with its link.",
        kind: "platform",
      },
    ],
  },
];

export const templateByKey = (key: string): WorkflowTemplate | undefined =>
  TEMPLATES.find((t) => t.key === key);

export type TemplateBuild =
  | { ok: true; definition: TemplateDefinition }
  | { ok: false; reason: string };

/**
 * A whole number inside a parameter's bounds, or the reason it is not.
 *
 * Refused rather than clamped. Somebody typing 90 into "days to wait" and
 * getting 30 has an automation that does something they did not ask for and
 * a screen that says they did.
 */
function numberOf(parameter: TemplateParameter, raw: unknown): number | string {
  const given = raw === undefined || raw === null || raw === "" ? parameter.default : Number(raw);
  if (given === undefined || !Number.isInteger(given)) {
    return `${parameter.label} has to be a whole number.`;
  }
  if (parameter.min !== undefined && given < parameter.min) {
    return `${parameter.label} cannot be less than ${parameter.min}.`;
  }
  if (parameter.max !== undefined && given > parameter.max) {
    return `${parameter.label} cannot be more than ${parameter.max}.`;
  }
  return given;
}

/**
 * The workflow a template installs, with the company's own values in it.
 *
 * The copy is plain, short and the company's to change: it is a starting
 * point on the canvas, and a placeholder that resolves to nothing becomes an
 * empty string rather than braces in a customer's text.
 */
export function buildTemplate(key: string, values: Record<string, unknown>): TemplateBuild {
  const template = templateByKey(key);
  if (!template) return { ok: false, reason: `There is no recommended automation called ${key}.` };

  if (key === "estimate_follow_up") {
    const days = numberOf(template.parameters[0]!, values["days"]);
    if (typeof days === "string") return { ok: false, reason: days };

    return {
      ok: true,
      definition: {
        name: template.name,
        description:
          `Installed from the recommended list. ${days} ${days === 1 ? "day" : "days"} after an estimate `
          + "is sent, if it is still waiting for an answer: text the link, email the link, then raise a "
          + "call for the office.",
        triggerKind: "event",
        triggerEvents: ["estimate.sent"],
        steps: [
          { kind: "wait", config: { days } },
          { kind: "stop_unless", config: { check: "estimate_undecided" } },
          {
            kind: "send_estimate",
            config: {
              channel: "sms",
              body: "Hi {{ customer.name }}, it is {{ organization.name }}. Just checking you saw "
                + "estimate #{{ estimate.number }}. You can read it and approve it here: {{ link }}",
            },
          },
          {
            kind: "send_estimate",
            config: {
              channel: "email",
              subject: "Your estimate from {{ organization.name }}",
              body: "Hi {{ customer.name }},\n\nWe sent you estimate #{{ estimate.number }} a few "
                + "days ago and wanted to make sure it reached you. You can read it, choose an "
                + "option and approve it here:\n\n{{ link }}\n\nIf you have questions, just reply "
                + "to this email.\n\n{{ organization.name }}",
            },
          },
          {
            kind: "create_task",
            config: {
              title: "Ring {{ customer.name }} about estimate #{{ estimate.number }}",
              queue: "office",
              dueInHours: 24,
            },
          },
        ],
      },
    };
  }

  if (key === "review_after_paid") {
    const hours = numberOf(template.parameters[0]!, values["hours"]);
    if (typeof hours === "string") return { ok: false, reason: hours };
    const platform = typeof values["platform"] === "string" ? values["platform"].trim() : "";
    if (platform === "") {
      return {
        ok: false,
        reason: "Choose where to send them. Declare a review site with its link under Reviews first.",
      };
    }

    return {
      ok: true,
      definition: {
        name: template.name,
        description:
          `Installed from the recommended list. ${hours} ${hours === 1 ? "hour" : "hours"} after a job's `
          + "invoice is paid, ask for a review if your review rules allow it.",
        triggerKind: "event",
        triggerEvents: ["invoice.paid"],
        steps: [
          { kind: "wait", config: { hours } },
          { kind: "request_review", config: { platform } },
          {
            kind: "send_review_request",
            config: {
              channel: "sms",
              body: "Hi {{ customer.name }}, thank you for choosing {{ organization.name }}. If you "
                + "have a minute, a review helps a local business like ours more than anything: "
                + "{{ review.url }}",
            },
          },
        ],
      },
    };
  }

  return { ok: false, reason: `There is no recommended automation called ${key}.` };
}
