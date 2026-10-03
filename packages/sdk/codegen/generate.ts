/**
 * THE SDK, WRITTEN FROM THE OPENAPI DOCUMENT
 *
 * One function, document in and source text out, with no disk and no
 * network, so a test can regenerate the client in memory and compare it with
 * the file in the tree. That comparison is the whole of why the SDK cannot
 * drift: the contracts produce `openapi.json`, `openapi.json` produces
 * `src/generated.ts`, and a test fails the moment either step is skipped.
 *
 * WHAT IT READS is exactly what the API package writes, and nothing it does
 * not: component schemas with no `$ref` inside them, nullable as a type list,
 * unions as `oneOf` or `anyOf`, a GET's input as query parameters rather than
 * a component, path parameters as parameters, and the idempotency and dry run
 * headers as parameters. A construct it does not know becomes `unknown`,
 * never `any`, so a gap in the generator is a type a caller has to narrow
 * rather than one that lets anything through.
 */

type Json = Record<string, unknown>;

interface Parameter {
  name: string;
  in: "path" | "query" | "header";
  required: boolean;
  description?: string;
  schema: Json;
}

interface Operation {
  operationId: string;
  summary: string;
  description?: string;
  parameters?: Parameter[];
  requestBody?: { content: Record<string, { schema: Json }> };
  responses: Record<string, { content?: Record<string, { schema: Json }> }>;
  "x-authorization": "session" | "grant" | "public";
  "x-permissions": string[];
  "x-dry-run"?: boolean;
}

export interface OpenApiDocument {
  info: { version: string };
  paths: Record<string, Record<string, unknown>>;
  components: { schemas: Record<string, Json> };
}

const METHODS = ["get", "post", "patch", "put", "delete"] as const;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string) => (IDENTIFIER.test(name) ? name : JSON.stringify(name));

