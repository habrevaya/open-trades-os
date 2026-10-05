import { z } from "zod";
import { defineRoute } from "../lib/define";
import { Uuid } from "./common";

/**
 * CONNECTED APPLICATIONS
 *
 * Two sides, and for a long time only one of them was here.
 *
 * FROM THE APP'S SIDE, one read: what this token may do. Before it, an
 * integrator could only find out by trying. The migration loader learned
 * whether it held `data:import` by posting a deliberately invalid back-dated
 * invoice and reading a 403 against a 422, which is a write probe against a
 * live company's books, one change in validation order away from creating a
 * junk invoice.
 *
 * FROM THE OPERATOR'S SIDE, nothing at all, and `services/apps.ts` had the
 * whole of it: install, change what an app may do, revoke it, issue a token and
 * revoke a token, every one guarded and tested, and no route and no screen. So
 * `docs/concepts/connected-apps.md` described the way a third party integrates
 * with this product and there was no way for a company to let one in.
 *
 * The permission on all five is `integration:write`, which is the same one that
 * connects a built integration, and the catalogue says why there is no separate
 * API key permission: a token belongs to a named app with its own grant, its own
 * audit attribution and its own revocation, so "who may call us" is answerable
 * without anybody holding a string equivalent to a password that belongs to
 * nobody in particular. Installing is ALSO checked against what the installer
 * holds, inside the service, because `integration:write` answers whether they
 * may touch integrations and not whether this particular grant is theirs to
 * give.
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

/** What an operator sees about one credential. Never the credential. */
export const AppTokenView = z.object({
  id: Uuid,
  label: z.string().nullable(),
  /** The last four characters. Enough to tell two apart, not enough to use. */
  hint: z.string().nullable(),
  expiresAt: z.string(),
  lastUsedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  /** Computed against the clock on every read, never stored. */
  expired: z.boolean(),
});

export const AppView = z.object({
  id: Uuid,
  name: z.string(),
  publisher: z.string().nullable(),
  description: z.string().nullable(),
  homepageUrl: z.string().nullable(),
  status: z.string(),
  permissions: z.array(z.string()),
  /** What a request asked for, when it was one. What is here and not above was left out. */
  requestedPermissions: z.array(z.string()).nullable(),
  scopes: z.record(z.string()),
  approvedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedReason: z.string().nullable(),
  /** `operator` installed here by hand, `request` asked through the consent flow, `oauth` a remote MCP client. */
  source: z.enum(["operator", "request", "oauth"]),
  /** The request, for an app that asked. Null for one installed by hand. */
  request: z.object({
    expiresAt: z.string().nullable(),
    expired: z.boolean(),
    /** The host the person deciding is sent back to. */
    returnsTo: z.string().nullable(),
    requestedFrom: z.string().nullable(),
    refusedAt: z.string().nullable(),
    refusedReason: z.string().nullable(),
    /** When the app collected its credential, which it does once. */
    claimedAt: z.string().nullable(),
  }).nullable(),
  tokens: z.array(AppTokenView),
  /**
   * Whether anything can actually call us as this app right now: active, and
   * holding a token that is neither revoked nor lapsed. Separate from `status`
   * because expiry moves on its own, and a screen reading the status alone
   * reports an integration as connected on the morning its last token lapsed.
   */
  live: z.boolean(),
});

export const listApps = defineRoute({
  method: "get",
  path: "/v1/apps",
  summary: "The applications this company has let in",
  description:
    "Every connected app with what it was granted, who approved it, and its credentials by label and last four characters. The token itself is not here and cannot be: only its hash is stored.",
  module: "M26",
  permissions: ["settings:read"],
  input: z.object({}),
  output: z.object({ apps: z.array(AppView) }),
});

export const installApp = defineRoute({
  method: "post",
  path: "/v1/apps",
  summary: "Let an application in",
  description:
    "Installs and approves in one call. The grant is refused if it is wider than what the installer holds, or names a permission that does not exist: an unknown key is refused rather than dropped, because dropping it produces an app that looks correctly limited and is limited by accident, and the release that adds the permission turns it on with nobody having approved it.",
  module: "M26",
  idempotent: true,
  permissions: ["integration:write"],
  input: z.object({
    name: z.string().min(1).max(200),
    publisher: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    homepageUrl: z.string().max(500).optional(),
    permissions: z.array(z.string()).min(1),
    scopes: z.record(ScopeValue).optional(),
  }),
  output: z.object({ app: Uuid }),
});

