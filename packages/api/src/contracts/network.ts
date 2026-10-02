import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * A FRANCHISE ROLL UP, AND THE CONSENT THAT MAKES ONE LEGITIMATE
 *
 * `network` and `network_grant` have been in this schema since the first
 * migration with no reader and no writer anywhere. They describe several
 * organizations, each a real tenant with its own customers, under one operator
 * entitled to a consolidated view.
 *
 * Row level security is forced on every table carrying `organization_id`, so a
 * roll up is by definition a read across that boundary. It happens in one
 * security definer function in `sql/after.sql` and nowhere else, and the rules
 * it enforces are the feature: the caller must be the network's OPERATOR, the
 * member must have granted THAT aggregate, a revocation is immediate, and the
 * return shape is (organization, period, metric, value) with no path to a row.
 */

export const Aggregate = z.enum(["job_counts", "revenue_summary", "kpi_scorecard", "gl_summary"]);

const Shared = z.object({
  aggregate: Aggregate,
  /** In the member's words. On the screen where somebody ticks a box, the label is the decision. */
  description: z.string(),
  grantedAt: z.string().nullable(),
});

const MembershipView = z.object({
  networkId: Uuid.nullable(),
  networkName: z.string().nullable(),
  networkKind: z.string().nullable(),
  memberCode: z.string().nullable(),
  isOperator: z.boolean(),
  sharing: z.array(Shared),
  notSharing: z.array(Shared.omit({ grantedAt: true })),
});

export const getNetworkMembership = defineRoute({
  method: "get",
  path: "/v1/network",
  summary: "What network this company is in, and what it shares",
  description:
    "Returns what is shared AND what is not, so the screen is a list of choices rather than a list of facts. A company in no network gets the full list under notSharing and a null network, because 'you are not in one' is the answer rather than an error.",
  module: "M01",
  permissions: ["settings:read"],
  idempotent: true,
  input: z.object({}),
  output: MembershipView,
});

export const shareWithNetwork = defineRoute({
  method: "post",
  path: "/v1/network/share",
  summary: "Start sharing one aggregate with the network's operator",
  description:
    "The MEMBER grants, per aggregate, and there is no shape of call in which an operator grants on a member's behalf: the row is written by the member's own session. Per aggregate rather than per network, because a franchisor entitled to revenue under the agreement is not therefore entitled to the general ledger. `settings:write`, which is the owner and the administrator: the decision to show another company your revenue should not be available to somebody who does not sign the franchise agreement. Re-granting is a no-op, which is the right shape for a checkbox.",
  module: "M01",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ aggregate: Aggregate }),
  output: MembershipView,
});

export const stopSharingWithNetwork = defineRoute({
  method: "post",
  path: "/v1/network/stop-sharing",
  summary: "Stop sharing one aggregate",
  description:
    "Takes effect immediately: the roll up checks for a live grant on every call and caches nothing. Revoked rather than deleted, because 'they used to see our revenue and we stopped letting them in March' is a fact a member may need to prove, and a deleted row proves nothing.",
  module: "M01",
  permissions: ["settings:write"],
  idempotent: true,
  input: z.object({ aggregate: Aggregate }),
  output: MembershipView,
});

export const listNetworkMembers = defineRoute({
  method: "get",
  path: "/v1/network/members",
  summary: "The roster, for the network's operator",
  description:
    "INCLUDES THE MEMBERS SHARING NOTHING, which is the point: 'we have six franchisees and two have not turned sharing on' is what an operator needs to see, and a roster listing only the sharing ones makes the missing numbers look like zeros. That is the difference between chasing a franchisee and writing off a market. Name and member code only, never the address or the EIN. A member of the network that does not operate it is told the network does not exist, rather than told there is something it may not have.",
  module: "M01",
  permissions: ["report:read"],
  idempotent: true,
  input: z.object({}),
  output: z.object({
    networkId: Uuid,
    data: z.array(z.object({
      organizationId: Uuid,
      name: z.string(),
      memberCode: z.string().nullable(),
      suspended: z.boolean(),
      aggregates: z.array(Aggregate),
    })),
  }),
});

export const getNetworkRollup = defineRoute({
  method: "get",
  path: "/v1/network/rollup",
  summary: "The consolidated numbers, from the members who agreed to share them",
  description:
    "AGGREGATES ONLY. The shape is (organization, period, metric, value) and there is no path through it to a customer, an address, a job or an invoice number, which is a property of the SQL function body rather than of a convention: every branch of it is a GROUP BY. `gl_summary` reports by account CLASS and never by account code, because the code is the member's own chart of accounts and naming one would let an operator ask about a single account, which is a row read wearing an aggregate's clothes. A member who has not granted contributes nothing, SILENTLY, and is named in notContributing instead: raising an error would let an operator lean on a member by making the whole report fail until they consent. Values are strings, because money that has been through a JSON parser as a float is not money.",
  module: "M01",
  permissions: ["report:read"],
  idempotent: true,
  input: z.object({
    aggregate: Aggregate,
    from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  }),
  output: z.object({
    networkId: Uuid,
    aggregate: Aggregate,
    from: z.string(),
    to: z.string(),
    data: z.array(z.object({
      organizationId: Uuid,
      memberCode: z.string().nullable(),
      period: z.string(),
      metric: z.string(),
      value: z.string(),
    })),
    notContributing: z.array(z.object({
      organizationId: Uuid,
      name: z.string(),
      /** False means no consent. True means consent and no activity, a different fact. */
      sharesThis: z.boolean(),
    })),
  }),
});

export const networkRoutes = {
  getNetworkMembership,
  shareWithNetwork,
  stopSharingWithNetwork,
  listNetworkMembers,
  getNetworkRollup,
} as const;
