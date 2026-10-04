import { PERMISSIONS, SENSITIVE_PERMISSIONS, type Permission } from "../access/permissions";

/**
 * OAUTH FOR REMOTE MCP CLIENTS, THE RULES WITHOUT THE DATABASE
 *
 * A remote MCP client connects the way any OAuth client does: it sends the
 * person to an authorization page with the scopes it wants, the person
 * approves, and the client exchanges a one time code for a token. Everything
 * in this file is a decision that flow makes and that a test should be able
 * to reach without a browser: what a scope grants, which addresses a code may
 * be sent to, and what a PKCE verifier has to look like.
 *
 * WHAT A SCOPE IS HERE. A scope is either a permission from the catalogue,
 * exactly as an app install names one, or a bundle of them with a name a
 * person can read on the consent page. The bundles exist because MCP clients
 * ask for a handful of coarse scopes, and a consent page listing forty
 * permission keys is a page nobody reads. Every bundle is expanded to its
 * permissions before anybody approves anything, and the page shows the
 * expansion: a bundle is a way of asking, never a grant of its own.
 */

export interface ScopeBundle {
  /** What the consent page says the client is asking for. */
  label: string;
  permissions: readonly Permission[];
}

/**
 * Every permission whose action is reading, including field level reads.
 *
 * Computed from the catalogue rather than listed, so a read permission added
 * next year is covered by `read` the day it ships. That is the right
 * direction for a bundle whose promise is "everything you can see and nothing
 * you can change": a new read widens what it shows and can never change
 * anything.
 */
const READS = (Object.keys(PERMISSIONS) as Permission[]).filter((p) => p.endsWith(":read"));

export const SCOPE_BUNDLES: Readonly<Record<string, ScopeBundle>> = {
  read: {
    label: "See everything you can see, and change nothing",
    permissions: READS,
  },
  customers: {
    label: "Look up, add and edit customers, their addresses and their equipment",
    permissions: [
      "customer:read", "customer:write", "property:read", "property:write",
      "equipment:read", "equipment:write",
    ],
  },
  jobs: {
    label: "Book jobs, change visits and read service reports",
    permissions: ["job:read", "job:write", "visit:read", "visit:write", "servicereport:read"],
  },
  dispatch: {
    label: "Assign technicians and move visits on the board",
    permissions: ["visit:read", "visit:dispatch", "visit:reschedule"],
  },
  estimates: {
    label: "Write and send estimates from the price book",
    permissions: ["estimate:read", "estimate:write", "estimate:send", "pricebook:read"],
  },
  invoices: {
    label: "Raise and send invoices and see payments",
    permissions: ["invoice:read", "invoice:write", "invoice:send", "payment:read"],
  },
  messages: {
    label: "Read and send customer texts and emails",
    permissions: ["message:read", "message:send"],
  },
  tasks: {
    label: "Read and work the office task queue",
    permissions: ["task:read", "task:write"],
  },
  reports: {
    label: "Run reports and dashboards",
    permissions: ["report:read"],
  },
};

/**
 * What a client that names no scope is given to approve.
 *
 * Reading only, because the alternative defaults are both wrong. Refusing is
 * hostile to the clients that never send a scope, which is several of the
 * common ones; defaulting to everything the approver holds would make the
 * absence of a request the widest request there is.
 */
export const DEFAULT_SCOPE = "read";

/** Every scope a client may name, for the discovery document. Bundles first, then permissions. */
export function supportedScopes(): string[] {
  return [...Object.keys(SCOPE_BUNDLES), ...Object.keys(PERMISSIONS)];
}

/** A scope string as sent: space separated, order and repeats meaningless. */
export function parseScope(scope: string | null | undefined): string[] {
  const parts = (scope ?? "").split(/\s+/).map((s) => s.trim()).filter((s) => s !== "");
  return [...new Set(parts.length > 0 ? parts : [DEFAULT_SCOPE])];
}

export interface ScopeResolution {
  /** Asked for and held by the person approving. Exactly what the app would get. */
  granted: Permission[];
  /**
   * Asked for and NOT held by the person approving, so not given. Shown on
   * the consent page, because "you cannot give this away, you do not have it"
   * is something a person should read before approving the rest.
   */
  withheld: Permission[];
  /** Names that are neither a bundle nor a permission. The request is refused for these. */
  unknown: string[];
}

/**
 * What a list of scopes grants, given what the approver holds.
 *
 * A bundle is cut down to what the approver holds rather than refused whole,
 * which is where this differs from installing an app by hand, where an
 * unheld permission refuses the install. The difference is who chose the
 * list: a person typing permissions can fix their list, and a client asking
 * for `jobs` cannot know which of the five this particular person holds. The
 * cut is shown, never silent.
 *
 * An unknown name is not cut, it is reported, and the caller refuses the
 * request: dropping a scope nobody recognises would install a client with less
 * than it asked for and no sign of why, and the release that adds the name
 * would turn it on unapproved.
 */
export function resolveScopes(requested: readonly string[], held: ReadonlySet<string>): ScopeResolution {
  const wanted = new Set<Permission>();
  const unknown: string[] = [];
  for (const name of requested) {
    const bundle = SCOPE_BUNDLES[name];
    if (bundle) {
      for (const permission of bundle.permissions) wanted.add(permission);
    } else if (name in PERMISSIONS) {
      wanted.add(name as Permission);
    } else {
      unknown.push(name);
    }
  }
  const sorted = [...wanted].sort();
  return {
    granted: sorted.filter((p) => held.has(p)),
    withheld: sorted.filter((p) => !held.has(p)),
    unknown,
  };
}

export type Narrowing =
  | { ok: true; granted: Permission[] }
  | { ok: false; message: string };

