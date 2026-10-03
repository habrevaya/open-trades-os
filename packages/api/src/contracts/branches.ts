import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * M01. BRANCHES: A COMPANY DIVIDED INTO PARTS THAT EACH SEE THEIR OWN WORK
 *
 * A branch is a business unit (`/v1/business-units` creates, renames and
 * retires one). These routes are what make it mean something: putting
 * people and work in one, and the names a list's branch filter offers.
 * Limiting what somebody sees to their branch is a scope on a custom role
 * (`business_unit`), applied by every list and report the scope already
 * narrows.
 */

export const listBranchOptions = defineRoute({
  method: "get",
  path: "/v1/branches",
  summary: "The branches a list can be filtered by",
  description:
    "Live branches by name, the caller's own, and whether the caller's view is already narrower than the whole company, in which case a branch filter can only narrow it further. Open to anybody who reads jobs, customers, invoices, estimates or reports, because a dispatcher filtering a list needs the names and has no business in Settings.",
  module: "M01",
  permissions: ["job:read"],
  input: z.object({}),
  output: z.object({
    branches: z.array(z.object({ id: Uuid, name: z.string(), code: z.string().nullable() })),
    yours: Uuid.nullable(),
    narrowed: z.boolean(),
  }),
});

export const getBranchOverview = defineRoute({
  method: "get",
  path: "/v1/branch-overview",
  summary: "Each branch with its people and its work",
  description:
    "Every branch, retired ones too, with how many people belong to it and how many jobs (and open jobs) are in it; how many jobs are in no branch, which only people who see the whole company can see; and how many people have no branch.",
  module: "M01",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({
    branches: z.array(z.object({
      id: Uuid, name: z.string(), code: z.string().nullable(), active: z.boolean(),
      people: z.number().int(), openJobs: z.number().int(), jobs: z.number().int(),
    })),
    unassigned: z.object({ jobs: z.number().int(), openJobs: z.number().int() }),
    peopleWithoutBranch: z.number().int(),
  }),
});

export const assignJobsToBranch = defineRoute({
  method: "post",
  path: "/v1/branch-assignments",
  summary: "Put jobs in a branch, or take them out of every branch",
  description:
    "Up to five hundred at a time, each one audited on the job. Only somebody who sees the whole company may move work between branches, because a branch scoped person who moved a job elsewhere could no longer see it. A retired branch takes no new work.",
  module: "M01",
  permissions: ["job:write"],
  idempotent: true,
  dryRun: true,
  input: z.object({
    jobIds: z.array(Uuid).min(1).max(500),
    businessUnitId: Uuid.nullable(),
  }),
  output: z.object({ moved: z.number().int(), businessUnitId: Uuid.nullable() }),
});

export const setMemberBranch = defineRoute({
  method: "post",
  path: "/v1/memberships/{membershipId}/branch",
  summary: "Put somebody in a branch",
  description:
    "Their branch is what a branch scope shows them and where a job they book lands. Taking it away is refused while their role or their own limits show them only their branch, because they would then see nothing at all.",
  module: "M01",
  permissions: ["membership:write"],
  /** Setting a state. */
  idempotent: true,
  input: z.object({ membershipId: Uuid, businessUnitId: Uuid.nullable() }),
  output: z.object({ membershipId: Uuid, businessUnitId: Uuid.nullable() }),
});

export const branchRoutes = {
  listBranchOptions, getBranchOverview, assignJobsToBranch, setMemberBranch,
} as const;
