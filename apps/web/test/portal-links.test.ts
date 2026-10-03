import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
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
 * Every link the API builds by hand rather than through `mintGrant`, read
 * off the source: `${portalBase()}/x/...` in any service. The deposit link
 * was one of these, `/pay/{deposit id}`, and the map above never saw it.
 */
function handBuiltPaths(): string[] {
  const dir = join(import.meta.dirname, "../../../packages/api/src/services");
  const found = new Set<string>();
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts"))) {
    const source = readFileSync(join(dir, file), "utf8");
    for (const m of source.matchAll(/\$\{portalBase\(\)\}\/([a-z]+)\//g)) found.add(`${file}: /${m[1]}/`);
  }
  return [...found];
}

describe("portal links", () => {
  it("finds the map at all", () => {
    expect(portalPaths()).toMatchObject({ estimate: "e", invoice: "i" });
  });

  it("have a page for every scope, with no exceptions", () => {
    const missing = Object.entries(portalPaths())
      .filter(([, path]) => !existsSync(join(PORTAL_APP, path, "[token]", "page.tsx")))
      .map(([scope, path]) => `${scope} -> /${path}/{token}`);
    expect(missing).toEqual([]);
  });

  it("have a page for every link a service builds by hand, too", () => {
    const paths = handBuiltPaths();
    expect(paths.length).toBeGreaterThan(0);
    /**
     * A link to a token, or to a company's own page by its public key: the
     * sign in page is `/portal/{slug}`, built by hand from the slug the
     * same way, and it needs a page behind it just as much.
     */
    const missing = paths.filter((entry) => {
      const segment = entry.split("/")[1]!;
      return !existsSync(join(PORTAL_APP, segment, "[token]", "page.tsx"))
        && !existsSync(join(PORTAL_APP, segment, "[slug]", "page.tsx"));
    });
    expect(missing).toEqual([]);
  });
});