/** A comment that cannot close itself early. */
const comment = (text: string, indent: string): string => {
  const lines = text.replace(/\*\//g, "* /").split("\n").map((line) => line.trimEnd());
  return lines.length === 1
    ? `${indent}/** ${lines[0]} */\n`
    : `${indent}/**\n${lines.map((line) => `${indent} *${line ? ` ${line}` : ""}`).join("\n")}\n${indent} */\n`;
};

/** One JSON Schema as a TypeScript type expression. */
export function typeOf(schema: Json | undefined, indent = ""): string {
  if (!schema || typeof schema !== "object") return "unknown";

  const union = (schema["oneOf"] ?? schema["anyOf"]) as Json[] | undefined;
  if (Array.isArray(union)) {
    const members = [...new Set(union.map((member) => typeOf(member, indent)))];
    return members.join(" | ");
  }

  if (Array.isArray(schema["enum"])) {
    const values = (schema["enum"] as unknown[]).map((value) => JSON.stringify(value));
    const nullable = Array.isArray(schema["type"]) && (schema["type"] as string[]).includes("null");
    return [...values, ...(nullable && !values.includes("null") ? ["null"] : [])].join(" | ");
  }

  const declared = schema["type"];
  if (Array.isArray(declared)) {
    const parts = (declared as string[]).map((type) => single({ ...schema, type }, indent));
    return [...new Set(parts)].join(" | ");
  }
  if (typeof declared === "string") return single(schema, indent);
  return "unknown";
}

function single(schema: Json, indent: string): string {
  switch (schema["type"]) {
    case "string": return "string";
    case "integer":
    case "number": return "number";
    case "boolean": return "boolean";
    case "null": return "null";
    case "array": {
      const item = typeOf(schema["items"] as Json | undefined, indent);
      return item.includes(" | ") || item.includes("\n") ? `Array<${item}>` : `${item}[]`;
    }
    case "object": return objectOf(schema, indent);
    default: return "unknown";
  }
}

function objectOf(schema: Json, indent: string): string {
  const properties = (schema["properties"] ?? {}) as Record<string, Json>;
  const names = Object.keys(properties);
  const extra = schema["additionalProperties"];
  if (names.length === 0) {
    if (extra && typeof extra === "object") return `Record<string, ${typeOf(extra as Json, indent)}>`;
    return "Record<string, unknown>";
  }
  const required = new Set((schema["required"] ?? []) as string[]);
  const inner = `${indent}  `;
  let out = "{\n";
  for (const name of names) {
    const property = properties[name]!;
    if (typeof property["description"] === "string") out += comment(property["description"], inner);
    out += `${inner}${key(name)}${required.has(name) ? "" : "?"}: ${typeOf(property, inner)};\n`;
  }
  if (extra && typeof extra === "object") out += `${inner}[key: string]: unknown;\n`;
  return `${out}${indent}}`;
}

const refName = (schema: Json | undefined): string | null => {
  const ref = schema?.["$ref"];
  return typeof ref === "string" ? ref.split("/").pop()! : null;
};

const capitalize = (s: string) => s[0]!.toUpperCase() + s.slice(1);

interface Rendered {
  id: string;
  method: string;
  path: string;
  pathParams: string[];
  queryParams: string[];
  idempotent: boolean;
  dryRun: boolean;
  paginated: boolean;
  authorization: string;
  permissions: string[];
  summary: string;
  inputType: string;
  outputType: string;
  inputRequired: boolean;
  declarations: string;
}

function render(path: string, method: string, op: Operation, schemas: Record<string, Json>): Rendered {
  const parameters = op.parameters ?? [];
  const pathParams = parameters.filter((p) => p.in === "path");
  const queryParams = parameters.filter((p) => p.in === "query");
  const bodyName = refName(op.requestBody?.content["application/json"]?.schema);
  const success = op.responses["201"] ?? op.responses["200"];
  const outputName = refName(success?.content?.["application/json"]?.schema);
  const Id = capitalize(op.operationId);

  let declarations = "";
  const pieces: string[] = [];
  let inputRequired = false;

  const params = [...pathParams, ...queryParams];
  if (params.length > 0) {
    const typeName = bodyName ? `${Id}Params` : `${Id}Input`;
    declarations += `export interface ${typeName} {\n`;
    for (const p of params) {
      if (p.description) declarations += comment(p.description, "  ");
      declarations += `  ${key(p.name)}${p.required ? "" : "?"}: ${typeOf(p.schema, "  ")};\n`;
      if (p.required) inputRequired = true;
    }
    declarations += "}\n\n";
    pieces.push(typeName);
  }
  if (bodyName) {
    pieces.push(bodyName);
    const body = schemas[bodyName];
    if (((body?.["required"] ?? []) as string[]).length > 0) inputRequired = true;
  }

  let inputType: string;
  if (pieces.length === 0) {
    inputType = `${Id}Input`;
    declarations += `export type ${inputType} = Record<string, never>;\n\n`;
  } else if (pieces.length === 1 && pieces[0] === `${Id}Input`) {
    inputType = pieces[0];
  } else {
    inputType = `${Id}Input`;
    if (bodyName !== inputType) declarations += `export type ${inputType} = ${pieces.join(" & ")};\n\n`;
    else inputType = pieces.join(" & ");
  }

  const outputSchema = outputName ? schemas[outputName] : undefined;
  const outputProps = (outputSchema?.["properties"] ?? {}) as Record<string, unknown>;
  const paginated = "nextCursor" in outputProps && "data" in outputProps
    && queryParams.some((p) => p.name === "cursor");

  return {
    id: op.operationId,
    method: method.toUpperCase(),
    path,
    pathParams: pathParams.map((p) => p.name),
    queryParams: queryParams.map((p) => p.name),
    idempotent: parameters.some((p) => p.in === "header" && p.name === "idempotency-key"),
    dryRun: op["x-dry-run"] === true,
    paginated,
    authorization: op["x-authorization"],
    permissions: op["x-permissions"],
    summary: op.summary,
    inputType,
    outputType: outputName ?? "unknown",
    inputRequired,
    declarations,
  };
}

/**
 * The whole of `src/generated.ts`.
 *
 * Sorted by operation id throughout, so a change to one route is a change to
 * a few lines of the diff rather than a reshuffle of the file.
 */
export function generate(document: OpenApiDocument): string {
  const schemas = document.components.schemas;
  const operations: Rendered[] = [];
  for (const [path, item] of Object.entries(document.paths)) {
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (op) operations.push(render(path, method, op, schemas));
    }
  }
  operations.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  let out = "";
  out += comment(
    "GENERATED from packages/api/openapi.json by packages/sdk/codegen. Do not edit by hand:\n"
    + "run `pnpm --filter @opentradesos/api run openapi`, which regenerates both, and a test\n"
    + "fails when this file and the document disagree.",
    "",
  );
  out += `\nexport const API_VERSION = ${JSON.stringify(document.info.version)};\n\n`;

  out += "/* ------------------------------------------------------------ schemas */\n\n";
  for (const name of Object.keys(schemas).sort()) {
    const schema = schemas[name]!;
    if (typeof schema["description"] === "string") out += comment(schema["description"], "");
    const type = typeOf(schema, "");
    const plainObject = schema["type"] === "object" && !schema["oneOf"] && !schema["anyOf"] && type.startsWith("{");
    out += plainObject
      ? `export interface ${name} ${type}\n\n`
      : `export type ${name} = ${type};\n\n`;
  }

  out += "/* ------------------------------------------------------- operation input */\n\n";
  for (const op of operations) out += op.declarations;

  out += "/* ----------------------------------------------------------- operations */\n\n";
  out += "export interface OperationTypes {\n";
  for (const op of operations) out += `  ${op.id}: { input: ${op.inputType}; output: ${op.outputType} };\n`;
  out += "}\n\n";

  out += "export type OperationId = keyof OperationTypes;\n\n";

  out += comment("How each operation is reached. Read by the client, never by a caller.", "");
  out += "export const OPERATIONS = {\n";
  for (const op of operations) {
    out += `  ${op.id}: { method: ${JSON.stringify(op.method)}, path: ${JSON.stringify(op.path)}, `
      + `pathParams: ${JSON.stringify(op.pathParams)}, queryParams: ${JSON.stringify(op.queryParams)}, `
      + `idempotent: ${op.idempotent}, dryRun: ${op.dryRun}, paginated: ${op.paginated}, `
      + `authorization: ${JSON.stringify(op.authorization)}, permissions: ${JSON.stringify(op.permissions)} },\n`;
  }
  out += "} as const;\n\n";

  const ids = (filter: (op: Rendered) => boolean) => {
    const list = operations.filter(filter).map((op) => JSON.stringify(op.id));
    return list.length > 0 ? list.join(" | ") : "never";
  };
  out += comment("Operations whose list pages with `cursor` and `nextCursor`, for `paginate`.", "");
  out += `export type PaginatedOperationId = ${ids((op) => op.paginated)};\n\n`;
  out += comment("Bulk operations that can be asked what they would change, for `dryRun`.", "");
  out += `export type DryRunOperationId = ${ids((op) => op.dryRun)};\n\n`;

  out += "export interface CallOptions {\n";
  out += comment(
    "The idempotency key for an operation that takes one. Generated when omitted, and reused on\n"
    + "the client's own retries; pass your own to make a retry from another process safe too.",
    "  ",
  );
  out += "  idempotencyKey?: string;\n";
  out += "  signal?: AbortSignal;\n";
  out += "}\n\n";

  out += comment(
    "One method per operation, each a typed call to the same request function, so every\n"
    + "operation behaves the same way: the same authentication, idempotency, retries and errors.",
    "",
  );
  out += "export abstract class GeneratedOperations {\n";
  out += "  protected abstract call<K extends OperationId>(\n";
  out += "    operation: K, input: OperationTypes[K][\"input\"], options?: CallOptions,\n";
  out += "  ): Promise<OperationTypes[K][\"output\"]>;\n\n";
  for (const op of operations) {
    const doc = `${op.summary}.\n\n${op.method} ${op.path}${op.permissions.length > 0 ? `. Needs ${op.permissions.join(", ")}` : ""}.`;
    out += comment(doc, "  ");
    const param = op.inputRequired ? `input: ${op.inputType}` : `input: ${op.inputType} = {} as ${op.inputType}`;
    out += `  ${op.id}(${param}, options?: CallOptions): Promise<${op.outputType}> {\n`;
    out += `    return this.call(${JSON.stringify(op.id)}, input, options);\n`;
    out += "  }\n\n";
  }
  out = `${out.trimEnd()}\n}\n`;
  return out;
}