export const updateApp = defineRoute({
  method: "patch",
  path: "/v1/apps/{id}",
  summary: "Change what an application may do",
  description:
    "Checked against the RESULT rather than the change, because editing an app you may edit into one you may not have installed is the same escalation and checking only the difference would miss it.",
  module: "M26",
  permissions: ["integration:write"],
  input: z.object({
    id: Uuid,
    name: z.string().min(1).max(200).optional(),
    permissions: z.array(z.string()).min(1).optional(),
    scopes: z.record(ScopeValue).optional(),
  }),
  output: z.object({ app: Uuid }),
});

export const revokeApp = defineRoute({
  method: "post",
  path: "/v1/apps/{id}/revoke",
  summary: "Turn an application off, permanently",
  description:
    "Not a delete: what the app did stays attributable, and an operator asking what this thing was reading needs the row afterwards. Its tokens are revoked in the same transaction, so a credential that leaked is dead even if somebody later flips the app back to active by hand. A reinstall is a new row with a new approval, because trusting it again is a new decision.",
  module: "M26",
  idempotent: true,
  permissions: ["integration:write"],
  input: z.object({ id: Uuid, reason: z.string().max(500).optional() }),
  output: z.object({ app: Uuid, status: z.string() }),
});

export const issueAppToken = defineRoute({
  method: "post",
  path: "/v1/apps/{appId}/tokens",
  summary: "Issue a credential to an application",
  description:
    "THE TOKEN IS IN THE RESPONSE AND NOWHERE ELSE. Only its hash is stored, so a token a support engineer could read out of a table does not exist, and an operator who loses one issues another, which is the same action they would take if it leaked. Issuing is granting, so it goes through the same authority check as installing: somebody who may create tokens but not approve apps cannot mint a credential for an app somebody else approved with powers they do not hold. NOT IDEMPOTENT, and alone among the writes here: a retry leaves a second token rather than returning the first, because there is nothing stored that a replay could hand back. The extra token is visible in the list by its label and last four characters and can be revoked.",
  module: "M26",
  permissions: ["integration:write"],
  input: z.object({
    appId: Uuid,
    label: z.string().max(120).optional(),
    expiresInDays: z.number().int().min(1).max(365).optional(),
  }),
  output: z.object({ token: z.string(), id: Uuid, expiresAt: z.string() }),
});

export const revokeAppToken = defineRoute({
  method: "post",
  path: "/v1/apps/tokens/{tokenId}/revoke",
  summary: "Kill one credential",
  description:
    "Takes effect on the next call rather than at the end of anything, because the revocation is a condition in the function that resolves a token rather than a check any caller could forget.",
  module: "M26",
  idempotent: true,
  permissions: ["integration:write"],
  input: z.object({ tokenId: Uuid }),
  output: z.object({ revoked: z.literal(true) }),
});

/* ------------------------------------------------------- the consent flow */

const PermissionList = z.array(z.string().min(1).max(100)).min(1).max(200);

export const requestAppInstall = defineRoute({
  method: "post",
  path: "/v1/public/app-requests",
  summary: "Ask a company to let your application in",
  description:
    "For a third party with no credential yet. Names the company by its public slug and says exactly what the app wants: its permissions from the catalogue and the record scope on each resource. Nothing is granted by asking. The answer carries `decisionUrl`, the page where somebody at the company sees the request in plain words and approves or refuses that exact list, and `claimSecret`, shown once, which the app presents to `POST /v1/public/app-requests/{id}/claim` to collect its credential after approval. An unknown permission is refused rather than dropped. Requests expire after seven days unanswered, a company holds at most twenty waiting, and asking is counted per network address. SAFE TO RETRY WITH YOUR OWN SECRET: send `claimSecret` (32 to 200 random URL safe characters) and a retry carrying the same one is answered with the first request as it stands, `repeated: true`, rather than leaving a second one waiting. The same secret on a request asking for something else is refused. Without one the server makes a secret, shown once, and a retry makes a second request. People at the company who can approve are emailed when a request arrives, if the company has an email provider connected.",
  module: "M26",
  authorization: "public",
  permissions: [],
  input: z.object({
    company: z.string().min(1).max(120),
    name: z.string().min(1).max(200),
    publisher: z.string().max(200).optional(),
    description: z.string().max(2000).optional(),
    homepageUrl: z.string().max(500).optional(),
    permissions: PermissionList,
    scopes: z.record(ScopeValue).optional(),
    /** Where the person deciding is sent back to, with `request`, `status` and `state` added. Https only. */
    redirectUri: z.string().max(1000).optional(),
    /** Opaque, echoed back as `state` on the return address. */
    state: z.string().max(500).optional(),
    /** Your own claim secret, so a retry returns the first request. 32 to 200 of A-Z a-z 0-9 - _. */
    claimSecret: z.string().min(32).max(200).optional(),
  }),
  output: z.object({
    id: Uuid,
    /** `pending` for a new request. A retry answers with the first request's status now. */
    status: z.enum(["pending", "active", "refused", "revoked"]),
    /** True when this was a retry with the same claim secret, answered with the first request. */
    repeated: z.boolean(),
    decisionPath: z.string(),
    decisionUrl: z.string(),
    /** Shown once. The app's proof, when it comes back, that it is the one that asked. */
    claimSecret: z.string(),
    expiresAt: z.string(),
  }),
});

