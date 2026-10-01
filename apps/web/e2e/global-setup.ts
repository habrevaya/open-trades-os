import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseSeed } from "./seed";

/**
 * Migrate, then seed, then remember what the seed printed.
 *
 * The seed is the fixture the screenshots are taken from, and it prints the
 * owner's and the technician's session tokens and two portal links. Reading
 * them from its output rather than from the database means the suite signs
 * in exactly the way the seed tells a person to.
 *
 * Re-running is safe. The seed derives every id from a name, so it updates
 * the same company rather than adding another, and everything the specs
 * create carries a run-unique name.
 */
export default function globalSetup(): void {
  const root = resolve(__dirname, "../../..");
  const run = (args: string[]) =>
    execFileSync("pnpm", args, { cwd: root, env: process.env, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] });

  run(["--filter", "@opentradesos/db", "migrate"]);
  const output = run(["--filter", "@opentradesos/db", "seed"]);

  const seed = parseSeed(output);
  const dir = join(__dirname, ".state");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "seed.json"), JSON.stringify(seed, null, 2));
}
