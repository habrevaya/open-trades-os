import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * CONNECTED APPLICATIONS, FROM THE APP'S SIDE
 *
 * One read: what this token may do. Before it, an integrator could only find
 * out by trying. The migration loader learned whether it held `data:import`
 * by posting a deliberately invalid back-dated invoice and reading a 403
 * against a 422, which is a write probe against a live company's books, one
 * change in validation order away from creating a junk invoice.
 */
export const ScopeValue = z.enum(["own", "crew", "business_unit", "location", "all"]);

export const getAppSelf = defineRoute({
  method: "get",
  path: "/v1/apps/me",
  summary: "What this app token may do",
  description:
    "The app behind the bearer token, the permissions it was granted and the record scope it holds on each scoped resource. Needs no permission, because it answers only about the caller. A signed-in person calling it gets a 404: there is no app behind a session.",
  module: "M28",
  permissions: [],
  input: z.object({}),
  output: z.object({
    appId: Uuid,
    name: z.string(),
    publisher: z.string().nullable(),
    organizationId: Uuid,
    /** Exactly what the install granted, sorted. An app inherits nothing from whoever installed it. */
    permissions: z.array(z.string()),
    /**
     * The scope in force on every scoped resource, not only the ones the
     * install named: an unnamed one resolves to `own`, which for an app
     * matches nothing, and that is worth knowing before a list comes back
     * empty.
     */
    scopes: z.record(ScopeValue),
  }),
});

export const appRoutes = { getAppSelf } as const;
