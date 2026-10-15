import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * WHAT A CUSTOMER'S ACCOUNT PAGE SHOWS, AS THE OFFICE ARRANGES IT
 *
 * Every block the page could show, in the order it draws them, each shown or
 * hidden, with a heading of the company's own or the usual one. Saving names
 * every block, so what is saved is the whole page. The bills cannot be hidden.
 * A company's own arrangement is never written over by a trade pack upgrade.
 */

const BlockKind = z.enum([
  "visit_timeline", "service_report", "readings_trend", "equipment_register",
  "checklist_results", "photo_gallery", "documents", "invoices", "payments",
  "plan_status", "next_visit", "recommended_work", "referral", "contact_card",
]);

const LayoutRow = z.object({
  kind: BlockKind,
  /** What the customer sees as the heading. */
  title: z.string(),
  /** The company's own heading, or null for the usual words. */
  customTitle: z.string().nullable(),
  /** The usual heading, for putting it back. */
  usualTitle: z.string(),
  visible: z.boolean(),
  hideable: z.boolean(),
});

const Layout = z.object({
  blocks: z.array(LayoutRow),
  /** Which trade pack's layout this started from, when one did. */
  startedFrom: z.string().nullable(),
  /** Whether the company has changed it from what the pack set up. */
  changed: z.boolean(),
  /** For a plan's page: which plan, and whether it has a layout of its own (false: its members see the company's). */
  plan: z.object({ id: Uuid, name: z.string(), ownLayout: z.boolean() }).nullable(),
});

const BlocksInput = z.array(z.object({
  kind: BlockKind,
  title: z.string().max(200).nullable().optional(),
  visible: z.boolean(),
})).min(1).max(30);

export const getPortalLayout = defineRoute({
  method: "get",
  path: "/v1/portal-layout",
  summary: "The blocks on a customer's account page, in order",
  description: "Every block the page could show: the ones it shows, in order, then the ones it does not. Starts from the layout the trade pack seeded.",
  module: "M05",
  permissions: ["settings:read"],
  input: z.object({}),
  output: Layout,
});

export const setPortalLayout = defineRoute({
  method: "put",
  path: "/v1/portal-layout",
  summary: "Rearrange, hide and retitle the blocks on a customer's account page",
  description:
    "Name every block once, in the order to draw them, each shown or not, with a heading of up to 60 characters or none for the usual words. The bills cannot be hidden. Saved on the company's layout, so a trade pack upgrade keeps it and lists it as the company's own.",
  module: "M05",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({
    blocks: z.array(z.object({
      kind: BlockKind,
      title: z.string().max(200).nullable().optional(),
      visible: z.boolean(),
    })).min(1).max(30),
  }),
  output: Layout,
});

export const listPlanPortalLayouts = defineRoute({
  method: "get",
  path: "/v1/portal-layout/plans",
  summary: "Which agreement plans have an account page of their own",
  description: "Every plan with whether its members see a layout of its own or the company's, and how many customers are members now (an active or past due agreement on it).",
  module: "M05",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({
    plans: z.array(z.object({ planId: Uuid, name: z.string(), active: z.boolean(), ownLayout: z.boolean(), members: z.number().int() })),
  }),
});

export const getPlanPortalLayout = defineRoute({
  method: "get",
  path: "/v1/agreement-plans/{id}/portal-layout",
  summary: "The account page a plan's members see",
  description: "The plan's own layout when it has one; otherwise the company's layout, which is what its members see, with `plan.ownLayout` false.",
  module: "M05",
  permissions: ["settings:read"],
  input: z.object({ id: Uuid }),
  output: Layout,
});

export const setPlanPortalLayout = defineRoute({
  method: "put",
  path: "/v1/agreement-plans/{id}/portal-layout",
  summary: "Give a plan's members an account page of their own, or change it",
  description:
    "Arranged exactly as the company's layout is: name every block once, in order, each shown or not, with a heading or none. Starts from the company's layout when the plan has none. Members are customers with an active or past due agreement on the plan; a customer on several plans with a layout lands on the one of their oldest active agreement and is offered the others to choose; everyone else sees the company's layout. Never touched by a trade pack upgrade.",
  module: "M05",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid, blocks: BlocksInput }),
  output: Layout,
});

export const removePlanPortalLayout = defineRoute({
  method: "post",
  path: "/v1/agreement-plans/{id}/portal-layout/remove",
  summary: "Put a plan's members back on the company's account page",
  description: "Deletes the plan's own layout. Its members see the company's layout again from their next visit. Removing what is not there changes nothing.",
  module: "M05",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ id: Uuid }),
  output: Layout,
});

export const portalLayoutRoutes = {
  getPortalLayout, setPortalLayout, listPlanPortalLayouts, getPlanPortalLayout, setPlanPortalLayout, removePlanPortalLayout,
} as const;
