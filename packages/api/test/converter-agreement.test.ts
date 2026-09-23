import { describe, it, expect } from "vitest";
import { buildOpenApiDocument } from "../src/lib/openapi";
import { routes } from "../src/contracts/index";
import { allTools } from "../src/mcp/tools";

/**
 * TWO CONVERTERS, AND THIS IS WHERE THEY ARE MADE TO AGREE
 *
 * There are currently two paths from a zod contract to JSON Schema. The
 * OpenAPI document uses @asteasolutions/zod-to-openapi; the MCP tool list
 * uses src/lib/json-schema.ts, which was written for it. They were built in
 * parallel by two people who did not know about each other, which is exactly
 * how the registry's old comment about "one definition, no drift" came to be
 * false in the first place.
 *
 * Converging on one converter is the real answer and is not done. Until it
 * is, this file makes the drift LOUD instead of silent: an integrator reading
 * the document and an agent reading the tool list must be told the same thing
 * about the same field, and if they stop being told the same thing somebody
 * finds out here rather than from a 422 on a request the schema said was
 * valid.
 *
 * If this file is ever deleted, the two converters can diverge unobserved.
 */

type Schema = Record<string, unknown>;

const document = buildOpenApiDocument(routes) as {
  paths: Record<string, Record<string, {
    operationId?: string;
    parameters?: { name: string; in: string; schema?: Schema }[];
    requestBody?: { content?: Record<string, { schema?: Schema }> };
  }>>;
  components?: { schemas?: Record<string, Schema> };
};

/**
 * Follows a `$ref` into components.
 *
 * The document puts each request body in `components.schemas` and points at
 * it, which is correct and is why the first version of this comparison saw
 * every body as empty and reported two hundred disagreements that were
 * entirely its own. A comparison that cannot read one of the two things it
 * compares is worse than no comparison: it is a red test that trains
 * somebody to stop reading it.
 */
function resolve(schema: Schema | undefined): Schema | undefined {
  if (!schema) return undefined;
  const ref = schema.$ref;
  if (typeof ref !== "string") return schema;
  const name = ref.replace("#/components/schemas/", "");
  return document.components?.schemas?.[name];
}

/** Every field the document says an operation accepts, by name. */
function documentedFields(operationId: string): Map<string, Schema> {
  const fields = new Map<string, Schema>();
  for (const methods of Object.values(document.paths)) {
    for (const operation of Object.values(methods)) {
      if (operation.operationId !== operationId) continue;

      for (const parameter of operation.parameters ?? []) {
        /**
         * Headers are not tool arguments. An MCP tool call has no headers at
         * all, which is why the idempotency key travels as an argument and
         * the server lifts it back into one before dispatching.
         */
        if (parameter.in === "header") continue;
        const resolved = resolve(parameter.schema);
        if (resolved) fields.set(parameter.name, resolved);
      }

      const body = resolve(operation.requestBody?.content?.["application/json"]?.schema);
      const properties = (body?.properties ?? {}) as Record<string, Schema>;
      for (const [key, schema] of Object.entries(properties)) {
        fields.set(key, resolve(schema) ?? schema);
      }
    }
  }
  return fields;
}

describe("the document and the tool list describe the same API", () => {
  it("offers a tool for a route the document also describes", () => {
    const operationIds = new Set<string>();
    for (const methods of Object.values(document.paths)) {
      for (const operation of Object.values(methods)) {
        if (operation.operationId) operationIds.add(operation.operationId);
      }
    }

    // Tools are a subset: grant and public routes are documented and are not
    // tools, for reasons the tool list explains. Nothing may be a tool and
    // absent from the document.
    const missing = allTools()
      .filter((tool) => !operationIds.has(tool.routeName))
      .map((tool) => tool.routeName);
    expect(missing).toEqual([]);
  });

  it("agrees on which fields exist", () => {
    const disagreements: string[] = [];
    let compared = 0;

    for (const tool of allTools()) {
      const documented = documentedFields(tool.routeName);
      if (documented.size === 0) continue;

      const inTool = new Set(Object.keys(tool.inputSchema.properties ?? {}));
      // The idempotency key is an argument the tool adds, because a tool call
      // has no headers. The document carries it as a header. Not a drift.
      inTool.delete("idempotencyKey");

      for (const name of documented.keys()) {
        compared += 1;
        if (!inTool.has(name)) disagreements.push(`${tool.routeName}: document has ${name}, the tool does not`);
      }
      for (const name of inTool) {
        if (!documented.has(name)) disagreements.push(`${tool.routeName}: the tool has ${name}, the document does not`);
      }
    }

    // A comparison of zero fields would make every assertion here vacuous.
    expect(compared).toBeGreaterThan(50);
    expect(disagreements).toEqual([]);
  });

  it("agrees that money is a string in both", () => {
    /**
     * The one disagreement that would cost real money. A field the document
     * calls a string and the tool list calls a number puts an IEEE 754 float
     * into whichever of the two a client trusted.
     */
    let checked = 0;
    for (const tool of allTools()) {
      const documented = documentedFields(tool.routeName);
      for (const [name, schema] of documented) {
        const pattern = schema.pattern;
        if (typeof pattern !== "string" || !pattern.includes("\\d{1,")) continue;
        checked += 1;
        expect(schema.type).toBe("string");
        expect(tool.inputSchema.properties?.[name]?.type).toBe("string");
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
