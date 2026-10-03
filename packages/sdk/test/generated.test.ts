import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { generate, typeOf, type OpenApiDocument } from "../codegen/generate";

/**
 * THE SDK CANNOT DRIFT FROM THE API
 *
 * The contracts write `openapi.json` and the document writes the client. The
 * API package already fails when the document is stale; this fails when the
 * client is, by regenerating it in memory and comparing with the file in the
 * tree. Run `pnpm --filter @opentradesos/api run openapi` to fix either.
 */
const here = import.meta.dirname;
const document = JSON.parse(readFileSync(resolve(here, "../../api/openapi.json"), "utf8")) as OpenApiDocument;

describe("the generated client", () => {
  it("is exactly what the current OpenAPI document produces", () => {
    const onDisk = readFileSync(resolve(here, "../src/generated.ts"), "utf8");
    expect(onDisk === generate(document), "src/generated.ts is stale: run the api package's openapi script").toBe(true);
  });

  it("has a method for every operation in the document", () => {
    const source = generate(document);
    let count = 0;
    for (const item of Object.values(document.paths)) {
      for (const method of ["get", "post", "patch", "put", "delete"]) {
        const op = item[method] as { operationId: string } | undefined;
        if (!op) continue;
        count += 1;
        expect(source).toContain(`  ${op.operationId}(input`);
      }
    }
    expect(count).toBeGreaterThan(500);
  });

  it("never writes `any`", () => {
    expect(generate(document)).not.toMatch(/:\s*any\b/);
  });
});

describe("turning a schema into a type", () => {
  it("covers nullables, enums, unions, records and arrays", () => {
    expect(typeOf({ type: ["string", "null"] })).toBe("string | null");
    expect(typeOf({ type: "string", enum: ["a", "b"] })).toBe('"a" | "b"');
    expect(typeOf({ type: ["string", "null"], enum: ["a", null] })).toBe('"a" | null');
    expect(typeOf({ oneOf: [{ type: "string" }, { type: "integer" }] })).toBe("string | number");
    expect(typeOf({ type: "object", additionalProperties: { type: "boolean" } })).toBe("Record<string, boolean>");
    expect(typeOf({ type: "array", items: { type: "string" } })).toBe("string[]");
    expect(typeOf({ type: "array", items: { type: ["string", "null"] } })).toBe("Array<string | null>");
    expect(typeOf({})).toBe("unknown");
  });

  it("marks optional what the schema does not require", () => {
    expect(typeOf({ type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a"] }))
      .toBe("{\n  a: string;\n  b?: number;\n}");
  });
});