/**
 * What the person ticked on the consent page, checked against what the page
 * offered.
 *
 * The person approving may give less than the client asked for: an
 * assistant asking for `customers` that only needs to look people up can be
 * left without `customer:write`. Only ever less. A permission that was not
 * offered (the client did not ask for it, or the approver does not hold it)
 * is refused by name rather than dropped or granted, because the form is
 * posted by a browser and the page is not what decides. Nothing ticked is
 * refused too: an app that can do nothing is a "Do not connect" pressed the
 * long way round, and saying so beats installing it.
 */
export function narrowGrant(offered: readonly Permission[], chosen: readonly string[]): Narrowing {
  const allowed = new Set<string>(offered);
  const extra = [...new Set(chosen)].filter((p) => !allowed.has(p));
  if (extra.length > 0) {
    return { ok: false, message: `Not offered on this page, so it cannot be given: ${extra.join(", ")}.` };
  }
  const picked = new Set(chosen);
  const granted = offered.filter((p) => picked.has(p));
  if (granted.length === 0) {
    return { ok: false, message: "Tick at least one thing it may do, or choose Do not connect." };
  }
  return { ok: true, granted };
}

/** The permissions that expose money, flagged on the consent page. */
export const isSensitive = (permission: string): boolean =>
  (SENSITIVE_PERMISSIONS as readonly string[]).includes(permission);

/** A permission in the words the catalogue already uses. */
export const describePermission = (permission: string): string =>
  (PERMISSIONS as Record<string, string>)[permission] ?? permission;

/* ------------------------------------------------------------------ PKCE */

/**
 * WHAT A VERIFIER MAY BE, from RFC 7636: 43 to 128 characters of the
 * unreserved set. Checked rather than merely hashed, because a verifier of
 * eight characters is guessable whatever its hash looks like, and a client
 * sending one has a bug worth hearing about.
 */
const VERIFIER = /^[A-Za-z0-9\-._~]{43,128}$/;

/** The S256 challenge is a base64url SHA-256: exactly 43 characters, no padding. */
const CHALLENGE = /^[A-Za-z0-9\-_]{43}$/;

export const isVerifier = (value: string): boolean => VERIFIER.test(value);
export const isChallenge = (value: string): boolean => CHALLENGE.test(value);

/**
 * Only S256.
 *
 * `plain` sends the verifier itself as the challenge, through the browser,
 * which is the one channel PKCE exists to distrust. RFC 7636 allows it for
 * clients that cannot hash; every MCP client can, and the MCP authorization
 * specification requires S256.
 */
export const CHALLENGE_METHOD = "S256";

/**
 * Constant time comparison of two strings of base64url, for the challenge
 * check. Lengths are compared first and that leaks only the length, which
 * for a challenge is fixed and public.
 */
export function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

/* -------------------------------------------------------- redirect URIs */

const LOOPBACK = new Set(["127.0.0.1", "[::1]", "localhost"]);
const FORBIDDEN_SCHEMES = new Set(["javascript:", "data:", "file:", "vbscript:", "blob:", "about:"]);

/**
 * Whether a client may register this address to receive codes.
 *
 * Https anywhere. Plain http only to this machine, because that is how a
 * desktop client receives a code: it listens on a loopback port for the
 * moment it takes, which RFC 8252 describes and every desktop MCP client
 * does. A private scheme an installed application has claimed, for the
 * same reason. Never a fragment, because a code in a fragment is read by
 * script on whatever page is there rather than by the client.
 *
 * Returns the refusal in words, or null.
 */
export function redirectUriProblem(uri: string): string | null {
  let parsed: URL;
  try {
    parsed = new URL(uri);
  } catch {
    return `"${uri}" is not an address a code can be sent to.`;
  }
  if (parsed.hash !== "" || uri.includes("#")) return "A redirect address cannot carry a fragment.";
  if (FORBIDDEN_SCHEMES.has(parsed.protocol)) return `A ${parsed.protocol} address cannot receive a code.`;
  if (parsed.protocol === "https:") return null;
  if (parsed.protocol === "http:") {
    return LOOPBACK.has(parsed.hostname)
      ? null
      : "Plain http is only allowed to this machine (127.0.0.1, [::1] or localhost). Use https.";
  }
  // A private scheme claimed by an installed application.
  return null;
}

/**
 * Whether a redirect address sent with a request is one the client
 * registered.
 *
 * Byte for byte, with one exception RFC 8252 requires: a loopback address
 * may come back on any port, because a desktop client picks a free port each
 * time it listens. Everything else about it, the scheme, the host and the
 * path, must match. Anything looser is how an authorization server becomes
 * an open redirector that hands codes to whoever asks.
 */
export function redirectUriMatches(sent: string, registered: readonly string[]): boolean {
  if (registered.includes(sent)) return true;
  let parsed: URL;
  try {
    parsed = new URL(sent);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" || !LOOPBACK.has(parsed.hostname)) return false;
  return registered.some((candidate) => {
    try {
      const reg = new URL(candidate);
      return reg.protocol === "http:" && reg.hostname === parsed.hostname
        && reg.pathname === parsed.pathname && reg.search === parsed.search;
    } catch {
      return false;
    }
  });
}

/* ------------------------------------------------------------- lifetimes */

/** A code is used within seconds; ten minutes covers a person reading the page slowly. */
export const CODE_TTL_MS = 10 * 60 * 1000;
/**
 * An hour. Short, because an access token is a bearer credential an MCP
 * client keeps in memory and sometimes in a log, and the refresh token is
 * what lets it last.
 */
export const ACCESS_TTL_SECONDS = 60 * 60;
/** Thirty days without being used, then the person connects again. */
export const REFRESH_TTL_MS = 30 * 86_400_000;
