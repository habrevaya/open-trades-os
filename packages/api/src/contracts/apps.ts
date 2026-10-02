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
  scopes: z.record(z.string()),
  approvedAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedReason: z.string().nullable(),
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

export const appRoutes = {
  getAppSelf, listApps, installApp, updateApp, revokeApp, issueAppToken, revokeAppToken,
} as const;
