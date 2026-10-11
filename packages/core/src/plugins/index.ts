/**
 * PLUGINS: WHAT A CONNECTED APPLICATION MAY ADD TO A COMPANY
 *
 * Never code uploaded into this server. A plugin is declarative data an
 * application registers through the API, checked here against a closed
 * vocabulary and refused in words when it does not fit: a job workflow
 * (stages over the job statuses, with gates to leave them), a pricing rule
 * (one of four kinds), or a report type (a cut of one of the report
 * builder's datasets). The services store them, version them and turn them
 * off with the application; this decides what they mean.
 */
export const PLUGIN_KINDS = ["job_workflow", "pricing_rule", "report_type"] as const;
export type PluginKind = (typeof PLUGIN_KINDS)[number];

export const PLUGIN_KIND_LABEL: Record<PluginKind, string> = {
  job_workflow: "Job workflow",
  pricing_rule: "Pricing rule",
  report_type: "Report type",
};

export * from "./workflow.js";
export * from "./pricing.js";
export * from "./report-type.js";
