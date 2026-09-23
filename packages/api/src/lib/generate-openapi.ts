import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { routes } from "../contracts/index";
import { buildOpenApiDocument } from "./openapi";

/**
 * Writes the OpenAPI document. The generator next to this file does the work
 * and touches nothing, so this is the only piece that needs a disk to run.
 *
 * The output is checked in. A generated artifact in the tree is what makes a
 * contract change show up as a diff on the document in the same review, which
 * is the only moment anybody is looking at both.
 */

const here = dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] ?? resolve(here, "../../openapi.json");

const document = buildOpenApiDocument(routes);

// Trailing newline, because a file without one shows up in every later diff
// as a change to its last line.
writeFileSync(target, `${JSON.stringify(document, null, 2)}\n`, "utf8");

const operations = Object.values(document.paths).reduce(
  (total, item) => total + item["x-allowed-methods"].length,
  0,
);
console.log(`Wrote ${target}: ${Object.keys(document.paths).length} paths, ${operations} operations.`);