export const claimAppCredential = defineRoute({
  method: "post",
  path: "/v1/public/app-requests/{id}/claim",
  summary: "Collect the credential an approved request earned",
  description:
    "Answers `pending` until somebody decides, `refused` or `expired` when the answer is no, and `approved` with the token, ONCE, when it is yes. The token is stored only as a hash, so a second collection answers `claimed` with no token and the company issues a new one if it was lost. A wrong claim secret is the same not found as an id that does not exist. NOT IDEMPOTENT for the same reason: what it hands over cannot be handed over again.",
  module: "M26",
  authorization: "public",
  permissions: [],
  input: z.object({ id: Uuid, claimSecret: z.string().min(1).max(200) }),
  output: z.object({
    status: z.enum(["pending", "expired", "refused", "revoked", "claimed", "approved"]),
    message: z.string(),
    token: z.string().optional(),
    expiresAt: z.string().optional(),
    /** With the token: what it may do, which can be part of what was asked for. */
    permissions: z.array(z.string()).optional(),
    /** With the token: what was asked for and left out by the person who approved it. */
    withheld: z.array(z.string()).optional(),
  }),
});

export const reviewAppRequest = defineRoute({
  method: "get",
  path: "/v1/apps/{id}/request",
  summary: "What an app is asking for, in plain words",
  description:
    "Every permission the app asked for with the catalogue's own words, the ones that expose money flagged, and whether the person looking holds each. `approvable` is false with the reason when they could not approve it as it stands: nobody can give an app what they do not hold.",
  module: "M26",
  permissions: ["settings:read"],
  input: z.object({ id: Uuid }),
  output: z.object({
    app: AppView,
    asks: z.array(z.object({
      permission: z.string(), label: z.string(), sensitive: z.boolean(), held: z.boolean(),
      /** Null while it waits; once approved, whether this one was given. */
      granted: z.boolean().nullable(),
    })),
    reach: z.array(z.object({ resource: z.string(), scope: z.string(), widerThanYours: z.boolean() })),
    /** Asked for and not given, once approved. */
    leftOut: z.array(z.object({ permission: z.string(), label: z.string() })),
    approvable: z.boolean(),
    blockedBecause: z.string().nullable(),
    /** Once answered, where to send the person who answered, with the outcome for the app. */
    returnTo: z.string().nullable(),
  }),
});

const Decision = z.object({
  app: Uuid,
  status: z.string(),
  /** Where to send the person who decided, with the outcome for the app. Null when the app gave no address. */
  returnTo: z.string().nullable(),
});

export const approveAppRequest = defineRoute({
  method: "post",
  path: "/v1/apps/{id}/approve",
  summary: "Approve what an app asked for, or part of it",
  description:
    "Without `permissions`, approves the whole list the app asked for. With it, approves only those, and each has to be one the app asked for: a permission it did not ask for is refused rather than added, and an empty list is refused (that is refusing). Through the same check as installing: refused, naming them, when the grant holds anything the approver does not hold. The record reach is the app's as asked. Approving does not hand anybody a credential; the app collects it with its claim secret and is told what was left out. Approving an app already approved changes nothing and succeeds.",
  module: "M26",
  idempotent: true,
  permissions: ["integration:write"],
  input: z.object({ id: Uuid, permissions: z.array(z.string().max(100)).max(200).optional() }),
  output: Decision.extend({
    /** What it was given. */
    permissions: z.array(z.string()),
    /** What it asked for and was not given. */
    withheld: z.array(z.string()),
  }),
});

export const refuseAppRequest = defineRoute({
  method: "post",
  path: "/v1/apps/{id}/refuse",
  summary: "Refuse an app's request",
  description:
    "The app is told no, with the reason if one is given, when it next comes for its credential, and it gets nothing. Kept rather than deleted, so a list of what asked and was refused survives. Refusing twice succeeds; refusing an approved app is refused, because that is turning it off.",
  module: "M26",
  idempotent: true,
  permissions: ["integration:write"],
  input: z.object({ id: Uuid, reason: z.string().max(500).optional() }),
  output: Decision,
});

export const appRoutes = {
  getAppSelf, listApps, installApp, updateApp, revokeApp, issueAppToken, revokeAppToken,
  requestAppInstall, claimAppCredential, reviewAppRequest, approveAppRequest, refuseAppRequest,
} as const;
