import { z } from "zod";
import { defineRoute } from "../lib/define";

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
});

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

export const portalLayoutRoutes = { getPortalLayout, setPortalLayout } as const;
