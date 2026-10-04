import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { generate, type OpenApiDocument } from "./generate";

/**
 * Regenerates `src/generated.ts` from the API's OpenAPI document. Run by the
 * API package's `openapi` script straight after it writes the document, so
 * the two are always produced together.
 */
const here = dirname(fileURLToPath(import.meta.url));
const source = process.argv[2] ?? resolve(here, "../../api/openapi.json");
const target = process.argv[3] ?? resolve(here, "../src/generated.ts");

const document = JSON.parse(readFileSync(source, "utf8")) as OpenApiDocument;
writeFileSync(target, generate(document), "utf8");
console.info(`Wrote ${target} from ${source}.`);
