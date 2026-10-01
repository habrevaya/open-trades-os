import { readFileSync } from "node:fs";
import { join } from "node:path";

export interface Seed {
  owner: string;
  tech: string;
  proposal: string;
  tracking: string;
}

/** The same parse scripts/screenshots.mjs does, and the same refusal. */
export function parseSeed(output: string): Seed {
  const sessions = [...output.matchAll(/ots_session=([^;]+);/g)].map((m) => m[1]!);
  const links = Object.fromEntries(
    [...output.matchAll(/(proposal|job tracking)\s+(\/\S+)/g)].map((m) => [m[1]!, m[2]!]),
  );
  const [owner, tech] = sessions;
  if (!owner || !tech || !links["proposal"] || !links["job tracking"]) {
    throw new Error(`The seed printed no sessions or portal links:\n${output}`);
  }
  return { owner, tech, proposal: links["proposal"], tracking: links["job tracking"] };
}

export function readSeed(): Seed {
  return JSON.parse(readFileSync(join(__dirname, ".state", "seed.json"), "utf8")) as Seed;
}
