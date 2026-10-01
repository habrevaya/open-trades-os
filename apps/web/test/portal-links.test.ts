import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * EVERY LINK WE SEND A CUSTOMER OPENS SOMETHING
 *
 * `portal.mintGrant` builds a link as `{base}/{path}/{token}`, and the
 * invoice path `/i/` went out in every emailed invoice with no page behind
 * it. The email said "View and pay your invoice"; the customer got a 404.
 * Nothing noticed, because the link is a string built in the API and the
 * page is a folder in the web app, and no test looked at both.
 *
 * The map is read from the source rather than imported, so this suite does
 * not have to load the database client to check a folder exists.
 */
const PORTAL_TS = join(import.meta.dirname, "../../../packages/api/src/services/portal.ts");
const PORTAL_APP = join(import.meta.dirname, "../src/app/(portal)");

function portalPaths(): Record<string, string> {
  const source = readFileSync(PORTAL_TS, "utf8");
  const block = source.match(/export const PORTAL_PATHS = \{([^}]*)\}/);
  if (!block) throw new Error("PORTAL_PATHS not found in portal.ts");
  return Object.fromEntries(
    [...block[1]!.matchAll(/(\w+):\s*"(\w+)"/g)].map((m) => [m[1]!, m[2]!]),
  );
}

/**
 * Scopes that can be minted but are not sent to anybody by the product.
 * A customer-wide grant exists in the API for integrators building their
 * own portal; nothing in this product emails one. Listed by name so adding
 * a scope here is a decision somebody wrote down.
 */
const NO_PAGE_YET = new Set(["customer"]);

describe("portal links", () => {
  it("finds the map at all", () => {
    expect(portalPaths()).toMatchObject({ estimate: "e", invoice: "i" });
  });

  it("have a page for every scope the product sends", () => {
    const missing = Object.entries(portalPaths())
      .filter(([scope]) => !NO_PAGE_YET.has(scope))
      .filter(([, path]) => !existsSync(join(PORTAL_APP, path, "[token]", "page.tsx")))
      .map(([scope, path]) => `${scope} -> /${path}/{token}`);
    expect(missing).toEqual([]);
  });
});
